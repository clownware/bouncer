// PreToolUse orchestration: payload in, hook JSON out.
//
// The shape of this function is the safety argument. Every branch that is not "policy
// produced a verdict and the mode allows emitting it" returns no decision, which Claude
// Code treats as "proceed normally". There is no path from an error to a block, and no
// path from an error to an allow either.

import { existsSync } from "node:fs";
import { JevAdapter } from "../adapters/jev.js";
import { MockAdapter } from "../adapters/mock.js";
import { AdapterError, noulProbability, type Adapter, type Question } from "../adapters/types.js";
import { evaluate, shortCircuit, type Decision } from "../engine/evaluate.js";
import { buildState, commandOf } from "../engine/state.js";
import type { Policy, Verdict } from "../engine/types.js";
import * as breaker from "../io/breaker.js";
import { apiKey, dataDir, errorsIn, pluginRoot, resolvePolicy } from "../io/config.js";
import { append, type DecisionRecord } from "../io/log.js";
import type { HookPayload } from "../io/stdin.js";

/** What the hook writes to stdout. `undefined` means write nothing. */
export interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: Verdict;
    readonly permissionDecisionReason: string;
  };
  readonly systemMessage?: string;
}

export interface RunOptions {
  /** Injected in tests. Defaults to the backend named by the policy. */
  readonly adapter?: Adapter;
  /** Injected in tests so the engine never stats a real path. */
  readonly targetExists?: (path: string) => boolean | undefined;
  readonly now?: () => number;
}

export async function runPreToolUse(
  payload: HookPayload,
  options: RunOptions = {},
): Promise<HookOutput | undefined> {
  const now = options.now ?? Date.now;
  const started = now();

  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (tool.length === 0) return undefined;

  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const resolved = resolvePolicy(cwd, pluginRoot());
  const policy = resolved.policy;

  const dir = dataDir();
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";

  // An unloadable policy means bouncer does nothing. Refusing to start enforcing on a
  // broken config is the point; a syntax error must not become a block.
  if (policy === undefined) {
    // No policy file anywhere means bouncer is simply not set up — there is nothing to
    // tell the user and nothing they did wrong, so say nothing at all.
    if (resolved.source === "(none)") return undefined;

    // A policy file that exists and does not parse is different: the user wrote it and
    // needs to know it is being ignored. Once per session — a systemMessage on every tool
    // call would be spam by the fiftieth Bash.
    const state = breaker.read(dir, sessionId);
    if (!breaker.shouldNotify(state, "policy-error")) return undefined;
    breaker.write(dir, breaker.markNotified(state, "policy-error"));

    const first = errorsIn(resolved.diagnostics)[0];
    return {
      systemMessage: `bouncer: not enforcing — ${resolved.source} ${first ? `has a problem at ${first.path || "the top level"}: ${first.message}` : "could not be loaded"}`,
    };
  }
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const agentType = typeof payload["agent_type"] === "string" ? payload["agent_type"] : undefined;
  const permissionMode = typeof payload.permission_mode === "string" ? payload.permission_mode : undefined;

  const base = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    ...(typeof payload.tool_use_id === "string" ? { tool_use_id: payload.tool_use_id } : {}),
    tool,
    ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
    ...(agentType !== undefined ? { agent_type: agentType } : {}),
    mode: policy.mode,
    backend: policy.backend,
  };

  // Cheap outs first: tool not gated, permission mode skipped, command on the fast path.
  // None of these touch the network, and the fast path is the main reason a heavy session
  // stays responsive.
  const early = shortCircuit(policy, {
    tool,
    command: commandOf(tool, toolInput),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  });

  if (early !== undefined) {
    // Only fast-path hits are worth a log line; the other two are noise, and a log full of
    // "Read is not gated" is a log nobody reads.
    if (early.reason.kind === "fast-path") {
      append(dir, { ...base, ...verdictFields(early), latency_ms: { total: now() - started } });
    }
    return outputFor(early, policy);
  }

  const breakerState = breaker.read(dir, sessionId);
  const status = breaker.check(breakerState);

  if (status.tripped) {
    append(dir, {
      ...base,
      verdict: "allow",
      emitted: null,
      reason: { kind: "no-rule-matched" },
      latency_ms: { total: now() - started },
      error: { kind: "breaker_open", message: "standing down for this session" },
    });
    return undefined;
  }

  const state = buildState({
    toolName: tool,
    toolInput,
    cwd,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...targetExistsFor(tool, toolInput, options),
  });

  let adapter: Adapter;
  try {
    adapter = options.adapter ?? adapterFor(policy);
  } catch (err) {
    return standDown(dir, base, breakerState, status, err, now() - started, policy);
  }

  const questions = questionsFor(policy);
  const adapterStarted = now();

  try {
    const response = await adapter.decide({ state: state.text, questions, timeoutMs: policy.timeoutMs });
    const adapterMs = now() - adapterStarted;

    const answers: Record<string, number> = {};
    for (const [name, answer] of Object.entries(response.answers)) {
      const p = noulProbability(answer);
      if (p !== undefined) answers[name] = p;
    }

    const decision = evaluate(policy, answers);
    const next = breaker.record(breakerState, {
      failed: false,
      overBudget: adapterMs > policy.timeoutMs,
      warmup: status.warmup,
    });
    breaker.write(dir, next.state);

    append(dir, {
      ...base,
      ...verdictFields(decision),
      answers,
      state: state.text,
      redacted_kinds: state.redactedKinds,
      latency_ms: { total: now() - started, adapter: adapterMs },
      ...(status.warmup ? { warmup: true } : {}),
    });

    const output = outputFor(decision, policy);
    if (next.message !== undefined) {
      return { ...(output ?? {}), systemMessage: next.message };
    }
    return output;
  } catch (err) {
    return standDown(dir, base, breakerState, status, err, now() - started, policy);
  }
}

