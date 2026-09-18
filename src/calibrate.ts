// The calibration harness.
//
// This is the release gate, and the reason bouncer ships observing. Nobody should be
// asked to enable enforcement on the strength of a README claiming the classifier is
// good; they should look at a table.
//
// What the table measures is worth being precise about: it is the classifier's agreement
// with the fixture labels. The labels are hand-written judgments about what *should*
// warrant a prompt, so this is agreement with a human's policy intuitions, not accuracy
// against ground truth. Since the user is also the one setting the thresholds, that is
// the right thing to measure — but the README has to say so rather than imply otherwise.
//
// Fixtures are tool calls rather than pre-built states, so a run exercises the state
// builder and redaction too. A state-builder regression that stops the classifier seeing
// a path is a calibration regression, and this is where it should show up.

import { readFileSync } from "node:fs";
import type { Adapter, Question } from "./adapters/types.js";
import { noulProbability } from "./adapters/types.js";
import { buildState, commandOf } from "./engine/state.js";
import { evaluate } from "./engine/evaluate.js";
import { matchHardRule } from "./engine/hardrules.js";
import type { CalibrationPolicy, Policy, Verdict } from "./engine/types.js";

export interface Fixture {
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly cwd?: string;
  readonly permission_mode?: string;
  readonly target_exists?: boolean;
  /** Expected answer per question. Questions not listed are not scored. */
  readonly expect: Readonly<Record<string, boolean>>;
  /** Why the label is what it is. Required — an unexplained label cannot be argued with. */
  readonly note: string;
  /** The fixture this one is the near-miss counterpart of. */
  readonly pair?: string;
}

export interface Scored {
  readonly fixture: Fixture;
  readonly question: string;
  readonly expected: boolean;
  readonly p: number;
  readonly predicted: boolean;
  readonly correct: boolean;
  /** Probability assigned to the predicted class: max(p, 1-p). */
  readonly confidence: number;
  /**
   * What the policy's rules would decide for this fixture, from every question's answer
   * rather than only the labelled ones. Same for each row of a fixture.
   *
   * `correct` above compares the answer to the label at a 0.5 boundary. The rules do not
   * act at 0.5 — `unreviewed_execution` fires at 0.65 — so the two can disagree, and a
   * question can report perfect accuracy while a fixture labelled `true` is allowed.
   * That gap is what `disagreements` below reports.
   */
  readonly verdict: Verdict;
  /**
   * What produced the verdict, for explaining it.
   *
   * `source` is `hard_rule` when a `gate.hard_rules` entry decided, in which case `question`
   * is the entry's name and `p` is NaN — a hard rule has no probability, which is the point
   * of it.
   */
  readonly verdictReason: {
    readonly question: string;
    readonly p: number;
    readonly source: "hard_rule" | "rule";
  };
}

/**
 * A fixture whose labels and whose verdict tell different stories.
 *
 * `missed`: some question is labelled `true` and the policy still allows it. Whatever the
 * accuracy column says, the gate does nothing here.
 * `friction`: every question is labelled `false` and the policy asks anyway. CLAUDE.md
 * calls this the failure mode, and nothing else in the table measures it.
 */
export interface Disagreement {
  readonly fixture: Fixture;
  readonly kind: "missed" | "friction";
  readonly verdict: Verdict;
  readonly question: string;
  readonly p: number;
}

export interface QuestionReport {
  readonly question: string;
  readonly n: number;
  readonly accuracy: number;
  /** Mean squared error against the label. Lower is better; 0.25 is a coin flip. */
  readonly brier: number;
  readonly buckets: readonly Bucket[];
  readonly misses: readonly Scored[];
  readonly gate: GateResult;
}

/**
 * A question measured against the release gate in `policy.calibration`.
 *
 * Computed here rather than read off the bucket columns. The buckets round to whole
 * percents and split at 0.8, so eyeballing them invites exactly the mistake this exists
 * to prevent: 11 of 13 is 84.6%, which displays as 85% and is under an 0.85 bar.
 */
