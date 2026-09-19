// `bouncer calibrate` — run the fixtures through a backend and print the reliability table.
//
// Manual and local by design. The live pass needs a real API key, which no automated
// thread ever has; CI runs the same code against the mock adapter so the harness itself
// stays tested.
//
//   bouncer calibrate [--fixtures path] [--set name] [--backend jev|local|mock] [--compare a,b] [--out run.jsonl] [--json]
//   bouncer calibrate --from <log.jsonl> [--fixtures path] [--set name] [--json]
//
// `--out` writes what the classifier said about each fixture, one line per fixture, in the
// shape `--from` reads. The answers are the only part of a run that costs a live call, and a
// published table that keeps them can be re-scored under a moved threshold by anyone, with
// no key. A second live run is not a substitute: the same fixture has read 0.63, 0.64 and
// 0.65 across runs 6 to 8, which is the width of the window being argued about.
//
// `--from` scores a log's recorded answers instead of asking a backend, so re-scoring a run
// you have already paid for — after a relabelling, or after moving a threshold — costs
// nothing and calls nothing. It joins the log to the labels by id: `bouncer judge` writes
// `item` on every line, so a judgments log over a fixture file lines up by construction.
//
// `--set` names the policy set to score against, defaulting to `gate`. A fixture file does
// not name its own set on purpose: the same batch scored against two sets is a thing
// someone will want to do, and a set baked into every line makes that an edit (docs/adr/009).
//
// `--compare` runs two backends over the same fixture set and prints them side by side.
// Both runs go through the same `score()`, so the comparison is of the backends and not of
// two code paths that happen to agree.

import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { JevAdapter } from "../adapters/jev.js";
import { LocalAdapter } from "../adapters/local.js";
import { MockAdapter } from "../adapters/mock.js";
import { AdapterError, type Adapter } from "../adapters/types.js";
import {
  compare,
  formatComparison,
  formatReport,
  loadFixtures,
  report,
  score,
  scoreAnswered,
  scoreFromLog,
  type Answered,
  type Fixture,
  type Scored,
} from "../calibrate.js";
import { parseFlags } from "./args.js";
import { GATE_SET, type Policy } from "../engine/types.js";
import { apiKey, errorsIn, localBackend, pluginRoot, resolvePolicy } from "../io/config.js";
import type { DecisionRecord } from "../io/log.js";

export interface CalibrateArgs {
  readonly fixtures?: string;
  /** A decisions or judgments log to score instead of calling a backend. */
  readonly from?: string;
  /** The policy set to score against. Defaults to `gate`. */
  readonly set?: string;
  readonly backend?: string;
  /** One or two backend names. One means "against the backend already selected". */
  readonly compare?: string;
  /** Where to write the run's raw answers, for `--from` to read back. */
  readonly out?: string;
  /** A policy file for this run, ahead of every other place one is looked for. */
  readonly policy?: string;
  readonly json?: boolean;
  /** What was wrong with the argv. The command prints it and exits 1 without running. */
  readonly error?: string;
}

const FLAGS = { values: ["fixtures", "set", "from", "backend", "compare", "out", "policy"], switches: ["json"] } as const;

export function parseArgs(argv: readonly string[]): CalibrateArgs {
  const { values, switches, error } = parseFlags(argv, FLAGS);
  const value = (name: string): string | undefined => values.get(name);
  return {
    ...(value("fixtures") !== undefined ? { fixtures: value("fixtures") as string } : {}),
    ...(value("set") !== undefined ? { set: value("set") as string } : {}),
    ...(value("from") !== undefined ? { from: value("from") as string } : {}),
    ...(value("backend") !== undefined ? { backend: value("backend") as string } : {}),
    ...(value("compare") !== undefined ? { compare: value("compare") as string } : {}),
    ...(value("out") !== undefined ? { out: value("out") as string } : {}),
    ...(value("policy") !== undefined ? { policy: value("policy") as string } : {}),
    json: switches.has("json"),
    ...(error !== undefined ? { error } : {}),
  };
}

