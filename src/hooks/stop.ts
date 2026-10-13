// Stop orchestration: payload in, a log line out, and never anything on stdout.
//
// The shape of this function is the promise, as it is in pretooluse.ts, and here the promise
// is simpler: there is no return value. A `Stop` hook that prints `{"decision":"block"}`
// keeps the agent working past the point it chose to stop, and a hook that exits 2 does the
// same. This one can do neither, because it has nothing to return and `src/cli.ts` writes
// nothing for it. docs/adr/015 says what would have to be true before that changes.
//
// It is off unless a stop policy exists (`stopPolicyPath`), because unlike the gate it sends
// content: the end of the agent's closing message.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "../adapters/types.js";
import { adapterFor } from "../commands/calibrate.js";
import { buildItemState } from "../engine/item.js";
import { dataDir, pluginRoot, resolvePolicy, stopPolicyPath } from "../io/config.js";
import type { HookPayload } from "../io/stdin.js";
import { judge } from "../judge.js";
import { STOP_SET, stopItem, wouldFor, type Would } from "../stop.js";

export const STOPS_FILE = "stops.jsonl";

/** One stop, as `bouncer stops` reads it back. */
export interface StopRecord {
  readonly ts: string;
  readonly session_id: string;
  readonly prompt_id?: string;
  /** Where the session's own record is, so the next typed prompt can be found later. */
  readonly transcript_path?: string;
  readonly cwd: string;
  readonly permission_mode?: string;
  /** Claude Code's own flag: this stop follows a continuation some Stop hook already forced. */
  readonly stop_hook_active: boolean;
  readonly backend: string;
  readonly model?: string;
  readonly policy: { readonly file: string; readonly questions: string };
  /** Absent when nothing was judged. */
  readonly would?: Would;
  /** The question whose rule decided, or `default`. */
  readonly decided_by?: string;
  readonly answers?: Readonly<Record<string, number>>;
  /** The redacted item the judgment was made on. */
  readonly state?: string;
  readonly redacted_kinds?: readonly string[];
  /** Why nothing was judged, when the reason is not a failure. */
  readonly skipped?: "work-still-running";
  readonly error?: { readonly kind: string; readonly message: string };
  readonly latency_ms: number;
}

export interface StopOptions {
  /** Injected in tests. Defaults to `$BOUNCER_BACKEND`, or the stop policy's backend. */
  readonly adapter?: Adapter;
  /** Injected in tests, in place of the three places a stop policy is looked for. */
  readonly policyPath?: string;
  readonly now?: () => number;
}

export async function runStop(payload: HookPayload, options: StopOptions = {}): Promise<void> {
  try {
    await observe(payload, options);
  } catch {
    // A stop that could not be watched is a stop nobody watched. Nothing to tell anyone.
  }
}

async function observe(payload: HookPayload, options: StopOptions): Promise<void> {
  if (payload.hook_event_name !== "Stop") return;

  const message = payload["last_assistant_message"];
  if (typeof message !== "string" || message.trim().length === 0) return;

  const now = options.now ?? Date.now;
  const started = now();
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();

  // No stop policy anywhere is the ordinary case, and it means this consumer is off.
  const path = options.policyPath ?? stopPolicyPath(cwd);
  if (path === undefined) return;

  const policy = resolvePolicy(cwd, pluginRoot(), path).policy;
  const set = policy?.sets[STOP_SET];
  if (policy === undefined || set === undefined) return;

  const override = process.env["BOUNCER_BACKEND"];
  const backend = options.adapter?.name ?? (override !== undefined && override.length > 0 ? override : policy.backend);
  const dir = dataDir();

  const base = {
    ts: new Date().toISOString(),
    session_id: typeof payload.session_id === "string" ? payload.session_id : "unknown",
    ...(typeof payload["prompt_id"] === "string" ? { prompt_id: payload["prompt_id"] } : {}),
    ...(typeof payload["transcript_path"] === "string" ? { transcript_path: payload["transcript_path"] } : {}),
    cwd,
    ...(typeof payload.permission_mode === "string" ? { permission_mode: payload.permission_mode } : {}),
    stop_hook_active: payload["stop_hook_active"] === true,
    backend,
    policy: { file: policy.fingerprint, questions: set.questionsFingerprint },
  };

  // An agent that stops with a task still running is waiting on the task, not on the user,
  // and its closing message says so. Nothing is sent: there is no go-ahead to look for.
  if (count(payload["background_tasks"]) + count(payload["session_crons"]) > 0) {
    record(dir, { ...base, skipped: "work-still-running", latency_ms: now() - started });
    return;
  }

  const adapter = options.adapter ?? adapterFor(backend);
  if (typeof adapter === "string") {
    record(dir, { ...base, error: { kind: "no-backend", message: adapter }, latency_ms: now() - started });
    return;
  }

  const run = await judge([{ id: "stop", state: buildItemState(stopItem(message)) }], {
    setName: STOP_SET,
    set,
    mode: policy.mode,
    adapter,
    timeoutMs: policy.timeoutMs,
    concurrency: 1,
  });

  const item = run.items[0];
  if (item === undefined) return;

  const seen = { state: item.state, redacted_kinds: item.redactedKinds };
  const model = item.model !== undefined ? { model: item.model } : {};

  if (item.outcome === "unjudged") {
    record(dir, { ...base, ...seen, error: item.error, latency_ms: now() - started });
    return;
  }

  // A long message is cut to its tail before it is ever an item, so `incomplete` means the
  // tail alone overran the item builder's cap. Left alone, like anything else half-read.
  const decided =
    item.outcome === "judged"
      ? { would: wouldFor(item.verdict), decided_by: item.reason.kind === "rule" ? item.reason.question : item.reason.kind }
      : { would: "leave" as const, decided_by: "truncated" };

  record(dir, { ...base, ...model, ...decided, answers: item.answers, ...seen, latency_ms: now() - started });
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function record(dir: string, line: StopRecord): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, STOPS_FILE), `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // A log that cannot be written changes nothing about the stop.
  }
}
