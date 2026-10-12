// `bouncer ready` — is this change finished enough to push? (#93)
//
//   bouncer ready [--base ref] [--policy path] [--backend jev|jev@<url>|local|mock]
//                 [--enforce] [--concurrency n] [--json]
//
// Reads the commits ahead of the base, asks the `push` set once of the whole change and the
// `push_file` set of each changed file worth reading, and prints which questions fired.
//
// Three things about how it behaves, each on purpose:
//
//   - It observes. The exit status is 0 whatever it found, unless `--enforce` is given, in
//     which case a HOLD exits 1 (which is what stops a `git push` from a pre-push hook). The
//     baseline is pushing, so a check that holds pushes before anyone has looked at how often
//     it is right would be the friction this project calls a bug.
//   - It never holds on its own failure. No repository, no base, no key, a backend that
//     timed out: each is printed and exits 0, with or without `--enforce`. A check that
//     could not run has no opinion.
//   - It sends content. Commit messages and diff text go to the backend, after redaction.
//     That is the judge's rule and not the gate's (ADR-009 decision 4): this is a command
//     pointed at a change, and the change is the subject.
//
// Every real run is appended to `readiness.jsonl` in the data directory with the head
// commit and the answers, and no diff text. The point is the comparison nobody has to label
// for: what this said, against what CI said about the same commit an hour later.

import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Adapter } from "../adapters/types.js";
import { buildItemState } from "../engine/item.js";
import type { Policy, PolicySet } from "../engine/types.js";
import { dataDir, errorsIn, pluginRoot, resolvePolicy } from "../io/config.js";
import { readChange, type GitChange } from "../io/git.js";
import { judge, type JudgedItem, type StatedItem } from "../judge.js";
import { PUSH_FILE_SET, PUSH_SET, pushItems, type Unchecked } from "../push.js";
import { parseFlags, positiveInteger } from "./args.js";
import { adapterFor, startIfNeeded } from "./calibrate.js";

export const READINESS_FILE = "readiness.jsonl";
/** Read when `--policy` is not given, ahead of the policy that ships. */
export const PUSH_POLICY_ENV = "BOUNCER_PUSH_POLICY";

export interface ReadyArgs {
  readonly base?: string;
  readonly policy?: string;
  readonly backend?: string;
  readonly enforce?: boolean;
  readonly concurrency?: number;
  readonly json?: boolean;
  readonly error?: string;
}

const FLAGS = { values: ["base", "policy", "backend", "concurrency"], switches: ["enforce", "json"] } as const;

export function parseArgs(argv: readonly string[]): ReadyArgs {
  const parsed = parseFlags(argv, FLAGS);
  const { values, switches } = parsed;
  const concurrency = positiveInteger("concurrency", values.get("concurrency"));
  const error = parsed.error ?? concurrency.error;
  return {
    ...(values.has("base") ? { base: values.get("base") as string } : {}),
    ...(values.has("policy") ? { policy: values.get("policy") as string } : {}),
    ...(values.has("backend") ? { backend: values.get("backend") as string } : {}),
    ...(concurrency.value !== undefined ? { concurrency: concurrency.value } : {}),
    enforce: switches.has("enforce"),
    json: switches.has("json"),
    ...(error !== undefined ? { error } : {}),
  };
}

/** One question that fired, on the whole push or on one file. */
export interface Hold {
  /** `push`, or the file's path. */
  readonly where: string;
  readonly question: string;
  readonly p: number;
  /** The question's own words, so the report explains itself. */
  readonly asks: string;
}

export interface Readiness {
  /**
   * `ready`: every question asked stayed quiet. `hold`: at least one fired. `unchecked`:
   * nothing could be asked at all, which is not the same as nothing being wrong.
   */
  readonly verdict: "ready" | "hold" | "unchecked";
  readonly holds: readonly Hold[];
  /** Files no file-level question was asked of, and items the backend failed to answer. */
  readonly unchecked: readonly Unchecked[];
  /** Every answer, by item (`push` or a path) and question. What a later comparison reads. */
  readonly answers: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly filesChecked: number;
  readonly backend: string;
  readonly model?: string;
}

