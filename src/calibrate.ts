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
// Fixtures are items rather than pre-built states, so a run exercises the state builder and
// redaction too. A state-builder regression that stops the classifier seeing a path is a
// calibration regression, and this is where it should show up. Which builder runs is the
// fixture's `kind`, so the same harness scores tool calls and a batch of documents.

import { readFileSync } from "node:fs";
import type { Adapter, Question } from "./adapters/types.js";
import { noulProbability } from "./adapters/types.js";
import { buildState, commandOf } from "./engine/state.js";
import { itemState } from "./engine/item.js";
import { evaluate, type Reason } from "./engine/evaluate.js";
import { matchHardRule } from "./engine/hardrules.js";
import { GATE_SET, type BuiltState, type CalibrationPolicy, type Policy, type PolicySet, type Verdict } from "./engine/types.js";
import { parseLog, type DecisionRecord } from "./io/log.js";

/**
 * A fixture is an item with labels, and `kind` says which `StateBuilder` builds it.
 *
 * Until v0.3 a fixture *was* a hook payload: `{ tool, input, cwd, permission_mode,
 * target_exists }` with an `expect` block bolted on. That was the shape ADR-008 named as
 * the thing the second consumer would have to change, and `bouncer judge` is it.
 *
 * The migration is in `parseFixtures`: a line with a top-level `tool` and no `kind` is read
 * as `kind: "tool_call"` with those five fields lifted into `item` unchanged. So
 * `fixtures/gate.jsonl` does not change by a byte and neither does what it scores: the
 * printed report and every scored number are identical to the pre-v0.3 build's, which is
 * what keeps runs 1 through 8 comparable with whatever comes next. A calibration table
 * whose fixtures quietly changed shape underneath it is worth nothing.
 */
export type FixtureKind = "tool_call" | "item";

export interface Fixture {
  readonly id: string;
  readonly kind: FixtureKind;
  /**
   * The item itself. For `tool_call`, the hook-payload fields; for `item`, whatever the
   * user's batch contains.
   */
  readonly item: Readonly<Record<string, unknown>>;
  /** Expected answer per question. Questions not listed are not scored. */
  readonly expect: Readonly<Record<string, boolean>>;
  /** Why the label is what it is. Required — an unexplained label cannot be argued with. */
  readonly note: string;
  /** The fixture this one is the near-miss counterpart of. */
  readonly pair?: string;
}

/** The hook-payload fields a `tool_call` fixture's item carries. */
export interface ToolCallItem {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly cwd?: string;
  readonly permission_mode?: string;
  readonly target_exists?: boolean;
}

