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

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeAtomic } from "../io/atomic.js";
import { JevAdapter } from "../adapters/jev.js";
import { LocalAdapter } from "../adapters/local.js";
import { MockAdapter } from "../adapters/mock.js";
import { AdapterError, type Adapter } from "../adapters/types.js";
import { parseFlags, positiveInteger } from "./args.js";
import { questionsOf } from "../calibrate.js";
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
  /** A policy file for this run, ahead of every other place one is looked for. */
  readonly policy?: string;
  readonly json?: boolean;
  /** What was wrong with the argv. The command prints it and exits 1 without running. */
  readonly error?: string;
}

const FLAGS = { values: ["set", "backend", "out", "manifest", "concurrency", "policy"], switches: ["json"], positionals: 1 } as const;

export function parseArgs(argv: readonly string[]): JudgeArgs {
  const parsed = parseFlags(argv, FLAGS);
  const { values } = parsed;
  // The one bare word is the batch. A second is refused rather than ignored: whichever of
  // the two was judged, the other was a file the user believed had been.
  const path = parsed.positionals[0];
  const concurrency = positiveInteger("concurrency", values.get("concurrency"));
  const error = parsed.error ?? concurrency.error;

  return {
    ...(path !== undefined ? { path } : {}),
    ...(values.has("set") ? { set: values.get("set") as string } : {}),
    ...(values.has("backend") ? { backend: values.get("backend") as string } : {}),
    ...(values.has("out") ? { out: values.get("out") as string } : {}),
    ...(values.has("manifest") ? { manifest: values.get("manifest") as string } : {}),
    ...(values.has("policy") ? { policy: values.get("policy") as string } : {}),
    ...(concurrency.value !== undefined ? { concurrency: concurrency.value } : {}),
    json: parsed.switches.has("json"),
    ...(error !== undefined ? { error } : {}),
  };
}

export async function judge(args: JudgeArgs, write: (s: string) => void): Promise<number> {
  if (args.error !== undefined) {
    write(args.error);
    return 1;
  }

  if (args.path === undefined) {
    write("Usage: bouncer judge <file-or-dir> [--set name] [--backend jev|local|mock] [--policy file]\n");
    return 1;
  }

  const root = pluginRoot() ?? process.cwd();
  const resolved = resolvePolicy(process.cwd(), root, args.policy);

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
  const manifestWritten = writeManifest(manifestPath, run, policy);

  // Decided once, so `--json` cannot disagree with the text output about it — it used to
  // return 0 before this was ever looked at. Non-zero when any item went unjudged or
  // incomplete, not only when all did: a run meant to be left unattended is exactly where
  // "ninety-nine of a hundred failed" must not exit clean. A failed manifest write counts,
  // since the file at that path is then some other run's. Never 2.
  const status = run.judged === 0 || run.failed > 0 || run.incomplete > 0 || !manifestWritten ? 1 : 0;

  if (args.json === true) {
    // `manifest` stays the manifest. It used to be overwritten here with the path, which
    // dropped the denominator and the items from the one output a script would parse.
    write(`${JSON.stringify({ ...run, log: logPath, manifestPath, manifestWritten }, null, 2)}\n`);
    return status;
  }

  write(formatRun(run));
  write(`\n  judgments  ${logPath}\n`);
  write(`  manifest   ${manifestWritten ? manifestPath : `(could not be written to ${manifestPath})`}\n`);
  if (run.failed > 0 || run.incomplete > 0) {
    write(
      `\n${run.failed + run.incomplete} item${run.failed + run.incomplete === 1 ? "" : "s"} settled nothing and` +
        ` ${run.failed + run.incomplete === 1 ? "is" : "are"} listed in the manifest under \`unjudged\` and \`incomplete\`.` +
        " Nothing here accepted them.\n",
    );
  }

  return status;
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
    ...(item.model !== undefined ? { model: item.model } : {}),
    policy: identityOf(policy, run.set),
    // Only a judged item has a verdict, and the line says so by not having one. It used to
    // say `allow` beside an `error`, which is "accepted" to anything that reads one field.
    ...(item.outcome === "judged" ? { verdict: item.verdict } : {}),
    // Nothing is emitted anywhere: there is no Claude Code here to emit to. Written as null
    // rather than left out so a reader never has to ask which kind of line it is holding.
    emitted: null,
    reason: item.outcome === "unjudged" ? { kind: "no-rule-matched" } : item.reason,
    // An incomplete item keeps its answers: they are real, about the head of the item, and
    // `truncated` beside them is what tells a re-score which kind they are.
    ...(item.outcome !== "unjudged" ? { source: "judge" as const, answers: item.answers } : {}),
    ...(item.probes !== undefined ? { probes: item.probes } : {}),
    // The log line carries the state, so the escalation on it does not repeat it — same
    // rule as the gate's. The standalone manifest is where the item stands on its own.
    ...(item.outcome === "judged" && item.escalation !== undefined ? { escalation: withoutState(item.escalation) } : {}),
    state: item.state,
    ...(item.redactedKinds.length > 0 ? { redacted_kinds: item.redactedKinds } : {}),
    ...(item.truncated ? { truncated: true } : {}),
    latency_ms: { total: item.latencyMs, adapter: item.latencyMs },
    ...(item.outcome === "unjudged" ? { error: item.error } : {}),
  };
}