/**
 * The adapter could not answer.
 *
 * `on_error` decides, and its default is to emit nothing. `deny` is available and
 * documented as a footgun; it is honoured here because a user who set it meant it.
 */
function standDown(
  dir: string,
  base: Omit<DecisionRecord, "verdict" | "emitted" | "reason" | "latency_ms">,
  state: breaker.BreakerState,
  status: breaker.BreakerDecision,
  err: unknown,
  totalMs: number,
  policy: Policy,
): HookOutput | undefined {
  const error = err instanceof AdapterError
    ? { kind: err.kind, message: err.message }
    : { kind: "unknown", message: err instanceof Error ? err.message : String(err) };

  const next = breaker.record(state, { failed: true, overBudget: false, warmup: status.warmup });
  breaker.write(dir, next.state);

  append(dir, {
    ...base,
    verdict: "allow",
    emitted: policy.onError === "deny" ? "deny" : null,
    reason: { kind: "no-rule-matched" },
    latency_ms: { total: totalMs },
    error,
    ...(status.warmup ? { warmup: true } : {}),
  });

  if (policy.onError === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `bouncer could not reach its classifier (${error.kind}) and this policy is configured to deny on error.`,
      },
      ...(next.message !== undefined ? { systemMessage: next.message } : {}),
    };
  }

  return next.message !== undefined ? { systemMessage: next.message } : undefined;
}

function outputFor(decision: Decision, policy: Policy): HookOutput | undefined {
  if (decision.emit === undefined) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.emit,
      permissionDecisionReason: explain(decision, policy),
    },
  };
}

/** A one-line reason the user reads at the prompt. Names the question and the number. */
function explain(decision: Decision, policy: Policy): string {
  const { reason } = decision;
  switch (reason.kind) {
    case "rule": {
      if (reason.question === "default") return "bouncer: no rule matched.";
      const instructions = policy.gate.questions[reason.question]?.instructions ?? reason.question;
      return `bouncer: ${instructions} (${reason.question} ${reason.p.toFixed(2)})`;
    }
    case "fast-path":
      return `bouncer: matched the fast path (${reason.prefix.trim()}).`;
    case "tool-not-gated":
      return `bouncer: ${reason.tool} is not gated by this policy.`;
    case "permission-mode-skipped":
      return `bouncer: skipped in ${reason.permissionMode} mode.`;
    case "no-rule-matched":
      return "bouncer: no rule matched.";
  }
}

function verdictFields(decision: Decision) {
  return {
    verdict: decision.verdict,
    emitted: decision.emit ?? null,
    reason: decision.reason,
  };
}

function questionsFor(policy: Policy): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const [name, question] of Object.entries(policy.gate.questions)) {
    questions[name] = {
      type: "noul",
      instructions: question.instructions,
      ...(question.criteria !== undefined ? { criteria: question.criteria } : {}),
    };
  }
  return questions;
}

function adapterFor(policy: Policy): Adapter {
  const override = process.env["BOUNCER_BACKEND"];
  const backend = override !== undefined && override.length > 0 ? override : policy.backend;

  if (backend === "mock") return new MockAdapter();
  if (backend === "jev") return new JevAdapter({ apiKey: apiKey() ?? "" });

  throw new AdapterError("invalid_request", `unknown backend "${backend}"`);
}

/**
 * Whether the tool's target file already exists.
 *
 * This is the one stat the hook does, and it is here rather than in the engine so the
 * engine stays pure. Without it a Write that creates and a Write that overwrites look
 * identical to the classifier.
 */
function targetExistsFor(
  tool: string,
  toolInput: Readonly<Record<string, unknown>>,
  options: RunOptions,
): { targetExists?: boolean } {
  if (tool !== "Write" && tool !== "Edit" && tool !== "NotebookEdit") return {};

  const raw = toolInput["file_path"] ?? toolInput["notebook_path"];
  if (typeof raw !== "string" || raw.length === 0) return {};

  const exists = (options.targetExists ?? defaultTargetExists)(raw);
  return exists === undefined ? {} : { targetExists: exists };
}

function defaultTargetExists(path: string): boolean | undefined {
  try {
    return existsSync(path);
  } catch {
    // A permission error on the parent directory is not knowing, which is different from
    // knowing the file is absent. Returning undefined keeps the fact out of the state
    // rather than asserting something false.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
