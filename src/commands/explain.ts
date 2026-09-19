// `/bouncer:explain` — why a specific call was decided the way it was.
//
// The model never sees the judgment (ADR-001), so this log is the only way to answer
// "why did that get blocked". It prints the raw probability per question rather than only
// the verdict, because the useful next action is usually to move a threshold.

import { dataDir } from "../io/config.js";
import { tail, type DecisionRecord } from "../io/log.js";

const SEARCH_DEPTH = 500;

export function explain(toolUseId?: string): string {
  const records = tail(dataDir(), SEARCH_DEPTH);

  if (records.length === 0) {
    return "No decisions logged yet.\n";
  }

  const record =
    toolUseId === undefined || toolUseId.length === 0
      ? records.find((r) => r.reason.kind !== "fast-path") ?? records[0]
      : records.find((r) => r.tool_use_id === toolUseId);

  if (record === undefined) {
    return `No decision logged for ${toolUseId}. It may have scrolled out of the last ${SEARCH_DEPTH} entries.\n`;
  }

  return render(record);
}

function render(record: DecisionRecord): string {
  const lines: string[] = [];

  // A judge line has no tool, because an item is not a tool call. It names its item and
  // the set it was judged against instead.
  lines.push(`${record.tool ?? `${record.set ?? "?"}: ${record.item ?? "(item)"}`} at ${record.ts}`);
  // A line where the classifier could not answer has no verdict, or — written before
  // 2026-09-19 — an `allow` nobody concluded. Either way nothing was decided, and saying
  // "no rule matched" about it sent people to their thresholds to fix a network error.
  const concluded = record.error === undefined && record.verdict !== undefined;
  const emitted = record.emitted === null ? `  (nothing emitted${concluded ? ` — ${record.mode} mode` : ""})` : `  (emitted ${record.emitted})`;
  lines.push(`Verdict: ${concluded ? record.verdict : "none"}${emitted}`);
  lines.push(
    `Because: ${record.error !== undefined ? `the classifier could not answer (${record.error.kind}: ${record.error.message})` : describe(record)}`,
  );

  if (record.permission_mode !== undefined) {
    lines.push(`Permission mode: ${record.permission_mode}`);
  }
  if (record.agent_type !== undefined) {
    lines.push(`Called by subagent: ${record.agent_type}`);
  }

  if (record.answers !== undefined && Object.keys(record.answers).length > 0) {
    lines.push("", "Judgments:");
    const entries = Object.entries(record.answers).sort((a, b) => b[1] - a[1]);
    const width = Math.max(...entries.map(([name]) => name.length));
    for (const [name, p] of entries) {
      lines.push(`  ${name.padEnd(width)}  ${p.toFixed(2)}  ${bar(p)}`);
    }
  }

  // The escalation: every threshold this call crossed, not only the one that decided.
  // The judgments table above is every answer; this is the subset a rule acted on, and it
  // is the same record a reasoning model would be handed. See docs/adr/008.
  if (record.escalation !== undefined && record.escalation.signals.length > 0) {
    lines.push("", `Escalated as ${record.escalation.verdict}, on:`);
    for (const signal of record.escalation.signals) {
      const mark = signal.decided ? "→" : " ";
      lines.push(`  ${mark} ${signal.question} ${signal.p.toFixed(2)} ${signal.criterion} (rule ${signal.ruleIndex} → ${signal.verdict})`);
      lines.push(`      ${signal.asks}`);
    }
    if (record.escalation.signals.length > 1) {
      lines.push("  → marks the one that decided; first match wins.");
    }
  }

  if (record.error !== undefined) {
    lines.push("", `Error: ${record.error.kind} — ${record.error.message}`);
  }

  if (record.state !== undefined) {
    lines.push("", "What was sent to the classifier:", `  ${record.state}`);
  }

  if (record.redacted_kinds !== undefined && record.redacted_kinds.length > 0) {
    lines.push("", `Redacted before sending: ${record.redacted_kinds.join(", ")}`);
  }

  const adapter = record.latency_ms.adapter;
  lines.push("", `Latency: ${record.latency_ms.total}ms total${adapter !== undefined ? `, ${adapter}ms in the classifier` : ""}${record.warmup === true ? "  (first call of the session)" : ""}`);

  return `${lines.join("\n")}\n`;
}

function describe(record: DecisionRecord): string {
  const reason = record.reason;
  switch (reason.kind) {
    case "rule":
      return reason.question === "default"
        ? "no rule matched, so the policy's default applied"
        : `rule ${reason.ruleIndex} matched: ${reason.question} was ${reason.p.toFixed(2)}`;
    case "fast-path":
      return `the command matched the fast path (${reason.prefix.trim()}), so the classifier was never called`;
    case "hard-rule":
      return `the command matched the hard rule "${reason.name}", so the classifier was never called: ${reason.because}`;
    case "tool-not-gated":
      return `${reason.tool} is not in this policy's gate.tools`;
    case "permission-mode-skipped":
      return `bouncer skips ${reason.permissionMode} mode`;
    case "no-rule-matched":
      return "no rule matched and the policy has no default";
    case "unanswered":
      return `the rules reached an allow, but the classifier never answered ${reason.missing.join(", ")}, so nothing was approved`;
    case "truncated":
      return "the rules reached an allow, but the call was too long to show the classifier whole, so nothing was approved";
  }
}

function bar(p: number): string {
  const filled = Math.round(p * 20);
  return `${"█".repeat(filled)}${"·".repeat(20 - filled)}`;
}
