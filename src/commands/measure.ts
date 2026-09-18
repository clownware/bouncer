// `bouncer measure` — judge, reasoning model, and the cascade, side by side.
//
//   bouncer measure <labelled-fixtures> [--set name] [--backend jev|local|mock]
//                   [--reasoning "<command>"] [--concurrency n] [--json]
//
// The reasoning command is whatever you already use to call a frontier model; it is not an
// API client bouncer ships. It reads one JSON object on stdin and writes one on stdout, and
// `src/io/reasoning.ts` documents the two shapes. `$BOUNCER_REASONING_CMD` is read when
// `--reasoning` is not given, so a recipe can live in a shell profile.
//
// A worked invocation is in the README. The point of the command form is that the claim
// being measured is about a class of model, so hardcoding one vendor's client would
// undercut the thing it is measuring — docs/adr/009 decision 6.

import { JevAdapter } from "../adapters/jev.js";
import { LocalAdapter } from "../adapters/local.js";
import { MockAdapter } from "../adapters/mock.js";
import { AdapterError, type Adapter } from "../adapters/types.js";
import { loadFixtures } from "../calibrate.js";
import { GATE_SET } from "../engine/types.js";
import { formatMeasurement, measure as runMeasure } from "../measure.js";
import { apiKey, errorsIn, localBackend, pluginRoot, resolvePolicy } from "../io/config.js";
import { CommandReasoning, REASONING_CMD_ENV } from "../io/reasoning.js";

export interface MeasureArgs {
  readonly fixtures?: string;
  readonly set?: string;
  readonly backend?: string;
  readonly reasoning?: string;
  readonly concurrency?: number;
  readonly json?: boolean;
}

const VALUE_FLAGS = ["set", "backend", "reasoning", "concurrency", "fixtures"] as const;

export function parseArgs(argv: readonly string[]): MeasureArgs {
  const values = new Map<string, string>();
  let positional: string | undefined;

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
    positional ??= token;
  }

  const fixtures = values.get("fixtures") ?? positional;
  const concurrency = Number(values.get("concurrency"));

  return {
    ...(fixtures !== undefined ? { fixtures } : {}),
    ...(values.has("set") ? { set: values.get("set") as string } : {}),
    ...(values.has("backend") ? { backend: values.get("backend") as string } : {}),
    ...(values.has("reasoning") ? { reasoning: values.get("reasoning") as string } : {}),
    ...(Number.isFinite(concurrency) && concurrency > 0 ? { concurrency } : {}),
    json: argv.includes("--json"),
  };
}

export async function measure(args: MeasureArgs, write: (s: string) => void): Promise<number> {
  if (args.fixtures === undefined) {
    write('Usage: bouncer measure <labelled-fixtures> [--set name] [--reasoning "<command>"]\n');
    return 1;
  }

  const command = args.reasoning ?? process.env[REASONING_CMD_ENV];
  if (command === undefined || command.trim().length === 0) {
    // Named rather than defaulted: there is no reasonable guess at which reasoning model
    // someone wants billed, and a wrong guess spends their money.
    write(
      `Cannot measure without a reasoning model to compare against.\n` +
        `  Pass --reasoning "<command>" or set ${REASONING_CMD_ENV}.\n` +
        `  The command reads one JSON object on stdin and writes one on stdout;\n` +
        `  the README has a worked example.\n`,
    );
    return 1;
  }

  const root = pluginRoot() ?? process.cwd();
  const resolved = resolvePolicy(process.cwd(), root);

  if (resolved.policy === undefined) {
    write(`Cannot measure: ${resolved.source} did not load.\n`);
    for (const d of errorsIn(resolved.diagnostics)) write(`  ${d.path || "(top level)"}: ${d.message}\n`);
    return 1;
  }

  const setName = args.set ?? GATE_SET;
  const set = resolved.policy.sets[setName];
  if (set === undefined) {
    write(`${resolved.source} defines no set named "${setName}". It has: ${Object.keys(resolved.policy.sets).join(", ")}.\n`);
    return 1;
  }

  let fixtures;
  try {
    fixtures = loadFixtures(args.fixtures);
  } catch (err) {
    write(`Cannot read fixtures at ${args.fixtures}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (fixtures.length === 0) {
    write(`${args.fixtures} has no fixtures, so there is nothing to measure.\n`);
    return 1;
  }

  const backend = args.backend ?? resolved.policy.backend;
  const adapter = adapterFor(backend);
  if (typeof adapter === "string") {
    write(`${adapter}\n`);
    return 1;
  }

  const problem = await startIfNeeded(adapter);
  if (problem !== undefined) {
    write(`Cannot measure with ${adapter.name}: ${problem}\n`);
    return 1;
  }

  const measurement = await runMeasure(fixtures, {
    setName,
    set,
    mode: resolved.policy.mode,
    adapter,
    reasoning: new CommandReasoning(command),
    timeoutMs: Math.max(resolved.policy.timeoutMs, 30_000),
    ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
    onProgress: (phase, done, total) => {
      // A reasoning pass is one frontier-model call per item and takes minutes. Without
      // this the command looks hung for the length of the run.
      if (!args.json) process.stderr.write(`\r  ${phase}: ${done}/${total}          `);
    },
  });
  if (!args.json) process.stderr.write("\r\x1b[K");

  if (args.json === true) {
    write(`${JSON.stringify(measurement, null, 2)}\n`);
    return 0;
  }

  write(formatMeasurement(measurement));

  // Every reasoning call failing means the command is wrong, not that the model is bad, and
  // the table above would read as a result rather than as a broken run.
  return measurement.reasoningFailures === measurement.fixtures ? 1 : 0;
}

/** An adapter, or the sentence to print instead of one. */
function adapterFor(backend: string): Adapter | string {
  if (backend === "mock") return new MockAdapter();
  if (backend === "local") return new LocalAdapter(localBackend());

  if (backend === "jev") {
    const key = apiKey();
    if (key === undefined) {
      return "Cannot measure with jev: set BOUNCER_TYPESAFE_API_KEY or TYPESAFE_API_KEY.";
    }
    return new JevAdapter({ apiKey: key });
  }

  return `Unknown backend "${backend}".`;
}

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
