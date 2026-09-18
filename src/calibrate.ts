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
import { buildState } from "./engine/state.js";
import { evaluate } from "./engine/evaluate.js";
import type { CalibrationPolicy, Policy, Verdict } from "./engine/types.js";
import type { DecisionRecord } from "./io/log.js";

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
  /** The question and probability the winning rule matched on, for explaining a verdict. */
  readonly verdictReason: { readonly question: string; readonly p: number };
  /**
   * True when this row scores a `gate.probe_questions` entry rather than a live one.
   *
   * Probe rows are kept out of the gate table, out of the "N of N clear the bar" line and
   * out of the verdict comparison. A probe changed no verdict, so counting it toward the
   * release gate would let an experiment decide whether the product ships.
   */
  readonly probe: boolean;
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

  // Probes go in the same fan-out here for the same reason they do in the hook: a run
  // that asked them separately would not be measuring what production asks. They are
  // scored only where a fixture labels them, and never enter the verdict below.
  const probeNames = new Set(Object.keys(policy.gate.probeQuestions));
  for (const [name, q] of Object.entries(policy.gate.probeQuestions)) {
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
      if (probeNames.has(name)) continue;
      const value = noulProbability(response.answers[name]);
      if (value !== undefined) answers[name] = value;
    }
    const decision = evaluate(policy, answers);
    const verdictReason = {
      question: decision.reason.kind === "rule" ? decision.reason.question : "default",
      p: decision.reason.kind === "rule" ? decision.reason.p : Number.NaN,
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
        verdict: decision.verdict,
        verdictReason,
        probe: probeNames.has(question),
      });
    }

    onProgress?.(i + 1, fixtures.length);
  }

  return results;
}

