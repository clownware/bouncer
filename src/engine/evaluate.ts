// Rule evaluation: probabilities in, verdict out.
//
// Pure and synchronous. Everything that can fail — loading policy, calling the
// classifier, writing the log — happens elsewhere, so this can be exhaustively tested
// against a table and read by a user trying to work out why they got prompted.

import { matchHardRule } from "./hardrules.js";
import { satisfies } from "./policy.js";
import { ANY_QUESTION, type HardRule, type Mode, type Policy, type PolicySet, type Verdict } from "./types.js";

export type Reason =
  /** A rule matched. */
  | { readonly kind: "rule"; readonly ruleIndex: number; readonly question: string; readonly p: number }
  /** The command matched an entry in `gate.fast_path`, so no classifier call was made. */
  | { readonly kind: "fast-path"; readonly prefix: string }
  /** The command matched an entry in `gate.hard_rules`, so no classifier call was made. */
  | { readonly kind: "hard-rule"; readonly name: string; readonly because: string }
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

/**
 * Decided without calling the classifier.
 *
 * Order matters and is the argument for the design. Permission mode and tool gating come
 * first because they mean bouncer has no business here at all. Then hard rules, then the
 * fast path — that way round, because the fast path is an allowlist whose entries have to
 * be safe for every argument they can be given, and a deterministic backstop that ran
 * after it could not back anything up. See docs/adr/004.
 */
export function shortCircuit(
  policy: Policy,
  input: { readonly tool: string; readonly command: string; readonly permissionMode?: string },
): Decision | undefined {
  if (input.permissionMode !== undefined && policy.skipPermissionModes.includes(input.permissionMode)) {
    return decide(policy.mode, "allow", { kind: "permission-mode-skipped", permissionMode: input.permissionMode });
  }

  if (!policy.gate.tools.includes(input.tool)) {
    return decide(policy.mode, "allow", { kind: "tool-not-gated", tool: input.tool });
  }

  const hard = matchHardRule(policy.gate.hardRules, input.command);
  if (hard !== undefined) {
    return decideHard(policy, hard);
  }

  const prefix = matchFastPath(policy.gate.fastPath, input.command);
  if (prefix !== undefined) {
    return decide(policy.mode, "allow", { kind: "fast-path", prefix });
  }

  return undefined;
}

/** A hard rule's verdict, with `seatbelt`'s promotion applied. */
function decideHard(policy: Policy, rule: HardRule): Decision {
  const reason = { kind: "hard-rule", name: rule.name, because: rule.because } as const;
  return {
    verdict: rule.verdict,
    reason,
    emit: emitFor(policy.mode, rule.verdict, true),
  };
}

/**
 * Applies a policy set's rules to the classifier's answers.
 *
 * Takes the set rather than the whole `Policy`, and the mode rather than reading it off
 * one. Until v0.3 this reached through `policy.gate.rules`, which is exactly the
 * hook-shaped reach-through ADR-008 said must not exist below the entrypoint — it was
 * invisible while the gate was the only consumer, and `bouncer judge` is what made it
 * visible. See docs/adr/009 on what the second consumer bent.
 *
 * `answers` maps question name to probability. A question the classifier did not answer
 * is skipped rather than treated as zero: a missing answer is an absence of evidence, and
 * reading it as "definitely not destructive" would be exactly the wrong default.
 */
export function evaluate(set: PolicySet, mode: Mode, answers: Readonly<Record<string, number>>): Decision {
  for (const rule of set.rules) {
    if (rule.condition === undefined) {
      // The terminal `default` rule.
      return decide(mode, rule.verdict, { kind: "rule", ruleIndex: rule.index, question: "default", p: Number.NaN });
    }

    const { question, comparison } = rule.condition;

    if (question === ANY_QUESTION) {
      for (const [name, p] of Object.entries(answers)) {
        if (satisfies(p, comparison)) {
          return decide(mode, rule.verdict, { kind: "rule", ruleIndex: rule.index, question: name, p });
        }
      }
      continue;
    }

    const p = answers[question];
    if (p === undefined) continue;
    if (satisfies(p, comparison)) {
      return decide(mode, rule.verdict, { kind: "rule", ruleIndex: rule.index, question, p });
    }
  }

  // No rule matched and there was no default. Emitting nothing is the safe reading:
  // the user's normal permission flow still runs.
  return { verdict: "allow", reason: { kind: "no-rule-matched" }, emit: undefined };
}

function decide(mode: Mode, verdict: Verdict, reason: Reason): Decision {
  return { verdict, reason, emit: emitFor(mode, verdict) };
}

/**
 * Maps a policy verdict onto what the hook is allowed to say, given the mode.
 *
 *                     observe   guard   full    seatbelt
 *   allow               —         —      allow     —
 *   ask, from a rule    —        ask     ask      deny
 *   ask, from a judge   —        ask     ask       —
 *   deny                —        deny    deny     deny
 *
 * `guard` withholds `allow` on purpose: emitting it would suppress a prompt the user
 * would otherwise have seen, which is a removal of friction they have not yet agreed to.
 * `guard` can only ever add.
 *
 * `seatbelt` is for a session started with `--dangerously-skip-permissions`, where the
 * baseline is no prompts at all, so `ask` is not a verdict that can help — it forces the
 * prompt the user turned off. Two things follow, and the asymmetry between them is the
 * whole of ADR-004's argument:
 *
 * - a hard rule's `ask` is promoted to `deny`, because a deterministic rule's
 *   false-positive rate is a property of the rule rather than of a model's answer today;
 * - a judged `ask` emits nothing, because 0.63 on a noul is not a reason to stop a tool
 *   call in a session the user configured never to stop. The judge still runs, still logs
 *   and still feeds calibration; it just does not get to interrupt.
 *
 * A judgment can still `deny` in `seatbelt`, when it clears a `deny` rule the user enabled
 * in `gate.rules`. Those ship commented out, so `seatbelt` out of the box is hard rules and
 * silence.
 */
export function emitFor(mode: Mode, verdict: Verdict, fromHardRule = false): Verdict | undefined {
  if (mode === "observe") return undefined;
  if (verdict === "allow") return mode === "full" ? "allow" : undefined;
  if (mode === "seatbelt" && verdict === "ask") return fromHardRule ? "deny" : undefined;
  return verdict;
}

function matchFastPath(prefixes: readonly string[], command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;

  // A shell operator means more than one command is running, and the fast path only
  // reasons about the first token sequence. Refuse rather than allow half a pipeline.
  //
  // A redirect is refused for the same reason, though it starts no second command: an entry
  // is on the list because of what the verb does, and `ls > ~/.ssh/authorized_keys` does
  // what the redirect does. Without `<` and `>` here it took the fast path, and in `full`
  // mode that is bouncer approving the overwrite.
  //
  // Any `$`, not only `$(`. The shell expands a variable before the verb sees it, and a
  // harmless verb's error message prints what it was given: `ls $OPENAI_API_KEY` answers
  // "ls: sk-...: No such file or directory". That is `echo $OPENAI_API_KEY`, the `secrets`
  // question's own example, arriving by a verb that was never going to be judged.
  if (/[;&|<>$]|`|\n/.test(trimmed)) return undefined;

  for (const prefix of prefixes) {
    if (trimmed === prefix.trim()) return prefix;
    // Only an entry written with a trailing space takes arguments. One written without is a
    // whole command and matches nothing longer: `npm test` is the project's own script, and
    // `npm test --script-shell /tmp/x.sh` is somebody else's program. See docs/adr/010.
    if (prefix.endsWith(" ") && trimmed.startsWith(prefix)) return prefix;
  }

  return undefined;
}
