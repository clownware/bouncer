// `bouncer calibrate --gate <candidate>`: ask everything the calibration gate needs, of the
// reference and of a candidate backend, and print the verdict (ADR-011; docs/calibration-gate.md).
//
//   bouncer calibrate --gate <[name=]backend> [--reference <[name=]backend>] [--fixtures path]
//                     [--variants dir] [--injection path] [--out-dir dir] [--policy path] [--json]
//
// Per arm it makes up to five passes over the fixtures and one over the injection set:
//
//   base       the questions as the policy words them, probes included
//   reversed   every question that has a current reversed form, asked in that form
//   r1 r2 r3   every question that has three current rewordings, one rewording per pass
//   injection  each attack case and each control
//
// A variant pass replaces questions and never adds them. Clef's head scores every question
// in a request jointly (ADR-011 decision 2), so a reversed form asked beside its original
// would be answered in that original's company, which is not how anything in production is
// asked. One variant kind per request, the same question count as the hook sends, probes kept.
//
// What this does not do yet, and says so in its own output: fit a temperature, measure
// latency through the hook, or write an attestation. So today the gate can report five
// parts and cannot pass: the sixth is never evaluated.
//
// Exit status is 0 when the gate passes and 1 when it does not. Never 2.

import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "../io/atomic.js";
import { join } from "node:path";
import type { Adapter } from "../adapters/types.js";
import { score, scoreAnswered, type Answered, type Fixture } from "../calibrate.js";
import { GATE_SET, type GatePolicy, type Policy, type Verdict } from "../engine/types.js";
import {
  REWORDINGS,
  checkVariants,
  parseInjection,
  parseVariants,
  stampVariants,
  withVariants,
  type InjectionCase,
  type Variant,
} from "../gatefixtures.js";
import type { InjectionOutcome } from "../gatemetrics.js";
import { assess, formatGate, type GateArm, type GateAssessment, type GateInputs, type GateVariantRow } from "../gatereport.js";
import { adapterFor, labelled, startIfNeeded, writeAnswers, type CalibrateArgs } from "./calibrate.js";

/** A pass over the fixtures: `base`, `reversed`, a rewording's position (`r1`…), or `injection`. */
export type Stage = string;

export interface GateArmSpec {
  /** The column name. */
  readonly label: string;
  readonly adapter: Adapter;
}

export interface GateOptions {
  readonly policy: Policy;
  readonly fixtures: readonly Fixture[];
  readonly reversed: readonly Variant[];
  readonly rewordings: readonly Variant[];
  readonly cases: readonly InjectionCase[];
  readonly reference: GateArmSpec;
  readonly candidate: GateArmSpec;
  readonly onProgress?: (arm: string, stage: Stage, done: number, total: number) => void;
}

export interface GateRun {
  readonly inputs: GateInputs;
  /** What each arm said in each pass, reference first, for `--out-dir`. */
  readonly answers: readonly [ReadonlyMap<Stage, readonly Answered[]>, ReadonlyMap<Stage, readonly Answered[]>];
  /** The policy each variant pass was asked under, so its answers are recorded against their own wording. */
  readonly asked: ReadonlyMap<Stage, Policy>;
}

/** The same policy, asking a different wording of the gate's questions. */
function asking(policy: Policy, gate: GatePolicy): Policy {
  return { ...policy, sets: { ...policy.sets, [GATE_SET]: gate }, gate };
}

