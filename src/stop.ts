// The stop consumer: when the agent stops, was it asking for a go-ahead it did not need?
//
// Pure. `src/hooks/stop.ts` reads the payload and writes the log; `src/commands/stops.ts`
// reads the log and the transcripts. What is here is what both agree on: the item a stop
// becomes, what a verdict on it means, and how the user's next prompt is read as a label.
//
// See docs/adr/015. The set only watches. Nothing in this file, or anything that calls it,
// tells Claude Code to continue.

import type { Verdict } from "./engine/types.js";
import type { Item } from "./engine/item.js";

export const STOP_SET = "stop";

/**
 * How much of the closing message is sent: its end.
 *
 * A request for a go-ahead is the last thing a message says, and the vendor's own guidance
 * is that accuracy falls as irrelevant state grows. A long report followed by "shall I
 * merge?" is judged on its last screenful, and `closing_message_cut` says the head is gone.
 * A size, like the item builder's own cap, and not a threshold on an answer.
 */
export const CLOSING_TAIL_CHARS = 6000;

export function stopItem(lastAssistantMessage: string): Item {
  const message = lastAssistantMessage.trim();
  const cut = message.length > CLOSING_TAIL_CHARS;
  return {
    closing_message: cut ? message.slice(message.length - CLOSING_TAIL_CHARS) : message,
    closing_message_cut: cut,
  };
}

/**
 * What a verdict on a stop means, in the words the log and the report use.
 *
 * The set's `allow` is "a go-ahead would have followed this"; everything else is "leave the
 * stop alone". Named here so that nothing downstream reads `allow` as permission: the hook
 * emits nothing whatever this returns.
 */
export type Would = "continue" | "leave";

export function wouldFor(verdict: Verdict): Would {
  return verdict === "allow" ? "continue" : "leave";
}

/**
 * Whether a typed prompt is a bare go-ahead: the label a stop is scored against.
 *
 * A heuristic over the user's own words, and the report says so. It is deliberately narrow.
 * "proceed with option 2" carries a choice the agent was waiting for, so it is not a
 * go-ahead the agent could have assumed; "proceed" and "merge it" are. Anything long is the
 * user saying something, whatever its first word.
 */
const GO_AHEAD =
  /^(?:ok(?:ay)?[,.]? +|yes[,.]? +|yep[,.]? +|sure[,.]? +|great[,.]? +)?(?:y|yes|yep|yeah|ok|okay|sure|go|go ahead|go for it|proceed|continue|carry on|keep going|do it|do that|do both|do all of (?:it|them|that)|ship it|merge(?: it| them| both| the prs?| that)?|push(?: it)?|commit(?: it)?|run it|sounds good|lgtm|approved?|please do|yes please)(?: please| now| then)?[.! ]*$/i;

export function isGoAhead(prompt: string): boolean {
  return GO_AHEAD.test(prompt.trim());
}

/** One stop from the log, reduced to what the comparison needs. */
export interface ScoredStop {
  readonly would: Would;
  /** The question whose rule decided, or `default` / `uncertain`. */
  readonly decidedBy: string;
  /** `go-ahead`, `other`, or `none` when the session has no later typed prompt. */
  readonly next: "go-ahead" | "other" | "none";
}

export interface StopScore {
  readonly judged: number;
  /** Stops with a later prompt to score against. */
  readonly labelled: number;
  /** Would continue, and the user typed a go-ahead: a prompt that need not have been typed. */
  readonly saved: number;
  /** Would continue, and the user said something else: the hook would have run ahead. */
  readonly ranAhead: number;
  /** Left alone, and the user typed a go-ahead: by the question that held it. */
  readonly missed: Readonly<Record<string, number>>;
  /** Left alone, and the user said something else. */
  readonly rightlyLeft: number;
  readonly unlabelled: number;
}

export function scoreStops(stops: readonly ScoredStop[]): StopScore {
  const missed: Record<string, number> = {};
  let saved = 0;
  let ranAhead = 0;
  let rightlyLeft = 0;
  let unlabelled = 0;

  for (const stop of stops) {
    if (stop.next === "none") unlabelled += 1;
    else if (stop.would === "continue") {
      if (stop.next === "go-ahead") saved += 1;
      else ranAhead += 1;
    } else if (stop.next === "go-ahead") missed[stop.decidedBy] = (missed[stop.decidedBy] ?? 0) + 1;
    else rightlyLeft += 1;
  }

  return {
    judged: stops.length,
    labelled: stops.length - unlabelled,
    saved,
    ranAhead,
    missed,
    rightlyLeft,
    unlabelled,
  };
}
