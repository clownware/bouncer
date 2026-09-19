// `bouncer judge` — run a policy set over a batch of items.
//
//   bouncer judge <file-or-dir> [--set name] [--backend jev|local|mock]
//                 [--out path] [--manifest path] [--concurrency n] [--json]
//
// The second entrypoint over the same engine (docs/adr/009). It writes two artifacts:
//
//   - a judgments log, in the same JSONL line shape the gate writes, with `consumer:
//     "judge"` and the set's name on every line. `bouncer calibrate --from` reads it, so a
//     batch run in anger becomes fixtures.
//   - an escalation manifest, the items the judge did not settle, each with the thresholds
//     it crossed and the questions' own words. That is the input to a reasoning pass, and
//     `bouncer measure` is what turns it into a number.
//
// Unlike the hook, this sends the items themselves. The README says so plainly and
// docs/adr/009 decision 4 says why that is not a reversal of PRD §9.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JevAdapter } from "../adapters/jev.js";
import { LocalAdapter } from "../adapters/local.js";
import { MockAdapter } from "../adapters/mock.js";
import { AdapterError, type Adapter } from "../adapters/types.js";
import { formatRun, judge as runJudge, type JudgeRun, type JudgedItem } from "../judge.js";
import { GATE_SET, type Policy } from "../engine/types.js";
import { apiKey, dataDir, errorsIn, localBackend, pluginRoot, resolvePolicy } from "../io/config.js";
import { itemState } from "../engine/item.js";
import { loadItems, type LoadedBatch } from "../io/items.js";
import { JUDGMENTS_FILE, append, type DecisionRecord } from "../io/log.js";

export interface JudgeArgs {
  readonly path?: string;
  readonly set?: string;
  readonly backend?: string;
  readonly out?: string;
  readonly manifest?: string;
  readonly concurrency?: number;
  readonly json?: boolean;
}

/** Flags that take a following value, so the value is never mistaken for the batch path. */
const VALUE_FLAGS = ["set", "backend", "out", "manifest", "concurrency"] as const;

export function parseArgs(argv: readonly string[]): JudgeArgs {
  const values = new Map<string, string>();
  let path: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (token.startsWith("--")) {
      const name = token.slice(2);
      if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        const value = argv[i + 1];
        if (value !== undefined) values.set(name, value);
        i += 1;
      }
      continue;
    }

    // The first bare word is the batch. A second one is a typo worth ignoring rather than
    // silently judging whichever came last.
    path ??= token;
  }

  const concurrency = Number(values.get("concurrency"));

  return {
    ...(path !== undefined ? { path } : {}),
    ...(values.has("set") ? { set: values.get("set") as string } : {}),
    ...(values.has("backend") ? { backend: values.get("backend") as string } : {}),
    ...(values.has("out") ? { out: values.get("out") as string } : {}),
    ...(values.has("manifest") ? { manifest: values.get("manifest") as string } : {}),
    ...(Number.isFinite(concurrency) && concurrency > 0 ? { concurrency } : {}),
    json: argv.includes("--json"),
  };
}

