// The measurement harness: what the substitution actually bought.
//
// The claim this whole project rests on is that a judgment model can do the work a
// reasoning model was doing, for a fraction of the tokens, at a quality you can live with.
// That is a measurable claim and it has been asserted rather than measured everywhere so
// far. This measures it, on the user's own batch, against the user's own labels.
//
// Three passes over the same labelled fixtures, because two would measure the wrong thing:
//
//   judge      the policy set over every item. How good is the fast model alone.
//   reasoning  the reasoning command over every item. The ceiling, and the bill.
//   cascade    judge everything; re-ask only the escalation manifest's items.
//
// The third is the product. "The judgment model is 0.89 and the reasoning model is 0.94" is
// not a claim anyone can act on; "judge everything, re-adjudicate the 12% it flagged, land
// at 0.93 for a seventh of the tokens" is. A cascade's accuracy is not the judge's and its
// bill is not either, so it gets measured rather than inferred. See docs/adr/009 decision 5.
//
// Accuracy here means the same thing it means in `bouncer calibrate`: agreement with the
// fixture labels, at a 0.5 boundary, over the questions a fixture labels. The labels are
// hand-written judgments, so this is agreement with a human's intuitions rather than truth,
// and `formatMeasurement` says so rather than letting the table imply otherwise.

import type { Adapter } from "./adapters/types.js";
import { questionsOf, stateFor, type Fixture } from "./calibrate.js";
import type { EscalationItem } from "./engine/escalation.js";
import type { Mode, PolicySet } from "./engine/types.js";
import { judge, type JudgeRun, type StatedItem } from "./judge.js";
import type { ReasoningBackend, ReasoningResponse } from "./io/reasoning.js";

/** What one pass scored and what it cost. */
export interface PassResult {
  readonly name: "judge" | "reasoning" | "cascade";
  /** What produced the answers: a backend name, or both, for the cascade. */
  readonly by: string;
  /** Labelled (item, question) rows this pass answered. */
  readonly n: number;
  readonly correct: number;
  /** NaN when nothing was answered. */
  readonly accuracy: number;
  /** Undefined when a backend in this pass reported no counts — never silently zero. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Items this pass ran a model over. The denominator for tokens per item. */
  readonly items: number;
  /** Rows this pass could not answer, because a call failed or a question came back empty. */
  readonly unanswered: number;
}

export interface Measurement {
  readonly set: string;
  readonly fixtures: number;
  readonly passes: readonly PassResult[];
  /** Items the judge escalated, over items it judged. */
  readonly escalated: number;
  readonly judged: number;
  /** Items whose reasoning call failed outright, with the first error's message. */
  readonly reasoningFailures: number;
  readonly firstReasoningError?: string;
}

export interface MeasureOptions {
  readonly setName: string;
  readonly set: PolicySet;
  readonly mode: Mode;
  readonly adapter: Adapter;
  readonly reasoning: ReasoningBackend;
  readonly timeoutMs: number;
  readonly concurrency?: number;
  readonly onProgress?: (phase: "judge" | "reasoning" | "cascade", done: number, total: number) => void;
}