export async function runGate(options: GateOptions): Promise<GateRun> {
  const { policy, fixtures, cases } = options;
  const gate = policy.gate;

  const reversed = checkVariants(options.reversed, gate, "reversed");
  const reworded = checkVariants(options.rewordings, gate, "rephrase");

  // One policy per pass, built once and used for both arms, so the two are asked the same bytes.
  const asked = new Map<Stage, Policy>([["base", policy]]);
  const usableReversed = Object.entries(reversed.usable);
  if (usableReversed.length > 0) {
    asked.set("reversed", asking(policy, withVariants(gate, Object.fromEntries(usableReversed.map(([q, v]) => [q, v[0] as Variant])))));
  }
  const usableReworded = Object.entries(reworded.usable).map(
    ([q, variants]) => [q, [...variants].sort((a, b) => a.id.localeCompare(b.id))] as const,
  );
  if (usableReworded.length > 0) {
    for (let i = 0; i < REWORDINGS; i += 1) {
      asked.set(`r${i + 1}`, asking(policy, withVariants(gate, Object.fromEntries(usableReworded.map(([q, v]) => [q, v[i] as Variant])))));
    }
  }

  const runArm = async (spec: GateArmSpec): Promise<{ arm: GateArm; answers: Map<Stage, Answered[]> }> => {
    const answers = new Map<Stage, Answered[]>();
    const pass = async (stage: Stage, items: readonly Fixture[], under: Policy) => {
      const collected: Answered[] = [];
      const scored = await score(items, under, spec.adapter, (done, total, answered) => {
        collected.push(answered);
        options.onProgress?.(spec.label, stage, done, total);
      });
      answers.set(stage, collected);
      return { scored, collected };
    };

    const base = await pass("base", fixtures, policy);
    const baseById = new Map(base.collected.map((a) => [a.fixture.id, a]));

    const variantRows = async (stages: readonly Stage[], measured: ReadonlySet<string>): Promise<GateVariantRow[]> => {
      const rows: GateVariantRow[] = [];
      for (const stage of stages) {
        const under = asked.get(stage);
        if (under === undefined) continue;
        const { collected } = await pass(stage, fixtures, under);
        for (const answered of collected) {
          const original = baseById.get(answered.fixture.id);
          for (const [question, label] of Object.entries(answered.fixture.expect)) {
            if (!measured.has(question)) continue;
            const p = original?.answers[question];
            const q = answered.answers[question];
            // An answer either pass did not get is not a flip. It is not a row.
            if (p === undefined || q === undefined) continue;
            rows.push({ fixture: answered.fixture.id, variant: stage, question, label, p, q });
          }
        }
      }
      return rows;
    };

    const reversedRows = await variantRows(["reversed"], new Set(Object.keys(reversed.usable)));
    const rewordedRows = await variantRows(
      Array.from({ length: REWORDINGS }, (_, i) => `r${i + 1}`),
      new Set(Object.keys(reworded.usable)),
    );

    let outcomes: InjectionOutcome[] | undefined;
    if (cases.length > 0) {
      const verdictOf = (answered: Answered): Verdict => scoreAnswered(answered, policy, gate, GATE_SET).verdict;
      const { collected } = await pass(
        "injection",
        cases.map((c) => c.fixture),
        policy,
      );
      const attackedById = new Map(collected.map((a) => [a.fixture.id, a]));
      outcomes = [];
      for (const c of cases) {
        const original = baseById.get(c.base.id);
        const attacked = attackedById.get(c.fixture.id);
        if (original === undefined) {
          throw new Error(`injection case "${c.fixture.id}" is based on "${c.base.id}", which is not among the fixtures this run asked`);
        }
        if (attacked === undefined) continue;
        outcomes.push({
          id: c.fixture.id,
          surface: c.surface,
          attack: c.attack,
          control: c.control,
          base: verdictOf(original),
          attacked: verdictOf(attacked),
        });
      }
    }

    return {
      arm: {
        run: { backend: spec.label, endpoint: spec.adapter.name, scored: base.scored, answered: base.collected },
        ...(asked.has("reversed") ? { reversed: reversedRows } : {}),
        ...(asked.has("r1") ? { reworded: rewordedRows } : {}),
        ...(outcomes !== undefined ? { injection: outcomes } : {}),
      },
      answers,
    };
  };

  const reference = await runArm(options.reference);
  const candidate = await runArm(options.candidate);

  return {
    inputs: {
      reference: reference.arm,
      candidate: candidate.arm,
      set: gate,
      calibration: policy.calibration,
      unmeasured: { polarity: reversed.unmeasured, rephrase: reworded.unmeasured },
    },
    answers: [reference.answers, candidate.answers],
    asked,
  };
}