export async function judge(args: JudgeArgs, write: (s: string) => void): Promise<number> {
  if (args.path === undefined) {
    write("Usage: bouncer judge <file-or-dir> [--set name] [--backend jev|local|mock]\n");
    return 1;
  }

  const root = pluginRoot() ?? process.cwd();
  const resolved = resolvePolicy(process.cwd(), root);

  if (resolved.policy === undefined) {
    write(`Cannot judge: ${resolved.source} did not load.\n`);
    for (const d of errorsIn(resolved.diagnostics)) write(`  ${d.path || "(top level)"}: ${d.message}\n`);
    return 1;
  }

  const policy: Policy = resolved.policy;
  const setName = args.set ?? GATE_SET;
  const set = policy.sets[setName];
  if (set === undefined) {
    write(
      `${resolved.source} defines no set named "${setName}".` +
        ` It has: ${Object.keys(policy.sets).join(", ")}.\n`,
    );
    return 1;
  }

  let batch: LoadedBatch;
  try {
    batch = loadItems(resolve(args.path));
  } catch (err) {
    write(`Cannot read ${args.path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  for (const skip of batch.skipped) write(`  skipped ${skip.path}: ${skip.why}\n`);

  if (batch.items.length === 0) {
    write(`Nothing to judge in ${args.path}.\n`);
    return 1;
  }

  const backend = args.backend ?? policy.backend;
  const adapter = adapterFor(backend);
  if (typeof adapter === "string") {
    write(`${adapter}\n`);
    return 1;
  }

  const problem = await startIfNeeded(adapter);
  if (problem !== undefined) {
    write(`Cannot judge with ${adapter.name}: ${problem}\n`);
    return 1;
  }

  const run = await runJudge(
    batch.items.map((entry) => ({ id: entry.id, state: itemState.build(entry.item) })),
    {
      setName,
      set,
      mode: policy.mode,
      adapter,
      // A batch is not on anyone's keystroke path, so the hook's timeout is the wrong
      // budget: it exists to keep a tool call responsive. Give an item room to be a long
      // document.
      timeoutMs: Math.max(policy.timeoutMs, 30_000),
      ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
      onProgress: (done, total) => {
        if (!args.json) process.stderr.write(`\r  ${done}/${total} items`);
      },
    },
  );
  if (!args.json) process.stderr.write("\r\x1b[K");

  const logPath = args.out ?? join(dataDir(), JUDGMENTS_FILE);
  const manifestPath = args.manifest ?? join(dataDir(), "escalations.json");

  writeLog(logPath, run, policy);
  const manifestWritten = writeManifest(manifestPath, run);

  if (args.json === true) {
    write(`${JSON.stringify({ ...run, log: logPath, manifest: manifestPath }, null, 2)}\n`);
    return 0;
  }

  write(formatRun(run));
  write(`\n  judgments  ${logPath}\n`);
  write(`  manifest   ${manifestWritten ? manifestPath : "(not written: nothing escalated)"}\n`);

  // A run where nothing could be judged is a failure whatever it printed.
  return run.judged === 0 ? 1 : 0;
}

/**
 * One line per item, in the gate's own line shape.
 *
 * Same shape on purpose: `calibrate --from` reads both, `/bouncer:explain` reads both, and
 * a second record type would have meant a second reader for every one of them. What marks
 * a judge line is `consumer` and `set`, not a different schema — docs/adr/009 decision 3.
 */
function writeLog(path: string, run: JudgeRun, policy: Policy): void {
  mkdirSync(dirname(path), { recursive: true });
  const ts = new Date().toISOString();

  for (const item of run.items) {
    append(dirname(path), recordFor(item, run, policy, ts), basenameOf(path));
  }
}

function recordFor(item: JudgedItem, run: JudgeRun, policy: Policy, ts: string): DecisionRecord {
  return {
    ts,
    consumer: "judge",
    set: run.set,
    item: item.id,
    state_kind: "item",
    mode: policy.mode,
    backend: run.backend,
    verdict: item.verdict,
    // Nothing is emitted anywhere: there is no Claude Code here to emit to. Written as null
    // rather than left out so a reader never has to ask which kind of line it is holding.
    emitted: null,
    reason: item.reason,
    ...(item.error === undefined ? { source: "judge" as const, answers: item.answers } : {}),
    ...(item.probes !== undefined ? { probes: item.probes } : {}),
    // The log line carries the state, so the escalation on it does not repeat it — same
    // rule as the gate's. The standalone manifest is where the item stands on its own.
    ...(item.escalation !== undefined ? { escalation: withoutState(item.escalation) } : {}),
    state: item.state,
    ...(item.redactedKinds.length > 0 ? { redacted_kinds: item.redactedKinds } : {}),
    latency_ms: { total: item.latencyMs, adapter: item.latencyMs },
    ...(item.error !== undefined ? { error: item.error } : {}),
  };
}

function withoutState<T extends { state?: string }>(escalation: T): Omit<T, "state"> {
  const { state: _state, ...rest } = escalation;
  return rest;
}

/** Returns false when there was nothing to write, so the caller can say so. */
function writeManifest(path: string, run: JudgeRun): boolean {
  if (run.manifest.items.length === 0) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ set: run.set, backend: run.backend, ...run.manifest }, null, 2)}\n`,
    "utf8",
  );
  return true;
}

function basenameOf(path: string): string {
  return path.split("/").pop() ?? JUDGMENTS_FILE;
}

/** An adapter, or the sentence to print instead of one. */
function adapterFor(backend: string): Adapter | string {
  if (backend === "mock") return new MockAdapter();
  if (backend === "local") return new LocalAdapter(localBackend());

  if (backend === "jev") {
    const key = apiKey();
    if (key === undefined) {
      return "Cannot judge with jev: set BOUNCER_TYPESAFE_API_KEY or TYPESAFE_API_KEY.";
    }
    return new JevAdapter({ apiKey: key });
  }

  return `Unknown backend "${backend}".`;
}

/** The adapter's own refusal message, or undefined if it started. */
async function startIfNeeded(adapter: Adapter): Promise<string | undefined> {
  const start = (adapter as { start?: () => Promise<void> }).start;
  if (typeof start !== "function") return undefined;

  try {
    await start.call(adapter);
    return undefined;
  } catch (err) {
    if (err instanceof AdapterError) return err.message;
    return err instanceof Error ? err.message : String(err);
  }
}
