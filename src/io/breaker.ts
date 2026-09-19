// The circuit breaker.
//
// Bouncer failing must degrade to "no bouncer", never to "friction on every call". Two
// failure shapes get there:
//
//   - the adapter keeps erroring (bad key, no network, rate limited)
//   - the adapter keeps answering, but too slowly to be worth it
//
// Either one trips the breaker into observe mode for the rest of the session, with one
// visible message. State lives in a small JSON file so it survives across hook processes,
// which are separate invocations of the same binary.
//
// The first gated call of a session is recorded but never counted. ADR-003 asks for that,
// and the reason it gives did not survive real traffic: it measured 513 ms cold against
// 168-350 ms warm inside one process, but the hook is a process per call and never has a
// warm connection to be colder than. From an installed plugin the first call of a session
// is no slower than any other (docs/adr/003, corrected 2026-09-18).
//
// It stays because it cannot cost anything. Both limits count consecutive calls, five and
// twenty of them, so one uncounted call neither trips the breaker nor saves it — and a
// safety component is not where to delete a margin on the strength of two samples.
//
// The file holds several sessions, because the data directory is one per machine and not
// one per project: two Claude Code windows share it whatever repositories they are in.
// Until 2026-09-19 it held one record, which each session overwrote with its own. A session
// that found somebody else's record started fresh, and a fresh session's first call is the
// uncounted warm-up — so with two windows open every call was a warm-up, the count was
// written back as zero each time, and the breaker could not trip however long the
// classifier stayed down. The once-per-session notices were lost the same way.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./atomic.js";

export const BREAKER_FILE = "breaker.json";

/**
 * How many sessions the file remembers, most recent last.
 *
 * One file with a cap rather than a file per session: nothing sweeps the data directory,
 * so per-session files would be the first thing in it to grow without bound, and
 * `session_id` arrives on stdin, which is not something to build a filename from. Eight is
 * more windows than anyone has open; a session evicted by a ninth re-learns that the
 * classifier is down in five calls.
 */
export const MAX_SESSIONS = 8;

/** Consecutive adapter failures before giving up for the session. */
export const FAILURE_LIMIT = 5;
/** Consecutive over-budget calls before giving up for the session. */
export const SLOW_LIMIT = 20;

export interface BreakerState {
  readonly session_id: string;
  /** True once the session's first gated call has been seen. */
  readonly warmed: boolean;
  readonly consecutive_failures: number;
  readonly consecutive_slow: number;
  readonly tripped?: { readonly reason: "failures" | "latency"; readonly at: string };
  /** Notice keys already shown this session. See `shouldNotify`. */
  readonly notified?: readonly string[];
}

export interface BreakerDecision {
  /** True when the adapter should not be called at all. */
  readonly tripped: boolean;
  /** A one-off message to surface, the first time it trips. */
  readonly message?: string;
  /** True when this is the session's first gated call. */
  readonly warmup: boolean;
}

const FRESH = (sessionId: string): BreakerState => ({
  session_id: sessionId,
  warmed: false,
  consecutive_failures: 0,
  consecutive_slow: 0,
});

/** Every session the file remembers, oldest first. Empty when there is no usable file. */
export function readAll(dir: string): BreakerState[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, BREAKER_FILE), "utf8"));
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const sessions = (parsed as Record<string, unknown>)["sessions"];
  if (Array.isArray(sessions)) return sessions.filter(isState);
  // The single record an older build wrote. It is one session's state and reads as that.
  return isState(parsed) ? [parsed] : [];
}

export function read(dir: string, sessionId: string): BreakerState {
  // A session the file has not seen starts clean: a bad key yesterday says nothing about today.
  return readAll(dir).find((s) => s.session_id === sessionId) ?? FRESH(sessionId);
}

export function write(dir: string, state: BreakerState): void {
  // Read, replace this session's record, write back. Two hooks finishing together can each
  // read the file before the other writes, and one update is then lost — which delays a trip
  // by a call and resets nobody, so it is not worth a lock in a process that lives 40 ms.
  const others = readAll(dir).filter((s) => s.session_id !== state.session_id);
  const sessions = [...others, state].slice(-MAX_SESSIONS);
  // A failed write is ignored: losing breaker state means at worst re-learning that the
  // adapter is down.
  writeAtomic(join(dir, BREAKER_FILE), JSON.stringify({ sessions }));
}

function isState(value: unknown): value is BreakerState {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["session_id"] === "string";
}

/**
 * Whether a one-off notice has already been shown this session.
 *
 * A `systemMessage` lands in the user's transcript, so anything emitted per tool call is
 * spam by the fiftieth Bash. Persistent conditions — a broken policy file, a missing API
 * key — are true on every call and need saying exactly once.
 */
export function shouldNotify(state: BreakerState, key: string): boolean {
  return !(state.notified ?? []).includes(key);
}

export function markNotified(state: BreakerState, key: string): BreakerState {
  return { ...state, notified: [...(state.notified ?? []), key] };
}

export function check(state: BreakerState): BreakerDecision {
  if (state.tripped !== undefined) {
    return { tripped: true, warmup: false };
  }
  return { tripped: false, warmup: !state.warmed };
}

/** Folds a call's outcome into the state, returning the new state and any message. */
export function record(
  state: BreakerState,
  outcome: { readonly failed: boolean; readonly overBudget: boolean; readonly warmup: boolean },
): { readonly state: BreakerState; readonly message?: string } {
  // The warm-up call is observed so the session is marked warmed, but its outcome is not
  // counted toward either limit.
  if (outcome.warmup) {
    return { state: { ...state, warmed: true } };
  }

  const failures = outcome.failed ? state.consecutive_failures + 1 : 0;
  const slow = outcome.overBudget ? state.consecutive_slow + 1 : 0;
  const next: BreakerState = { ...state, warmed: true, consecutive_failures: failures, consecutive_slow: slow };

  if (failures >= FAILURE_LIMIT) {
    return {
      state: { ...next, tripped: { reason: "failures", at: new Date().toISOString() } },
      message: `bouncer: the classifier failed ${failures} times in a row, so it is standing down for this session. Claude Code's normal permission prompts are unaffected. Run /bouncer:status for the last error.`,
    };
  }

  if (slow >= SLOW_LIMIT) {
    return {
      state: { ...next, tripped: { reason: "latency", at: new Date().toISOString() } },
      message: `bouncer: the classifier has been over budget for ${slow} calls in a row, so it is standing down for this session rather than keep slowing you down. Run /bouncer:status for the numbers.`,
    };
  }

  return { state: next };
}
