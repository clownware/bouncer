// `/bouncer:status` — what is configured, and what it has been doing.
//
// Written for someone deciding whether to move off observe mode, so it leads with the
// mode and the numbers that would justify changing it, not with configuration trivia.

import { manifestOf, type EscalationItem } from "../engine/escalation.js";
import * as breaker from "../io/breaker.js";
import { apiKey, dataDir, errorsIn, localBackend, pluginRoot, resolvePolicy } from "../io/config.js";
import { LOG_FILE, tail, type DecisionRecord } from "../io/log.js";
import type { HardRule, HardRuleWhen } from "../engine/types.js";
import { join, resolve } from "node:path";

const SAMPLE = 200;

export function status(): string {
  const cwd = process.cwd();
  const resolved = resolvePolicy(cwd, pluginRoot());
  const dir = dataDir();
  const lines: string[] = [];

  if (resolved.policy === undefined) {
    lines.push("bouncer is NOT running.", "");
    lines.push(`Policy: ${resolved.source}`);
    for (const d of errorsIn(resolved.diagnostics)) {
      lines.push(`  error at ${d.path || "the top level"}: ${d.message}`);
    }
    lines.push("", "Claude Code's own permission prompts are unaffected.");
    return `${lines.join("\n")}\n`;
  }

  const policy = resolved.policy;
  const sampled = tail(dir, SAMPLE);

  // Lines the mock adapter answered are set aside before anything is counted.
  //
  // The mock answers from fixed keyword heuristics and never reaches a network, so its
  // verdicts say nothing about the configured backend and its latencies are sub-millisecond
  // by construction. `npm run bench` used to write hundreds of them into the user's log,
  // which is how this was found: a status reading `ask 70` and `p50 0ms` over seventy
  // copies of one hardcoded benchmark payload, with "switching to guard would have added 70
  // prompts" underneath it. That last line is the one number someone reads before turning
  // enforcement on, so it is the one that must not be fed by a stand-in.
  //
  // Kept when the policy names `mock` as its backend: someone running the mock deliberately
  // has no other history, and silently summarising nothing would be worse than summarising
  // a stand-in they chose.
  const setAside = policy.backend === "mock" ? [] : sampled.filter((r) => r.backend === "mock");
  const records = setAside.length === 0 ? sampled : sampled.filter((r) => r.backend !== "mock");

  lines.push(`Mode:    ${policy.mode}${modeNote(policy.mode)}`);
  lines.push(`Backend: ${policy.backend}${backendNote(policy.backend)}`);
  lines.push(`Policy:  ${resolved.source}`);
  // The log's path is the first thing someone asks for when they want to watch what
  // bouncer is doing, and nothing else prints it: the data directory is an environment
  // variable with a fallback, so it is not guessable from the outside.
  lines.push(`Log:     ${join(dir, LOG_FILE)}`);

  const warnings = resolved.diagnostics.filter((d) => d.severity === "warning");
  for (const w of warnings) lines.push(`  warning at ${w.path || "the top level"}: ${w.message}`);

  lines.push(...hardRuleDrift(policy.gate.hardRules, resolved.source, cwd));

  // Every session the file remembers, because this command does not run inside one and has
  // no id of its own to ask with. It used to ask with an empty one, which matches nothing,
  // so this line never printed. The time is there so an old session's trip reads as old.
  const standingDown = breaker.readAll(dir).filter((s) => s.tripped !== undefined);
  if (standingDown.length > 0) lines.push("");
  for (const s of standingDown) {
    lines.push(`STANDING DOWN in session ${s.session_id.slice(0, 8)} (${s.tripped?.reason} since ${s.tripped?.at}).`);
  }

  lines.push("");

  if (records.length === 0) {
    lines.push("No decisions logged yet.");
    if (setAside.length > 0) lines.push("", mockNote(setAside.length, policy.backend));
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Last ${records.length} decisions:`);
  lines.push(...summarize(records));

  if (setAside.length > 0) lines.push("", mockNote(setAside.length, policy.backend));

  if (policy.mode === "observe") {
    // What guard would have put in front of the user. An error line emits nothing in any
    // mode, and neither does a call withheld for being truncated — that one carries `ask` so
    // that a careless reader lands on the safe side, and this is the reader that must not be
    // careless: it is the number someone looks at before turning enforcement on.
    const wouldPrompt = records.filter(
      (r) => r.error === undefined && r.reason.kind !== "truncated" && (r.verdict === "ask" || r.verdict === "deny"),
    ).length;
    lines.push(
      "",
      `In observe mode nothing was emitted. Switching to guard would have added ${wouldPrompt} prompt${wouldPrompt === 1 ? "" : "s"} across these ${records.length} calls.`,
      "Run `bouncer calibrate` before trusting that number.",
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Where a policy's hard rules have fallen behind the bundled ones (#126).
 *
 * A copied policy keeps the rule it was copied with. 0.2.4 narrowed `git-push-force-refspec`
 * in the bundled file; a copy taken before it kept `text: [" +"]`, and weeks later denied a
 * commit whose message said "+0.6 ms", which read as the fixed bug coming back. Nothing
 * said the copy was the cause. A changelog is read once, at update time if at all.
 *
 * Compared by name, because a name is the one thing a copy and its source still share. It
 * says "differs" and never "stale": the difference may be an edit the user made on purpose,
 * and this cannot tell. Here and not in the hook for that reason — it is printed when
 * someone asks, so a deliberate edit costs its author a few lines and no prompt.
 */
function hardRuleDrift(mine: readonly HardRule[], source: string, cwd: string): string[] {
  const root = pluginRoot();
  if (root === undefined) return [];
  const bundledPath = join(root, "policy", "default.yaml");
  if (resolve(source) === resolve(bundledPath)) return [];

  const bundled = resolvePolicy(cwd, root, bundledPath).policy?.gate.hardRules;
  if (bundled === undefined) return [];

  const { differing, missing } = compareHardRules(mine, bundled);
  if (differing.length === 0 && missing.length === 0) return [];

  const lines = ["", "Hard rules that are not the bundled ones:"];
  for (const d of differing) lines.push(`  ${d.name} differs`, ...d.details.map((detail) => `    ${detail}`));
  if (missing.length > 0) lines.push(`  not in your policy: ${missing.join(", ")}`);
  lines.push(
    `A copied policy keeps the rules it was copied with. If you did not change these on purpose, take them from ${bundledPath}.`,
  );
  return lines;
}

export interface HardRuleComparison {
  /** Entries of the same name whose `when` is not the same, and one line per predicate that is not. */
  readonly differing: readonly { readonly name: string; readonly details: readonly string[] }[];
  /** Bundled entries the policy has no entry of that name for. */
  readonly missing: readonly string[];
}

/** An entry only the user's policy has is theirs, and is not reported. */
export function compareHardRules(mine: readonly HardRule[], bundled: readonly HardRule[]): HardRuleComparison {
  const byName = new Map(mine.map((r) => [r.name, r]));
  const differing: { name: string; details: string[] }[] = [];
  const missing: string[] = [];

  for (const rule of bundled) {
    const own = byName.get(rule.name);
    if (own === undefined) {
      missing.push(rule.name);
      continue;
    }
    const details = whenDifferences(own.when, rule.when);
    if (details.length > 0) differing.push({ name: rule.name, details });
  }
  return { differing, missing };
}

/**
 * Predicate by predicate, in the policy file's own spelling. Only what differs is printed:
 * `redacts_as` holds thirteen kinds and the one that changed is the line worth reading. A
 * list is compared as a set, since no predicate reads its order.
 */
function whenDifferences(mine: HardRuleWhen, bundled: HardRuleWhen): string[] {
  const keys: (readonly [string, keyof HardRuleWhen])[] = [
    ["first_token", "firstToken"],
    ["tokens", "tokens"],
    ["token_prefix", "tokenPrefix"],
    ["not_tokens", "notTokens"],
    ["text", "text"],
    ["path_labelled", "pathLabelled"],
    ["redacts_as", "redactsAs"],
    ["target_labelled", "targetLabelled"],
  ];
  const show = (values: readonly string[]): string => values.map((v) => JSON.stringify(v)).join(", ");

  const details: string[] = [];
  for (const [key, field] of keys) {
    const own = mine[field];
    const theirs = bundled[field];
    if (own === undefined && theirs === undefined) continue;
    if (theirs === undefined) details.push(`${key}: [${show(own ?? [])}] is only in yours`);
    else if (own === undefined) details.push(`${key}: [${show(theirs)}] is only in the bundled entry`);
    else {
      const onlyMine = own.filter((v) => !theirs.includes(v));
      const onlyTheirs = theirs.filter((v) => !own.includes(v));
      if (onlyMine.length === 0 && onlyTheirs.length === 0) continue;
      const sides = [
        ...(onlyMine.length > 0 ? [`yours has ${show(onlyMine)}`] : []),
        ...(onlyTheirs.length > 0 ? [`the bundled entry has ${show(onlyTheirs)}`] : []),
      ];
      details.push(`${key}: ${sides.join("; ")}`);
    }
  }
  return details;
}

function summarize(records: readonly DecisionRecord[]): string[] {
  // A line where the classifier could not answer concluded nothing. It used to be written
  // `allow`, and counted here as one — under a heading someone reads to decide whether the
  // allow side can be trusted. New lines carry no verdict; old ones are told by their error.
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.error !== undefined || r.verdict === undefined) continue;
    counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  }

  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([verdict, n]) => `  ${verdict.padEnd(6)} ${n}`);

  const undecided = records.filter((r) => r.error !== undefined || r.verdict === undefined).length;
  if (undecided > 0) {
    lines.push(`  (${undecided} more concluded nothing — the classifier could not answer — and are not counted above)`);
  }

  const fastPath = records.filter((r) => r.reason.kind === "fast-path").length;
  if (fastPath > 0) {
    lines.push(`  (${fastPath} of these never reached the classifier — fast path)`);
  }

  // The substitution ratio (docs/adr/008): of the calls the classifier answered, how many
  // it could not settle. That is the set a reasoning model would have to look at, so it is
  // the number that says what asking a judgment model first actually bought.
  const judged = records.filter((r) => r.source === "judge");
  if (judged.length > 0) {
    const escalated = judged
      .map((r) => r.escalation)
      .filter((e): e is EscalationItem => e !== undefined);
    const manifest = manifestOf(escalated, judged.length);
    const pct = (manifest.escalationRate * 100).toFixed(1);
    lines.push(
      "",
      `Escalated ${manifest.items.length} of ${manifest.itemsJudged} judged calls (${pct}%) — the calls a rule could not settle on the classifier's answer alone.`,
    );
  }

  // Every call, the first of a session included. It used to be left out as connection
  // setup the rest of the session would not pay, but the hook is a process per call and
  // pays it every time — and this is the line the README sends people to for what they
  // actually wait for. The first call is part of that whether or not it is typical.
  const adapterCalls = records
    .filter((r) => typeof r.latency_ms.adapter === "number")
    .map((r) => r.latency_ms.adapter as number)
    .sort((a, b) => a - b);

  if (adapterCalls.length > 0) {
    const p = (q: number) => adapterCalls[Math.min(adapterCalls.length - 1, Math.floor(adapterCalls.length * q))];
    lines.push("", `Classifier latency over ${adapterCalls.length} calls: p50 ${p(0.5)}ms, p95 ${p(0.95)}ms`);
  }

  const errors = records.filter((r) => r.error !== undefined);
  if (errors.length > 0) {
    const last = errors[0];
    lines.push("", `${errors.length} error${errors.length === 1 ? "" : "s"}; most recent: ${last?.error?.kind} — ${last?.error?.message}`);
  }

  return lines;
}

/** Why some of the log is missing from the numbers above it. */
function mockNote(count: number, backend: string): string {
  const s = count === 1 ? "" : "s";
  return (
    `Ignoring ${count} record${s} answered by the mock backend — the mock scores from fixed ` +
    `keyword heuristics, so ${count === 1 ? "it is" : "they are"} test or benchmark traffic rather than evidence about ${backend}.`
  );
}

function modeNote(mode: string): string {
  switch (mode) {
    case "observe":
      return "  (logging only — Claude Code behaves exactly as it would without bouncer)";
    case "guard":
      return "  (adds prompts where policy says so; never removes one)";
    case "full":
      return "  (also suppresses prompts on calls judged safe)";
    default:
      return "";
  }
}

/** What is missing or where it is pointing, for the one backend line. */
function backendNote(backend: string): string {
  if (backend === "jev") return apiKey() === undefined ? "  (no API key in the environment)" : "";
  if (backend === "local") {
    const { baseUrl } = localBackend();
    return `  (${baseUrl ?? "http://127.0.0.1:8080/v1"})`;
  }
  return "";
}
