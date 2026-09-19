import { describe, expect, it } from "vitest";
import { escalationFor, manifestOf, type EscalationItem } from "../src/engine/escalation.js";
import { evaluate, shortCircuit } from "../src/engine/evaluate.js";
import { loadPolicy } from "../src/engine/policy.js";
import type { Policy } from "../src/engine/types.js";

function policyFrom(source: string): Policy {
  const { policy, diagnostics } = loadPolicy(source);
  if (!policy) throw new Error(`policy failed to load: ${JSON.stringify(diagnostics)}`);
  return policy;
}

const GUARD = policyFrom(`
version: 1
mode: guard
gate:
  tools: [Bash, Edit]
  fast_path: ["git status"]
  hard_rules:
    - name: reads_a_credential_file
      when: { first_token: [cat], path_labelled: [ssh_configuration, ssh_key] }
      then: ask
      because: "it prints a private key"
  questions:
    destructive:
      instructions: "It destroys something."
    secrets:
      instructions: "It exposes a credential."
    prod:
      instructions: "It targets production."
  probe_questions:
    reversible:
      instructions: "A candidate rewording."
  rules:
    - when: { destructive: { p: ">=0.85" } }
      then: deny
    - when: { secrets: { p: ">=0.70" } }
      then: ask
    - when: { prod: { p: ">=0.60" } }
      then: ask
    - when: { any: { p: "0.40..0.60" } }
      then: ask
    - default: allow
`);

/** The escalation for a set of answers, via the same `evaluate` the hook calls. */
function escalate(answers: Record<string, number>, item = "item-1"): EscalationItem | undefined {
  return escalationFor(GUARD.gate, evaluate(GUARD.gate, GUARD.mode, answers), answers, item);
}

describe("escalationFor, on what it does and does not escalate", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly answers: Record<string, number>;
    readonly verdict?: "ask" | "deny";
  }> = [
    { name: "a clean allow escalates nothing", answers: { destructive: 0.02, secrets: 0.03, prod: 0.01 } },
    { name: "a deny escalates", answers: { destructive: 0.91, secrets: 0.02, prod: 0.01 }, verdict: "deny" },
    { name: "an ask on a threshold escalates", answers: { destructive: 0.1, secrets: 0.78, prod: 0.02 }, verdict: "ask" },
    { name: "an ask from the uncertainty band escalates", answers: { destructive: 0.52, secrets: 0.1, prod: 0.05 }, verdict: "ask" },
    // Just below every threshold and just outside the band: allowed, and an allow is the
    // judge settling it. Nothing to hand a reasoning model.
    { name: "0.62 on nothing that fires is not an escalation", answers: { destructive: 0.62, secrets: 0.3, prod: 0.3 } },
  ];

  for (const { name, answers, verdict } of cases) {
    it(name, () => {
      const escalation = escalate(answers);
      if (verdict === undefined) {
        expect(escalation).toBeUndefined();
        return;
      }
      expect(escalation?.verdict).toBe(verdict);
      expect(escalation?.signals.length).toBeGreaterThan(0);
    });
  }

  it("carries the item id it was given", () => {
    expect(escalate({ secrets: 0.9 }, "toolu_abc")?.item).toBe("toolu_abc");
  });

  it("never carries a state of its own — the log line it rides on has one", () => {
    expect(escalate({ secrets: 0.9 })).not.toHaveProperty("state");
  });
});

describe("escalationFor, on the deterministic paths", () => {
  // ADR-004's argument, restated as a type: the edges are code, and code does not ask a
  // reasoning model for help. A hard rule's `ask` is a decision, not an escalation.
  it("does not escalate a hard rule", () => {
    const decision = shortCircuit(GUARD, { tool: "Bash", command: "cat ~/.ssh/id_rsa" });
    expect(decision?.reason.kind).toBe("hard-rule");
    expect(decision?.verdict).toBe("ask");
    expect(escalationFor(GUARD.gate, decision!, {}, "item-1")).toBeUndefined();
  });

  it("does not escalate a fast path", () => {
    const decision = shortCircuit(GUARD, { tool: "Bash", command: "git status" });
    expect(decision?.reason.kind).toBe("fast-path");
    expect(escalationFor(GUARD.gate, decision!, {}, "item-1")).toBeUndefined();
  });

  it("does not escalate an ungated tool", () => {
    const decision = shortCircuit(GUARD, { tool: "Read", command: "" });
    expect(decision?.reason.kind).toBe("tool-not-gated");
    expect(escalationFor(GUARD.gate, decision!, {}, "item-1")).toBeUndefined();
  });
});

describe("escalationFor, on the signals themselves", () => {
  it("reports every threshold crossed, not only the one that decided", () => {
    // `secrets` decides at rule 2. `prod` would also have fired at rule 3, and a reasoning
    // model re-adjudicating this item needs to know that.
    const escalation = escalate({ destructive: 0.1, secrets: 0.71, prod: 0.66 });
    expect(escalation?.signals.map((s) => s.question)).toEqual(["secrets", "prod"]);
    expect(escalation?.signals.filter((s) => s.decided).map((s) => s.question)).toEqual(["secrets"]);
  });

  it("records the threshold in the spelling the policy wrote it", () => {
    const [signal] = escalate({ secrets: 0.71 })?.signals ?? [];
    expect(signal?.criterion).toBe(">=0.7");
    expect(signal?.ruleIndex).toBe(2);
    expect(signal?.verdict).toBe("ask");
  });

  it("carries the question's own words, which are the reasoning prompt", () => {
    const [signal] = escalate({ secrets: 0.71 })?.signals ?? [];
    expect(signal?.asks).toBe("It exposes a credential.");
  });

  it("names every question in the band under an `any` rule", () => {
    const escalation = escalate({ destructive: 0.55, secrets: 0.48, prod: 0.02 });
    const band = escalation?.signals.filter((s) => s.criterion === "0.4..0.6") ?? [];
    expect(band.map((s) => s.question).sort()).toEqual(["destructive", "secrets"]);
    // One of them decided; claiming both did would misreport what stopped the user.
    expect(band.filter((s) => s.decided)).toHaveLength(1);
  });

  it("does not report a question the classifier did not answer", () => {
    const escalation = escalate({ secrets: 0.9 });
    expect(escalation?.signals.map((s) => s.question)).toEqual(["secrets"]);
  });

  it("cannot see a probe question, because evaluate is never handed one", () => {
    // The structural guarantee from ADR-006's probe block, restated here: probes are split
    // out before `evaluate`, so they are not in `answers` and cannot reach a signal either.
    const escalation = escalate({ secrets: 0.9 });
    expect(escalation?.signals.some((s) => s.question === "reversible")).toBe(false);
  });
});

describe("manifestOf", () => {
  const item = (id: string): EscalationItem => ({ item: id, verdict: "ask", signals: [] });

  it("is the ratio, not the count", () => {
    const manifest = manifestOf([item("a"), item("b")], 40);
    expect(manifest.itemsJudged).toBe(40);
    expect(manifest.escalationRate).toBeCloseTo(0.05);
  });

  it("reads zero rather than dividing by zero when nothing was judged", () => {
    expect(manifestOf([], 0).escalationRate).toBe(0);
  });

  it("keeps a denominator the item list cannot supply", () => {
    // One item out of one and one item out of a hundred are the same list. The whole claim
    // of the substitution play lives in the number that tells them apart.
    expect(manifestOf([item("a")], 1).escalationRate).toBe(1);
    expect(manifestOf([item("a")], 100).escalationRate).toBeCloseTo(0.01);
  });
});