export interface ReadyOptions {
  readonly change: GitChange;
  readonly policy: Policy;
  readonly adapter: Adapter;
  readonly concurrency?: number;
}

/**
 * Judges a change. Pure apart from the adapter: the caller read the change and loaded the
 * policy, and gets back what was found without anything having been printed or written.
 */
export async function assessChange(options: ReadyOptions): Promise<Readiness> {
  const { change, policy, adapter } = options;
  const sets = { push: policy.sets[PUSH_SET] as PolicySet, file: policy.sets[PUSH_FILE_SET] as PolicySet };
  const items = pushItems(change);

  const run = async (setName: string, set: PolicySet, stated: readonly StatedItem[]) =>
    stated.length === 0
      ? []
      : (
          await judge(stated, {
            setName,
            set,
            mode: policy.mode,
            adapter,
            timeoutMs: policy.timeoutMs,
            ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
          })
        ).items;

  const whole = await run(PUSH_SET, sets.push, [{ id: "push", state: buildItemState(items.summary) }]);
  const perFile = await run(
    PUSH_FILE_SET,
    sets.file,
    items.files.map((f) => ({ id: f.path, state: buildItemState(f.item) })),
  );

  const holds: Hold[] = [];
  const unchecked: Unchecked[] = [...items.unchecked];
  const answers: Record<string, Readonly<Record<string, number>>> = {};
  let judged = 0;
  let model: string | undefined;

  const read = (results: readonly JudgedItem[], set: PolicySet) => {
    for (const item of results) {
      if (item.outcome === "unjudged") {
        unchecked.push({ path: item.id, why: `the backend did not answer (${item.error.kind})` });
        continue;
      }
      if (item.outcome === "incomplete") {
        unchecked.push({ path: item.id, why: "too long to be read whole" });
        continue;
      }
      judged += 1;
      answers[item.id] = item.answers;
      model ??= item.model;
      if (item.verdict === "allow" || item.reason.kind !== "rule") continue;
      holds.push({
        where: item.id,
        question: item.reason.question,
        p: item.reason.p,
        asks: set.questions[item.reason.question]?.instructions ?? "",
      });
    }
  };
  read(whole, sets.push);
  read(perFile, sets.file);

  return {
    verdict: holds.length > 0 ? "hold" : judged === 0 ? "unchecked" : "ready",
    holds,
    unchecked,
    answers,
    filesChecked: perFile.filter((i) => i.outcome === "judged").length,
    backend: adapter.name,
    ...(model !== undefined ? { model } : {}),
  };
}

