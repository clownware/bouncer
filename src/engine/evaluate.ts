// Rule evaluation: probabilities in, verdict out.
//
// Pure and synchronous. Everything that can fail — loading policy, calling the
// classifier, writing the log — happens elsewhere, so this can be exhaustively tested
// against a table and read by a user trying to work out why they got prompted.

import { satisfies } from "./policy.js";
import { ANY_QUESTION, type Mode, type Policy, type Verdict } from "./types.js";

export type Reason =
  /** A rule matched. */
  | { readonly kind: "rule"; readonly ruleIndex: number; readonly question: string; readonly p: number }
  /** The command matched an entry in `gate.fast_path`, so no classifier call was made. */
  | { readonly kind: "fast-path"; readonly prefix: string }
  /** The tool is not in `gate.tools`. */
  | { readonly kind: "tool-not-gated"; readonly tool: string }
  /** `permission_mode` is listed in `skip_permission_modes`. */
  | { readonly kind: "permission-mode-skipped"; readonly permissionMode: string }
  /** No rule matched and the policy has no `default`. */
  | { readonly kind: "no-rule-matched" };

export interface Decision {
  /** What policy concluded, before mode is applied. */
  readonly verdict: Verdict;
  readonly reason: Reason;
  /**
   * What to actually put on stdout. `undefined` means emit nothing, which Claude Code
   * treats as "no decision" and falls through to its normal permission flow.
   *
   * This is where `mode` is applied, and it is the whole friction guarantee: in `observe`
   * this is always undefined, so the plugin cannot add a prompt that was not already
   * going to happen. See docs/adr/003.
   */
  readonly emit: Verdict | undefined;
}

/** Decided without calling the classifier. */
export function shortCircuit(
  policy: Policy,
  input: { readonly tool: string; readonly command: string; readonly permissionMode?: string },
): Decision | undefined {
  if (input.permissionMode !== undefined && policy.skipPermissionModes.includes(input.permissionMode)) {
    return decide(policy, "allow", { kind: "permission-mode-skipped", permissionMode: input.permissionMode });
  }

  if (!policy.gate.tools.includes(input.tool)) {
    return decide(policy, "allow", { kind: "tool-not-gated", tool: input.tool });
  }

  const prefix = matchFastPath(policy.gate.fastPath, input.command);
  if (prefix !== undefined) {
    return decide(policy, "allow", { kind: "fast-path", prefix });
  }

  return undefined;
}

/**
 * Applies the rules to the classifier's answers.
 *
 * `answers` maps question name to probability. A question the classifier did not answer
 * is skipped rather than treated as zero: a missing answer is an absence of evidence, and
 * reading it as "definitely not destructive" would be exactly the wrong default.
 */
export function evaluate(policy: Policy, answers: Readonly<Record<string, number>>): Decision {
  for (const rule of policy.gate.rules) {
    if (rule.condition === undefined) {
      // The terminal `default` rule.
      return decide(policy, rule.verdict, { kind: "rule", ruleIndex: rule.index, question: "default", p: Number.NaN });
    }

    const { question, comparison } = rule.condition;

    if (question === ANY_QUESTION) {
      for (const [name, p] of Object.entries(answers)) {
        if (satisfies(p, comparison)) {
          return decide(policy, rule.verdict, { kind: "rule", ruleIndex: rule.index, question: name, p });
        }
      }
      continue;
    }

    const p = answers[question];
    if (p === undefined) continue;
    if (satisfies(p, comparison)) {
      return decide(policy, rule.verdict, { kind: "rule", ruleIndex: rule.index, question, p });
    }
  }

  // No rule matched and there was no default. Emitting nothing is the safe reading:
  // the user's normal permission flow still runs.
  return { verdict: "allow", reason: { kind: "no-rule-matched" }, emit: undefined };
}

function decide(policy: Policy, verdict: Verdict, reason: Reason): Decision {
  return { verdict, reason, emit: emitFor(policy.mode, verdict) };
}

/**
 * Maps a policy verdict onto what the hook is allowed to say, given the mode.
 *
 *              observe   guard   full
 *   allow        —         —      allow
 *   ask          —        ask     ask
 *   deny         —        deny    deny
 *
 * `guard` withholds `allow` on purpose: emitting it would suppress a prompt the user
 * would otherwise have seen, which is a removal of friction they have not yet agreed to.
 * `guard` can only ever add.
 */
export function emitFor(mode: Mode, verdict: Verdict): Verdict | undefined {
  if (mode === "observe") return undefined;
  if (verdict === "allow") return mode === "full" ? "allow" : undefined;
  return verdict;
}

function matchFastPath(prefixes: readonly string[], command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;

  // A shell operator means more than one command is running, and the fast path only
  // reasons about the first token sequence. Refuse rather than allow half a pipeline.
  if (/[;&|]|\$\(|`|\n/.test(trimmed)) return undefined;

  for (const prefix of prefixes) {
    if (trimmed === prefix.trim()) return prefix;
    if (prefix.endsWith(" ") && trimmed.startsWith(prefix)) return prefix;
    // A prefix written without a trailing space still has to match on a word boundary,
    // so "git log" does not match "git logsomething".
    if (!prefix.endsWith(" ") && trimmed.startsWith(`${prefix} `)) return prefix;
  }

  return undefined;
}
