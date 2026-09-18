// `bouncer calibrate` — run the fixtures through a backend and print the reliability table.
//
// Manual and local by design. The live pass needs a real API key, which no automated
// thread ever has; CI runs the same code against the mock adapter so the harness itself
// stays tested.
//
//   bouncer calibrate [--fixtures path] [--backend jev|local|mock] [--compare a,b] [--json]
//
// `--compare` runs two backends over the same fixture set and prints them side by side.
// Both runs go through the same `score()`, so the comparison is of the backends and not of
// two code paths that happen to agree.

import { join } from "node:path";
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
  type Fixture,
  type Scored,
} from "../calibrate.js";
import type { Policy } from "../engine/types.js";
import { apiKey, errorsIn, localBackend, pluginRoot, resolvePolicy } from "../io/config.js";

export interface CalibrateArgs {
  readonly fixtures?: string;
  readonly backend?: string;
  /** One or two backend names. One means "against the backend already selected". */
  readonly compare?: string;
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
    ...(value("compare") !== undefined ? { compare: value("compare") as string } : {}),
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

  const primary = args.backend ?? resolved.policy.backend;
  const names = backendsFor(primary, args.compare);

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
  for (const [i, adapter] of adapters.entries()) {
    const label = names[i] as string;
    runs.push({ backend: label, scored: await run(fixtures, resolved.policy, adapter, label, names.length, args) });
  }

  const [first, second] = runs;
  if (first === undefined) {
    write("No backend to run.\n");
    return 1;
  }

  if (args.json === true) {
    const payload =
      second === undefined
        ? { backend: first.backend, fixtures: fixtures.length, reports: report(first.scored, resolved.policy.calibration) }
        : {
            backends: [first.backend, second.backend],
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

  for (const r of runs) {
    write(formatReport(report(r.scored, resolved.policy.calibration), r.backend, resolved.policy.calibration, r.scored));
    write("\n");
  }

  if (second !== undefined) {
    write(formatComparison(compare(first, second, resolved.policy.calibration), resolved.policy.calibration));
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
): Promise<Scored[]> {
  // Progress matters here: a live run is one network call per fixture and takes minutes.
  // It goes to stderr so `--json` output stays pipeable.
  const prefix = total > 1 ? `${label}: ` : "";
  const scored = await score(fixtures, policy, adapter, (done, n) => {
    if (!args.json) process.stderr.write(`\r  ${prefix}${done}/${n} fixtures`);
  });
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
