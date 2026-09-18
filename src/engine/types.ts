// Shared types for the decision engine.
//
// These mirror the policy file's shape rather than an idealised internal model, so that a
// validation error can always point at the line the user wrote.

/** What bouncer is allowed to emit. See docs/adr/003. */
export type Mode = "observe" | "guard" | "full";

/** The verdicts a rule can produce. `allow` is only emitted in `full` mode. */
export type Verdict = "allow" | "ask" | "deny";

export type OnError = "passthrough" | "deny";

/**
 * A threshold on a returned probability.
 *
 * Deliberately not a confidence value: Jev's `noul` answers carry no confidence field,
 * and on the types that do, the docs describe it as a statistic computed from the
 * distribution rather than independent signal. Everything is expressed on `p`.
 */
export type Comparison =
  | { readonly kind: "gte"; readonly value: number }
  | { readonly kind: "gt"; readonly value: number }
  | { readonly kind: "lte"; readonly value: number }
  | { readonly kind: "lt"; readonly value: number }
  | { readonly kind: "range"; readonly low: number; readonly high: number };

/** The reserved question name matching when *any* question satisfies the condition. */
export const ANY_QUESTION = "any";

export interface Condition {
  /** A question name from `gate.questions`, or the literal `any`. */
  readonly question: string;
  readonly comparison: Comparison;
}

export interface Rule {
  /** Absent on the terminal `default:` rule. */
  readonly condition?: Condition;
  readonly verdict: Verdict;
  /** 1-based position in the policy file's rule list, for diagnostics. */
  readonly index: number;
}

export interface Question {
  readonly instructions: string;
  /** Optional `true` / `false` descriptions passed through to the classifier. */
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

export interface GatePolicy {
  readonly tools: readonly string[];
  readonly fastPath: readonly string[];
  readonly questions: Readonly<Record<string, Question>>;
  /**
   * Questions asked in the same call as `questions` and read by nothing.
   *
   * Output tokens are free and Jev answers a fan-out in parallel, so an extra question
   * costs a few hundred input tokens and no measurable latency. That makes it nearly free
   * to ask a candidate rewording alongside the one in force and find out, from real
   * traffic, whether it would have done better — without a second live run and without
   * putting an unproven question anywhere near a verdict.
   *
   * The guarantee is structural rather than a convention: probe answers are split out
   * before `evaluate()` is called, so no rule can read one even by accident, including the
   * `any` rule that iterates every answer it is given. They reach `decisions.jsonl` and
   * stop there.
   */
  readonly probeQuestions: Readonly<Record<string, Question>>;
  readonly rules: readonly Rule[];
}

/**
 * The bar `bouncer calibrate` holds each question to, from PRD §12.
 *
 * Here rather than in `src/calibrate.ts` for the same reason the rule thresholds are:
 * they are numbers, and numbers live in the policy the user owns. A user who wants a
 * stricter bar before trusting a question should be able to say so without editing code,
 * and the README tells them to run calibration and decide for themselves.
 */
export interface CalibrationPolicy {
  /** Only answers at or above this confidence count toward the bar. */
  readonly confidenceFloor: number;
  /** The accuracy a question must reach among those answers to pass. */
  readonly accuracyBar: number;
}

export interface Policy {
  readonly version: 1;
  readonly backend: string;
  readonly mode: Mode;
  readonly timeoutMs: number;
  readonly onError: OnError;
  readonly skipPermissionModes: readonly string[];
  readonly gate: GatePolicy;
  readonly calibration: CalibrationPolicy;
}

/** A problem with the policy file. `warnings` do not prevent loading; `errors` do. */
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly message: string;
}
