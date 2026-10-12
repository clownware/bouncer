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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeAtomic } from "../io/atomic.js";
import { join } from "node:path";
import type { Adapter } from "../adapters/types.js";
import { score, scoreAnswered, scoreFromLog, type Answered, type Fixture } from "../calibrate.js";
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
  type VariantCheck,
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

/** Which passes a run makes, and which questions each variant part can measure. */
export interface GatePlan {
  /** The policy each pass is asked under: `base`, and one per usable variant kind. */
  readonly asked: ReadonlyMap<Stage, Policy>;
  readonly reversed: VariantCheck;
  readonly reworded: VariantCheck;
}

/** The passes for each rewording position, in order. */
const REWORDING_STAGES: readonly Stage[] = Array.from({ length: REWORDINGS }, (_, i) => `r${i + 1}`);

/**
 * One policy per pass, built once and used for both arms, so the two are asked the same
 * bytes, and built the same way for a recorded run, so its answers are checked against the
 * wording they would be asked under today.
 */
export function planGate(policy: Policy, reversedForms: readonly Variant[], rewordings: readonly Variant[]): GatePlan {
  const gate = policy.gate;
  const reversed = checkVariants(reversedForms, gate, "reversed");
  const reworded = checkVariants(rewordings, gate, "rephrase");

  const asked = new Map<Stage, Policy>([["base", policy]]);
  const usableReversed = Object.entries(reversed.usable);
  if (usableReversed.length > 0) {
    asked.set("reversed", asking(policy, withVariants(gate, Object.fromEntries(usableReversed.map(([q, v]) => [q, v[0] as Variant])))));
  }
  const usableReworded = Object.entries(reworded.usable).map(
    ([q, variants]) => [q, [...variants].sort((a, b) => a.id.localeCompare(b.id))] as const,
  );
  if (usableReworded.length > 0) {
    REWORDING_STAGES.forEach((stage, i) => {
      asked.set(stage, asking(policy, withVariants(gate, Object.fromEntries(usableReworded.map(([q, v]) => [q, v[i] as Variant])))));
    });
  }
  return { asked, reversed, reworded };
}

/**
 * An arm, from what it answered in each pass.
 *
 * The live run and a recorded one both end here, for the reason `scoreAnswered` gives about
 * `calibrate` itself: two paths that each worked out the same numbers their own way would
 * print different tables from the same answers. A pass that is not in `answers` leaves its
 * part absent, which `assess` reports as not measured.
 */