export async function measure(
  fixtures: readonly Fixture[],
  options: MeasureOptions,
): Promise<Measurement> {
  const stated: StatedItem[] = fixtures.map((f) => ({ id: f.id, state: stateFor(f) }));
  const byId = new Map(fixtures.map((f) => [f.id, f]));

  const judgeRun = await judge(stated, {
    setName: options.setName,
    set: options.set,
    mode: options.mode,
    adapter: options.adapter,
    timeoutMs: options.timeoutMs,
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    onProgress: (done, total) => options.onProgress?.("judge", done, total),
  });

  const judgeAnswers = new Map(judgeRun.items.map((i) => [i.id, i.answers]));
  const escalatedIds = new Set(judgeRun.manifest.items.map((i) => i.item));
  const signalsById = new Map(judgeRun.manifest.items.map((i) => [i.item, i.signals]));

  // The full reasoning pass runs over every item, and the cascade reuses its answers for
  // the escalated subset rather than asking twice. Asking twice would double the bill of a
  // measurement run and, worse, let the two passes disagree on the same item — which would
  // make the cascade row a different experiment rather than a subset of this one.
  const questions = questionsOf(options.set);
  const reasoning = new Map<string, ReasoningResponse>();
  const failures: string[] = [];

  let done = 0;
  for (const item of judgeRun.items) {
    try {
      reasoning.set(
        item.id,
        await options.reasoning.answer({
          item: item.id,
          state: item.state,
          questions,
          ...(signalsById.has(item.id) ? { signals: signalsById.get(item.id) as EscalationItem["signals"] } : {}),
        }),
      );
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
    options.onProgress?.("reasoning", ++done, judgeRun.items.length);
  }

  const reasoningAnswers = new Map([...reasoning].map(([id, r]) => [id, r.answers]));

  // The cascade: the judge's answer everywhere, replaced by the reasoning model's answer on
  // exactly the items the manifest named.
  const cascadeAnswers = new Map(judgeAnswers);
  for (const id of escalatedIds) {
    const answers = reasoningAnswers.get(id);
    if (answers !== undefined) cascadeAnswers.set(id, answers);
  }

  const reasoningTokens = sumTokens([...reasoning.values()]);
  const cascadeTokens = sumTokens([...escalatedIds].flatMap((id) => {
    const r = reasoning.get(id);
    return r === undefined ? [] : [r];
  }));

  const passes: PassResult[] = [
    {
      name: "judge",
      by: options.adapter.name,
      ...accuracyOf(byId, judgeAnswers),
      ...(judgeRun.inputTokens !== undefined ? { inputTokens: judgeRun.inputTokens } : {}),
      items: judgeRun.judged,
    },
    {
      name: "reasoning",
      by: options.reasoning.name,
      ...accuracyOf(byId, reasoningAnswers),
      ...reasoningTokens,
      items: reasoning.size,
    },
    {
      name: "cascade",
      by: `${options.adapter.name} + ${options.reasoning.name}`,
      ...accuracyOf(byId, cascadeAnswers),
      // Every item pays the judge; only the escalated ones pay the reasoning model. That
      // sum is the whole cost argument, so it is added rather than estimated.
      ...addTokens(
        judgeRun.inputTokens === undefined ? {} : { inputTokens: judgeRun.inputTokens },
        cascadeTokens,
      ),
      items: judgeRun.judged,
    },
  ];

  return {
    set: options.setName,
    fixtures: fixtures.length,
    passes,
    escalated: judgeRun.manifest.items.length,
    judged: judgeRun.judged,
    reasoningFailures: failures.length,
    ...(failures[0] !== undefined ? { firstReasoningError: failures[0] } : {}),
  };
}

/**
 * Agreement with the labels, over the questions each fixture labels.
 *
 * Identical in shape to what `calibrate` computes, deliberately: a measurement run and a
 * calibration run over the same fixtures should produce the same number for the judge, and
 * two different definitions of accuracy in one repository is how that stops being true.
 */
function accuracyOf(
  fixtures: ReadonlyMap<string, Fixture>,
  answers: ReadonlyMap<string, Readonly<Record<string, number>>>,
): { n: number; correct: number; accuracy: number; unanswered: number } {
  let n = 0;
  let correct = 0;
  let unanswered = 0;

  for (const [id, fixture] of fixtures) {
    const given = answers.get(id);
    for (const [question, expected] of Object.entries(fixture.expect)) {
      const p = given?.[question];
      // A question nobody answered is not a question anyone got wrong. Counting it as a
      // miss would charge a model for a failed HTTP call.
      if (p === undefined) {
        unanswered += 1;
        continue;
      }
      n += 1;
      if (p >= 0.5 === expected) correct += 1;
    }
  }

  return { n, correct, accuracy: n === 0 ? Number.NaN : correct / n, unanswered };
}

/** Undefined rather than zero when nothing reported a count. */
function sumTokens(responses: readonly ReasoningResponse[]): { inputTokens?: number; outputTokens?: number } {
  const add = (pick: (r: ReasoningResponse) => number | undefined): number | undefined =>
    responses.reduce<number | undefined>((sum, r) => {
      const value = pick(r);
      return value === undefined ? sum : (sum ?? 0) + value;
    }, undefined);

  const inputTokens = add((r) => r.inputTokens);
  const outputTokens = add((r) => r.outputTokens);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/**
 * Adds two token counts, and stays undefined if either side never reported one.
 *
 * "Undefined plus 400 is 400" would print a cascade cost that leaves out whichever half
 * did not count its tokens, and it would print it as a fact. A missing half means the total
 * is unknown, and the table says so.
 */
function addTokens(
  left: { inputTokens?: number; outputTokens?: number },
  right: { inputTokens?: number; outputTokens?: number },
): { inputTokens?: number; outputTokens?: number } {
  const both = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

  const inputTokens = both(left.inputTokens, right.inputTokens);
  const outputTokens = both(left.outputTokens, right.outputTokens);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

export function formatMeasurement(m: Measurement): string {
  const lines: string[] = [];
  const pct = (n: number) => (Number.isNaN(n) ? "     —" : `${(n * 100).toFixed(1).padStart(5)}%`);
  const num = (n?: number) => (n === undefined ? "—" : n.toLocaleString("en-US"));
  const per = (total: number | undefined, items: number) =>
    total === undefined || items === 0 ? "—" : Math.round(total / items).toLocaleString("en-US");

  const legend = new Map<string, string>();

  lines.push(`Set: ${m.set}   Fixtures: ${m.fixtures}`, "");
  lines.push("| pass | by | accuracy | n | input | output | in/item |");
  lines.push("|---|---|---|---|---|---|---|");

  // The atoms a cascade cell is composed of, in the order `measure()` joined them.
  const atoms = ["judge", "reasoning"].flatMap((n) => {
    const found = m.passes.find((p) => p.name === n);
    return found === undefined ? [] : [found.by];
  });

  for (const p of m.passes) {
    lines.push(
      `| ${p.name} | ${labelFor(p.by, legend, atoms)} | ${pct(p.accuracy)} | ${p.correct}/${p.n} | ` +
        `${num(p.inputTokens)} | ${num(p.outputTokens)} | ${per(p.inputTokens, p.items)} |`,
    );
  }

  // Any realistic reasoning command is a shell pipeline. Printed in the cell it turns the
  // table into one unreadable line, and the table is the deliverable — so the cell gets a
  // short name and the command is printed once, in full, underneath. Truncating in place
  // would have been worse than either: a command you cannot read and cannot look up.
  if (legend.size > 0) {
    lines.push("");
    for (const [short, full] of legend) lines.push(`  ${short} = ${full}`);
  }

  lines.push("");
  lines.push(
    `Escalated ${m.escalated} of ${m.judged} judged ` +
      `(${m.judged === 0 ? "—" : `${((m.escalated / m.judged) * 100).toFixed(1)}%`})` +
      " — the items the cascade row paid the reasoning model for.",
  );

  const judgePass = m.passes.find((p) => p.name === "judge");
  const cascade = m.passes.find((p) => p.name === "cascade");
  const full = m.passes.find((p) => p.name === "reasoning");

  if (
    cascade !== undefined &&
    full !== undefined &&
    cascade.inputTokens !== undefined &&
    full.inputTokens !== undefined &&
    full.inputTokens > 0
  ) {
    const ratio = cascade.inputTokens / full.inputTokens;
    const delta = cascade.accuracy - full.accuracy;
    const points = `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} points of accuracy against the labels`;

    lines.push("");
    if (ratio <= 1) {
      // The sentence the whole table exists to support, with both halves in it. A token
      // saving stated without what it cost in accuracy is the number a vendor would print.
      // 99.86% rounds to "100% fewer", which reads as free. It is not free, and the one
      // number this whole command exists to produce should not overstate itself by rounding.
      const saved = (1 - ratio) * 100;
      const savedText = cascade.inputTokens === 0 ? "100" : saved >= 99.5 ? ">99" : saved.toFixed(0);
      lines.push(`The cascade used ${savedText}% fewer input tokens than the reasoning pass, at ${points}.`);
    } else {
      // The honest failure mode, and the reason the rate is printed next to the cost: past
      // some escalation rate, judging first and then re-asking costs more than just asking.
      // A harness that could only report savings would never say so.
      lines.push(
        `The cascade cost ${moreText(ratio)}% MORE input tokens than simply running the` +
          ` reasoning pass on everything, at ${points}.`,
        `At ${m.judged === 0 ? "this" : `${((m.escalated / m.judged) * 100).toFixed(0)}%`} escalation it is not` +
          " worth running: either the thresholds are too wide or the questions are not separating the batch.",
      );
    }

    if (judgePass !== undefined && !Number.isNaN(judgePass.accuracy)) {
      const worth = cascade.accuracy - judgePass.accuracy;
      lines.push(
        worth === 0
          ? `The judge alone scored ${(judgePass.accuracy * 100).toFixed(1)}%, so the escalations changed no verdict.`
          : `The judge alone scored ${(judgePass.accuracy * 100).toFixed(1)}%, so the escalations are worth ${(worth * 100).toFixed(1)} points.`,
      );
    }
  }

  if (m.reasoningFailures > 0) {
    lines.push(
      "",
      `${m.reasoningFailures} reasoning call${m.reasoningFailures === 1 ? "" : "s"} failed and are excluded` +
        ` from the rows above. First error: ${m.firstReasoningError ?? "(none recorded)"}`,
    );
  }

  const unanswered = m.passes.reduce((sum, p) => sum + p.unanswered, 0);
  if (unanswered > 0) {
    lines.push(`${unanswered} labelled rows went unanswered and are excluded rather than counted wrong.`);
  }

  lines.push(
    "",
    "Accuracy is agreement with the fixture labels at a 0.5 boundary, not accuracy against",
    "ground truth. The labels are hand-written judgments about what should be flagged, which",
    "is the right thing to measure when you also set the thresholds — but it is what this is.",
  );

  return `${lines.join("\n")}\n`;
}

/** Rounds away from zero, so a cascade that cost more never reports costing 0% more. */
function moreText(ratio: number): string {
  const more = (ratio - 1) * 100;
  return more < 0.5 ? "<1" : more.toFixed(0);
}

/**
 * The name for the `by` cell, registering anything shortened in the legend.
 *
 * A backend name like `mock` or `jev` is already short and passes through untouched. A
 * reasoning command is a whole shell pipeline, so it becomes the basename of the program it
 * starts with.
 *
 * `names` is how the cascade's cell gets both of its halves shortened. It is built from the
 * two backends the cascade was composed from, never by splitting the cascade's own string on
 * the `" + "` this module joined it with: a reasoning command is arbitrary shell and a `jq`
 * filter that adds two token fields contains that exact separator.
 */
function labelFor(by: string, legend: Map<string, string>, names: readonly string[]): string {
  const composed = names.join(" + ");
  if (by === composed && names.length > 1) {
    return names.map((name) => shortAtom(name, legend)).join(" + ");
  }
  return shortAtom(by, legend);
}

const MAX_CELL = 24;

function shortAtom(atom: string, legend: Map<string, string>): string {
  if (atom.length <= MAX_CELL) return atom;

  const program = (atom.trim().split(/\s/)[0] ?? atom).split("/").pop() ?? atom;
  const base = program.length > 0 && program.length <= MAX_CELL ? program : atom.slice(0, MAX_CELL);

  // Two different commands starting with the same program would otherwise share one legend
  // entry and the table would claim they were the same pass.
  let short = base;
  for (let n = 2; legend.has(short) && legend.get(short) !== atom; n++) short = `${base}#${n}`;

  legend.set(short, atom);
  return short;
}
