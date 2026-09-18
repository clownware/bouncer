// The adapter contract.
//
// These types mirror Jev's wire format rather than an idealised internal model. That is a
// deliberate choice: a translation layer between "our question type" and "their question
// type" would buy nothing, and every field it renamed would be a place for the two to
// drift. A local logprob adapter (v0.3) implements this same shape.
//
// Verified against docs.typesafe.ai on 2026-09-18 and confirmed live by
// scripts/jev-latency.mjs. Two details are easy to get wrong:
//
//   - `questions` is a MAP keyed by names the caller chooses. Answers come back under the
//     same keys. It is not an array of objects carrying their own id.
//   - A `noul` answer is a bare probability with NO confidence field. `choice` and `score`
//     do return `confidence`, but the docs describe it as a statistic computed from the
//     distribution rather than independent signal — so policy is written on `p` alone.

export type QuestionType = "noul" | "choice" | "score";

/** "Is this true?" — the only type v0.1's gate uses. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  /** Option name to description. A null description is allowed. */
  readonly criteria: Readonly<Record<string, string | null>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  /** Ordered level descriptions, 2 to 10 of them. */
  readonly criteria: readonly string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  readonly type: "noul";
  /** Probability the statement is true, 0 to 1. There is no confidence field. */
  readonly noul: number;
}

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly legend?: Readonly<Record<string, string>>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecideRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, Question>>;
  readonly timeoutMs: number;
  /** Aborts the call from the caller's side; the adapter also enforces `timeoutMs`. */
  readonly signal?: AbortSignal;
}

export interface DecideResponse {
  /** Keyed by the same names as the request's questions. */
  readonly answers: Readonly<Record<string, Answer>>;
  readonly model?: string;
  readonly inputTokens?: number;
  /** Wall-clock milliseconds for the call, measured by the adapter. */
  readonly latencyMs: number;
}

export interface Adapter {
  readonly name: string;
  decide(request: DecideRequest): Promise<DecideResponse>;
}

/**
 * Why a decision could not be obtained.
 *
 * The engine maps every one of these onto the policy's `on_error`, which defaults to
 * emitting no decision. The kind exists so the log can distinguish "your key is wrong"
 * (worth telling the user once) from "the network hiccuped" (worth counting toward the
 * circuit breaker), not so that any of them can fail open.
 */
export type AdapterErrorKind =
  | "timeout"
  | "auth"
  | "invalid_request"
  | "rate_limited"
  | "unavailable"
  | "malformed_response";

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly status?: number;
  /** True when trying the same request again could plausibly succeed. */
  readonly retryable: boolean;

  constructor(kind: AdapterErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AdapterError";
    this.kind = kind;
    if (options?.status !== undefined) this.status = options.status;
    this.retryable = kind === "rate_limited" || kind === "unavailable" || kind === "timeout";
  }
}

/** Reads a noul probability from an answer, or undefined if it is not a noul. */
export function noulProbability(answer: Answer | undefined): number | undefined {
  if (answer === undefined || answer.type !== "noul") return undefined;
  return typeof answer.noul === "number" && Number.isFinite(answer.noul) ? answer.noul : undefined;
}
