// Reading a Claude Code session transcript, for the one thing `bouncer stops` wants from it:
// what the user typed next.
//
// The transcript is Claude Code's file and its format is not a contract. Everything here is
// best-effort, and a line this does not understand is skipped. The shapes relied on were
// read off transcripts written by Claude Code 2.1.201: one JSON object per line, `type`
// `user` or `assistant`, an ISO `timestamp`, `isSidechain` on a subagent's lines, and a
// typed prompt as `message.content` holding a string (a tool result is a list instead).

import { readFileSync } from "node:fs";

export interface TypedPrompt {
  readonly ts: string;
  readonly text: string;
}

/** Every prompt a person typed in the session, oldest first. Empty if the file cannot be read. */
export function typedPrompts(path: string): TypedPrompt[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const prompts: TypedPrompt[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["type"] !== "user" || entry["isSidechain"] === true || entry["isMeta"] === true) continue;

    const ts = entry["timestamp"];
    const message = entry["message"];
    if (typeof ts !== "string" || !isRecord(message)) continue;

    const text = textOf(message["content"]);
    // A line beginning with a tag is the harness speaking in the user's turn: a command
    // wrapper, a system reminder, a task notification. Nobody typed it.
    if (text === undefined || text.length === 0 || text.startsWith("<") || text.startsWith("[")) continue;
    prompts.push({ ts, text });
  }
  return prompts;
}

/** The first prompt typed after `after`, an ISO timestamp. */
export function nextTypedPrompt(prompts: readonly TypedPrompt[], after: string): TypedPrompt | undefined {
  const t = Date.parse(after);
  if (Number.isNaN(t)) return undefined;
  return prompts.find((p) => Date.parse(p.ts) > t);
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return undefined;
  // A list holding a tool result is the tool answering, not the user.
  if (content.some((part) => isRecord(part) && part["type"] === "tool_result")) return undefined;
  return content
    .flatMap((part) => (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []))
    .join(" ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
