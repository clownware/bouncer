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
import type { EscalationItem } from "../engine/escalation.js";
import type { Reason } from "../engine/evaluate.js";
import type { Verdict } from "../engine/types.js";

export const LOG_FILE = "decisions.jsonl";

/** Where `bouncer judge` writes. Same line shape, different consumer — see docs/adr/009. */
export const JUDGMENTS_FILE = "judgments.jsonl";

/**
 * When the log passes this size it is renamed to `decisions.jsonl.1`, replacing the
 * previous generation, and a fresh file is started. One line is a few hundred bytes, so
 * this is on the order of ten thousand gated calls, and at most two generations exist.
 * Without a cap the file grows for as long as the plugin is installed.
 */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

export interface DecisionRecord {
  readonly ts: string;
  /**
   * Which entrypoint wrote the line: the PreToolUse gate, or the batch judge.
   *
   * Absent on every line written before v0.3, all of which are the gate's. Deliberately
   * NOT folded into `source` below, which already means *which layer decided* and whose
   * `judge` value means the classifier: overloading it would silently reclassify every
   * line already on disk and break the one query that field exists for. See docs/adr/009.
   */
  readonly consumer?: "gate" | "judge";
  /** The policy set the item was judged against. Absent means `gate`. */
  readonly set?: string;
  /** The item's key, for a judge line: its own id, its path, or `file:line`. */
  readonly item?: string;
  /** The `StateBuilder` that produced `state`: `tool_call` or `item`. */
  readonly state_kind?: string;
  readonly session_id?: string;
  readonly tool_use_id?: string;
  /**
   * Absent on a judge line, because an item is not a tool call. Every reader treats an
   * absent `tool` as an item line rather than as a malformed one.
   */
  readonly tool?: string;
  readonly permission_mode?: string;
  readonly agent_type?: string;
  readonly mode: string;
  readonly backend: string;
  /**
   * The model that answered, as the backend reported it — `jev-1.13.0`, not the
   * `jev-latest` that was asked for. An alias moves; a threshold tuned against one version
   * and re-scored against answers from another is a comparison nobody meant to make.
   * Absent when no model answered, or when the backend does not say.
   */
  readonly model?: string;
  /**
   * Which policy was installed: `file` is the policy file's fingerprint and `questions` is
   * the set's. `calibrate --from` reads the second to tell whether these answers are to the
   * questions it is about to score them against. See `PolicySet.questionsFingerprint`.
   */
  readonly policy?: { readonly file: string; readonly questions: string };
  /**
   * What policy concluded — absent when it concluded nothing: the classifier could not
   * answer, or a batch item was too long to show it whole. Those lines used to say `allow`,
   * which is what a reader of this one field takes for "accepted". Lines written before
   * 2026-09-19 still do, so a reader tallying verdicts leaves out any line with an `error`.
   */
  readonly verdict?: Verdict;
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
   *
   * Shaped exactly like `answers` — a bare probability per question name — because the two
   * differ in what was allowed to read them, not in what was measured. Which key an answer
   * sits under is what says that, and it stays true for a line read years later: an answer
   * recorded here could not have moved the verdict on this call, whatever the policy does
   * with that question now.
   */
  readonly probes?: Readonly<Record<string, number>>;
  /**
   * What the judge could not settle: every threshold this item crossed, at what `p`.
   * Absent unless the classifier produced a verdict other than `allow`. See docs/adr/008.
   *
   * The item carries no `state` of its own — this record's `state` field is the same
   * string, and writing it twice would double the largest field in the log.
   */
  readonly escalation?: EscalationItem;
  readonly state?: string;
  readonly redacted_kinds?: readonly string[];
  /** True when `state` was over its cap, so the answers are about the head of it. */
  readonly truncated?: boolean;
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
export function append(dir: string, record: DecisionRecord, name: string = LOG_FILE): void {
  try {
    mkdirSync(dir, { recursive: true });

    const safe: DecisionRecord =
      record.state !== undefined ? { ...record, state: redactState(record.state) } : record;

    const file = join(dir, name);
    rotateIfOversized(file);
    appendFileSync(file, `${JSON.stringify(safe)}\n`, "utf8");
  } catch {
    // Intentionally silent. stderr from a hook is noise in the user's transcript, and
    // there is nothing they can usefully do about it mid-run.
  }
}

/** Checked before every append. A missing file is size zero, so this is a no-op on the first write. */
/**
 * The second redaction pass, over a state that is already serialised.
 *
 * The state builders redact each field as they build it; this is the belt to that pair of
 * braces, and it used to run the patterns straight over the JSON text. They are written for
 * raw text. `op://[^\s"']+` stops at a quote and not at the backslash escaping one, so on
 * `\"op://\"` it took the backslash, left the quote bare, and the line's `state` stopped
 * being JSON — found as one real line in 145 that `JSON.parse` refused. So the strings are
 * redacted where they are strings, and the JSON is written again around them.
 *
 * A state with nothing to redact comes back byte for byte: `JSON.stringify` of a parsed
 * `JSON.stringify` keeps key order and number spelling. One that is not JSON is redacted as
 * the text it is.
 */
function redactState(state: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return redact(state).text;
  }
  return JSON.stringify(redactStrings(parsed));
}

function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redact(value).text;
  if (Array.isArray(value)) return value.map(redactStrings);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v)]));
  }
  return value;
}

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
export function tail(dir: string, count: number, name: string = LOG_FILE): DecisionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, name), "utf8");
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
