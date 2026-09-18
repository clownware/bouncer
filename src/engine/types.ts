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
  readonly rules: readonly Rule[];
}

export interface Policy {
  readonly version: 1;
  readonly backend: string;
  readonly mode: Mode;
  readonly timeoutMs: number;
  readonly onError: OnError;
  readonly skipPermissionModes: readonly string[];
  readonly gate: GatePolicy;
}

/** A problem with the policy file. `warnings` do not prevent loading; `errors` do. */
export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly message: string;
}
