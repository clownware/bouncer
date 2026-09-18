// The decision log: append-only JSONL, one line per gated tool call.
//
// This is the only record of what bouncer did. `/bouncer:explain` reads it, the
// calibration harness replays it, and it is what a user looks at when they want to know
// why something got prompted. So it stores enough to answer those questions and nothing
// that would make the file itself a liability.
//
// Contrary to PRD §9, the redacted state IS stored rather than only its hash. A hash
// cannot answer "why did that get blocked", cannot seed fixtures from real history, and
// cannot be re-scored when a policy changes — which are the three things the log exists
// for. The state is already redacted before it reaches here, and there is a second
// redaction pass on write as a backstop.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../engine/redact.js";
import type { Reason } from "../engine/evaluate.js";
import type { Verdict } from "../engine/types.js";

export const LOG_FILE = "decisions.jsonl";

/**
 * When the log passes this size it is renamed to `decisions.jsonl.1`, replacing the
 * previous generation, and a fresh file is started. One line is a few hundred bytes, so
 * this is on the order of ten thousand gated calls, and at most two generations exist.
 * Without a cap the file grows for as long as the plugin is installed.
 */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * A probe answer as it appears in the log.
 *
 * `source` is on every entry rather than implied by the key it sits under, so a line read
 * on its own — by a script, by a future reader, by a question that has since been promoted
 * out of `probe_questions` and into `questions` — says which answers could have moved the
 * verdict and which could not. That distinction is the whole point of the record.
 *
 * Not the record's own `source` above, which says what produced the verdict. This one says
 * what the answer was for. A record reading `source: "judge"` with probe entries reading
 * `source: "probe"` is the ordinary case: the judge decided, and these rode along.
 */
export interface ProbeAnswer {
  readonly p: number;
  readonly source: "probe";
}

export interface DecisionRecord {
  readonly ts: string;
  readonly session_id?: string;
  readonly tool_use_id?: string;
  readonly tool: string;
  readonly permission_mode?: string;
  readonly agent_type?: string;
  readonly mode: string;
  readonly backend: string;
  /** What policy concluded. */
  readonly verdict: Verdict;
  /** What was actually put on stdout; null when nothing was emitted. */
  readonly emitted: Verdict | null;
  readonly reason: Reason;
  /**
   * Which layer decided: a deterministic entry in `gate.hard_rules`, an entry in
   * `gate.fast_path`, or the classifier and `gate.rules`. See docs/adr/004.
   *
   * Redundant with `reason.kind` and written anyway, because this is the field a query
   * over the log actually wants: "what did the judge decide" has to exclude the lines the
   * judge never saw, and `answers` being absent is true of error lines too.
   */
  readonly source?: "hard_rule" | "fast_path" | "judge";
  /** Raw probability per question. The thing calibration is computed from. */
  readonly answers?: Readonly<Record<string, number>>;
  /**
   * Answers to `gate.probe_questions`, which no rule read and which changed nothing about
   * `verdict`. Absent when the policy defines no probes.
   */
  readonly probes?: Readonly<Record<string, ProbeAnswer>>;
  readonly state?: string;
  readonly redacted_kinds?: readonly string[];
  readonly latency_ms: { readonly total: number; readonly adapter?: number };
  readonly error?: { readonly kind: string; readonly message: string };
  /** True for the first gated call of a session — excluded from the latency breaker. */
  readonly warmup?: boolean;
}

/**
 * Appends a record. Never throws.
 *
 * A logging failure must not affect the verdict. By the time this runs the decision is
 * already made, and a full disk is not a reason to change what Claude Code is told.
 */
export function append(dir: string, record: DecisionRecord): void {
  try {
    mkdirSync(dir, { recursive: true });

    const safe: DecisionRecord =
      record.state !== undefined ? { ...record, state: redact(record.state).text } : record;

    const file = join(dir, LOG_FILE);
    rotateIfOversized(file);
    appendFileSync(file, `${JSON.stringify(safe)}\n`, "utf8");
  } catch {
    // Intentionally silent. stderr from a hook is noise in the user's transcript, and
    // there is nothing they can usefully do about it mid-run.
  }
}

/** Checked before every append. A missing file is size zero, so this is a no-op on the first write. */
function rotateIfOversized(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;
  renameSync(file, `${file}.1`);
}

/**
 * Parses a whole log, oldest first, skipping lines that do not parse.
 *
 * Separate from `tail` because calibration wants every record in order rather than the
 * last N newest-first, and because it takes the text: a log named on the command line is
 * not necessarily the one in the data directory.
 */
export function parseLog(source: string): DecisionRecord[] {
  const records: DecisionRecord[] = [];

  for (const line of source.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // A truncated final line is expected if a write was interrupted. Skip it.
    }
  }

  return records;
}

/** Reads the most recent records, newest first. Returns [] if the log is unreadable. */
export function tail(dir: string, count: number): DecisionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, LOG_FILE), "utf8");
  } catch {
    return [];
  }

  const records: DecisionRecord[] = [];
  const lines = raw.split("\n");

  for (let i = lines.length - 1; i >= 0 && records.length < count; i--) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // A truncated final line is expected if a write was interrupted. Skip it.
    }
  }

  return records;
}
