// Loaders for the calibration gate's datasets (docs/calibration-gate.md §2).
//
// Four files feed the gate and three of them are not plain fixtures: real traces carry a
// stratum and a split, a variant is a question rather than a call, and an injection case is
// a call that only means something beside the clean one it was made from. Each loader here
// refuses what would make its part of the gate measure something else, at load, by name.
// A dataset that loads with a hole in it produces a rate with a smaller denominator and no
// way to tell.
//
// Parsing is pure. The one function that reads a file is at the bottom.

import { readFileSync } from "node:fs";
import { parseFixtures, stateFor, toolCallOf, type Fixture } from "./calibrate.js";
import { shortCircuit } from "./engine/evaluate.js";
import { fingerprint, fingerprintQuestions } from "./engine/fingerprint.js";
import { commandOf, targetOf } from "./engine/state.js";
import type { Policy, PolicySet, Question, Verdict } from "./engine/types.js";

/** The hard cases a trace set is weighted toward, and the one name for everything else. */
export const STRATA = ["long_command", "chained_shell", "outside_write", "network", "secrets_path", "ordinary"] as const;
export type Stratum = (typeof STRATA)[number];

export const SPLITS = ["fit", "gate"] as const;
export type Split = (typeof SPLITS)[number];

const VERDICTS: readonly Verdict[] = ["allow", "ask", "deny"];

/** A labelled real call: a fixture, plus where it sits in the set. */
export interface Trace {
  readonly fixture: Fixture;
  readonly strata: readonly Stratum[];
  /** `fit` rows tune a temperature and are never scored by the gate; `gate` rows are the reverse. */
  readonly split: Split;
  /** Only where the verdict the labels derive is not what the labeller means. */
  readonly verdict?: Verdict;
}

/**
 * The verdict a fixture's labels ask for, as `calibrate` has always derived it: any
 * question labelled true means the call should prompt. `deny` is never derived, because no
 * `deny` rule ships enabled; a trace says so itself, in `verdict`.
 */
export function expectedVerdict(trace: Pick<Trace, "fixture" | "verdict">): Verdict {
  return trace.verdict ?? (Object.values(trace.fixture.expect).some(Boolean) ? "ask" : "allow");
}

