// The generic item state builder: the second implementation of `StateBuilder`.
//
// `toolCallState` describes an *action* and deliberately keeps the content out — a Write's
// bytes become a byte count, because the bytes are not what the gate is judging. Here the
// content is the whole subject. Scoring a draft against a policy without sending the draft
// is not a stricter version of the feature, it is a different and useless one. See
// docs/adr/009 decision 4 for why that is not a reversal of PRD §9: the gate runs on every
// tool call over content the user never chose to send, and `bouncer judge` is a command
// the user points at a file.
//
// What that buys is an obligation. Every string still goes through `redact()`, so a
// credential pasted into a batch does not leave the machine even when the batch does, and
// an oversized item is visibly truncated rather than quietly half-judged.
//
// The item's own field names are the state's field names. That is the point: TypeSafe's
// guidance is to give each part of the state a descriptive name, and a question then refers
// to one by backticked path (`title`, `body.summary`) in its own instructions. A flat blob
// would force every question to re-describe where to look.

import { redact } from "./redact.js";
import type { BuiltState, StateBuilder } from "./types.js";

/**
 * Hard cap on a judged item's serialized state.
 *
 * Four times the gate's cap and still far under Jev's own limit of 32k tokens for state
 * plus the longest question. The gate's 4 KB is a latency budget on a hook that runs
 * hundreds of times a session; a batch command is not on anyone's keystroke path, so the
 * cap here exists to keep one runaway item from spending the request's whole budget rather
 * than to save milliseconds.
 */
export const MAX_ITEM_STATE_BYTES = 16 * 1024;

/** Per-field cap applied first, so one huge field is cut before the whole state is. */
const FIELD_LIMIT = 4096;

/** An item is whatever the user's JSONL line or file contains. */
export type Item = Readonly<Record<string, unknown>>;

export const itemState: StateBuilder<Item> = {
  kind: "item",
  build: buildItemState,
};

export function buildItemState(item: Item): BuiltState {
  const kinds = new Set<string>();

  const cleaned = cleanValue(item, kinds, 0);
  const state = isRecord(cleaned) ? cleaned : { value: cleaned };

  let text = JSON.stringify(state);
  let truncated = false;

  if (Buffer.byteLength(text, "utf8") > MAX_ITEM_STATE_BYTES) {
    truncated = true;
    text = JSON.stringify(capStrings(state, FIELD_LIMIT));

    if (Buffer.byteLength(text, "utf8") > MAX_ITEM_STATE_BYTES) {
      // Say so in the text. A classifier reasoning about a document it cannot see the end
      // of should at least know that is what it is doing.
      text = `${text.slice(0, MAX_ITEM_STATE_BYTES - 32)}\n… [truncated]`;
    }
  }

  return { text, redactedKinds: [...kinds], truncated };
}

/**
 * Depth-limited copy with every string redacted.
 *
 * The depth limit is not a size guard — that is the byte cap — it is a guard against a
 * cyclic or pathologically nested item taking the process down. A batch is user data, and
 * this is the only place in the engine that walks an arbitrary object.
 */
const MAX_DEPTH = 8;

function cleanValue(value: unknown, kinds: Set<string>, depth: number): unknown {
  if (typeof value === "string") {
    const { text, kinds: found } = redact(value);
    for (const k of found) kinds.add(k);
    return text;
  }

  if (depth >= MAX_DEPTH) return "… [too deeply nested]";

  if (Array.isArray(value)) {
    return value.map((entry) => cleanValue(entry, kinds, depth + 1));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cleanValue(entry, kinds, depth + 1)]),
    );
  }

  return value;
}

function capStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}… [truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => capStrings(entry, limit));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, capStrings(entry, limit)]));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
