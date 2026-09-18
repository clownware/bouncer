// Shared types for the decision engine.
//
// These mirror the policy file's shape rather than an idealised internal model, so that a
// validation error can always point at the line the user wrote.

/**
 * What bouncer is allowed to emit. See docs/adr/003, and docs/adr/004 for `seatbelt`.
 *
 * `seatbelt` is the mode for a session running `--dangerously-skip-permissions`, where the
 * baseline is no prompts at all. `ask` cannot help there — it forces the prompt the user
 * turned off — so the mode emits nothing for one and denies on a hard rule instead.
 */
export type Mode = "observe" | "guard" | "full" | "seatbelt";

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

/**
 * The predicates a `gate.hard_rules` entry can assert, ANDed together.
 *
 * Every one exists for a specific near-miss pair in fixtures/gate.jsonl; ADR-004 has the
 * table. The data lives in the policy file — there is no list of paths, verbs or
 * credential shapes in `src/`.
 */
export interface HardRuleWhen {
  /** The command's first word is one of these. */
  readonly firstToken?: readonly string[];
  /** Every one of these appears as an exact token. */
  readonly tokens?: readonly string[];
  /** None of these appears as a token. Never asserted alone. */
  readonly notTokens?: readonly string[];
  /** One of these appears as a case-insensitive substring. For text inside a quoted argument. */
  readonly text?: readonly string[];
  /** Some token is a path carrying one of these sensitivity labels. */
  readonly pathLabelled?: readonly string[];
  /** `redact()` reports one of these kinds for the command. */
  readonly redactsAs?: readonly string[];
}

/**
 * A deterministic rule, evaluated before the classifier.
 *
 * Entries ship as `ask`. `seatbelt` promotes that to `deny` rather than the entry doing so,
 * so changing populations never means rewriting the policy file.
 */
export interface HardRule {
  readonly name: string;
  readonly verdict: Verdict;
  /** The one-line reason the user reads at the prompt. */
  readonly because: string;
  readonly when: HardRuleWhen;
  /** 1-based position in the policy file's list, for diagnostics. */
  readonly index: number;
}

export interface GatePolicy {
  readonly tools: readonly string[];
  readonly fastPath: readonly string[];
  readonly hardRules: readonly HardRule[];
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