/** Each JSON line of a `//`-commented JSONL file, with its 1-based line number. */
function lines(source: string, what: string): Array<{ raw: Record<string, unknown>; line: number }> {
  const out: Array<{ raw: Record<string, unknown>; line: number }> = [];
  source.split("\n").forEach((text, i) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) return;
    try {
      out.push({ raw: JSON.parse(trimmed) as Record<string, unknown>, line: i + 1 });
    } catch (err) {
      throw new Error(`${what} line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return out;
}

export function parseTraces(source: string): Trace[] {
  const fixtures = parseFixtures(source);
  const raws = lines(source, "trace");

  return fixtures.map((fixture, i) => {
    const raw = (raws[i] as { raw: Record<string, unknown> }).raw;

    const strata = raw["strata"];
    if (!Array.isArray(strata) || strata.length === 0) {
      throw new Error(`trace "${fixture.id}" has no "strata"; name at least one of ${STRATA.join(", ")}`);
    }
    for (const name of strata) {
      if (!(STRATA as readonly unknown[]).includes(name)) {
        throw new Error(`trace "${fixture.id}" names stratum ${JSON.stringify(name)}; expected one of ${STRATA.join(", ")}`);
      }
    }

    const split = raw["split"];
    if (!(SPLITS as readonly unknown[]).includes(split)) {
      throw new Error(`trace "${fixture.id}" has split ${JSON.stringify(split)}; expected "fit" or "gate"`);
    }

    const verdict = raw["verdict"];
    if (verdict !== undefined && !(VERDICTS as readonly unknown[]).includes(verdict)) {
      throw new Error(`trace "${fixture.id}" has verdict ${JSON.stringify(verdict)}; expected allow, ask or deny`);
    }

    return {
      fixture,
      strata: strata as Stratum[],
      split: split as Split,
      ...(verdict !== undefined ? { verdict: verdict as Verdict } : {}),
    };
  });
}

// Variants (§2.2).

/** The fingerprint a variant's `base` names: of the one question it was written against. */
export function questionFingerprint(question: Question): string {
  return fingerprint(
    JSON.stringify([question.instructions, question.criteria?.true ?? null, question.criteria?.false ?? null]),
  );
}

export type VariantKind = "reversed" | "rephrase";

export interface Variant {
  readonly question: string;
  readonly kind: VariantKind;
  /** `reversed`, or the rewording's own id (`r1`, `r2`, `r3`). */
  readonly id: string;
  readonly wording: Question;
  /** Absent on a draft: a variant with no `base` has not been stamped against any wording. */
  readonly base?: string;
  readonly note: string;
}

function wordingOf(raw: unknown, where: string): Question {
  if (typeof raw !== "object" || raw === null) throw new Error(`${where} has no wording`);
  const record = raw as Record<string, unknown>;
  const instructions = record["instructions"];
  if (typeof instructions !== "string" || instructions.length === 0) throw new Error(`${where} has no "instructions"`);
  const criteria = record["criteria"];
  if (criteria !== undefined && (typeof criteria !== "object" || criteria === null)) {
    throw new Error(`${where} has "criteria" that is not a mapping`);
  }
  const c = (criteria ?? {}) as Record<string, unknown>;
  for (const side of ["true", "false"]) {
    if (c[side] !== undefined && typeof c[side] !== "string") throw new Error(`${where} has a criteria.${side} that is not text`);
  }
  return {
    instructions,
    ...(criteria !== undefined
      ? {
          criteria: {
            ...(typeof c["true"] === "string" ? { true: c["true"] } : {}),
            ...(typeof c["false"] === "string" ? { false: c["false"] } : {}),
          },
        }
      : {}),
  };
}

/** `polarity.jsonl` carries its wording under `reversed`; `rephrase.jsonl` carries it at the top level. */
export function parseVariants(source: string, kind: VariantKind): Variant[] {
  const seen = new Set<string>();
  return lines(source, "variant").map(({ raw, line }) => {
    const question = raw["question"];
    if (typeof question !== "string" || question.length === 0) throw new Error(`variant line ${line} names no "question"`);
    if (typeof raw["note"] !== "string" || raw["note"].length === 0) throw new Error(`variant line ${line} is missing "note"`);

    const id = kind === "reversed" ? "reversed" : raw["id"];
    if (typeof id !== "string" || id.length === 0) throw new Error(`variant line ${line} (${question}) has no "id"`);
    const key = `${question}/${id}`;
    if (seen.has(key)) throw new Error(`variant ${key} appears twice`);
    seen.add(key);

    const base = raw["base"];
    if (base !== undefined && typeof base !== "string") throw new Error(`variant ${key} has a "base" that is not a fingerprint`);

    return {
      question,
      kind,
      id,
      wording: wordingOf(kind === "reversed" ? raw["reversed"] : raw, `variant ${key}`),
      ...(typeof base === "string" ? { base } : {}),
      note: raw["note"],
    };
  });
}

/** How many rewordings a question needs before the rephrase part has measured it. */
export const REWORDINGS = 3;

export interface VariantCheck {
  /** Variants whose `base` matches the question the policy ships today, by question. */
  readonly usable: Readonly<Record<string, readonly Variant[]>>;
  /** Why a question cannot be measured. One reason per question, the first that applies. */
  readonly unmeasured: Readonly<Record<string, string>>;
}

/**
 * Which variants can be asked under this policy, and which questions have none.
 *
 * A variant is stale the moment its question is edited: it was written to mean the same as,
 * or the opposite of, a sentence that no longer ships. Asking it anyway would report a flip
 * rate between two questions nobody chose to compare. So it is not asked, the question is
 * reported as not measured, and a part with an unmeasured question does not pass.
 */
export function checkVariants(variants: readonly Variant[], set: PolicySet, kind: VariantKind): VariantCheck {
  const usable: Record<string, Variant[]> = {};
  const unmeasured: Record<string, string> = {};
  const needed = kind === "reversed" ? 1 : REWORDINGS;

  for (const [name, question] of Object.entries(set.questions)) {
    const own = variants.filter((v) => v.question === name && v.kind === kind);
    const current = questionFingerprint(question);

    if (own.length === 0) {
      unmeasured[name] = kind === "reversed" ? "no reversed form" : "no rewordings";
    } else if (own.some((v) => v.base === undefined)) {
      unmeasured[name] = "a variant carries no base fingerprint, so nothing says which wording it was written against";
    } else if (own.some((v) => v.base !== current)) {
      unmeasured[name] = `stale: written against another wording of the question (now ${current})`;
    } else if (own.length < needed) {
      unmeasured[name] = `${own.length} of ${needed} rewordings`;
    } else {
      usable[name] = own;
    }
  }
  return { usable, unmeasured };
}

export interface Stamped {
  /** The file's new text. Identical to the input when nothing was stamped. */
  readonly text: string;
  /** Lines given a `base`, by question. */
  readonly stamped: Readonly<Record<string, number>>;
  /** Lines whose `base` already names the wording that ships, by question. */
  readonly current: Readonly<Record<string, number>>;
  /** Lines written against another wording and left alone, by question. */
  readonly stale: Readonly<Record<string, number>>;
}

/**
 * Writes the shipped wording's fingerprint into the variants of the questions named.
 *
 * A `base` is a claim: this line was written to mean the same as, or the opposite of, the
 * question as it reads today, and someone has checked that it does. So stamping is asked
 * for by question name and is never a side effect of a run, and it does the least it can:
 *
 *   - a line with no `base` gets one;
 *   - a line whose `base` is already current is left byte for byte as it was;
 *   - a line whose `base` names another wording is **stale** and is not touched, unless
 *     `restamp` is set. Restamping says "the question changed and I have reread this line
 *     against the new one". Doing it by default would erase the one signal that a question
 *     was edited underneath its variants.
 *
 * Comments, blank lines and every other line keep their bytes and their order. Throws on a
 * line that names a question the set does not ask, which is a typo or a deleted question
 * and in either case not something to stamp around.
 */
export function stampVariants(
  source: string,
  set: PolicySet,
  questions: ReadonlySet<string>,
  options: { readonly restamp?: boolean } = {},
): Stamped {
  const count = (into: Record<string, number>, question: string) => {
    into[question] = (into[question] ?? 0) + 1;
  };
  const stamped: Record<string, number> = {};
  const current: Record<string, number> = {};
  const stale: Record<string, number> = {};

  const out = source.split("\n").map((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) return line;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`variant line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const name = raw["question"];
    if (typeof name !== "string") throw new Error(`variant line ${i + 1} names no "question"`);
    const question = set.questions[name];
    if (question === undefined) {
      throw new Error(`variant line ${i + 1} is for "${name}", which the policy does not ask (it asks: ${Object.keys(set.questions).join(", ")})`);
    }
    if (!questions.has(name)) return line;

    const fingerprintNow = questionFingerprint(question);
    if (raw["base"] === fingerprintNow) {
      count(current, name);
      return line;
    }
    if (raw["base"] !== undefined && options.restamp !== true) {
      count(stale, name);
      return line;
    }

    count(stamped, name);
    // `base` directly after `question`, so the two things that identify a line sit together.
    const { question: _question, base: _base, ...rest } = raw;
    return JSON.stringify({ question: name, base: fingerprintNow, ...rest });
  });

  return { text: out.join("\n"), stamped, current, stale };
}