export interface GateResult {
  /** Answers at or above the confidence floor. The gate's denominator. */
  readonly n: number;
  readonly correct: number;
  /** NaN when `n` is 0: a question nothing answered confidently has no accuracy. */
  readonly accuracy: number;
  /** False when `n` is 0 — an unmeasured question has not cleared anything. */
  readonly passes: boolean;
}

export interface Bucket {
  readonly low: number;
  readonly high: number;
  readonly n: number;
  readonly accuracy: number;
}

const BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0001], // inclusive of 1.0
];

export function parseFixtures(source: string): Fixture[] {
  const fixtures: Fixture[] = [];

  source.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) return;

    let parsed: Fixture;
    try {
      parsed = JSON.parse(trimmed) as Fixture;
    } catch (err) {
      throw new Error(`fixture line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const field of ["id", "tool", "note"] as const) {
      if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
        throw new Error(`fixture line ${i + 1} is missing "${field}"`);
      }
    }
    if (typeof parsed.expect !== "object" || parsed.expect === null || Object.keys(parsed.expect).length === 0) {
      throw new Error(`fixture "${parsed.id}" has no expectations, so it scores nothing`);
    }

    fixtures.push(parsed);
  });

  return fixtures;
}

export function loadFixtures(path: string): Fixture[] {
  return parseFixtures(readFileSync(path, "utf8"));
}

export async function score(
  fixtures: readonly Fixture[],
  policy: Policy,
  adapter: Adapter,
  onProgress?: (done: number, total: number) => void,
): Promise<Scored[]> {
  const questions: Record<string, Question> = {};
  for (const [name, q] of Object.entries(policy.gate.questions)) {
    questions[name] = { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
  }

  const results: Scored[] = [];

  for (const [i, fixture] of fixtures.entries()) {
    const state = buildState({
      toolName: fixture.tool,
      toolInput: fixture.input,
      cwd: fixture.cwd ?? "/home/user/project",
      ...(fixture.permission_mode !== undefined ? { permissionMode: fixture.permission_mode } : {}),
      ...(fixture.target_exists !== undefined ? { targetExists: fixture.target_exists } : {}),
    });

    const response = await adapter.decide({ state: state.text, questions, timeoutMs: 30_000 });

    // Every question's answer, not just the labelled ones: the `any` uncertainty rule
    // reads all of them, so a verdict computed from a subset would not be the real one.
    const answers: Record<string, number> = {};
    for (const name of Object.keys(questions)) {
      const value = noulProbability(response.answers[name]);
      if (value !== undefined) answers[name] = value;
    }
    // Hard rules decide before the classifier at hook time, so the verdict reported here
    // has to come from them too — otherwise the `missed` and `friction` sections describe
    // a policy that is not the one installed. The adapter is still called for every
    // fixture regardless: the accuracy and Brier columns measure the classifier, and hard
    // rules neither help nor hurt a question's answer.
    //
    // The fast path is deliberately still not modelled here, unchanged from run 7. It
    // would only ever turn an `ask` into an `allow`, and doing it in the same run as this
    // change would make two things move at once.
    const hard = matchHardRule(policy.gate.hardRules, commandOf(fixture.tool, fixture.input));
    const decision = hard === undefined ? evaluate(policy, answers) : undefined;

    const verdict: Verdict = hard?.verdict ?? decision?.verdict ?? "allow";
    const verdictReason = hard !== undefined
      ? { question: hard.name, p: Number.NaN, source: "hard_rule" as const }
      : {
          question: decision?.reason.kind === "rule" ? decision.reason.question : "default",
          p: decision?.reason.kind === "rule" ? decision.reason.p : Number.NaN,
          source: "rule" as const,
        };

    for (const [question, expected] of Object.entries(fixture.expect)) {
      const p = noulProbability(response.answers[question]);
      // A question the classifier did not answer is not scored. Counting it as wrong
      // would blame the model for an adapter problem.
      if (p === undefined) continue;

      const predicted = p >= 0.5;
      results.push({
        fixture,
        question,
        expected,
        p,
        predicted,
        correct: predicted === expected,
        confidence: Math.max(p, 1 - p),
        verdict,
        verdictReason,
      });
    }

    onProgress?.(i + 1, fixtures.length);
  }

  return results;
}

export function report(scored: readonly Scored[], calibration: CalibrationPolicy): QuestionReport[] {
  const byQuestion = new Map<string, Scored[]>();
  for (const s of scored) {
    const list = byQuestion.get(s.question) ?? [];
    list.push(s);
    byQuestion.set(s.question, list);
  }

  return [...byQuestion.entries()]
    .map(([question, items]) => ({
      question,
      n: items.length,
      gate: gateResult(items, calibration),
      accuracy: items.filter((i) => i.correct).length / items.length,
      brier: items.reduce((sum, i) => sum + (i.p - (i.expected ? 1 : 0)) ** 2, 0) / items.length,
      buckets: BUCKETS.map(([low, high]) => {
        const inBucket = items.filter((i) => i.confidence >= low && i.confidence < high);
        return {
          low,
          high: Math.min(high, 1),
          n: inBucket.length,
          accuracy: inBucket.length === 0 ? Number.NaN : inBucket.filter((i) => i.correct).length / inBucket.length,
        };
      }),
      misses: items.filter((i) => !i.correct).sort((a, b) => b.confidence - a.confidence),
    }))
    .sort((a, b) => a.question.localeCompare(b.question));
}

/**
 * Fixtures where the labels and the policy's verdict disagree.
 *
 * The accuracy columns compare each answer to its label at a 0.5 boundary. The rules act
 * at their own thresholds — 0.65 for `unreviewed_execution`, 0.70 for `destructive` — and
 * the uncertainty rule covers 0.40 to 0.60, so between 0.60 and a rule's threshold a
 * question is neither confident enough to fire nor uncertain enough to catch. A fixture
 * landing there is scored correct and allowed, and nothing else in the report says so.
 *
 * The verdict is the rules' outcome, not what the hook emits: in `observe` mode nothing is
 * emitted at all, and the question this answers is what would happen under `guard`.
 */
export function disagreements(scored: readonly Scored[]): Disagreement[] {
  const byFixture = new Map<string, Scored[]>();
  for (const s of scored) {
    const list = byFixture.get(s.fixture.id) ?? [];
    list.push(s);
    byFixture.set(s.fixture.id, list);
  }

  const out: Disagreement[] = [];

  for (const items of byFixture.values()) {
    const first = items[0];
    if (first === undefined) continue;
    const anyTrue = items.some((i) => i.expected);
    const asks = first.verdict !== "allow";

    if (anyTrue && !asks) {
      // Report the labelled-true question that came closest to firing: that is the one
      // whose threshold is worth arguing about.
      const closest = items.filter((i) => i.expected).sort((a, b) => b.p - a.p)[0] ?? first;
      out.push({
        fixture: first.fixture,
        kind: "missed",
        verdict: first.verdict,
        question: closest.question,
        p: closest.p,
      });
    } else if (!anyTrue && asks) {
      out.push({
        fixture: first.fixture,
        kind: "friction",
        verdict: first.verdict,
        question: first.verdictReason.question,
        p: first.verdictReason.p,
      });
    }
  }

  return out.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.fixture.id.localeCompare(b.fixture.id),
  );
}

/** `outside_repo 0.77`, or `hard rule reads-a-credential-file` when there is no number. */
function describeSource(d: Disagreement): string {
  return Number.isNaN(d.p) ? `hard rule ${d.question}` : `${d.question} ${d.p.toFixed(2)}`;
}

function gateResult(items: readonly Scored[], calibration: CalibrationPolicy): GateResult {
  const confident = items.filter((i) => i.confidence >= calibration.confidenceFloor);
  const correct = confident.filter((i) => i.correct).length;

  if (confident.length === 0) {
    return { n: 0, correct: 0, accuracy: Number.NaN, passes: false };
  }

  const accuracy = correct / confident.length;
  // Compared as the exact ratio, never as the rounded percentage. 11/13 is 0.846, which
  // is below an 0.85 bar however it prints.
  return { n: confident.length, correct, accuracy, passes: accuracy >= calibration.accuracyBar };
}

export function formatReport(
  reports: readonly QuestionReport[],
  backend: string,
  calibration: CalibrationPolicy,
  scored: readonly Scored[] = [],
): string {
  const lines: string[] = [];
  const pct = (n: number) => (Number.isNaN(n) ? "   —" : `${(n * 100).toFixed(0).padStart(3)}%`);
  // One decimal in the gate table, whole percents in the bucket table above it. The bar
  // is compared on the exact ratio either way, but a gate row printing "85%" next to a
  // "no" reads as a typo rather than as 84.6%.
  const gatePct = (n: number) => (Number.isNaN(n) ? "    —" : `${(n * 100).toFixed(1).padStart(4)}%`);

  lines.push(`Backend: ${backend}`, "");
  lines.push("| question | n | accuracy | Brier | 0.5–0.6 | 0.6–0.7 | 0.7–0.8 | 0.8–0.9 | 0.9–1.0 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");

  for (const r of reports) {
    const buckets = r.buckets.map((b) => (b.n === 0 ? " — " : `${pct(b.accuracy)} (${b.n})`)).join(" | ");
    lines.push(`| ${r.question} | ${r.n} | ${pct(r.accuracy)} | ${r.brier.toFixed(3)} | ${buckets} |`);
  }

  const floor = calibration.confidenceFloor.toFixed(2);
  const bar = calibration.accuracyBar.toFixed(2);
  lines.push("", `Against the gate (≥ ${bar} accuracy at confidence ≥ ${floor}):`, "");
  lines.push("| question | correct / n | accuracy | passes |");
  lines.push("|---|---|---|---|");

  for (const r of reports) {
    const g = r.gate;
    const counts = g.n === 0 ? "— / 0" : `${g.correct} / ${g.n}`;
    lines.push(`| ${r.question} | ${counts} | ${gatePct(g.accuracy)} | ${g.passes ? "yes" : "no"} |`);
  }

  const failing = reports.filter((r) => !r.gate.passes);
  lines.push(
    "",
    failing.length === 0
      ? `Every question clears the bar (${reports.length} of ${reports.length}).`
      : `${reports.length - failing.length} of ${reports.length} clear the bar. Below it: ${failing.map((r) => r.question).join(", ")}.`,
  );

  const disagreed = disagreements(scored);
  lines.push("", "What the policy would actually do, where that differs from the labels:", "");
  if (disagreed.length === 0) {
    lines.push("  Nothing. Every fixture's verdict matches its labels.");
  } else {
    for (const d of disagreed) {
      lines.push(
        d.kind === "missed"
          ? `  missed   ${d.fixture.id}: ${d.question} ${d.p.toFixed(2)}, labelled true, verdict ${d.verdict}`
          : `  friction ${d.fixture.id}: labelled false throughout, verdict ${d.verdict} on ${describeSource(d)}`,
      );
    }
    lines.push(
      "",
      "  `missed` is a fixture the labels say should prompt that the rules allow; `friction`",
      "  is one they say should not that the rules prompt on. Accuracy above is measured at a",
      "  0.5 boundary and the rules fire at their own thresholds, so a question can be 100%",
      "  accurate and still appear here.",
    );
  }

  const all = reports.flatMap((r) => r.misses);
  if (all.length > 0) {
    lines.push("", `Disagreements (${all.length}), most confident first:`, "");
    // Confident disagreements are the interesting ones: either the label is wrong or the
    // question is worded badly. A hedged disagreement is just uncertainty.
    for (const miss of all.sort((a, b) => b.confidence - a.confidence).slice(0, 20)) {
      lines.push(
        `  ${miss.question} on ${miss.fixture.id}: said ${miss.p.toFixed(2)}, label says ${miss.expected ? "true" : "false"}`,
      );
      lines.push(`      ${miss.fixture.note}`);
    }
  }

  lines.push(
    "",
    "This table measures the classifier's agreement with the fixture labels. The labels are",
    "hand-written judgments about what should warrant a prompt, so this is agreement with a",
    "human's policy intuitions, not accuracy against ground truth.",
  );

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// --compare: two backends, one fixture set, side by side.
// ---------------------------------------------------------------------------

/**
 * One question's numbers under both backends, over the answers they both produced.
 *
 * Paired rather than aggregated separately: if one backend failed to answer a fixture, the
 * other's answer for it is dropped too. Comparing a 94-row mean against an 89-row mean and
 * calling the difference a backend difference is how a harness lies to you quietly.
 */
export interface ComparisonRow {
  readonly question: string;
  readonly n: number;
  readonly accuracy: readonly [number, number];
  readonly brier: readonly [number, number];
  /** Mean absolute difference in p. How far apart the two are, independent of either being right. */
  readonly meanDelta: number;
  readonly gate: readonly [GateResult, GateResult];
}

export interface Comparison {
  readonly backends: readonly [string, string];
  readonly rows: readonly ComparisonRow[];
  /** Fixtures where the policy's verdict differs between backends — the user-visible bit. */
  readonly verdicts: { readonly same: number; readonly total: number; readonly differing: readonly VerdictDiff[] };
  /** The answers furthest apart, most distant first. */
  readonly widest: readonly PairedScore[];
}

export interface VerdictDiff {
  readonly fixture: Fixture;
  readonly verdicts: readonly [Verdict, Verdict];
}

export interface PairedScore {
  readonly fixture: Fixture;
  readonly question: string;
  readonly expected: boolean;
  readonly p: readonly [number, number];
}

const pairKey = (s: Scored): string => `${s.fixture.id}::${s.question}`;

/**
 * Pair two runs over the same fixtures.
 *
 * Neither side is privileged: `a` is whatever the user named first. The verdicts compared
 * are the policy's, computed from each backend's own answers, which is the question a user
 * swapping backends is actually asking — not "do the probabilities agree" but "would this
 * have prompted me in different places".
 */
export function compare(
  a: { readonly backend: string; readonly scored: readonly Scored[] },
  b: { readonly backend: string; readonly scored: readonly Scored[] },
  calibration: CalibrationPolicy,
): Comparison {
  const bByKey = new Map(b.scored.map((s) => [pairKey(s), s]));
  const paired: Array<readonly [Scored, Scored]> = [];
  for (const left of a.scored) {
    const right = bByKey.get(pairKey(left));
    if (right !== undefined) paired.push([left, right]);
  }

  const byQuestion = new Map<string, Array<readonly [Scored, Scored]>>();
  for (const pair of paired) {
    const list = byQuestion.get(pair[0].question) ?? [];
    list.push(pair);
    byQuestion.set(pair[0].question, list);
  }

  const rows: ComparisonRow[] = [...byQuestion.entries()]
    .map(([question, items]) => {
      const side = (i: 0 | 1): Scored[] => items.map((pair) => pair[i]);
      const brierOf = (rows: Scored[]) =>
        rows.reduce((sum, r) => sum + (r.p - (r.expected ? 1 : 0)) ** 2, 0) / rows.length;
      const accuracyOf = (rows: Scored[]) => rows.filter((r) => r.correct).length / rows.length;

      return {
        question,
        n: items.length,
        accuracy: [accuracyOf(side(0)), accuracyOf(side(1))] as const,
        brier: [brierOf(side(0)), brierOf(side(1))] as const,
        meanDelta: items.reduce((sum, [l, r]) => sum + Math.abs(l.p - r.p), 0) / items.length,
        gate: [gateResult(side(0), calibration), gateResult(side(1), calibration)] as const,
      };
    })
    .sort((x, y) => x.question.localeCompare(y.question));

  // Verdicts are per fixture, not per answer, so collapse to the first row of each.
  const verdictByFixture = new Map<string, readonly [Scored, Scored]>();
  for (const pair of paired) {
    if (!verdictByFixture.has(pair[0].fixture.id)) verdictByFixture.set(pair[0].fixture.id, pair);
  }

  const differing: VerdictDiff[] = [];
  for (const [left, right] of verdictByFixture.values()) {
    if (left.verdict !== right.verdict) {
      differing.push({ fixture: left.fixture, verdicts: [left.verdict, right.verdict] });
    }
  }
  differing.sort((x, y) => x.fixture.id.localeCompare(y.fixture.id));

  const widest: PairedScore[] = paired
    .map(([left, right]) => ({
      fixture: left.fixture,
      question: left.question,
      expected: left.expected,
      p: [left.p, right.p] as const,
    }))
    .sort((x, y) => Math.abs(y.p[0] - y.p[1]) - Math.abs(x.p[0] - x.p[1]));

  return {
    backends: [a.backend, b.backend],
    rows,
    verdicts: { same: verdictByFixture.size - differing.length, total: verdictByFixture.size, differing },
    widest,
  };
}

export function formatComparison(comparison: Comparison, calibration: CalibrationPolicy): string {
  const [left, right] = comparison.backends;
  const lines: string[] = [];
  const pct = (n: number) => (Number.isNaN(n) ? "   —" : `${(n * 100).toFixed(0).padStart(3)}%`);

  lines.push(
    `${left} vs ${right}`,
    "",
    // The one thing a reader is most likely to assume and be wrong about. Jev's noul
    // answers carry no confidence field at all, so there is nothing on that side to put in
    // a confidence column, and a column only the local side could fill would invite exactly
    // the comparison it cannot support.
    "A noul answer is a bare probability. Jev returns no confidence field for one, and the",
    "local adapter's softmax over two label tokens is not one either, so this compares p and",
    "Brier and nothing else. The confidence used by the gate below is the derived statistic",
    "max(p, 1 - p), computed the same way on both sides.",
    "",
  );

  lines.push(`| question | n | acc ${left} | acc ${right} | Brier ${left} | Brier ${right} | mean delta p |`);
  lines.push("|---|---|---|---|---|---|---|");
  for (const row of comparison.rows) {
    lines.push(
      `| ${row.question} | ${row.n} | ${pct(row.accuracy[0])} | ${pct(row.accuracy[1])} | ` +
        `${row.brier[0].toFixed(3)} | ${row.brier[1].toFixed(3)} | ${row.meanDelta.toFixed(3)} |`,
    );
  }

  const floor = calibration.confidenceFloor.toFixed(2);
  const bar = calibration.accuracyBar.toFixed(2);
  lines.push("", `Against the gate (at least ${bar} accuracy at confidence ${floor} or above):`, "");
  lines.push(`| question | ${left} | ${right} |`);
  lines.push("|---|---|---|");
  for (const row of comparison.rows) {
    const cell = (g: GateResult) => (g.n === 0 ? "— / 0" : `${g.correct} / ${g.n}  ${g.passes ? "yes" : "no"}`);
    lines.push(`| ${row.question} | ${cell(row.gate[0])} | ${cell(row.gate[1])} |`);
  }

  // The Brier difference is the definition of done in PRD section 12; state it rather than
  // leaving it to be read off the table, since "within 5 points, or say how far off" is a
  // sentence somebody has to write either way.
  const brierDelta = meanOf(comparison.rows.map((r) => r.brier[1] - r.brier[0]));
  lines.push(
    "",
    Number.isNaN(brierDelta)
      ? "No question was answered by both backends, so there is nothing to compare."
      : `Mean Brier across questions: ${right} is ${Math.abs(brierDelta).toFixed(3)} ` +
        `${brierDelta > 0 ? "worse" : "better"} than ${left}.`,
  );

  const { same, total, differing } = comparison.verdicts;
  lines.push("", `The policy reaches the same verdict on ${same} of ${total} fixtures.`);
  if (differing.length > 0) {
    lines.push("", "Where it does not:", "");
    for (const d of differing.slice(0, 20)) {
      lines.push(`  ${d.fixture.id}: ${left} ${d.verdicts[0]}, ${right} ${d.verdicts[1]}`);
    }
    if (differing.length > 20) lines.push(`  ... and ${differing.length - 20} more.`);
  }

  const widest = comparison.widest.filter((w) => Math.abs(w.p[0] - w.p[1]) >= 0.2).slice(0, 15);
  if (widest.length > 0) {
    lines.push("", "Furthest apart on p (0.20 or more), widest first:", "");
    for (const w of widest) {
      lines.push(
        `  ${w.question} on ${w.fixture.id}: ${left} ${w.p[0].toFixed(2)}, ${right} ${w.p[1].toFixed(2)} ` +
          `(label ${w.expected ? "true" : "false"})`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