/** The five keys the legacy spelling kept at the top level. */
const TOOL_CALL_KEYS = ["tool", "input", "cwd", "permission_mode", "target_exists"] as const;

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
   *
   * `unanswered` is `evaluate` refusing an allow because the classifier skipped questions;
   * `question` lists them. At hook time that is an error line, not a verdict, so
   * `disagreements` leaves the fixture out rather than calling it friction.
   *
   * `truncated` is the other refused allow: every question was answered, about the head of
   * a state that was over its cap. The gate emits nothing for it either, so it is left out
   * of `disagreements` the same way. `question` is empty — no one question decided it.
   */
  readonly verdictReason: {
    readonly question: string;
    readonly p: number;
    readonly source: "hard_rule" | "rule" | "unanswered" | "truncated";
  };
  /**
   * True when this row scores a `gate.probe_questions` entry rather than a live one.
   *
   * Probe rows are kept out of the gate table, out of the "N of N clear the bar" line and
   * out of the verdict comparison. A probe changed no verdict, so counting it toward the
   * release gate would let an experiment decide whether the product ships.
   */
  readonly probe: boolean;
  /** The server cut this fixture's state to its window. Same for each row of a fixture. */
  readonly serverTruncation?: { readonly from: number; readonly to: number };
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

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`fixture line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const field of ["id", "note"] as const) {
      if (typeof raw[field] !== "string" || (raw[field] as string).length === 0) {
        throw new Error(`fixture line ${i + 1} is missing "${field}"`);
      }
    }

    const expect = raw["expect"];
    if (typeof expect !== "object" || expect === null || Object.keys(expect).length === 0) {
      throw new Error(`fixture "${String(raw["id"])}" has no expectations, so it scores nothing`);
    }

    const { kind, item } = shapeOf(raw, i + 1);

    fixtures.push({
      id: raw["id"] as string,
      kind,
      item,
      expect: expect as Readonly<Record<string, boolean>>,
      note: raw["note"] as string,
      ...(typeof raw["pair"] === "string" ? { pair: raw["pair"] } : {}),
    });
  });

  return fixtures;
}

/**
 * Reads a fixture's kind and item, migrating the pre-v0.3 spelling.
 *
 * A line with a top-level `tool` and no `kind` is the old shape — a hook payload with
 * labels — and its five payload fields are lifted into `item` unchanged. Nothing about what
 * it scores changes; see the note on `Fixture`.
 */
function shapeOf(raw: Record<string, unknown>, line: number): { kind: FixtureKind; item: Record<string, unknown> } {
  const declared = raw["kind"];

  if (declared === undefined) {
    if (typeof raw["tool"] !== "string" || (raw["tool"] as string).length === 0) {
      throw new Error(`fixture line ${line} has no "kind" and no "tool", so nothing says how to build its state`);
    }
    const item: Record<string, unknown> = {};
    for (const key of TOOL_CALL_KEYS) {
      if (raw[key] !== undefined) item[key] = raw[key];
    }
    return { kind: "tool_call", item };
  }

  if (declared !== "tool_call" && declared !== "item") {
    throw new Error(`fixture line ${line} has kind "${String(declared)}"; expected "tool_call" or "item"`);
  }

  const item = raw["item"];
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error(`fixture line ${line} declares kind "${declared}" but has no "item" mapping`);
  }

  if (declared === "tool_call" && typeof (item as Record<string, unknown>)["tool"] !== "string") {
    throw new Error(`fixture line ${line} is a tool_call but its item has no "tool"`);
  }

  return { kind: declared, item: item as Record<string, unknown> };
}

export function loadFixtures(path: string): Fixture[] {
  return parseFixtures(readFileSync(path, "utf8"));
}

export async function score(
  fixtures: readonly Fixture[],
  policy: Policy,
  adapter: Adapter,
  onProgress?: (done: number, total: number, answered: Answered) => void,
  setName: string = GATE_SET,
): Promise<Scored[]> {
  const set = policy.sets[setName];
  if (set === undefined) {
    throw new Error(`the policy defines no set named "${setName}" (it has: ${Object.keys(policy.sets).join(", ")})`);
  }

  const questions = questionsOf(set);

  // Probes are scored only where a fixture labels them, and never enter the verdict below.
  const probeNames = new Set(Object.keys(set.probeQuestions));

  const results: Scored[] = [];

  for (const [i, fixture] of fixtures.entries()) {
    const state = stateFor(fixture);

    const response = await adapter.decide({ state: state.text, questions, timeoutMs: 30_000 });

    // Every question's answer, not just the labelled ones: the `any` uncertainty rule
    // reads all of them, so a verdict computed from a subset would not be the real one.
    const answers: Record<string, number> = {};
    const probes: Record<string, number> = {};
    for (const name of Object.keys(questions)) {
      const value = noulProbability(response.answers[name]);
      if (value === undefined) continue;
      if (probeNames.has(name)) probes[name] = value;
      else answers[name] = value;
    }

    const answered: Answered = {
      fixture,
      answers,
      probes,
      latencyMs: response.latencyMs,
      ...(response.model !== undefined ? { model: response.model } : {}),
      ...(response.inputTokens !== undefined ? { inputTokens: response.inputTokens } : {}),
      ...(state.truncated ? { truncated: true } : {}),
      ...(response.serverTruncation !== undefined ? { serverTruncation: response.serverTruncation } : {}),
    };
    results.push(...scoreAnswered(answered, policy, set, setName).rows);

    onProgress?.(i + 1, fixtures.length, answered);
  }

  return results;
}

/**
 * What the classifier said about one fixture, before anything scored it.
 *
 * This is the part of a run that costs a live call, and the only part. Everything in a
 * report is computed from it and from the policy, so a run that keeps these can be scored
 * again under a different threshold without a key — `calibrate --out` writes them and
 * `calibrate --from` reads them back.
 */
export interface Answered {
  readonly fixture: Fixture;
  readonly answers: Readonly<Record<string, number>>;
  /** Answers to `probe_questions`. Scored where labelled; never read by a rule. */
  readonly probes: Readonly<Record<string, number>>;
  readonly latencyMs: number;
  /** The model that answered, as the backend reported it. */
  readonly model?: string;
  /**
   * The state was over its cap, so these answers are about its head.
   *
   * `evaluate` refuses an allow on that, and the hook and `judge` both tell it. Without this
   * the verdict here was `allow` where the installed gate's is the refusal — the same
   * "a policy that is not the one installed" the hard-rule comment below is about.
   */
  readonly truncated?: boolean;
  /** Input tokens the backend billed, when it reported them. What cost per decision is read from. */
  readonly inputTokens?: number;
  /**
   * The server cut the state to its window before answering (`DecideResponse`).
   *
   * Unlike `truncated`, this does not refuse an allow: the hook does not read it either, so
   * a verdict computed with it would describe a gate that is not the installed one. It is
   * reported beside the verdict instead, and a verdict that differs from an untruncated
   * backend's on the same fixture is flagged as a flip.
   */
  readonly serverTruncation?: { readonly from: number; readonly to: number };
}

/**
 * Scores one fixture's answers: the policy's verdict, and a row per labelled question.
 *
 * `score()` and `scoreFromLog()` both end here, which is the point of it being one function.
 * When they each computed the verdict themselves, only the live path applied hard rules, so
 * re-scoring a recorded run reported `export-stripe-key` as `missed` under a policy whose
 * hard rules catch it — a different table from the same answers.
 */
export function scoreAnswered(
  answered: Answered,
  policy: Policy,
  set: PolicySet,
  setName: string,
): { rows: Scored[]; verdict: Verdict; reason: Reason } {
  const { fixture, answers, probes } = answered;

  // Hard rules and the fast path belong to the gate (ADR-008), so they only apply when the
  // set being scored is the gate and the fixture is a tool call.
  //
  // Hard rules decide before the classifier at hook time, so the verdict reported here
  // has to come from them too — otherwise the `missed` and `friction` sections describe
  // a policy that is not the one installed. The adapter is still called for every
  // fixture regardless: the accuracy and Brier columns measure the classifier, and hard
  // rules neither help nor hurt a question's answer.
  //
  // The fast path is deliberately still not modelled here, unchanged from run 7. It
  // would only ever turn an `ask` into an `allow`, and doing it in the same run as this
  // change would make two things move at once.
  const hard =
    setName === GATE_SET && fixture.kind === "tool_call"
      ? matchHardRule(policy.gate.hardRules, commandOf(toolCallOf(fixture).tool, toolCallOf(fixture).input))
      : undefined;

  const decision = hard === undefined ? evaluate(set, policy.mode, answers, { truncated: answered.truncated === true }) : undefined;
  const verdict: Verdict = hard?.verdict ?? decision?.verdict ?? "allow";
  const reason: Reason =
    hard !== undefined
      ? { kind: "hard-rule", name: hard.name, because: hard.because }
      : (decision?.reason ?? { kind: "no-rule-matched" });

  const verdictReason =
    reason.kind === "hard-rule"
      ? { question: reason.name, p: Number.NaN, source: "hard_rule" as const }
      : reason.kind === "unanswered"
        ? { question: reason.missing.join(", "), p: Number.NaN, source: "unanswered" as const }
        : reason.kind === "truncated"
          ? { question: "", p: Number.NaN, source: "truncated" as const }
          : {
              question: reason.kind === "rule" ? reason.question : "default",
              p: reason.kind === "rule" ? reason.p : Number.NaN,
              source: "rule" as const,
            };

  const rows: Scored[] = [];
  for (const [question, expected] of Object.entries(fixture.expect)) {
    const probe = question in set.probeQuestions;
    const p = probe ? probes[question] : answers[question];
    // A question the classifier did not answer is not scored. Counting it as wrong
    // would blame the model for an adapter problem.
    if (p === undefined) continue;

    const predicted = p >= 0.5;
    rows.push({
      fixture,
      question,
      expected,
      p,
      predicted,
      correct: predicted === expected,
      confidence: Math.max(p, 1 - p),
      verdict,
      verdictReason,
      probe,
      ...(answered.serverTruncation !== undefined ? { serverTruncation: answered.serverTruncation } : {}),
    });
  }

  return { rows, verdict, reason };
}

/**
 * The whole fan-out for a set: its questions and its probes, in one call.
 *
 * Probes go in the same request as the questions in force, for the same reason they do in
 * the hook — a run that asked them separately would not be measuring what production asks.
 */
export function questionsOf(set: PolicySet): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const source of [set.questions, set.probeQuestions]) {
    for (const [name, q] of Object.entries(source)) {
      questions[name] = { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
    }
  }
  return questions;
}

/** Reads a `tool_call` fixture's item as the hook payload it is. */
export function toolCallOf(fixture: Fixture): ToolCallItem {
  const item = fixture.item as Record<string, unknown>;
  return {
    tool: typeof item["tool"] === "string" ? item["tool"] : "",
    input: (item["input"] ?? {}) as Record<string, unknown>,
    ...(typeof item["cwd"] === "string" ? { cwd: item["cwd"] } : {}),
    ...(typeof item["permission_mode"] === "string" ? { permission_mode: item["permission_mode"] } : {}),
    ...(typeof item["target_exists"] === "boolean" ? { target_exists: item["target_exists"] } : {}),
  };
}

/**
 * Builds a fixture's state with the builder its `kind` names.
 *
 * Fixtures are items rather than pre-built states so that a run exercises the state builder
 * and redaction too: a regression that stops the classifier seeing a path is a calibration
 * regression, and this is where it should show up.
 */
export function stateFor(fixture: Fixture): BuiltState {
  if (fixture.kind === "item") return itemState.build(fixture.item);

  const call = toolCallOf(fixture);
  return buildState({
    toolName: call.tool,
    toolInput: call.input,
    cwd: call.cwd ?? "/home/user/project",
    ...(call.permission_mode !== undefined ? { permissionMode: call.permission_mode } : {}),
    ...(call.target_exists !== undefined ? { targetExists: call.target_exists } : {}),
  });
}

/**
 * Scores a log's recorded answers against labels, without calling a backend.
 *
 * `score()` above asks the classifier; this reads what it already said. That is the whole
 * point: a live run costs one call per item and, once it has been paid for, re-scoring it
 * after a relabelling or a threshold change should cost nothing. It is also what makes a
 * batch run in anger into calibration data — `bouncer judge` writes `item` on every line,
 * so a judgments log over a fixture file joins to it by id.
 *
 * The verdict is recomputed from the recorded probabilities rather than read off the line,
 * so changing a threshold and re-running this says what the new threshold would have done.
 * Lines a deterministic path decided carry no answers and are counted as skipped rather
 * than scored: there is nothing of the classifier's in them to measure.
 */
export function scoreFromLog(
  source: string,
  fixtures: readonly Fixture[],
  policy: Policy,
  setName: string = GATE_SET,
): FromLog {
  const set = policy.sets[setName];
  if (set === undefined) {
    throw new Error(`the policy defines no set named "${setName}" (it has: ${Object.keys(policy.sets).join(", ")})`);
  }

  const byId = new Map(fixtures.map((f) => [f.id, f]));

  const scored: Scored[] = [];
  const models = new Set<string>();
  let matched = 0;
  let unmatched = 0;
  let unscorable = 0;
  let otherSet = 0;
  let reworded = 0;

  for (const record of parseLog(source)) {
    // Answers to another set's questions, which an id shared between two fixture files
    // would otherwise join to these labels. A gate line names no set, and is the gate's.
    if ((record.set ?? GATE_SET) !== setName) {
      otherSet += 1;
      continue;
    }

    // A judge line is keyed on the item; a gate line has only its tool_use_id, so a user
    // labelling their own history labels by that.
    const key = record.item ?? record.tool_use_id;
    if (key === undefined) {
      unscorable += 1;
      continue;
    }

    const fixture = byId.get(key);
    if (fixture === undefined) {
      unmatched += 1;
      continue;
    }

    const answers = { ...(record.answers ?? {}) };
    const probes = record.probes ?? {};
    if (Object.keys(answers).length === 0) {
      // A hard rule, a fast-path hit or an error line. Nothing of the classifier's in it.
      unscorable += 1;
      continue;
    }

    matched += 1;
    // Counted and still scored. Re-scoring old answers under a moved threshold is what this
    // is for, and one reworded question should not put a whole run out of reach — but the
    // reader has to be told, because a number about the old wording looks like any other.
    // A line from before records carried this says nothing either way.
    if (record.policy !== undefined && record.policy.questions !== set.questionsFingerprint) reworded += 1;
    if (record.model !== undefined) models.add(record.model);

    // Read off the line rather than rebuilt from the fixture: the line is what the classifier
    // was actually shown, and a cap that has moved since would make the two disagree.
    const truncated = record.truncated === true ? { truncated: true } : {};
    const cut = record.server_truncated;
    const serverTruncation =
      cut !== undefined && Number.isFinite(cut.from) && Number.isFinite(cut.to) ? { serverTruncation: { from: cut.from, to: cut.to } } : {};
    scored.push(
      ...scoreAnswered({ fixture, answers, probes, latencyMs: 0, ...truncated, ...serverTruncation }, policy, set, setName).rows,
    );
  }

  return { scored, matched, unmatched, unscorable, otherSet, reworded, models: [...models].sort() };
}

export interface FromLog {
  readonly scored: Scored[];
  readonly matched: number;
  /** Lines naming an item no fixture has. */
  readonly unmatched: number;
  /** Lines with no classifier answer: a hard rule, the fast path, or an error. */
  readonly unscorable: number;
  /** Lines judged against a different set, and so skipped. */
  readonly otherSet: number;
  /** Matched lines whose questions were worded differently from the policy's now. Scored. */
  readonly reworded: number;
  /** Every model the matched lines name. More than one means the answers are not one sample. */
  readonly models: readonly string[];
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
    // Half an answer decided nothing, so it neither missed nor added friction. Nor did a
    // whole answer about half a state: both are an allow refused, and the gate emits nothing.
    if (first.verdictReason.source === "unanswered" || first.verdictReason.source === "truncated") continue;
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

/** What decided a fixture's verdict, for a line a person reads. */
function describeReason(s: Scored): string {
  const { source, question, p } = s.verdictReason;
  if (source === "hard_rule") return `hard rule ${question}`;
  if (source === "unanswered") return `unanswered ${question}`;
  if (source === "truncated") return "state over its cap";
  return Number.isNaN(p) ? question : `${question} ${p.toFixed(2)}`;
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
  /** What decided each side, in `describeReason` form: `destructive 0.72`, `hard rule x`, `default`. */
  readonly reasons: readonly [string, string];
  /**
   * The server cut the state on one side or both. A verdict that differs here may be the
   * truncation talking rather than the model, which is why these are counted apart.
   */
  readonly truncated: readonly [boolean, boolean];
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
      differing.push({
        fixture: left.fixture,
        verdicts: [left.verdict, right.verdict],
        reasons: [describeReason(left), describeReason(right)],
        truncated: [left.serverTruncation !== undefined, right.serverTruncation !== undefined],
      });
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
    "A noul answer is a bare probability. Jev, and a server built to its wire shape, return",
    "no confidence field for one, and the local adapter's softmax over two label tokens is",
    "not one either, so this compares p and Brier and nothing else. The confidence used by",
    "the gate below is the derived statistic max(p, 1 - p), computed the same way on both sides.",
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
    // Every one, not the first twenty: this list is what a routing decision gets read off,
    // and a fixture set is small enough that the tail is the part worth seeing.
    lines.push("", "Where it does not:", "");
    for (const d of differing) {
      const cut = d.truncated[0] || d.truncated[1] ? "  [state truncated by the server]" : "";
      lines.push(
        `  ${d.fixture.id}: ${left} ${d.verdicts[0]} (${d.reasons[0]}), ${right} ${d.verdicts[1]} (${d.reasons[1]})${cut}`,
      );
    }
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

// ---------------------------------------------------------------------------
// --compare with any number of arms: one summary line per backend, and gates.
// ---------------------------------------------------------------------------

/**
 * TypeSafe's price for Jev input, in US dollars per token. Output is free.
 *
 * A vendor fact (CLAUDE.md, verified 2026-09-18), not a threshold: nothing is decided by
 * it, it only turns `usage.input_tokens` into the cost column.
 */
const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** One backend's run, as `--compare` keeps it: its scores and what it said per fixture. */
export interface ArmRun {
  /** The column name: the `name=` label when one was given, else the adapter's name. */
  readonly backend: string;
  /**
   * The adapter's own name, which says what answered (`jev`, `local`, `jev@127.0.0.1:8093`).
   * Anything decided by what the backend is, the price for one, reads this and never the
   * label: the first live run labelled two loopback arms and reported both as unpriced.
   */
  readonly endpoint?: string;
  readonly scored: readonly Scored[];
  readonly answered: readonly Answered[];
}

/**
 * The numbers a routing decision reads for one backend, over its own fixtures.
 *
 * `falseAllows` counts fixtures, not answers: a fixture labelled true on `destructive` and
 * allowed is one false allow on `destructive`, whichever other questions it also carries.
 * Fixtures whose verdict was a refused allow (unanswered, or a state over bouncer's own cap)
 * are in neither count, as in `disagreements`: the gate emits nothing for them.
 */
export interface ArmSummary {
  readonly backend: string;
  readonly fixtures: number;
  readonly accuracy: number;
  /** Mean Brier across questions, the figure the Brier gate compares. */
  readonly brier: number;
  /** Expected calibration error over the reliability buckets. 0 is perfectly calibrated. */
  readonly ece: number;
  readonly falseAllows: { readonly total: number; readonly byQuestion: Readonly<Record<string, number>> };
  readonly falseAsks: { readonly count: number; readonly of: number; readonly rate: number };
  /** Adapter milliseconds, nearest-rank. Undefined when nothing was timed. */
  readonly latency?: { readonly p50: number; readonly p95: number };
  /** US dollars per fixture. Undefined when the backend is neither priced nor on this machine. */
  readonly costPerDecision?: number;
  readonly truncation: { readonly count: number; readonly of: number; readonly meanFrom: number; readonly meanTo: number };
}

export function summarise(arm: ArmRun, calibration: CalibrationPolicy): ArmSummary {
  const rows = arm.scored.filter((s) => !s.probe);
  const byFixture = new Map<string, Scored[]>();
  for (const s of rows) {
    const list = byFixture.get(s.fixture.id) ?? [];
    list.push(s);
    byFixture.set(s.fixture.id, list);
  }

  const byQuestion: Record<string, number> = {};
  let falseAllows = 0;
  let falseAsks = 0;
  let allFalse = 0;
  for (const items of byFixture.values()) {
    const first = items[0] as Scored;
    if (first.verdictReason.source === "unanswered" || first.verdictReason.source === "truncated") continue;
    const labelledTrue = items.filter((i) => i.expected);
    if (labelledTrue.length === 0) {
      allFalse += 1;
      if (first.verdict !== "allow") falseAsks += 1;
    } else if (first.verdict === "allow") {
      falseAllows += 1;
      for (const i of labelledTrue) byQuestion[i.question] = (byQuestion[i.question] ?? 0) + 1;
    }
  }

  const reports = report(arm.scored, calibration);
  const latencies = arm.answered.map((a) => a.latencyMs).filter((ms) => Number.isFinite(ms) && ms >= 0);
  const cut = arm.answered.flatMap((a) => (a.serverTruncation !== undefined ? [a.serverTruncation] : []));
  const cost = costPerDecision(arm);

  return {
    backend: arm.backend,
    fixtures: byFixture.size,
    accuracy: rows.length === 0 ? Number.NaN : rows.filter((r) => r.correct).length / rows.length,
    brier: meanOf(reports.map((r) => r.brier)),
    ece: expectedCalibrationError(rows),
    falseAllows: { total: falseAllows, byQuestion },
    falseAsks: { count: falseAsks, of: allFalse, rate: allFalse === 0 ? Number.NaN : falseAsks / allFalse },
    ...(latencies.length > 0 ? { latency: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95) } } : {}),
    ...(cost !== undefined ? { costPerDecision: cost } : {}),
    truncation: {
      count: cut.length,
      of: arm.answered.length,
      meanFrom: meanOf(cut.map((c) => c.from)),
      meanTo: meanOf(cut.map((c) => c.to)),
    },
  };
}

/**
 * Σ over buckets of (bucket share) × |bucket accuracy − bucket mean confidence|.
 *
 * The same five buckets the report prints, so the number and the reliability table beside
 * it describe one thing. Confidence is max(p, 1 − p), which is what the gate reads too.
 */
export function expectedCalibrationError(rows: readonly Scored[]): number {
  if (rows.length === 0) return Number.NaN;
  let ece = 0;
  for (const [low, high] of BUCKETS) {
    const inBucket = rows.filter((r) => r.confidence >= low && r.confidence < high);
    if (inBucket.length === 0) continue;
    const accuracy = inBucket.filter((r) => r.correct).length / inBucket.length;
    const confidence = inBucket.reduce((sum, r) => sum + r.confidence, 0) / inBucket.length;
    ece += (inBucket.length / rows.length) * Math.abs(accuracy - confidence);
  }
  return ece;
}

function nearestRank(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] as number;
}

/**
 * Jev is priced off the tokens it reported. A backend on this machine costs nothing per
 * call. Anything else (a hosted `jev@` or `chat@` endpoint) is a bill this cannot see, and
 * is left unpriced rather than printed as a zero.
 */
function costPerDecision(arm: ArmRun): number | undefined {
  const endpoint = arm.endpoint ?? arm.backend;
  if (endpoint === "jev") {
    const tokens = arm.answered.flatMap((a) => (a.inputTokens !== undefined ? [a.inputTokens] : []));
    return tokens.length === 0 ? undefined : meanOf(tokens) * JEV_USD_PER_INPUT_TOKEN;
  }
  const host = /@(?:https?:\/\/)?(\[[^\]]+\]|[^/:]+)/.exec(endpoint)?.[1];
  const onThisMachine = endpoint === "local" || (host !== undefined && ["127.0.0.1", "localhost", "[::1]"].includes(host));
  return onThisMachine ? 0 : undefined;
}

/**
 * The two gates `--compare` can print for a backend against the first, read from the
 * policy's `calibration` block. A part whose threshold is not set is left out, not assumed.
 *
 * - The Brier gate: mean Brier no more than `brier_within` worse than the first backend's,
 *   and every question meeting the calibration block (`accuracy_bar` at `confidence_floor`)
 *   on the answers both backends gave. Clownbot ADR-0036 decision 10 as written.
 * - The safety gate: no false allow on any question in `no_false_allows`, and verdict
 *   agreement with the first backend at or above `agreement_floor`.
 */
export interface GateVerdicts {
  readonly brier?: {
    readonly delta: number;
    readonly within: number;
    readonly questionsPassing: number;
    readonly questions: number;
    readonly passes: boolean;
  };
  readonly safety?: {
    readonly falseAllows?: { readonly byQuestion: Readonly<Record<string, number>>; readonly passes: boolean };
    readonly agreement?: { readonly rate: number; readonly floor: number; readonly passes: boolean };
    /** Undefined while either threshold is unset: half a gate has not been passed. */
    readonly passes?: boolean;
  };
}

/** `comparison` must have the reference backend first and `arm` second, as `compare()` builds it. */
export function gates(comparison: Comparison, arm: ArmSummary, calibration: CalibrationPolicy): GateVerdicts {
  const out: { -readonly [K in keyof GateVerdicts]: GateVerdicts[K] } = {};

  if (calibration.brierWithin !== undefined) {
    const delta = meanOf(comparison.rows.map((r) => r.brier[1] - r.brier[0]));
    const passing = comparison.rows.filter((r) => r.gate[1].passes).length;
    out.brier = {
      delta,
      within: calibration.brierWithin,
      questionsPassing: passing,
      questions: comparison.rows.length,
      passes: !Number.isNaN(delta) && delta <= calibration.brierWithin && passing > 0 && passing === comparison.rows.length,
    };
  }

  let falseAllows: { byQuestion: Record<string, number>; passes: boolean } | undefined;
  if (calibration.noFalseAllows !== undefined) {
    const byQuestion = Object.fromEntries(calibration.noFalseAllows.map((q) => [q, arm.falseAllows.byQuestion[q] ?? 0]));
    falseAllows = { byQuestion, passes: Object.values(byQuestion).every((n) => n === 0) };
  }

  const { same, total } = comparison.verdicts;
  const agreement =
    calibration.agreementFloor === undefined || total === 0
      ? undefined
      : { rate: same / total, floor: calibration.agreementFloor, passes: same / total >= calibration.agreementFloor };

  if (falseAllows !== undefined || agreement !== undefined) {
    out.safety = {
      ...(falseAllows !== undefined ? { falseAllows } : {}),
      ...(agreement !== undefined ? { agreement } : {}),
      ...(falseAllows !== undefined && agreement !== undefined ? { passes: falseAllows.passes && agreement.passes } : {}),
    };
  }
  return out;
}

/** The arms side by side, then false allows by question. */
export function formatArms(summaries: readonly ArmSummary[]): string {
  const pct = (n: number) => (Number.isNaN(n) ? "—" : `${(n * 100).toFixed(1)}%`);
  const num = (n: number) => (Number.isNaN(n) ? "—" : n.toFixed(3));
  const usd = (n: number | undefined) => (n === undefined ? "unpriced" : n === 0 ? "$0 (local)" : `$${n.toPrecision(2)}`);
  const ms = (n: number | undefined) => (n === undefined ? "—" : String(Math.round(n)));
  const lines: string[] = ["Arms", ""];

  lines.push("| arm | fixtures | accuracy | Brier | ECE | false allows | false asks | p50 ms | p95 ms | per decision | truncated |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    const t = s.truncation;
    const cut = t.count === 0 ? `0 / ${t.of}` : `${t.count} / ${t.of}, mean ${Math.round(t.meanFrom)} → ${Math.round(t.meanTo)} tokens`;
    lines.push(
      `| ${s.backend} | ${s.fixtures} | ${pct(s.accuracy)} | ${num(s.brier)} | ${num(s.ece)} | ${s.falseAllows.total} | ` +
        `${s.falseAsks.count} / ${s.falseAsks.of} (${pct(s.falseAsks.rate)}) | ${ms(s.latency?.p50)} | ${ms(s.latency?.p95)} | ` +
        `${usd(s.costPerDecision)} | ${cut} |`,
    );
  }

  const questions = [...new Set(summaries.flatMap((s) => Object.keys(s.falseAllows.byQuestion)))].sort();
  lines.push("");
  if (questions.length === 0) {
    lines.push("No arm allowed a fixture labelled true on any question.");
  } else {
    lines.push("False allows by question (fixtures labelled true and allowed):", "");
    lines.push(`| question | ${summaries.map((s) => s.backend).join(" | ")} |`);
    lines.push(`|---|${summaries.map(() => "---|").join("")}`);
    for (const q of questions) {
      lines.push(`| ${q} | ${summaries.map((s) => s.falseAllows.byQuestion[q] ?? 0).join(" | ")} |`);
    }
  }
  lines.push(
    "",
    "Truncation is what the server reported (X-Clownbot-Truncated). It does not change a verdict",
    "here, because the hook does not read it either.",
  );
  return `${lines.join("\n")}\n`;
}

export function formatGates(verdicts: GateVerdicts, comparison: Comparison): string {
  const [first, arm] = comparison.backends;
  const result = (b: boolean) => (b ? "passes" : "fails");
  const { same, total, differing } = comparison.verdicts;
  const agreement = total === 0 ? "no fixture in common" : `${same} of ${total} (${((same / total) * 100).toFixed(1)}%)`;
  const lines: string[] = [`Gates for ${arm} against ${first}:`, ""];

  const b = verdicts.brier;
  if (b === undefined) {
    lines.push("  Brier gate: not evaluated; set calibration.brier_within.");
  } else {
    const delta = Number.isNaN(b.delta) ? "—" : `${b.delta >= 0 ? "+" : ""}${b.delta.toFixed(3)}`;
    lines.push(
      `  Brier gate ${result(b.passes)}: mean Brier ${delta} against a limit of +${b.within.toFixed(3)}, ` +
        `and ${b.questionsPassing} of ${b.questions} questions meet the calibration block.`,
    );
  }

  const s = verdicts.safety;
  if (s === undefined) {
    lines.push(`  Safety gate: not evaluated; set calibration.no_false_allows and calibration.agreement_floor. Agreement is ${agreement}.`);
  } else {
    const parts = [
      s.falseAllows === undefined
        ? "no_false_allows not set"
        : `false allows ${Object.entries(s.falseAllows.byQuestion).map(([q, n]) => `${q} ${n}`).join(", ")} (each must be 0)`,
      s.agreement === undefined
        ? `agreement ${agreement}, agreement_floor not set`
        : `agreement ${agreement} against a floor of ${(s.agreement.floor * 100).toFixed(1)}%`,
    ];
    lines.push(`  ${s.passes === undefined ? "Safety gate incomplete" : `Safety gate ${result(s.passes)}`}: ${parts.join("; ")}.`);
  }

  const flips = differing.filter((d) => d.truncated[0] || d.truncated[1]);
  lines.push(`  Truncation flips: ${flips.length}${flips.length > 0 ? ` (${flips.map((f) => f.fixture.id).join(", ")})` : ""}.`);
  return `${lines.join("\n")}\n`;
}
