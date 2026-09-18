// `bouncer calibrate` — run the fixtures through a backend and print the reliability table.
//
// Manual and local by design. The live pass needs a real API key, which no automated
// thread ever has; CI runs the same code against the mock adapter so the harness itself
// stays tested.
//
//   bouncer calibrate [--fixtures path] [--backend jev|mock] [--json]
//   bouncer calibrate --from-log [path] [--labels path] [--json]
//
// `--from-log` answers a different question and makes no network call at all. Probes are
// answered on every real gated call and land in `decisions.jsonl`, so the log accumulates
// candidate-question data as a by-product of ordinary use. This reads it back. Labels come
// from a separate file a human writes, keyed by `tool_use_id`; a probe answer with no
// label is counted and skipped rather than guessed at.

import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { JevAdapter } from "../adapters/jev.js";
import { MockAdapter } from "../adapters/mock.js";
import type { Adapter } from "../adapters/types.js";
import {
  formatLoggedProbes,
  formatReport,
  loadFixtures,
  parseLoggedLabels,
  report,
  score,
  scoreLoggedProbes,
} from "../calibrate.js";
import { apiKey, dataDir, errorsIn, pluginRoot, resolvePolicy } from "../io/config.js";
import { LOG_FILE, parseLog } from "../io/log.js";

/** The labels file looked for next to the log when `--labels` is not given. */
const DEFAULT_LABELS_FILE = "probe-labels.jsonl";

export interface CalibrateArgs {
  readonly fixtures?: string;
  readonly backend?: string;
  readonly json?: boolean;
  /** Present for `--from-log`; an empty string means "the log in the data directory". */
  readonly fromLog?: string;
  readonly labels?: string;
}

export function parseArgs(argv: readonly string[]): CalibrateArgs {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  // `--from-log` takes an optional path, so the next token is only its value if it is not
  // itself a flag. Without this, `bouncer calibrate --from-log --json` would look for a
  // log named "--json".
  const optional = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const next = argv[i + 1];
    return next !== undefined && !next.startsWith("--") ? next : "";
  };

  return {
    ...(value("fixtures") !== undefined ? { fixtures: value("fixtures") as string } : {}),
    ...(value("backend") !== undefined ? { backend: value("backend") as string } : {}),
    ...(optional("from-log") !== undefined ? { fromLog: optional("from-log") as string } : {}),
    ...(value("labels") !== undefined ? { labels: value("labels") as string } : {}),
    json: argv.includes("--json"),
  };
}

/**
 * `--from-log`: score the probe answers already in the decision log.
 *
 * Reads no policy and calls no adapter. A missing labels file is the normal case rather
 * than an error — the log fills up on its own, and labelling it is a thing someone does
 * later, if ever.
 */
function calibrateFromLog(args: CalibrateArgs, write: (s: string) => void): number {
  const logPath = args.fromLog !== undefined && args.fromLog.length > 0
    ? args.fromLog
    : join(dataDir(), LOG_FILE);

  let records;
  try {
    records = parseLog(readFileSync(logPath, "utf8"));
  } catch (err) {
    write(`Cannot read the decision log at ${logPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const labelsPath = args.labels ?? join(dirname(logPath), DEFAULT_LABELS_FILE);
  let labels = new Map<string, Record<string, boolean>>();
  try {
    labels = parseLoggedLabels(readFileSync(labelsPath, "utf8"));
  } catch (err) {
    // An explicitly named labels file that cannot be read is a mistake worth reporting.
    // The default one being absent is not: most logs have never been labelled.
    if (args.labels !== undefined) {
      write(`Cannot read labels at ${labelsPath}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  const reports = scoreLoggedProbes(records, labels);

  if (args.json === true) {
    write(`${JSON.stringify({ log: logPath, records: records.length, reports }, null, 2)}\n`);
    return 0;
  }

  write(formatLoggedProbes(reports, logPath));
  return 0;
}

export async function calibrate(args: CalibrateArgs, write: (s: string) => void): Promise<number> {
  if (args.fromLog !== undefined) return calibrateFromLog(args, write);

  const root = pluginRoot() ?? process.cwd();
  const resolved = resolvePolicy(process.cwd(), root);

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

  const backend = args.backend ?? resolved.policy.backend;
  let adapter: Adapter;

  if (backend === "mock") {
    adapter = new MockAdapter();
  } else if (backend === "jev") {
    const key = apiKey();
    if (key === undefined) {
      write("Cannot calibrate against jev: set BOUNCER_TYPESAFE_API_KEY or TYPESAFE_API_KEY.\n");
      return 1;
    }
    adapter = new JevAdapter({ apiKey: key });
  } else {
    write(`Unknown backend "${backend}".\n`);
    return 1;
  }

  // Progress matters here: a live run is one network call per fixture and takes minutes.
  // It goes to stderr so `--json` output stays pipeable.
  const scored = await score(fixtures, resolved.policy, adapter, (done, total) => {
    if (!args.json) process.stderr.write(`\r  ${done}/${total} fixtures`);
  });
  if (!args.json) process.stderr.write("\r\x1b[K");

  const reports = report(scored, resolved.policy.calibration);

  if (args.json === true) {
    write(`${JSON.stringify({ backend, fixtures: fixtures.length, reports }, null, 2)}\n`);
    return 0;
  }

  write(formatReport(reports, backend, resolved.policy.calibration, scored));
  return 0;
}
