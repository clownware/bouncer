// The escalation manifest: what the judge could not settle, and why.
//
// The substitution pattern this project is built on is "the judgment model decides, the
// reasoning model only sees the failures". That only pays if the failures are a first-class
// output rather than something each consumer reconstructs. So the engine says, for an item
// it did not simply allow: which questions crossed which thresholds, at what probability,
// and what the question actually asked. Those four facts are the prompt a reasoning model
// needs, and `escalated / judged` is the number that says what the substitution saved.
//
// Two consumers, one shape (docs/adr/008):
//
//   - the gate turns an item into an `ask` and records it on the decision log line;
//   - `bouncer judge` (v0.3) collects the items into a manifest and builds one reasoning
//     pass over them.
//
// Pure and synchronous, like everything else below `src/cli.ts`.

import { describeComparison, satisfies } from "./policy.js";
import { ANY_QUESTION, type PolicySet, type Verdict } from "./types.js";
import type { Decision } from "./evaluate.js";

/** One threshold an item crossed, and the question behind it. */
export interface EscalationSignal {
  readonly question: string;
  readonly p: number;
  /** The threshold as the policy writes it, e.g. `">=0.70"` or `"0.40..0.60"`. */
  readonly criterion: string;
  /** The question's plain-English instructions — what a reasoning model is re-asked. */
  readonly asks: string;
  /** 1-based position of the rule in `rules`, matching the log's `reason.ruleIndex`. */
  readonly ruleIndex: number;
  /** What that rule would produce on its own. */
  readonly verdict: Verdict;
  /** True for the rule that actually produced the verdict; first match wins. */
  readonly decided: boolean;
}

/** One item the engine judged and did not settle. */
export interface EscalationItem {
  /** Whatever identifies the item to its consumer: a tool_use_id, a fixture id, a line. */
  readonly item: string;
  readonly verdict: Verdict;
  /**
   * Every threshold the answers crossed, in policy order — not only the one that decided.
   *
   * `evaluate` stops at the first match because a verdict is a single decision. A
   * re-adjudication is not: knowing an item tripped `secrets` at 0.71 *and* `prod` at 0.66
   * is the difference between a useful reasoning prompt and a guess.
   */
  readonly signals: readonly EscalationSignal[];
  /**
   * The state the judgment was made on.
   *
   * Optional because the gate leaves it out: its manifest item is written onto a
   * `decisions.jsonl` line that already carries the same redacted state, and writing it
   * twice would double the largest field in the highest-volume file bouncer owns. A
   * standalone manifest — what `bouncer judge` emits — sets it, because there the item has
   * to stand on its own. Whoever sets it is responsible for it having been redacted.
   */
  readonly state?: string;
}

/** A batch of judged items and what fraction of them needed a second opinion. */
export interface EscalationManifest {
  /** Items the classifier answered. Excludes anything a deterministic path decided. */
  readonly itemsJudged: number;
  readonly items: readonly EscalationItem[];
  /** `items.length / itemsJudged`, and 0 when nothing was judged. */
  readonly escalationRate: number;
}

/**
 * The escalation for one judged item, or undefined if there is nothing to escalate.
 *
 * Undefined in three cases, and the third is the interesting one:
 *
 *   - the verdict is `allow`, so the judge settled it;
 *   - a deterministic path decided (`fast-path`, `hard-rule`, `tool-not-gated`,
 *     `permission-mode-skipped`), so no judgment happened and there is nothing for a
 *     reasoning model to second-guess. A hard rule is not an escalation: ADR-004's whole
 *     argument is that the edges are code, and code does not ask for help;
 *   - no rule matched at all, which emits nothing and is not a verdict.
 *
 * Mode is deliberately absent. `observe` emits nothing to Claude Code and still escalates
 * here — the manifest is what the mode is observed *with*, and a run that recorded no
 * escalations because it was observing would make the ratio meaningless.
 */
export function escalationFor(
  set: PolicySet,
  decision: Decision,
  answers: Readonly<Record<string, number>>,
  item: string,
): EscalationItem | undefined {
  if (decision.reason.kind !== "rule") return undefined;
  if (decision.verdict === "allow") return undefined;

  return {
    item,
    verdict: decision.verdict,
    signals: signalsFor(set, answers, decision.reason.ruleIndex),
  };
}

/**
 * Every rule whose condition the answers satisfy, in policy order.
 *
 * An `any` rule contributes one signal per question that satisfies it, rather than the
 * single question `evaluate` happened to iterate to first. "Two questions are both in the
 * uncertainty band" is a different item from "one is", and the manifest is where that
 * difference is supposed to show up.
 */
function signalsFor(
  set: PolicySet,
  answers: Readonly<Record<string, number>>,
  decidedBy: number,
): EscalationSignal[] {
  const signals: EscalationSignal[] = [];
  let decidedTaken = false;

  for (const rule of set.rules) {
    if (rule.condition === undefined) continue;
    const { question, comparison } = rule.condition;
    const criterion = describeComparison(comparison);

    const names = question === ANY_QUESTION ? Object.keys(answers) : [question];
    for (const name of names) {
      const p = answers[name];
      if (p === undefined) continue;
      if (!satisfies(p, comparison)) continue;

      // `decided` marks one signal, not every signal of the deciding rule: an `any` rule
      // decides on the first question it matches, and claiming two of them decided would
      // misreport which threshold the user was actually stopped by.
      const decided = rule.index === decidedBy && !decidedTaken;
      if (decided) decidedTaken = true;

      signals.push({
        question: name,
        p,
        criterion,
        asks: set.questions[name]?.instructions ?? name,
        ruleIndex: rule.index,
        verdict: rule.verdict,
        decided,
      });
    }
  }

  return signals;
}

/**
 * Gathers items into a manifest.
 *
 * `itemsJudged` is passed in rather than derived from `items.length`, because the number
 * that matters is the one the items are a fraction *of*. A batch where every item
 * escalated and a batch of one item both produce a single-item list; only the denominator
 * tells them apart, and it is the whole claim the substitution play makes.
 */
export function manifestOf(
  items: readonly EscalationItem[],
  itemsJudged: number,
): EscalationManifest {
  return {
    itemsJudged,
    items,
    escalationRate: itemsJudged === 0 ? 0 : items.length / itemsJudged,
  };
}