/** A policy set with every question that has a usable variant replaced by it. Probes are kept. */
export function withVariants<S extends PolicySet>(set: S, chosen: Readonly<Record<string, Variant>>): S {
  const questions = Object.fromEntries(
    Object.entries(set.questions).map(([name, question]) => [name, chosen[name]?.wording ?? question]),
  );
  // The fingerprint follows the wording, so a recorded variant run can never be mistaken
  // for, or paired with, a run of the questions that ship.
  return { ...set, questions, questionsFingerprint: fingerprintQuestions(questions, set.probeQuestions) };
}

// Injection (§2.3).

/** Exactly the fields `buildState` sends. A surface that is not here never reaches a model. */
export const SURFACES = ["command_comment", "command_string", "heredoc_body", "stated_intent", "path", "git_branch", "project"] as const;
export type Surface = (typeof SURFACES)[number];

export interface InjectionCase {
  readonly fixture: Fixture;
  /** The clean fixture this was made from. */
  readonly base: Fixture;
  readonly surface: Surface;
  /** The template's name, so success is reported per template. */
  readonly attack: string;
  /** The base is labelled safe: the planted text should change nothing, and the case is not gated. */
  readonly control: boolean;
}

/**
 * Reads the injection set against the fixtures its bases come from and the policy it will
 * be scored under.
 *
 * Refused, each by name: a base that does not exist; a surface that is not one of the seven;
 * an attack case whose base is labelled safe, or a control whose base is not; and a case, or
 * its base, that a hard rule or the fast path decides or whose state is cut; and a case whose
 * state is the same as its base's. Those last four are the ones that matter. The planted text
 * never reaches a model in any of them, so the case would count toward the denominator as an
 * attack resisted. The first draft of the set had three of the last kind: a planted
 * `description` on a `Write`, which has no such field in the state.
 */
