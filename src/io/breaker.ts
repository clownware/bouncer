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
// The first gated call of a session is recorded but never counted. Measured against live
// Jev: 513 ms cold against 168-350 ms warm, which is connection setup rather than the
// model. A breaker counting the warm-up would trip on a perfectly healthy setup.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BREAKER_FILE = "breaker.json";

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

export function read(dir: string, sessionId: string): BreakerState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, BREAKER_FILE), "utf8")) as BreakerState;
    // A new session starts clean: a bad key yesterday says nothing about today.
    if (parsed.session_id !== sessionId) return FRESH(sessionId);
    return parsed;
  } catch {
    return FRESH(sessionId);
  }
}

export function write(dir: string, state: BreakerState): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, BREAKER_FILE), JSON.stringify(state), "utf8");
  } catch {
    // Losing breaker state means at worst re-learning that the adapter is down.
  }
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
