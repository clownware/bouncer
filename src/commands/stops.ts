// `bouncer stops` — what the Stop hook has seen, against what you typed next.
//
//   bouncer stops [--json]
//
// The Stop hook only watches (docs/adr/015). This is where watching becomes a number: each
// logged stop is paired with the next prompt typed in the same session, and the prompt is
// the label. A bare go-ahead after a stop the set called a go-ahead is a prompt that need
// not have been typed. Anything else after one is the hook running ahead of you, which is
// the number that decides whether it is ever allowed to do more than watch.
//
// Reads two things and sends nothing: `stops.jsonl` in the data directory, and the session
// transcripts those lines point at.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STOPS_FILE, type StopRecord } from "../hooks/stop.js";
import { dataDir, pluginRoot } from "../io/config.js";
import { nextTypedPrompt, typedPrompts, type TypedPrompt } from "../io/transcript.js";
import { isGoAhead, scoreStops, type ScoredStop, type StopScore } from "../stop.js";
import { parseFlags } from "./args.js";

export interface StopsArgs {
  readonly json?: boolean;
  readonly error?: string;
}

const FLAGS = { values: [], switches: ["json"] } as const;

export function parseArgs(argv: readonly string[]): StopsArgs {
  const { switches, error } = parseFlags(argv, FLAGS);
  return { json: switches.has("json"), ...(error !== undefined ? { error } : {}) };
}

export function readStops(dir: string): StopRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, STOPS_FILE), "utf8");
  } catch {
    return [];
  }
  const records: StopRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as StopRecord);
    } catch {
      // A torn line is one stop not counted.
    }
  }
  return records;
}

export interface StopsReport extends StopScore {
  readonly file: string;
  /** The shipped stop policy, to copy from. Absent when the plugin's directory is not known. */
  readonly template?: string;
  readonly lines: number;
  readonly skipped: number;
  readonly failed: number;
  /** Mock-backend lines, set aside for the reason `status` sets them aside. */
  readonly mock: number;
}

export function reportStops(dir: string, promptsFor: (path: string) => readonly TypedPrompt[] = typedPrompts): StopsReport {
  const all = readStops(dir);
  const real = all.filter((r) => r.backend !== "mock");

  const cache = new Map<string, readonly TypedPrompt[]>();
  const prompts = (path: string): readonly TypedPrompt[] => {
    let found = cache.get(path);
    if (found === undefined) {
      found = promptsFor(path);
      cache.set(path, found);
    }
    return found;
  };

  const scored: ScoredStop[] = [];
  for (const r of real) {
    if (r.would === undefined) continue;
    const next = r.transcript_path === undefined ? undefined : nextTypedPrompt(prompts(r.transcript_path), r.ts);
    scored.push({
      would: r.would,
      decidedBy: r.decided_by ?? "default",
      next: next === undefined ? "none" : isGoAhead(next.text) ? "go-ahead" : "other",
    });
  }

  const root = pluginRoot();
  return {
    file: join(dir, STOPS_FILE),
    ...(root !== undefined ? { template: join(root, "policy", "stop.yaml") } : {}),
    lines: all.length,
    skipped: real.filter((r) => r.skipped !== undefined).length,
    failed: real.filter((r) => r.error !== undefined).length,
    mock: all.length - real.length,
    ...scoreStops(scored),
  };
}

export function formatStops(report: StopsReport): string {
  const lines = [`Stops: ${report.file}`, ""];

  if (report.lines === 0) {
    lines.push(
      "Nothing logged. The Stop hook is off until a stop policy exists. It sends the end of the",
      "agent's closing message to the backend, which is why it does not turn itself on.",
      "",
      "For every project on this machine:",
      `  cp "${report.template ?? "policy/stop.yaml"}" ~/.bouncer/stop.yaml`,
      "For one repository, from its root:",
      `  cp "${report.template ?? "policy/stop.yaml"}" .bouncer.stop.yaml`,
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(`  ${report.judged} judged, ${report.labelled} with a later prompt to score against`);
  if (report.skipped > 0) lines.push(`  ${report.skipped} not judged: a task was still running, so the agent was not waiting on you`);
  if (report.failed > 0) lines.push(`  ${report.failed} not judged: the backend did not answer`);
  if (report.mock > 0) lines.push(`  ${report.mock} answered by the mock backend and set aside`);
  lines.push("");

  const missed = Object.entries(report.missed).sort((a, b) => b[1] - a[1]);
  const missedTotal = missed.reduce((sum, [, n]) => sum + n, 0);

  lines.push(
    "                        you typed a go-ahead   you said something else",
    `  would have continued  ${String(report.saved).padStart(20)}   ${String(report.ranAhead).padStart(23)}`,
    `  left alone            ${String(missedTotal).padStart(20)}   ${String(report.rightlyLeft).padStart(23)}`,
    "",
    `  ${report.saved} prompt${report.saved === 1 ? "" : "s"} you would not have had to type.`,
    `  ${report.ranAhead} time${report.ranAhead === 1 ? "" : "s"} it would have run ahead of you. This is the number that matters.`,
  );
  if (missed.length > 0) {
    lines.push(`  Go-aheads it left alone, by the question that held them: ${missed.map(([q, n]) => `${q} ${n}`).join(", ")}.`);
  }
  if (report.unlabelled > 0) {
    lines.push(`  ${report.unlabelled} stop${report.unlabelled === 1 ? " has" : "s have"} no later prompt in the session and ${report.unlabelled === 1 ? "is" : "are"} not scored.`);
  }
  lines.push(
    "",
    "A go-ahead is read off your own words by a fixed pattern (proceed, merge it, go ahead, yes),",
    "so this is agreement with a heuristic label. Nothing here changed what any session did.",
  );
  return `${lines.join("\n")}\n`;
}

export function stops(args: StopsArgs): string {
  if (args.error !== undefined) return args.error;
  const report = reportStops(dataDir());
  return args.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatStops(report);
}
