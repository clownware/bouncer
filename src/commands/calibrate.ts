// `bouncer calibrate` — run the fixtures through a backend and print the reliability table.
//
// Manual and local by design. The live pass needs a real API key, which no automated
// thread ever has; CI runs the same code against the mock adapter so the harness itself
// stays tested.
//
//   bouncer calibrate [--fixtures path] [--backend jev|mock] [--json]

import { join } from "node:path";
import { JevAdapter } from "../adapters/jev.js";
import { MockAdapter } from "../adapters/mock.js";
import type { Adapter } from "../adapters/types.js";
import { formatReport, loadFixtures, report, score } from "../calibrate.js";
import { apiKey, errorsIn, pluginRoot, resolvePolicy } from "../io/config.js";

export interface CalibrateArgs {
  readonly fixtures?: string;
  readonly backend?: string;
  readonly json?: boolean;
}

export function parseArgs(argv: readonly string[]): CalibrateArgs {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    ...(value("fixtures") !== undefined ? { fixtures: value("fixtures") as string } : {}),
    ...(value("backend") !== undefined ? { backend: value("backend") as string } : {}),
    json: argv.includes("--json"),
  };
}

export async function calibrate(args: CalibrateArgs, write: (s: string) => void): Promise<number> {
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

  write(formatReport(reports, backend, resolved.policy.calibration));
  return 0;
}