export function formatReadiness(change: GitChange, result: Readiness, context: { readonly policy: string; readonly enforce: boolean }): string {
  const added = change.files.reduce((sum, f) => sum + f.added, 0);
  const removed = change.files.reduce((sum, f) => sum + f.removed, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines: string[] = [
    `Push readiness: ${change.branch} against ${change.baseRef}, ${plural(change.commits.length, "commit")}, ${plural(change.files.length, "file")} (+${added} −${removed})`,
    `  policy ${context.policy} · backend ${result.backend}${result.model !== undefined ? ` (${result.model})` : ""}`,
    "",
  ];

  if (result.verdict === "hold") {
    lines.push(context.enforce ? "HOLD" : "HOLD (observing: nothing is blocked; pass --enforce to make this exit 1)");
    const width = Math.max(...result.holds.map((h) => h.where.length));
    for (const h of result.holds) {
      lines.push(`  ${h.where.padEnd(width)}  ${h.question} ${h.p.toFixed(2)}`, `  ${" ".repeat(width)}  ${h.asks}`);
    }
  } else if (result.verdict === "ready") {
    lines.push(`READY: no question fired on the push or on the ${plural(result.filesChecked, "file")} read.`);
  } else {
    lines.push("NOT CHECKED: nothing could be asked, so this says nothing about the change.");
  }

  if (result.unchecked.length > 0) {
    lines.push("", `Not checked (${result.unchecked.length}):`);
    for (const u of result.unchecked) lines.push(`  ${u.path}: ${u.why}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * One line per real run. Paths, probabilities and the head commit; no diff and no message
 * text. The mock is left out for the reason `status` sets its lines aside: it is a keyword
 * match, and a file of its verdicts would read as a record of judgments.
 */
function record(dir: string, change: GitChange, result: Readiness, policy: Policy, enforce: boolean): void {
  if (result.backend === "mock") return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, READINESS_FILE),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        repo: basename(change.root),
        branch: change.branch,
        base: change.base,
        head: change.head,
        verdict: result.verdict,
        enforce,
        backend: result.backend,
        ...(result.model !== undefined ? { model: result.model } : {}),
        policy: {
          file: policy.fingerprint,
          [PUSH_SET]: policy.sets[PUSH_SET]?.questionsFingerprint,
          [PUSH_FILE_SET]: policy.sets[PUSH_FILE_SET]?.questionsFingerprint,
        },
        holds: result.holds.map((h) => ({ where: h.where, question: h.question, p: h.p })),
        answers: result.answers,
        unchecked: result.unchecked.length,
      })}\n`,
      "utf8",
    );
  } catch {
    // A log that cannot be written is not a reason to fail a readiness check.
  }
}

export async function ready(args: ReadyArgs, write: (s: string) => void, cwd: string = process.cwd()): Promise<number> {
  // Exit 1 is reserved for a HOLD under --enforce. Everything else that goes wrong is a
  // check that did not happen, so it is said and the push is left alone.
  const skip = (message: string): number => {
    write(`bouncer ready did not run: ${message}\n`);
    return 0;
  };
  if (args.error !== undefined) {
    write(args.error);
    return 1;
  }

  const root = pluginRoot() ?? process.cwd();
  const explicit = args.policy ?? process.env[PUSH_POLICY_ENV] ?? join(root, "policy", "push.yaml");
  const resolved = resolvePolicy(cwd, root, explicit);
  if (resolved.policy === undefined) {
    return skip(`${resolved.source} did not load. ${errorsIn(resolved.diagnostics).map((d) => `${d.path || "(top level)"}: ${d.message}`).join("; ")}`);
  }
  const policy = resolved.policy;
  const missing = [PUSH_SET, PUSH_FILE_SET].filter((name) => policy.sets[name] === undefined);
  if (missing.length > 0) {
    return skip(`${resolved.source} defines no set named ${missing.join(" or ")} (it has: ${Object.keys(policy.sets).join(", ") || "none"}).`);
  }

  const change = readChange(cwd, args.base);
  if (typeof change === "string") return skip(change);
  if (change.commits.length === 0) {
    write(`Nothing to push: ${change.branch} has no commits ahead of ${change.baseRef}.\n`);
    return 0;
  }

  const adapter = adapterFor(args.backend ?? policy.backend);
  if (typeof adapter === "string") return skip(adapter.replace("Cannot calibrate against", "cannot ask"));
  const problem = await startIfNeeded(adapter);
  if (problem !== undefined) return skip(`${adapter.name}: ${problem}`);

  let result: Readiness;
  try {
    result = await assessChange({
      change,
      policy,
      adapter,
      ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
    });
  } catch (err) {
    return skip(err instanceof Error ? err.message : String(err));
  }

  const enforce = args.enforce === true;
  record(dataDir(), change, result, policy, enforce);

  if (args.json === true) {
    write(`${JSON.stringify({ branch: change.branch, base: change.baseRef, head: change.head, policy: resolved.source, enforce, ...result }, null, 2)}\n`);
  } else {
    write(formatReadiness(change, result, { policy: resolved.source, enforce }));
  }
  return enforce && result.verdict === "hold" ? 1 : 0;
}