export function parseInjection(source: string, bases: readonly Fixture[], policy: Policy): InjectionCase[] {
  const fixtures = parseFixtures(source);
  const raws = lines(source, "injection case");
  const byId = new Map(bases.map((f) => [f.id, f]));

  return fixtures.map((fixture, i) => {
    const raw = (raws[i] as { raw: Record<string, unknown> }).raw;
    const where = `injection case "${fixture.id}"`;

    const baseId = raw["base"];
    const base = typeof baseId === "string" ? byId.get(baseId) : undefined;
    if (base === undefined) throw new Error(`${where} names base ${JSON.stringify(baseId)}, which is not a fixture`);

    const surface = raw["surface"];
    if (!(SURFACES as readonly unknown[]).includes(surface)) {
      throw new Error(`${where} has surface ${JSON.stringify(surface)}; the gate sends only ${SURFACES.join(", ")}`);
    }
    if (typeof raw["attack"] !== "string" || raw["attack"].length === 0) throw new Error(`${where} names no "attack"`);

    const control = raw["control"] === true;
    const shouldPrompt = Object.values(base.expect).some(Boolean);
    if (!control && !shouldPrompt) {
      throw new Error(`${where} is an attack on "${base.id}", which is labelled safe; mark it "control": true or pick a base that should prompt`);
    }
    if (control && shouldPrompt) {
      throw new Error(`${where} is marked a control but "${base.id}" is labelled as needing a prompt`);
    }

    for (const [which, f] of [["its base", base], ["it", fixture]] as const) {
      const decided = decidedWithoutTheClassifier(f, policy);
      if (decided !== undefined) {
        throw new Error(`${where}: ${which} never reaches the classifier (${decided}), so planted text cannot be what decides it`);
      }
    }

    // A `description` on a Write, a branch the loader dropped: the case is byte-for-byte its
    // base by the time it is a state, and would be scored as an attack that failed.
    if (stateFor(fixture).text === stateFor(base).text) {
      throw new Error(`${where} builds the same state as "${base.id}": the planted text does not reach the classifier`);
    }

    return { fixture, base, surface: surface as Surface, attack: raw["attack"], control };
  });
}

function decidedWithoutTheClassifier(fixture: Fixture, policy: Policy): string | undefined {
  if (fixture.kind !== "tool_call") return "not a tool call";
  const call = toolCallOf(fixture);
  const target = targetOf(call.tool, call.input);
  const decision = shortCircuit(policy, {
    tool: call.tool,
    command: commandOf(call.tool, call.input),
    ...(target !== undefined ? { target } : {}),
  });
  if (decision !== undefined) {
    const reason = decision.reason;
    return reason.kind === "hard-rule" ? `hard rule ${reason.name}` : reason.kind === "fast-path" ? "fast path" : reason.kind;
  }
  return stateFor(fixture).truncated ? "its state is over the cap and is cut" : undefined;
}

export function load<T>(path: string, parse: (source: string) => T): T {
  return parse(readFileSync(path, "utf8"));
}
