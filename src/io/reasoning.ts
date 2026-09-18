// The reasoning pass: a command the user supplies, not an API client.
//
// `bouncer measure` needs a frontier model to compare the judgment model against, and the
// obvious implementation — a second HTTP client with a second key and a second vendor in
// the bundle — is the wrong one for four reasons, all in docs/adr/009 decision 6. Bouncer
// keeps zero runtime dependencies, never sees a second credential, works with whatever
// reasoning model the user already has a CLI for, and stays testable with no key anywhere.
//
// The protocol is one process per item, JSON in and JSON out:
//
//   stdin   { "item": "<id>", "state": <the redacted state, as JSON>,
//             "questions": { "<name>": { "instructions": "...", "criteria": {...} } },
//             "signals": [ { "question": "...", "p": 0.52, "criterion": ">=0.65",
//                            "asks": "..." } ] }
//   stdout  { "answers": { "<name>": true | false | 0.0-1.0 },
//             "input_tokens": 1840, "output_tokens": 210 }
//
// `signals` is present only on a cascade pass and is the escalation manifest's entry for
// that item: which thresholds the fast model crossed, at what probability, and the
// questions' own words. That is what makes the second pass a re-adjudication rather than a
// fresh classification — the expensive model is told what the cheap one was unsure about.
//
// Token counts are optional, and a backend that does not report them is reported as not
// reporting them rather than as zero. A measurement that quietly invents its denominator
// is worse than no measurement.

import { spawn } from "node:child_process";
import type { EscalationSignal } from "../engine/escalation.js";
import type { Question } from "../adapters/types.js";

export interface ReasoningRequest {
  readonly item: string;
  readonly state: string;
  readonly questions: Readonly<Record<string, Question>>;
  /** The manifest's signals for this item, on a cascade pass. Absent on a full pass. */
  readonly signals?: readonly EscalationSignal[];
}

export interface ReasoningResponse {
  /** Probability per question, 0 to 1. A boolean answer arrives here as 1 or 0. */
  readonly answers: Readonly<Record<string, number>>;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ReasoningBackend {
  readonly name: string;
  answer(request: ReasoningRequest): Promise<ReasoningResponse>;
}

/** Env var read when `--reasoning` is not given. */
export const REASONING_CMD_ENV = "BOUNCER_REASONING_CMD";

/** A command that takes too long on one item has hung; the run should say so, not stall. */
const DEFAULT_TIMEOUT_MS = 180_000;

export class CommandReasoning implements ReasoningBackend {
  readonly name: string;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.command = command;
    // The name is what the report prints, so it is the command the user actually ran. A
    // reader who cannot tell which model produced a row cannot use the row.
    this.name = command;
    this.timeoutMs = timeoutMs;
  }

  async answer(request: ReasoningRequest): Promise<ReasoningResponse> {
    const payload = JSON.stringify({
      item: request.item,
      state: request.state,
      questions: request.questions,
      ...(request.signals !== undefined ? { signals: request.signals } : {}),
    });

    const { stdout } = await this.spawn(payload);
    return parseResponse(stdout, request.item);
  }

  /**
   * Runs the command through a shell, because the whole point is that the user writes the
   * invocation. `claude -p "$(cat)" --output-format json | jq ...` is the shape this is
   * for, and it is not expressible as an argv array.
   *
   * The command comes from the user's own flag or environment, exactly like `$EDITOR`. It
   * is not attacker-influenced input, and bouncer runs nothing else anywhere.
   */
  private spawn(input: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`the reasoning command did not answer within ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          // The command's own stderr is the useful part of this message: it is where a
          // missing key or a rate limit will have said so.
          reject(new Error(`the reasoning command exited ${code}: ${stderr.trim().slice(0, 500)}`));
          return;
        }
        resolve({ stdout });
      });

      child.stdin.on("error", () => {
        // A command that exits before reading stdin (`--help`, a typo) closes the pipe.
        // The non-zero exit above is the message worth showing, not EPIPE.
      });
      child.stdin.end(input, "utf8");
    });
  }
}

/**
 * Reads the command's answer.
 *
 * Tolerant about the envelope and strict about the content: a CLI that prints a log line
 * before its JSON is normal, and the last JSON object on stdout is the answer. But an
 * answer that is not a probability or a boolean is rejected rather than coerced — a
 * measurement built on a silently-coerced `"maybe"` is not a measurement.
 */
export function parseResponse(stdout: string, item: string): ReasoningResponse {
  const json = lastJsonObject(stdout);
  if (json === undefined) {
    throw new Error(`the reasoning command printed no JSON object for "${item}"`);
  }

  const answersRaw = json["answers"];
  if (typeof answersRaw !== "object" || answersRaw === null || Array.isArray(answersRaw)) {
    throw new Error(`the reasoning command's output for "${item}" has no "answers" mapping`);
  }

  const answers: Record<string, number> = {};
  for (const [name, value] of Object.entries(answersRaw as Record<string, unknown>)) {
    if (typeof value === "boolean") {
      answers[name] = value ? 1 : 0;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
      answers[name] = value;
    } else {
      throw new Error(
        `the reasoning command answered "${name}" for "${item}" with ${JSON.stringify(value)};` +
          " expected true, false, or a number between 0 and 1",
      );
    }
  }

  return {
    answers,
    ...(countOf(json["input_tokens"]) !== undefined ? { inputTokens: countOf(json["input_tokens"]) as number } : {}),
    ...(countOf(json["output_tokens"]) !== undefined ? { outputTokens: countOf(json["output_tokens"]) as number } : {}),
  };
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The last balanced `{...}` on stdout that parses, so a chatty CLI's preamble is ignored. */
function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  for (let start = stdout.lastIndexOf("{"); start >= 0; start = stdout.lastIndexOf("{", start - 1)) {
    const end = stdout.lastIndexOf("}");
    if (end < start) continue;
    try {
      const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not the object's real start. Step back to the previous brace and try again.
    }
  }
  return undefined;
}