export function report(scored: readonly Scored[], calibration: CalibrationPolicy): QuestionReport[] {
  const byQuestion = new Map<string, Scored[]>();
  for (const s of scored) {
    if (s.probe) continue;
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
    // A probe answered nothing about this fixture's verdict, so letting one into
    // `anyTrue` would invent a `missed` out of a question no rule consulted.
    if (s.probe) continue;
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

/**
 * How the probes did, where a fixture labelled one.
 *
 * Deliberately not a `QuestionReport`: there is no gate row and no pass/fail. A probe is a
 * candidate, and the only useful thing to say about it is how its answers compare to the
 * labels next to the question it is a candidate to replace.
 */
export interface ProbeReport {
  readonly question: string;
  readonly n: number;
  readonly accuracy: number;
  readonly brier: number;
  readonly misses: readonly Scored[];
}

export function probeReport(scored: readonly Scored[]): ProbeReport[] {
  const byQuestion = new Map<string, Scored[]>();
  for (const s of scored) {
    if (!s.probe) continue;
    const list = byQuestion.get(s.question) ?? [];
    list.push(s);
    byQuestion.set(s.question, list);
  }

  return [...byQuestion.entries()]
    .map(([question, items]) => ({
      question,
      n: items.length,
      accuracy: items.filter((i) => i.correct).length / items.length,
      brier: items.reduce((sum, i) => sum + (i.p - (i.expected ? 1 : 0)) ** 2, 0) / items.length,
      misses: items.filter((i) => !i.correct).sort((a, b) => b.confidence - a.confidence),
    }))
    .sort((a, b) => a.question.localeCompare(b.question));
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

  const probes = probeReport(scored);
  if (probes.length > 0) {
    lines.push(
      "",
      "Probes (gate.probe_questions). Asked in the same call, read by no rule, counted",
      "toward no gate — this is what they would have said:",
      "",
    );
    lines.push("| probe | n | accuracy | Brier |");
    lines.push("|---|---|---|---|");
    for (const r of probes) {
      lines.push(`| ${r.question} | ${r.n} | ${pct(r.accuracy)} | ${r.brier.toFixed(3)} |`);
    }
  }

  const disagreed = disagreements(scored);
  lines.push("", "What the policy would actually do, where that differs from the labels:", "");
  if (disagreed.length === 0) {
    lines.push("  Nothing. Every fixture's verdict matches its labels.");
  } else {
    for (const d of disagreed) {
      lines.push(
        d.kind === "missed"
          ? `  missed   ${d.fixture.id}: ${d.question} ${d.p.toFixed(2)}, labelled true, verdict ${d.verdict}`
          : `  friction ${d.fixture.id}: labelled false throughout, verdict ${d.verdict} on ${d.question} ${d.p.toFixed(2)}`,
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

// --- Probes recovered from the decision log -----------------------------------------
//
// The point of a probe is that it is answered on real traffic, for free, on every gated
// call. That traffic is richer than any fixture file: it is the commands this user
// actually runs, in the proportions they actually run them. What it does not carry is a
// label, because nothing in a live session knows whether a prompt would have been wanted.
//
// So labels are supplied separately, by a human, keyed by the `tool_use_id` already in
// every log line. A probe answer with a label is scored; one without is counted and
// skipped. The skipped count is reported rather than hidden, because "n = 3" and
// "n = 3 of 812 seen" say very different things about a number.

/** A label a human attached to one logged decision: question name to expected answer. */
export type LoggedLabels = ReadonlyMap<string, Readonly<Record<string, boolean>>>;

export interface LoggedProbeReport {
  readonly question: string;
  /** Answers found in the log, labelled or not. */
  readonly n: number;
  /** Of those, the ones a label could be found for. The denominator of everything below. */
  readonly labelled: number;
  /** NaN when nothing was labelled — an unscored probe has no accuracy, not 0%. */
  readonly accuracy: number;
  readonly brier: number;
}

/**
 * Reads a labels file: one JSON object per line, `{"tool_use_id": "...", "expect": {...}}`.
 *
 * Blank lines and `//` comments are skipped, matching the fixture format, so a file can
 * carry a note about why a line is labelled the way it is.
 */
export function parseLoggedLabels(source: string): Map<string, Record<string, boolean>> {
  const labels = new Map<string, Record<string, boolean>>();

  source.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) return;

    let parsed: { tool_use_id?: unknown; expect?: unknown };
    try {
      parsed = JSON.parse(trimmed) as typeof parsed;
    } catch (err) {
      throw new Error(`label line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (typeof parsed.tool_use_id !== "string" || parsed.tool_use_id.length === 0) {
      throw new Error(`label line ${i + 1} is missing "tool_use_id"`);
    }
    if (typeof parsed.expect !== "object" || parsed.expect === null) {
      throw new Error(`label "${parsed.tool_use_id}" is missing "expect"`);
    }

    const expect: Record<string, boolean> = {};
    for (const [question, value] of Object.entries(parsed.expect as Record<string, unknown>)) {
      if (typeof value !== "boolean") {
        throw new Error(`label "${parsed.tool_use_id}" gives a non-boolean for "${question}"`);
      }
      expect[question] = value;
    }

    labels.set(parsed.tool_use_id, expect);
  });

  return labels;
}

export function loadLoggedLabels(path: string): Map<string, Record<string, boolean>> {
  return parseLoggedLabels(readFileSync(path, "utf8"));
}

/** Every probe answer in the log, scored where a label exists for it. */
export function scoreLoggedProbes(
  records: readonly DecisionRecord[],
  labels: LoggedLabels,
): LoggedProbeReport[] {
  const seen = new Map<string, { n: number; scored: Array<{ p: number; expected: boolean }> }>();

  for (const record of records) {
    if (record.probes === undefined) continue;
    const expect = record.tool_use_id === undefined ? undefined : labels.get(record.tool_use_id);

    for (const [question, answer] of Object.entries(record.probes)) {
      if (typeof answer?.p !== "number" || !Number.isFinite(answer.p)) continue;
      const entry = seen.get(question) ?? { n: 0, scored: [] };
      entry.n += 1;
      const expected = expect?.[question];
      if (expected !== undefined) entry.scored.push({ p: answer.p, expected });
      seen.set(question, entry);
    }
  }

  return [...seen.entries()]
    .map(([question, { n, scored }]) => ({
      question,
      n,
      labelled: scored.length,
      accuracy:
        scored.length === 0
          ? Number.NaN
          : scored.filter(({ p, expected }) => p >= 0.5 === expected).length / scored.length,
      brier:
        scored.length === 0
          ? Number.NaN
          : scored.reduce((sum, { p, expected }) => sum + (p - (expected ? 1 : 0)) ** 2, 0) / scored.length,
    }))
    .sort((a, b) => a.question.localeCompare(b.question));
}

export function formatLoggedProbes(reports: readonly LoggedProbeReport[], source: string): string {
  const lines: string[] = [];
  const pct = (n: number) => (Number.isNaN(n) ? "   —" : `${(n * 100).toFixed(0).padStart(3)}%`);

  lines.push(`Probe answers in ${source}`, "");

  if (reports.length === 0) {
    lines.push("  None. Either the policy defines no gate.probe_questions, or no gated call");
    lines.push("  has been made since it started to.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("| probe | answers | labelled | accuracy | Brier |");
  lines.push("|---|---|---|---|---|");
  for (const r of reports) {
    lines.push(
      `| ${r.question} | ${r.n} | ${r.labelled} | ${pct(r.accuracy)} | ${Number.isNaN(r.brier) ? "  —  " : r.brier.toFixed(3)} |`,
    );
  }

  const unlabelled = reports.filter((r) => r.labelled === 0);
  if (unlabelled.length > 0) {
    lines.push(
      "",
      `Not scored, for want of a label: ${unlabelled.map((r) => r.question).join(", ")}.`,
      "A label is a line in the labels file naming the tool_use_id of a logged call and what",
      "each probe should have said for it.",
    );
  }

  return `${lines.join("\n")}\n`;
}
