// `bouncer export` — turn the decision log into candidate fixtures.
//
//   bouncer export [--from <decisions.jsonl>] [--out <candidates.jsonl>] [--fixtures <known.jsonl>]
//
// With no `--from` it reads the log the hook writes, through `dataDir()`, both generations:
// `decisions.jsonl.1` first because it is the older, then `decisions.jsonl`. Run from a
// checkout rather than an installed plugin, `dataDir()` falls back to `~/.bouncer`, so name
// the plugin's log with `--from` (`bouncer status` prints its path).
//
// With no `--out` the candidates go to stdout and the counts to stderr, so the output pipes.
// `--out` refuses a file that exists: the file this writes is the one someone then spends an
// afternoon labelling, and a second export over it would erase the afternoon. It also
// refuses anywhere under `test/holdout/`, which is frozen and is not this command's to seed.
//
// `--fixtures` names the fixtures already written, `fixtures/gate.jsonl` by default, and a
// call that builds the same action as one of them is not exported again.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadFixtures, type Fixture } from "../calibrate.js";
import { HEADER, candidateLine, exportCandidates, type ExportResult } from "../export.js";
import { dataDir, pluginRoot, resolvePolicy } from "../io/config.js";
import { LOG_FILE, parseLog } from "../io/log.js";
import { parseFlags } from "./args.js";

export interface ExportArgs {
  readonly from?: string;
  readonly out?: string;
  readonly fixtures?: string;
  readonly error?: string;
}

const FLAGS = { values: ["from", "out", "fixtures"], switches: [] } as const;

export function parseArgs(argv: readonly string[]): ExportArgs {
  const { values, error } = parseFlags(argv, FLAGS);
  return {
    ...(values.get("from") !== undefined ? { from: values.get("from") as string } : {}),
    ...(values.get("out") !== undefined ? { out: values.get("out") as string } : {}),
    ...(values.get("fixtures") !== undefined ? { fixtures: values.get("fixtures") as string } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export function exportFixtures(args: ExportArgs, write: (s: string) => void, report: (s: string) => void): number {
  if (args.error !== undefined) {
    write(args.error);
    return 1;
  }

  if (args.out !== undefined) {
    const out = resolve(args.out);
    if (`${out}${sep}`.includes(`${sep}test${sep}holdout${sep}`)) {
      write(`Refusing to write under test/holdout: that corpus is frozen, and a case is added by hand.\n`);
      return 1;
    }
    if (existsSync(out)) {
      write(`Refusing to overwrite ${args.out}: it may already hold labels. Name a new file.\n`);
      return 1;
    }
  }

  const sources = args.from !== undefined ? [args.from] : [`${join(dataDir(), LOG_FILE)}.1`, join(dataDir(), LOG_FILE)];
  const present = sources.filter((path) => args.from !== undefined || existsSync(path));
  if (present.length === 0) {
    write(`No decision log at ${join(dataDir(), LOG_FILE)}. Name one with --from; bouncer status prints where the hook writes.\n`);
    return 1;
  }

  let text = "";
  for (const path of present) {
    try {
      text += `${readFileSync(path, "utf8")}\n`;
    } catch (err) {
      write(`Cannot read the log at ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  const root = pluginRoot() ?? process.cwd();
  const knownPath = args.fixtures ?? join(root, "fixtures", "gate.jsonl");
  let known: Fixture[] = [];
  if (args.fixtures !== undefined || existsSync(knownPath)) {
    try {
      known = loadFixtures(knownPath);
    } catch (err) {
      write(`Cannot read fixtures at ${knownPath}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  // The same rule `status` applies, for the same reason: a mock verdict is a stand-in, and
  // `npm run bench` once left hundreds of them over one payload in a real log.
  const keepMock = resolvePolicy(process.cwd(), root).policy?.backend === "mock";

  const result = exportCandidates(parseLog(text), { keepMock, known });
  const file = `${HEADER}\n${result.candidates.map(candidateLine).join("\n")}${result.candidates.length > 0 ? "\n" : ""}`;

  if (args.out === undefined) {
    write(file);
    report(summary(result, present, known.length > 0 ? knownPath : undefined));
    return 0;
  }

  try {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, file, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    write(`Cannot write ${args.out}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  write(summary(result, present, known.length > 0 ? knownPath : undefined));
  write(`\nWritten to ${args.out}. Label a line, uncomment it, then: bouncer calibrate --fixtures ${args.out} --from <the log>\n`);
  return 0;
}

function summary(result: ExportResult, sources: readonly string[], knownPath: string | undefined): string {
  const s = result.skipped;
  const lines = [
    `Read ${result.read} lines from ${sources.join(" and ")}.`,
    `Exported ${result.candidates.length} candidate fixtures, all unlabelled.`,
  ];
  const left: Array<[number, string]> = [
    [s.duplicate, "repeated an earlier call's state (counted in its note)"],
    [s.known, `matched a fixture already in ${knownPath ?? "the known set"}`],
    [s.noState, "carried no state (fast path or error)"],
    [s.notGate, "were not gate lines"],
    [s.mock, "were answered by the mock backend"],
    [s.truncated, "were over the state cap, so the classifier saw only their head"],
    [s.noId, "had no tool_use_id to join the logged answers on"],
    [s.unrebuildable, "did not rebuild to the state the classifier was shown"],
  ];
  for (const [n, why] of left) if (n > 0) lines.push(`  ${n} ${why}.`);
  if (result.redactedOnExport > 0) {
    lines.push(
      `${result.redactedOnExport} held text the current redaction patterns catch and the logged line did not; ` +
        `it is redacted in the export, so those candidates differ from what the classifier was shown.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