export function buildArm(
  spec: { readonly label: string; readonly endpoint: string },
  answers: ReadonlyMap<Stage, readonly Answered[]>,
  plan: GatePlan,
  policy: Policy,
  cases: readonly InjectionCase[],
): GateArm {
  const gate = policy.gate;
  const base = answers.get("base") ?? [];
  const baseById = new Map(base.map((a) => [a.fixture.id, a]));

  const variantRows = (stages: readonly Stage[], measured: ReadonlySet<string>): GateVariantRow[] | undefined => {
    if (!stages.every((stage) => plan.asked.has(stage) && answers.has(stage))) return undefined;
    const rows: GateVariantRow[] = [];
    for (const stage of stages) {
      for (const answered of answers.get(stage) ?? []) {
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

  const reversedRows = variantRows(["reversed"], new Set(Object.keys(plan.reversed.usable)));
  const rewordedRows = variantRows(REWORDING_STAGES, new Set(Object.keys(plan.reworded.usable)));

  let outcomes: InjectionOutcome[] | undefined;
  const attackedAnswers = answers.get("injection");
  if (cases.length > 0 && attackedAnswers !== undefined) {
    const verdictOf = (answered: Answered): Verdict => scoreAnswered(answered, policy, gate, GATE_SET).verdict;
    const attackedById = new Map(attackedAnswers.map((a) => [a.fixture.id, a]));
    outcomes = [];
    for (const c of cases) {
      const original = baseById.get(c.base.id);
      const attacked = attackedById.get(c.fixture.id);
      // A case whose base or whose own answer is missing cannot say whether text moved the
      // verdict. It is left out of the rate, which `injection_min_n` is there to notice.
      if (original === undefined || attacked === undefined) continue;
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
    run: {
      backend: spec.label,
      endpoint: spec.endpoint,
      scored: base.flatMap((a) => scoreAnswered(a, policy, gate, GATE_SET).rows),
      answered: base,
    },
    ...(reversedRows !== undefined ? { reversed: reversedRows } : {}),
    ...(rewordedRows !== undefined ? { reworded: rewordedRows } : {}),
    ...(outcomes !== undefined ? { injection: outcomes } : {}),
  };
}

export async function runGate(options: GateOptions): Promise<GateRun> {
  const { policy, fixtures, cases } = options;
  const plan = planGate(policy, options.reversed, options.rewordings);

  for (const c of cases) {
    if (!fixtures.some((f) => f.id === c.base.id)) {
      throw new Error(`injection case "${c.fixture.id}" is based on "${c.base.id}", which is not among the fixtures this run asks`);
    }
  }

  const runArm = async (spec: GateArmSpec): Promise<{ arm: GateArm; answers: Map<Stage, Answered[]> }> => {
    const answers = new Map<Stage, Answered[]>();
    const pass = async (stage: Stage, items: readonly Fixture[], under: Policy) => {
      const collected: Answered[] = [];
      await score(items, under, spec.adapter, (done, total, answered) => {
        collected.push(answered);
        options.onProgress?.(spec.label, stage, done, total);
      });
      answers.set(stage, collected);
    };

    for (const [stage, under] of plan.asked) await pass(stage, fixtures, under);
    if (cases.length > 0) {
      await pass(
        "injection",
        cases.map((c) => c.fixture),
        policy,
      );
    }
    return { arm: buildArm({ label: spec.label, endpoint: spec.adapter.name }, answers, plan, policy, cases), answers };
  };

  const reference = await runArm(options.reference);
  const candidate = await runArm(options.candidate);

  return {
    inputs: {
      reference: reference.arm,
      candidate: candidate.arm,
      set: policy.gate,
      calibration: policy.calibration,
      unmeasured: { polarity: plan.reversed.unmeasured, rephrase: plan.reworded.unmeasured },
    },
    answers: [reference.answers, candidate.answers],
    asked: plan.asked,
  };
}

/** A file name for an arm: its label, with anything a path would mind replaced. */
const slug = (label: string) => label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "arm";

interface Datasets {
  readonly reversedForms: Variant[];
  readonly rewordings: Variant[];
  readonly cases: InjectionCase[];
}

/**
 * The variant and injection files. A file that is not there is a part that is not measured,
 * which the report says. A file that is there and does not parse throws, because half a
 * dataset is worse than none.
 */
function loadDatasets(args: CalibrateArgs, root: string, fixtures: readonly Fixture[], policy: Policy): Datasets {
  const variantsDir = args.variants ?? join(root, "fixtures", "variants");
  const injectionPath = args.injection ?? join(root, "fixtures", "injection.jsonl");
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
  const polarityFile = read(join(variantsDir, "polarity.jsonl"));
  const rephraseFile = read(join(variantsDir, "rephrase.jsonl"));
  const injectionFile = read(injectionPath);
  return {
    reversedForms: polarityFile !== undefined ? parseVariants(polarityFile, "reversed") : [],
    rewordings: rephraseFile !== undefined ? parseVariants(rephraseFile, "rephrase") : [],
    cases: injectionFile !== undefined ? parseInjection(injectionFile, fixtures, policy) : [],
  };
}

/** What `--out-dir` leaves beside the answers, so `--gate --from` knows which arm was which. */
export const MANIFEST = "gate.json";

interface ManifestArm {
  readonly role: "reference" | "candidate";
  readonly label: string;
  readonly slug: string;
  readonly endpoint: string;
}

export async function gateCommand(
  args: CalibrateArgs,
  policy: Policy,
  source: string,
  root: string,
  fixtures: readonly Fixture[],
  write: (s: string) => void,
): Promise<number> {
  for (const [flag, value] of [["--compare", args.compare], ["--backend", args.backend], ["--out", args.out], ["--set", args.set]] as const) {
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

  let datasets: Datasets;
  try {
    datasets = loadDatasets(args, root, fixtures, policy);
  } catch (err) {
    write(`Cannot run the gate: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { reversedForms, rewordings, cases } = datasets;

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
      const arms: ManifestArm[] = [reference, candidate].map((spec, i) => ({
        role: i === 0 ? ("reference" as const) : ("candidate" as const),
        label: spec.label,
        slug: slug(spec.label),
        endpoint: spec.adapter.name,
      }));
      if (!writeAtomic(join(args.outDir, MANIFEST), `${JSON.stringify({ written: new Date().toISOString(), questions: policy.gate.questionsFingerprint, arms }, null, 2)}\n`)) {
        throw new Error(`could not write ${MANIFEST}`);
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
    if (args.outDir !== undefined) {
      write(`\nAnswers written to ${args.outDir}, one file per arm and pass. Re-score them without a key: bouncer calibrate --gate ${slug(candidate.label)} --from ${args.outDir}\n`);
    }
  }

  return assessment.attested ? 0 : 1;
}

interface RecordedArm {
  readonly dir: string;
  readonly slug: string;
  readonly label: string;
  readonly endpoint: string;
  readonly role?: "reference" | "candidate";
}

/** Every arm recorded in the directories named: one per `<slug>.base.jsonl`, named by the manifest when there is one. */
function recordedArms(dirs: readonly string[]): RecordedArm[] {
  const arms: RecordedArm[] = [];
  for (const dir of dirs) {
    let manifest: readonly ManifestArm[] = [];
    try {
      const parsed = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { arms?: unknown };
      if (Array.isArray(parsed.arms)) manifest = parsed.arms as ManifestArm[];
    } catch {
      // A directory recorded before the manifest existed, or one whose manifest was removed.
      // The file names still say which arms are in it; only the reference has to be named.
    }
    for (const file of readdirSync(dir).sort()) {
      const match = /^(.+)\.base\.jsonl$/.exec(file);
      if (match === null) continue;
      const armSlug = match[1] as string;
      const named = manifest.find((m) => m.slug === armSlug);
      arms.push({
        dir,
        slug: armSlug,
        label: named?.label ?? armSlug,
        endpoint: named?.endpoint ?? armSlug,
        ...(named?.role !== undefined ? { role: named.role } : {}),
      });
    }
  }
  return arms;
}

/**
 * `bouncer calibrate --gate <candidate> --from <dir>[,<dir>] [--reference <name>]`
 *
 * Scores a gate run that `--out-dir` recorded, with no key and no server. This is what a
 * moved margin, a changed threshold or a relabelled fixture costs after the answers have
 * been paid for: nothing. The candidate and the reference are named as the report printed
 * them, or by their file-name slug; the reference defaults to the one the run recorded.
 *
 * Three things it will not do. It will not score an answer against a question it was not an
 * answer to: every file must carry the fingerprint of the wording it would be asked under
 * today, base and variants alike, and one that does not is refused by name. It will not
 * invent a pass: a part whose pass was not recorded is reported as not measured. And it will
 * never write an attestation, because an attestation says a server answered today and this
 * read a file.
 */
export function gateFromCommand(
  args: CalibrateArgs,
  policy: Policy,
  source: string,
  root: string,
  fixtures: readonly Fixture[],
  write: (s: string) => void,
): number {
  for (const [flag, value] of [["--compare", args.compare], ["--backend", args.backend], ["--out", args.out], ["--out-dir", args.outDir], ["--set", args.set]] as const) {
    if (value !== undefined) {
      write(`--gate --from does not take ${flag}: it reads a recorded run and asks no backend.\n`);
      return 1;
    }
  }

  const dirs = (args.from as string).split(",").map((d) => d.trim()).filter((d) => d.length > 0);
  let arms: RecordedArm[];
  try {
    arms = recordedArms(dirs);
  } catch (err) {
    write(`Cannot read ${args.from}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const listing = arms.length === 0 ? "none" : arms.map((a) => (a.label === a.slug ? a.slug : `${a.label} (${a.slug})`)).join(", ");
  if (arms.length === 0) {
    write(`No recorded gate run in ${dirs.join(", ")}: expected files named <arm>.base.jsonl, as --out-dir writes them.\n`);
    return 1;
  }
  const find = (name: string) => arms.filter((a) => a.label === name || a.slug === name || a.slug === slug(name));
  const pick = (name: string, flag: string): RecordedArm | undefined => {
    const found = find(name);
    if (found.length === 1) return found[0];
    write(
      found.length === 0
        ? `No recorded arm named ${name} (${flag}). Recorded: ${listing}.\n`
        : `${name} (${flag}) is recorded in more than one of the directories given; name one directory.\n`,
    );
    return undefined;
  };

  const candidate = pick(args.gate as string, "--gate");
  if (candidate === undefined) return 1;
  let reference: RecordedArm | undefined;
  if (args.reference !== undefined) {
    reference = pick(args.reference, "--reference");
    if (reference === undefined) return 1;
  } else {
    const recorded = arms.filter((a) => a.role === "reference" && a !== candidate);
    if (recorded.length !== 1) {
      write(`Name the reference with --reference: ${recorded.length === 0 ? "none of these directories says which arm it was" : "more than one is recorded"}. Recorded: ${listing}.\n`);
      return 1;
    }
    reference = recorded[0] as RecordedArm;
  }
  if (reference === candidate) {
    write("The candidate and the reference are the same recorded arm.\n");
    return 1;
  }

  let datasets: Datasets;
  try {
    datasets = loadDatasets(args, root, fixtures, policy);
  } catch (err) {
    write(`Cannot score the gate: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const plan = planGate(policy, datasets.reversedForms, datasets.rewordings);
  const caseFixtures = datasets.cases.map((c) => c.fixture);
  const stages: Array<readonly [Stage, Policy, readonly Fixture[]]> = [
    ...[...plan.asked].map(([stage, under]) => [stage, under, fixtures] as const),
    ...(datasets.cases.length > 0 ? [["injection", policy, caseFixtures] as const] : []),
  ];

  const notes: string[] = [];
  const missing = { polarity: {} as Record<string, string>, rephrase: {} as Record<string, string> };
  const read = (arm: RecordedArm) => {
    const answers = new Map<Stage, readonly Answered[]>();
    let model: string | undefined;
    let first: string | undefined;
    for (const [stage, under, items] of stages) {
      const path = join(arm.dir, `${arm.slug}.${stage}.jsonl`);
      if (!existsSync(path)) {
        const reason = `no ${stage} pass was recorded for ${arm.label}`;
        if (stage === "reversed") for (const q of Object.keys(plan.reversed.usable)) missing.polarity[q] = reason;
        else if (REWORDING_STAGES.includes(stage)) for (const q of Object.keys(plan.reworded.usable)) missing.rephrase[q] = reason;
        else if (stage === "injection") notes.push(`${reason}, so injection is not measured`);
        else throw new Error(`${path} is missing: an arm with no base pass has nothing to score`);
        continue;
      }
      const log = scoreFromLog(readFileSync(path, "utf8"), items, under);
      if (log.reworded > 0) {
        const want = (under.sets[GATE_SET] as { questionsFingerprint: string }).questionsFingerprint;
        throw new Error(
          `${path} was answered under another wording (${log.questions.join(", ")}) than the ${stage} pass asks today (${want}). ` +
            "Those are answers to different questions; record the run again.",
        );
      }
      if (log.matched === 0) throw new Error(`${path} holds no answer to any fixture this run scores`);
      if (log.unmatched > 0) notes.push(`${arm.label}, ${stage}: ${log.unmatched} recorded answers are to fixtures that no longer exist and are left out`);
      if (log.matched < items.length) notes.push(`${arm.label}, ${stage}: ${items.length - log.matched} of ${items.length} fixtures have no recorded answer`);
      answers.set(stage, log.answered);
      if (stage === "base") {
        model = log.models.length === 1 ? log.models[0] : log.models.length > 1 ? log.models.join(" and ") : undefined;
        first = log.span?.first;
      }
    }
    return { arm: buildArm({ label: arm.label, endpoint: arm.endpoint }, answers, plan, policy, datasets.cases), model, first };
  };

  let ref: ReturnType<typeof read>;
  let cand: ReturnType<typeof read>;
  try {
    ref = read(reference);
    cand = read(candidate);
  } catch (err) {
    write(`Cannot score the gate: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const assessment = assess({
    reference: ref.arm,
    candidate: cand.arm,
    set: policy.gate,
    calibration: policy.calibration,
    unmeasured: {
      polarity: { ...plan.reversed.unmeasured, ...missing.polarity },
      rephrase: { ...plan.reworded.unmeasured, ...missing.rephrase },
    },
  });

  const recorded = `recorded: ${reference.label} answered ${ref.first ?? "at an unrecorded time"}, ${candidate.label} ${cand.first ?? "at an unrecorded time"}`;
  if (args.json === true) {
    write(`${JSON.stringify({ policy: source, from: dirs, fixtures: fixtures.length, notes, ...assessment }, null, 2)}\n`);
  } else {
    write(`Policy: ${source}\n`);
    write(
      formatGate(assessment, {
        endpoints: [reference.endpoint, candidate.endpoint],
        models: [ref.model, cand.model],
        questions: policy.gate.questionsFingerprint,
        notes: [recorded, ...notes, "scored from files, so this can never attest a backend: an attestation says a server answered today"],
      }),
    );
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
