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
import type { CalibrationPolicy, Policy } from "./engine/types.js";

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