function withoutState<T extends { state?: string }>(escalation: T): Omit<T, "state"> {
  const { state: _state, ...rest } = escalation;
  return rest;
}

function identityOf(policy: Policy, setName: string): { file: string; questions: string } {
  return { file: policy.fingerprint, questions: policy.sets[setName]?.questionsFingerprint ?? "" };
}

/**
 * Replaces the manifest with this run's, every time, and reports whether it could.
 *
 * It used to return early when nothing escalated, which left the previous run's file where
 * it was: judge a batch that escalates `old`, then a clean one to the same path, and the
 * manifest still names `old`. Whatever read it next re-adjudicated an item that was not in
 * the batch. An empty manifest is a result, and it is written like any other — atomically,
 * so a reader never sees half of one.
 *
 * `unjudged` and `incomplete` are beside `items` rather than in it. `items` goes to the
 * reasoning pass, and neither belongs there: one has nothing to re-adjudicate and the other
 * would be sent the same truncated state. They are for a person, and being in the artifact
 * is what makes them hard to miss.
 *
 * The manifest is handed to something that has never seen the policy file, so it carries
 * what that reader needs to ask the same question: every question the set asked, whole —
 * a signal's `asks` is the instructions alone, and the criteria are half of what the
 * classifier was told — plus which policy and which models produced it. The models are a
 * list because `jev-latest` is an alias and a long batch can straddle the day it moves.
 */
function writeManifest(path: string, run: JudgeRun, policy: Policy): boolean {
  const set = policy.sets[run.set];
  const models = [...new Set(run.items.flatMap((i) => (i.model === undefined ? [] : [i.model])))];

  return writeAtomic(
    path,
    `${JSON.stringify(
      {
        set: run.set,
        backend: run.backend,
        ...(models.length > 0 ? { models } : {}),
        policy: identityOf(policy, run.set),
        ...(set !== undefined ? { questions: questionsOf(set) } : {}),
        ...run.manifest,
        unjudged: needsAPerson(run, "unjudged"),
        incomplete: needsAPerson(run, "incomplete"),
      },
      null,
      2,
    )}\n`,
  );
}

function needsAPerson(run: JudgeRun, outcome: "unjudged" | "incomplete"): { item: string; because: string }[] {
  return run.items.flatMap((i) =>
    i.outcome !== outcome
      ? []
      : [{ item: i.id, because: i.outcome === "unjudged" ? `${i.error.kind}: ${i.error.message}` : "truncated" }],
  );
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
