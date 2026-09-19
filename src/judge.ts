// The batch judge: a policy set over a batch of items.
//
// This is the second consumer of the engine (docs/adr/008, docs/adr/009), and it is
// deliberately thin. It takes states the caller has already built, asks the set's questions
// in one fan-out per item, evaluates the same rules the gate evaluates, and collects what
// did not settle into an escalation manifest. Every line of judgment logic it uses is the line the
// PreToolUse hook uses; if that ever stops being true, one of the two is wrong.
//
// What it does NOT share with the hook is mode. `observe` / `guard` / `full` / `seatbelt`
// describe what may be said to Claude Code, and there is no Claude Code here — the verdict
// is the output, not a thing to be suppressed. So this reads `decision.verdict` and never
// `decision.emit`.
//
// No I/O: the caller supplies the items and writes the results. That is what lets the whole
// thing be tested against the mock adapter with no filesystem and no network.

import { noulProbability, type Adapter, type DecideResponse } from "./adapters/types.js";
import { AdapterError } from "./adapters/types.js";
import { questionsOf } from "./calibrate.js";
import { evaluate, type Reason } from "./engine/evaluate.js";
import { escalationFor, manifestOf, type EscalationItem, type EscalationManifest } from "./engine/escalation.js";
import type { BuiltState, Mode, PolicySet, Verdict } from "./engine/types.js";

/** One item, judged. */
export interface JudgedItem {
  readonly id: string;
  readonly verdict: Verdict;
  readonly reason: Reason;
  /** Raw probability per question. What calibration is computed from. */
  readonly answers: Readonly<Record<string, number>>;
  /** Answers to the set's probe questions, which no rule read. Absent when it has none. */
  readonly probes?: Readonly<Record<string, number>>;
  /** The redacted state the judgment was made on. */
  readonly state: string;
  readonly redactedKinds: readonly string[];
  readonly truncated: boolean;
  /** Present when the item did not settle. Carries its own `state`; see docs/adr/008. */
  readonly escalation?: EscalationItem;
  readonly latencyMs: number;
  readonly inputTokens?: number;
  /** The model that answered, as the backend reported it. Absent when it does not say. */
  readonly model?: string;
  /**
   * Present when the classifier could not answer.
   *
   * The item is reported rather than dropped, and it counts toward neither the verdict
   * tallies nor the escalation denominator: an item nobody judged is not an item the judge
   * settled, and quietly shrinking the denominator would flatter the ratio.
   */
  readonly error?: { readonly kind: string; readonly message: string };
}

export interface JudgeRun {
  readonly set: string;
  readonly backend: string;
  readonly items: readonly JudgedItem[];
  readonly manifest: EscalationManifest;
  /** Items the classifier answered. The manifest's denominator. */
  readonly judged: number;
  readonly failed: number;
  /** Summed over answered items. Undefined when the backend reports no token counts. */
  readonly inputTokens?: number;
  readonly latencyMs: number;
}

export interface JudgeOptions {
  readonly setName: string;
  readonly set: PolicySet;
  readonly mode: Mode;
  readonly adapter: Adapter;
  readonly timeoutMs: number;
  /** Items in flight at once. More is faster; the backend's rate limits are the ceiling. */
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * An item with its state already built.
 *
 * The runner judges states; which `StateBuilder` made one is the caller's business. That
 * is what lets `bouncer judge` build with `itemState` and `bouncer measure` build each
 * fixture with the builder its `kind` names, without either of them being a special case
 * in here.
 */
export interface StatedItem {
  readonly id: string;
  readonly state: BuiltState;
}

export async function judge(
  items: readonly StatedItem[],
  options: JudgeOptions,
): Promise<JudgeRun> {
  const questions = questionsOf(options.set);
  const probeNames = new Set(Object.keys(options.set.probeQuestions));

  const started = Date.now();
  const results: JudgedItem[] = new Array<JudgedItem>(items.length);
  let done = 0;

  // A fixed pool of workers pulling from a shared cursor, rather than chunking into batches
  // of N. Chunks wait for their slowest member before the next starts; a pool does not, and
  // on a batch where one item is much larger than the rest that is the whole difference.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const entry = items[index];
      if (entry === undefined) return;

      results[index] = await judgeOne(entry.id, entry.state, questions, probeNames, options);
      options.onProgress?.(++done, items.length);
    }
  };

  const width = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));

  const escalations = results.flatMap((r) => (r.escalation === undefined ? [] : [r.escalation]));
  // Unknown if any judged item went uncounted: a total over the items that happened to
  // report is not a smaller total, it is a wrong one. A failed item was never billed.
  const judged = results.filter((r) => r.error === undefined);
  const judgedCount = judged.length;
  const tokens =
    judged.length === 0
      ? undefined
      : judged.reduce<number | undefined>(
          (sum, r) => (sum === undefined || r.inputTokens === undefined ? undefined : sum + r.inputTokens),
          0,
        );

  return {
    set: options.setName,
    backend: options.adapter.name,
    items: results,
    manifest: manifestOf(escalations, judgedCount),
    judged: judgedCount,
    failed: results.length - judgedCount,
    ...(tokens !== undefined ? { inputTokens: tokens } : {}),
    latencyMs: Date.now() - started,
  };
}

