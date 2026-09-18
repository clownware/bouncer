// `/bouncer:status` — what is configured, and what it has been doing.
//
// Written for someone deciding whether to move off observe mode, so it leads with the
// mode and the numbers that would justify changing it, not with configuration trivia.

import * as breaker from "../io/breaker.js";
import { apiKey, dataDir, errorsIn, localBackend, pluginRoot, resolvePolicy } from "../io/config.js";
import { tail, type DecisionRecord } from "../io/log.js";

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
  const records = tail(dir, SAMPLE);

  lines.push(`Mode:    ${policy.mode}${modeNote(policy.mode)}`);
  lines.push(`Backend: ${policy.backend}${backendNote(policy.backend)}`);
  lines.push(`Policy:  ${resolved.source}`);

  const warnings = resolved.diagnostics.filter((d) => d.severity === "warning");
  for (const w of warnings) lines.push(`  warning at ${w.path || "the top level"}: ${w.message}`);

  const state = readBreaker(dir);
  if (state?.tripped !== undefined) {
    lines.push("", `STANDING DOWN for this session (${state.tripped.reason} since ${state.tripped.at}).`);
  }

  lines.push("");

  if (records.length === 0) {
    lines.push("No decisions logged yet.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Last ${records.length} decisions:`);
  lines.push(...summarize(records));

  if (policy.mode === "observe") {
    const wouldPrompt = records.filter((r) => r.verdict === "ask" || r.verdict === "deny").length;
    lines.push(
      "",
      `In observe mode nothing was emitted. Switching to guard would have added ${wouldPrompt} prompt${wouldPrompt === 1 ? "" : "s"} across these ${records.length} calls.`,
      "Run `bouncer calibrate` before trusting that number.",
    );
  }

  return `${lines.join("\n")}\n`;
}

function summarize(records: readonly DecisionRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);

  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([verdict, n]) => `  ${verdict.padEnd(6)} ${n}`);

  const fastPath = records.filter((r) => r.reason.kind === "fast-path").length;
  if (fastPath > 0) {
    lines.push(`  (${fastPath} of these never reached the classifier — fast path)`);
  }

  // Warm-up is excluded: it reflects connection setup, not steady-state behaviour, and
  // including it makes a healthy session look slow.
  const adapterCalls = records
    .filter((r) => r.warmup !== true && typeof r.latency_ms.adapter === "number")
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

function readBreaker(dir: string): breaker.BreakerState | undefined {
  try {
    return breaker.read(dir, "");
  } catch {
    return undefined;
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