export async function calibrate(args: CalibrateArgs, write: (s: string) => void): Promise<number> {
  if (args.error !== undefined) {
    write(args.error);
    return 1;
  }

  const root = pluginRoot() ?? process.cwd();
  const resolved = resolvePolicy(process.cwd(), root, args.policy);

  if (resolved.policy === undefined) {
    write(`Cannot calibrate: ${resolved.source} did not load.\n`);
    for (const d of errorsIn(resolved.diagnostics)) write(`  ${d.path || "(top level)"}: ${d.message}\n`);
    return 1;
  }

  const fixturePath = args.fixtures ?? join(root, "fixtures", "gate.jsonl");
  let fixtures;
  try {
    fixtures = loadFixtures(fixturePath);
  } catch (err) {
    write(`Cannot read fixtures at ${fixturePath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (args.from !== undefined) {
    return fromLog(args, resolved.policy, fixtures, write);
  }

  const primary = args.backend ?? resolved.policy.backend;
  const names = backendsFor(primary, args.compare);

  if (args.out !== undefined && names.length > 1) {
    // One file, one run. Two backends in it would match every fixture twice on the way back
    // in, and `--from` would score the pair as if it were one classifier.
    write("--out records one run; drop --compare, or run each backend with its own --out.\n");
    return 1;
  }

  const adapters: Adapter[] = [];
  for (const name of names) {
    const adapter = adapterFor(name);
    if (typeof adapter === "string") {
      write(`${adapter}\n`);
      return 1;
    }
    adapters.push(adapter);
  }

  // Preflight before the first fixture, not on it. The local adapter refuses to start when
  // the endpoint cannot constrain its decode, and finding that out 40 fixtures into a run
  // wastes the run and reads like a flake.
  for (const adapter of adapters) {
    const problem = await startIfNeeded(adapter);
    if (problem !== undefined) {
      write(`Cannot calibrate against ${adapter.name}: ${problem}\n`);
      return 1;
    }
  }

  const runs: Array<{ backend: string; scored: Scored[] }> = [];
  const answered: Answered[] = [];
  for (const [i, adapter] of adapters.entries()) {
    const label = names[i] as string;
    let scored: Scored[];
    try {
      scored = await run(fixtures, resolved.policy, adapter, label, names.length, args, answered);
    } catch (err) {
      // A set name that is not in the policy is a typo, not a crash. Say which names exist.
      write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    runs.push({ backend: label, scored });
  }

  const [first, second] = runs;
  if (first === undefined) {
    write("No backend to run.\n");
    return 1;
  }

  if (args.out !== undefined) {
    try {
      writeAnswers(args.out, answered, resolved.policy, args.set ?? GATE_SET, first.backend);
    } catch (err) {
      write(`Cannot write ${args.out}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (args.json === true) {
    const payload =
      second === undefined
        ? { backend: first.backend, policy: resolved.source, fixtures: fixtures.length, reports: report(first.scored, resolved.policy.calibration) }
        : {
            backends: [first.backend, second.backend],
            policy: resolved.source,
            fixtures: fixtures.length,
            reports: {
              [first.backend]: report(first.scored, resolved.policy.calibration),
              [second.backend]: report(second.scored, resolved.policy.calibration),
            },
            comparison: compare(first, second, resolved.policy.calibration),
          };
    write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  // Which file, because the answer to "did that run use the policy I meant" was otherwise
  // to go and work out the precedence by hand.
  write(`Policy: ${resolved.source}\n`);
  for (const r of runs) {
    write(formatReport(report(r.scored, resolved.policy.calibration), r.backend, resolved.policy.calibration, r.scored));
    write("\n");
  }

  if (second !== undefined) {
    write(formatComparison(compare(first, second, resolved.policy.calibration), resolved.policy.calibration));
  }

  if (args.out !== undefined) {
    write(`\nAnswers written to ${args.out}. Re-score them without a key: bouncer calibrate --from ${args.out}\n`);
  }

  return 0;
}

/**
 * The run's raw answers, one line per fixture, in the log's own line shape.
 *
 * Same shape as a judgments line for the reason `bouncer judge` gives: `--from` already
 * reads it, so a new schema would have needed a new reader. `item` is the fixture id, which
 * is what `--from` joins on.
 *
 * No `state`. The fixture file is committed beside whatever this writes and the state is
 * built from it, so repeating it here would only be a second copy that can drift. The file
 * is replaced rather than appended to: it is one run, and a rerun appended to the last
 * would match every fixture twice.
 *
 * A fixture a hard rule decides still carries its answers — the classifier was asked, and
 * the accuracy columns are computed from what it said — with `source` naming what decided
 * the verdict.
 */
function writeAnswers(path: string, answered: readonly Answered[], policy: Policy, setName: string, backend: string): void {
  const set = policy.sets[setName];
  if (set === undefined) return;

  const ts = new Date().toISOString();
  const lines = answered.map((a): DecisionRecord => {
    const { verdict, reason } = scoreAnswered(a, policy, set, setName);
    return {
      ts,
      consumer: "judge",
      set: setName,
      item: a.fixture.id,
      state_kind: a.fixture.kind,
      mode: policy.mode,
      backend,
      // A published run is re-scored for as long as the repository exists. Which model gave
      // these answers, and to which wording of the questions, is what makes that legitimate.
      ...(a.model !== undefined ? { model: a.model } : {}),
      policy: { file: policy.fingerprint, questions: set.questionsFingerprint },
      verdict,
      emitted: null,
      reason,
      source: reason.kind === "hard-rule" ? "hard_rule" : "judge",
      answers: a.answers,
      ...(Object.keys(a.probes).length > 0 ? { probes: a.probes } : {}),
      latency_ms: { total: a.latencyMs, adapter: a.latencyMs },
    };
  });

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

/**
 * `--from`: score what the classifier already said.
 *
 * No adapter is constructed at all, which is deliberate rather than incidental — this path
 * must work with no API key, no network and no local endpoint, because "re-score the run I
 * paid for last week" is a thing to do on a plane.
 */
function fromLog(
  args: CalibrateArgs,
  policy: Policy,
  fixtures: readonly Fixture[],
  write: (s: string) => void,
): number {
  let source: string;
  try {
    source = readFileSync(args.from as string, "utf8");
  } catch (err) {
    write(`Cannot read the log at ${args.from}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let result;
  try {
    result = scoreFromLog(source, fixtures, policy, args.set);
  } catch (err) {
    write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (result.matched === 0) {
    // Silence here would print an empty table that reads like a passing run.
    write(
      `No line in ${args.from} matched a fixture id.\n` +
        `  ${result.unmatched} lines named an item with no fixture, and ${result.unscorable} carried no answers.\n` +
        (result.otherSet > 0
          ? `  ${result.otherSet} were judged against a different set than "${args.set ?? "gate"}" — pass --set to score those.\n`
          : "") +
        `  A judgments log written over this fixture file joins by id; a gate log joins on tool_use_id.\n`,
    );
    return 1;
  }

  if (args.json === true) {
    write(
      `${JSON.stringify(
        {
          from: args.from,
          matched: result.matched,
          unmatched: result.unmatched,
          unscorable: result.unscorable,
          otherSet: result.otherSet,
          reworded: result.reworded,
          models: result.models,
          reports: report(result.scored, policy.calibration),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  write(formatReport(report(result.scored, policy.calibration), `${args.from} (recorded)`, policy.calibration, result.scored));
  write(
    `\nScored ${result.matched} logged items against their labels.` +
      ` ${result.unmatched} had no fixture; ${result.unscorable} carried no classifier answer` +
      ` (a hard rule, the fast path, or an error).\n`,
  );
  if (result.otherSet > 0) {
    write(`${result.otherSet} were judged against a different set and are left out.\n`);
  }
  if (result.models.length > 0) {
    write(
      result.models.length === 1
        ? `Answered by ${result.models[0]}.\n`
        : `Answered by ${result.models.length} models (${result.models.join(", ")}), so this is not one sample.\n`,
    );
  }
  // Last, and worded to be read: every number above it is about the old wording.
  if (result.reworded > 0) {
    write(
      `\n${result.reworded} of those ${result.matched} were answered under a different wording of this set's questions than\n` +
        `the policy has now. The probabilities above are about the old wording. Moving a threshold\n` +
        `leaves them valid; rewording a question does not, and only a live run re-asks it.\n`,
    );
  }
  return 0;
}

async function run(
  fixtures: readonly Fixture[],
  policy: Policy,
  adapter: Adapter,
  label: string,
  total: number,
  args: CalibrateArgs,
  answered: Answered[],
): Promise<Scored[]> {
  // Progress matters here: a live run is one network call per fixture and takes minutes.
  // It goes to stderr so `--json` output stays pipeable.
  const prefix = total > 1 ? `${label}: ` : "";
  const scored = await score(
    fixtures,
    policy,
    adapter,
    (done, n, a) => {
      answered.push(a);
      if (!args.json) process.stderr.write(`\r  ${prefix}${done}/${n} fixtures`);
    },
    args.set,
  );
  if (!args.json) process.stderr.write("\r\x1b[K");
  return scored;
}

/**
 * Which backends to run.
 *
 * `--compare local` compares against whatever `--backend` or the policy already selected,
 * which is the shape the flag is reached for; `--compare jev,local` names both explicitly.
 * A backend compared with itself is a typo worth catching rather than a run worth making.
 */
function backendsFor(primary: string, compare?: string): string[] {
  if (compare === undefined || compare.trim().length === 0) return [primary];

  const named = compare
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const pair = named.length >= 2 ? named.slice(0, 2) : [primary, ...named];
  return pair[0] === pair[1] ? [pair[0] as string] : pair;
}

/** An adapter, or the sentence to print instead of one. */
function adapterFor(backend: string): Adapter | string {
  if (backend === "mock") return new MockAdapter();

  if (backend === "jev") {
    const key = apiKey();
    if (key === undefined) {
      return "Cannot calibrate against jev: set BOUNCER_TYPESAFE_API_KEY or TYPESAFE_API_KEY.";
    }
    return new JevAdapter({ apiKey: key });
  }

  if (backend === "local") return new LocalAdapter(localBackend());

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