async function judgeOne(
  id: string,
  state: BuiltState,
  questions: ReturnType<typeof questionsOf>,
  probeNames: ReadonlySet<string>,
  options: JudgeOptions,
): Promise<JudgedItem> {
  const base = {
    id,
    state: state.text,
    redactedKinds: state.redactedKinds,
    truncated: state.truncated,
  };

  let response: DecideResponse;
  try {
    response = await options.adapter.decide({
      state: state.text,
      questions,
      timeoutMs: options.timeoutMs,
    });
  } catch (err) {
    const kind = err instanceof AdapterError ? err.kind : "unavailable";
    return {
      ...base,
      verdict: "allow",
      reason: { kind: "no-rule-matched" },
      answers: {},
      latencyMs: 0,
      error: { kind, message: err instanceof Error ? err.message : String(err) },
    };
  }

  const answers: Record<string, number> = {};
  const probes: Record<string, number> = {};
  for (const name of Object.keys(questions)) {
    const p = noulProbability(response.answers[name]);
    if (p === undefined) continue;
    if (probeNames.has(name)) probes[name] = p;
    else answers[name] = p;
  }

  const decision = evaluate(options.set, options.mode, answers);

  // Half an answer is a failed item, the same as none: it stays out of the tallies and out
  // of the denominator, because nothing here was judged.
  if (decision.reason.kind === "unanswered") {
    return {
      ...base,
      verdict: "allow",
      reason: { kind: "no-rule-matched" },
      answers: {},
      latencyMs: response.latencyMs,
      error: { kind: "malformed_response", message: `no answer for: ${decision.reason.missing.join(", ")}` },
    };
  }

  const escalation = escalationFor(options.set, decision, answers, id);

  return {
    ...base,
    verdict: decision.verdict,
    reason: decision.reason,
    answers,
    ...(Object.keys(probes).length > 0 ? { probes } : {}),
    // A standalone manifest sets `state`, because there the item has to be readable on its
    // own — unlike the gate's, which sits on a log line that already carries the string.
    ...(escalation !== undefined ? { escalation: { ...escalation, state: state.text } } : {}),
    latencyMs: response.latencyMs,
    ...(response.inputTokens !== undefined ? { inputTokens: response.inputTokens } : {}),
    ...(response.model !== undefined ? { model: response.model } : {}),
  };
}

/** Verdict tallies over a run, for the summary line. */
export function tally(run: JudgeRun): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { allow: 0, ask: 0, deny: 0 };
  for (const item of run.items) {
    if (item.error !== undefined) continue;
    counts[item.verdict] += 1;
  }
  return counts;
}

export function formatRun(run: JudgeRun): string {
  const lines: string[] = [];
  const counts = tally(run);
  const rate = run.manifest.escalationRate;

  lines.push(`Set: ${run.set}   Backend: ${run.backend}`, "");
  lines.push(`  judged     ${run.judged}`);
  if (run.failed > 0) lines.push(`  failed     ${run.failed}`);
  lines.push(`  allow      ${counts.allow}`);
  lines.push(`  ask        ${counts.ask}`);
  if (counts.deny > 0) lines.push(`  deny       ${counts.deny}`);
  lines.push("");
  // The ratio the substitution play lives on, printed with its denominator rather than as
  // a bare percentage: one of one and one of a hundred are not the same claim.
  lines.push(`  escalated  ${run.manifest.items.length} / ${run.judged}  (${(rate * 100).toFixed(1)}%)`);

  if (run.inputTokens !== undefined && run.judged > 0) {
    lines.push(`  tokens in  ${run.inputTokens} total, ${Math.round(run.inputTokens / run.judged)} per item`);
  }
  lines.push(`  wall clock ${(run.latencyMs / 1000).toFixed(1)}s`);

  return `${lines.join("\n")}\n`;
}

export type { EscalationManifest };