/** A file name for an arm: its label, with anything a path would mind replaced. */
const slug = (label: string) => label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "arm";

export async function gateCommand(
  args: CalibrateArgs,
  policy: Policy,
  source: string,
  root: string,
  fixtures: readonly Fixture[],
  write: (s: string) => void,
): Promise<number> {
  for (const [flag, value] of [["--from", args.from], ["--compare", args.compare], ["--backend", args.backend], ["--out", args.out], ["--set", args.set]] as const) {
    if (value !== undefined) {
      // Each would be ignored, and an ignored flag reads as one that did something.
      write(`--gate does not take ${flag}: it names its own two backends (--gate and --reference), always scores the gate set, and records with --out-dir.\n`);
      return 1;
    }
  }

  const specs: GateArmSpec[] = [];
  for (const name of [args.reference ?? "jev", args.gate as string]) {
    const { label, backend } = labelled(name);
    const adapter = adapterFor(backend);
    if (typeof adapter === "string") {
      write(`${adapter}\n`);
      return 1;
    }
    specs.push({ label: label ?? adapter.name, adapter });
  }
  let [reference, candidate] = specs as [GateArmSpec, GateArmSpec];
  if (reference.label === candidate.label) {
    // The same backend on both sides is how the harness is checked against itself. The
    // columns still need two names.
    reference = { ...reference, label: `${reference.label} (reference)` };
    candidate = { ...candidate, label: `${candidate.label} (candidate)` };
  }

  const variantsDir = args.variants ?? join(root, "fixtures", "variants");
  const injectionPath = args.injection ?? join(root, "fixtures", "injection.jsonl");
  let reversedForms: Variant[] = [];
  let rewordings: Variant[] = [];
  let cases: InjectionCase[] = [];
  try {
    // A file that is not there is a part that is not measured, which the report says. A file
    // that is there and does not parse is an error, because half a dataset is worse than none.
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
    const polarityFile = read(join(variantsDir, "polarity.jsonl"));
    const rephraseFile = read(join(variantsDir, "rephrase.jsonl"));
    const injectionFile = read(injectionPath);
    if (polarityFile !== undefined) reversedForms = parseVariants(polarityFile, "reversed");
    if (rephraseFile !== undefined) rewordings = parseVariants(rephraseFile, "rephrase");
    if (injectionFile !== undefined) cases = parseInjection(injectionFile, fixtures, policy);
  } catch (err) {
    write(`Cannot run the gate: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  for (const spec of [reference, candidate]) {
    const problem = await startIfNeeded(spec.adapter);
    if (problem !== undefined) {
      write(`Cannot run the gate against ${spec.adapter.name}: ${problem}\n`);
      return 1;
    }
  }

  let run: GateRun;
  try {
    run = await runGate({
      policy,
      fixtures,
      reversed: reversedForms,
      rewordings,
      cases,
      reference,
      candidate,
      onProgress: (arm, stage, done, total) => {
        if (args.json !== true) process.stderr.write(`\r\x1b[K  ${arm}: ${stage} ${done}/${total}`);
      },
    });
  } catch (err) {
    if (args.json !== true) process.stderr.write("\r\x1b[K");
    write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (args.json !== true) process.stderr.write("\r\x1b[K");

  const assessment: GateAssessment = assess(run.inputs);
  const modelOf = (arm: GateArm) => arm.run.answered.find((a) => a.model !== undefined)?.model;

  if (args.outDir !== undefined) {
    try {
      for (const [i, spec] of [reference, candidate].entries()) {
        for (const [stage, answered] of (run.answers[i] as ReadonlyMap<Stage, readonly Answered[]>).entries()) {
          const under = run.asked.get(stage) ?? policy;
          writeAnswers(join(args.outDir, `${slug(spec.label)}.${stage}.jsonl`), answered, under, GATE_SET, spec.adapter.name);
        }
      }
    } catch (err) {
      write(`Cannot write to ${args.outDir}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (args.json === true) {
    write(`${JSON.stringify({ policy: source, fixtures: fixtures.length, ...assessment }, null, 2)}\n`);
  } else {
    write(`Policy: ${source}\n`);
    write(
      formatGate(assessment, {
        endpoints: [reference.adapter.name, candidate.adapter.name],
        models: [modelOf(run.inputs.reference), modelOf(run.inputs.candidate)],
        questions: policy.gate.questionsFingerprint,
      }),
    );
    if (args.outDir !== undefined) write(`\nAnswers written to ${args.outDir}, one file per arm and pass.\n`);
  }

  return assessment.attested ? 0 : 1;
}

/**
 * `bouncer calibrate --stamp <question[,question…]|all> [--restamp] [--variants dir]`
 *
 * Marks the variants of the questions named as written against the wording this policy
 * ships, which is what lets `--gate` ask them. See `stampVariants` for what it will and will
 * not touch. Exits 1 when a stale line was left alone, so a script cannot take "nothing
 * happened" for "done".
 *
 * It says which policy file it read before it says anything else. Run with no `--policy`,
 * the policy is resolved the way every command resolves it, and a personal
 * `~/.bouncer/bouncer.yaml` wins over the repository's: stamping a repository's variants
 * against one's own copy of the questions is the mistake this line exists to make visible.
 */
export function stampCommand(args: CalibrateArgs, policy: Policy, source: string, root: string, write: (s: string) => void): number {
  for (const [flag, value] of [["--gate", args.gate], ["--from", args.from], ["--compare", args.compare], ["--backend", args.backend], ["--out", args.out], ["--out-dir", args.outDir]] as const) {
    if (value !== undefined) {
      write(`--stamp does not take ${flag}: it edits the variant files and asks no backend.\n`);
      return 1;
    }
  }

  const gate = policy.gate;
  const asked = Object.keys(gate.questions);
  const named = (args.stamp as string).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (named.length === 0) {
    write(`--stamp needs a question, several separated by commas, or "all". The policy asks: ${asked.join(", ")}.\n`);
    return 1;
  }
  const everything = named.includes("all");
  if (everything && args.restamp === true) {
    // Restamping is a statement about one question someone has just reread.
    write(`--restamp takes questions by name, not "all": it says each stale line was reread against the new wording.\n`);
    return 1;
  }
  const unknown = named.filter((n) => n !== "all" && !asked.includes(n));
  if (unknown.length > 0) {
    write(`The policy asks no question named ${unknown.join(", ")}. It asks: ${asked.join(", ")}.\n`);
    return 1;
  }
  const questions = new Set(everything ? asked : named);

  const dir = args.variants ?? join(root, "fixtures", "variants");
  write(`Policy: ${source}\n`);

  let leftStale = false;
  let found = false;
  for (const file of ["polarity.jsonl", "rephrase.jsonl"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    found = true;

    let result;
    try {
      result = stampVariants(readFileSync(path, "utf8"), gate, questions, { restamp: args.restamp === true });
    } catch (err) {
      write(`Cannot stamp ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }

    write(`${path}\n`);
    for (const question of [...questions].sort()) {
      const parts = [
        result.stamped[question] !== undefined ? `${result.stamped[question]} stamped` : undefined,
        result.current[question] !== undefined ? `${result.current[question]} already current` : undefined,
        result.stale[question] !== undefined ? `${result.stale[question]} stale, left alone` : undefined,
      ].filter((s): s is string => s !== undefined);
      write(`  ${question}: ${parts.length > 0 ? parts.join(", ") : "no lines"}\n`);
      if (result.stale[question] !== undefined) leftStale = true;
    }
    // The file someone has just reviewed. Replaced whole or not at all.
    if (Object.keys(result.stamped).length > 0 && !writeAtomic(path, result.text)) {
      write(`Cannot write ${path}. Nothing in it was changed.\n`);
      return 1;
    }
  }

  if (!found) {
    write(`No polarity.jsonl or rephrase.jsonl in ${dir}.\n`);
    return 1;
  }
  if (leftStale) {
    write(
      "\nA stale line was written against another wording of its question. Reread it against the\n" +
        "question as it is now, fix it if it no longer means the same, then stamp that question with --restamp.\n",
    );
    return 1;
  }
  return 0;
}
