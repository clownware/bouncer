// `unless: branch_adds_nothing_to_default` — docs/adr/014, #122.
//
// A hard rule is a string operation and this is the one place it is not the last word: the
// hook asks git whether a force-deleted branch would add anything to the remote's default
// branch, and passes the entry over when it would not. Three layers, tested where each can
// go wrong: what counts as a call that may be asked about, what git is asked, and what the
// built hook emits in a real repository — because the claim is about a deny that stops
// happening, and a unit test of a parser cannot see one.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shortCircuit } from "../src/engine/evaluate.js";
import { forceDeletedBranches, matchHardRule } from "../src/engine/hardrules.js";
import { loadPolicy } from "../src/engine/policy.js";
import { branchesAddNothing } from "../src/io/git.js";
import type { DecisionRecord } from "../src/io/log.js";

const SHIPPED = readFileSync("policy/default.yaml", "utf8");
const UNLESS = "branch_adds_nothing_to_default";

function shipped(mode = "seatbelt") {
  const { policy } = loadPolicy(SHIPPED.replace(/^mode: observe$/m, `mode: ${mode}`));
  if (policy === undefined) throw new Error("default policy failed to load");
  return policy;
}

describe("a call that may be asked about", () => {
  it.each([
    ["git branch -D feature/parser", ["feature/parser"]],
    ["git branch -D one two", ["one", "two"]],
    ["  git branch -D claude/push-readiness-93  ", ["claude/push-readiness-93"]],
    ["git branch -d -f v1.2_fix", ["v1.2_fix"]],
    ["git branch -df x", ["x"]],
    ["git branch --delete --force x", ["x"]],
  ])("`%s`", (command, branches) => {
    expect(forceDeletedBranches(command)).toEqual(branches);
  });

  // Each of these still matches the entry and is stopped by it. What they have in common is
  // that the hook's directory, or the branch, is not something the string settles.
  it.each([
    ["a chain, which can change directory first", "cd ../other && git branch -D x"],
    ["a chain after it", "git branch -D x && git push"],
    ["a second line", "git branch -D x\ngit status"],
    ["another repository named with -C", "git -C ../other branch -D x"],
    ["a remote-tracking branch", "git branch -D -r origin/x"],
    ["a variable", "git branch -D $BRANCH"],
    ["a command substitution", "git branch -D $(git branch --show-current)"],
    ["a glob", "git branch -D feature/*"],
    ["a quoted name", 'git branch -D "x"'],
    ["a name that is an option", "git branch -D --all"],
    ["a redirect", "git branch -D x > out.txt"],
    ["no name at all", "git branch -D"],
    ["a wrapper in front", "sudo git branch -D x"],
  ])("is not %s", (_label, command) => {
    expect(forceDeletedBranches(command)).toBeUndefined();
    expect(matchHardRule(shipped().gate.hardRules, command)?.name ?? "(none)").toMatch(/^git-branch-force-delete|^\(none\)$/);
  });

  it("is not a plain delete, which no entry stops in the first place", () => {
    expect(forceDeletedBranches("git branch -d x")).toBeUndefined();
  });
});

describe("the entry, once the fact is established", () => {
  const call = { tool: "Bash", command: "git branch -D feature/parser" } as const;

  it("carries its exemption in the reason when it stops a call", () => {
    expect(shortCircuit(shipped(), call)?.reason).toMatchObject({
      kind: "hard-rule",
      name: "git-branch-force-delete",
      unless: UNLESS,
    });
  });

  it("is passed over, and so are the other two spellings", () => {
    for (const command of [call.command, "git branch --delete --force x", "git branch -d -f x"]) {
      expect(shortCircuit(shipped(), { tool: "Bash", command })?.reason.kind, command).toBe("hard-rule");
      expect(shortCircuit(shipped(), { tool: "Bash", command, established: [UNLESS] }), command).toBeUndefined();
    }
  });

  it("does not excuse an entry that names no exemption", () => {
    const decision = shortCircuit(shipped(), { tool: "Bash", command: "git reset --hard HEAD~3", established: [UNLESS] });
    expect(decision?.emit).toBe("deny");
  });

  it("is named by exactly the three force-delete entries in the shipped policy", () => {
    expect(
      shipped()
        .gate.hardRules.filter((r) => r.unless !== undefined)
        .map((r) => r.name),
      "docs/adr/014 decides which entries can be waived by asking git. Adding one is a decision; say so there.",
    ).toEqual(["git-branch-force-delete", "git-branch-force-delete-long", "git-branch-force-delete-split"]);
  });

  it("is rejected by the loader when misspelt, rather than never holding", () => {
    const { diagnostics } = loadPolicy(SHIPPED.replace(`unless: ${UNLESS}`, "unless: branch_is_merged"));
    expect(diagnostics.filter((d) => d.severity === "error").map((d) => d.path)).toEqual([
      expect.stringMatching(/^gate\.hard_rules\[\d+\]\.unless$/),
    ]);
  });
});

// One repository for everything below: a bare remote and a clone of it, with a branch in
// each state the question has to tell apart.
let scratch: string;
let work: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

function commit(file: string, text: string, message: string): void {
  writeFileSync(join(work, file), text, "utf8");
  git(work, "add", file);
  git(work, "commit", "-q", "-m", message);
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bouncer-exemption-"));
  work = join(scratch, "work");
  git(scratch, "init", "-q", "--bare", "remote.git");
  git(scratch, "init", "-q", "-b", "main", "work");
  git(work, "remote", "add", "origin", join(scratch, "remote.git"));
  commit("a.txt", "a\n", "one");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");

  // Squash-merged, and the default branch has moved on since in another file.
  git(work, "checkout", "-q", "-b", "squashed");
  commit("b.txt", "b\n", "feature");
  commit("b.txt", "b\nb2\n", "feature, again");
  git(work, "checkout", "-q", "main");
  git(work, "merge", "-q", "--squash", "squashed");
  git(work, "commit", "-q", "-m", "squash of squashed");
  commit("c.txt", "c\n", "later work");

  // Squash-merged, and then the default branch rewrote the same lines.
  git(work, "checkout", "-q", "-b", "overwritten");
  commit("d.txt", "d\n", "another feature");
  git(work, "checkout", "-q", "main");
  git(work, "merge", "-q", "--squash", "overwritten");
  git(work, "commit", "-q", "-m", "squash of overwritten");
  commit("d.txt", "rewritten\n", "rewrite d");

  git(work, "push", "-q");

  // Work that exists nowhere else.
  git(work, "checkout", "-q", "-b", "unmerged");
  commit("u.txt", "u\n", "work in progress");
  git(work, "checkout", "-q", "main");

  // Committed locally and never pushed: on `main`, and not on the remote's.
  git(work, "checkout", "-q", "-b", "ahead-of-remote");
  git(work, "checkout", "-q", "main");
  commit("local.txt", "local\n", "not pushed");
  git(work, "branch", "-f", "ahead-of-remote", "main");
  git(work, "reset", "-q", "--hard", "origin/main");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("what git is asked", () => {
  const BUDGET = 5000;

  it("finds a squash-merged branch adds nothing, though `git branch -d` refuses it", () => {
    expect(() => git(work, "branch", "-d", "squashed")).toThrow(/not fully merged/);
    expect(branchesAddNothing(work, ["squashed"], BUDGET)).toBe(true);
  });

  it("finds unmerged work adds something", () => {
    expect(branchesAddNothing(work, ["unmerged"], BUDGET)).toBe(false);
  });

  it("answers for every branch named, not the first", () => {
    expect(branchesAddNothing(work, ["squashed", "unmerged"], BUDGET)).toBe(false);
    expect(branchesAddNothing(work, ["unmerged", "squashed"], BUDGET)).toBe(false);
  });

  it("does not vouch for a branch whose lines the default branch has since rewritten", () => {
    // The merge conflicts, so git cannot say the branch adds nothing. It was merged, and
    // this is the cost of not asking the forge: the entry's verdict stands.
    expect(branchesAddNothing(work, ["overwritten"], BUDGET)).toBe(false);
  });

  it("measures against the remote's default branch, not the local one", () => {
    // `ahead-of-remote` holds a commit that was only ever local. Against a local `main`
    // that also held it, it would add nothing, and deleting both would lose it.
    expect(branchesAddNothing(work, ["ahead-of-remote"], BUDGET)).toBe(false);
  });

  it("says no for a branch that does not exist, an empty list, and a spent budget", () => {
    expect(branchesAddNothing(work, ["no-such-branch"], BUDGET)).toBe(false);
    expect(branchesAddNothing(work, [], BUDGET)).toBe(false);
    expect(branchesAddNothing(work, ["squashed"], 0)).toBe(false);
  });

  it("says no outside a repository, and in one with no remote", () => {
    expect(branchesAddNothing(scratch, ["squashed"], BUDGET)).toBe(false);

    const lone = join(scratch, "lone");
    git(scratch, "init", "-q", "-b", "main", "lone");
    writeFileSync(join(lone, "a.txt"), "a\n", "utf8");
    git(lone, "add", "a.txt");
    git(lone, "commit", "-q", "-m", "one");
    git(lone, "branch", "copy");
    // `copy` is `main`. With a local base it would add nothing to itself.
    expect(branchesAddNothing(lone, ["copy"], BUDGET)).toBe(false);
    expect(branchesAddNothing(lone, ["main"], BUDGET)).toBe(false);
  });

  it("changes no ref and no file", () => {
    const before = git(work, "for-each-ref") + git(work, "status", "--porcelain");
    branchesAddNothing(work, ["squashed", "unmerged", "overwritten"], BUDGET);
    expect(git(work, "for-each-ref") + git(work, "status", "--porcelain")).toBe(before);
  });
});

describe("the built hook, in seatbelt, in that repository", () => {
  function hook(command: string, policyText = SHIPPED): { emitted: string | undefined; reason: string; line: DecisionRecord | undefined; exit: number | null } {
    const data = mkdtempSync(join(scratch, "data-"));
    const policy = join(data, "policy.yaml");
    writeFileSync(policy, policyText.replace(/^mode: observe$/m, "mode: seatbelt"), "utf8");

    const run = spawnSync(process.execPath, ["bin/bouncer.cjs", "pretooluse"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: work,
        session_id: "exemption",
      }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, BOUNCER_POLICY: policy, BOUNCER_BACKEND: "mock" },
    });

    const out = run.stdout.trim().length > 0 ? JSON.parse(run.stdout).hookSpecificOutput : undefined;
    let line: DecisionRecord | undefined;
    try {
      line = JSON.parse(readFileSync(join(data, "decisions.jsonl"), "utf8").trim().split("\n").at(-1) as string);
    } catch {
      line = undefined;
    }
    return { emitted: out?.permissionDecision, reason: out?.permissionDecisionReason ?? "", line, exit: run.status };
  }

  it("does not stop the force delete of a squash-merged branch, and says in the log why", () => {
    const { emitted, line, exit } = hook("git branch -D squashed");
    expect(exit).toBe(0);
    expect(emitted).toBeUndefined();
    expect(line?.source, "passed over is not approved: the call goes to the judge").toBe("judge");
    expect(line?.hard_rule_waived).toEqual({ rule: "git-branch-force-delete", unless: UNLESS });
  });

  it("stops the force delete of unmerged work, and tells the model the form that can pass", () => {
    const { emitted, reason, line } = hook("git branch -D unmerged");
    expect(emitted).toBe("deny");
    expect(reason).toContain("(hard rule: git-branch-force-delete)");
    expect(reason).toContain("only command in the call");
    expect(line?.source).toBe("hard_rule");
    expect(line?.hard_rule_waived).toBeUndefined();
  });

  it("stops one call that names both", () => {
    expect(hook("git branch -D squashed unmerged").emitted).toBe("deny");
  });

  it("stops the same squash-merged branch in a chain, where it cannot know the directory", () => {
    expect(hook("git checkout main && git branch -D squashed").emitted).toBe("deny");
    expect(hook("cd .. && git branch -D squashed").emitted).toBe("deny");
  });

  it("stops every force delete again when the policy's entry drops the line", () => {
    const without = SHIPPED.replaceAll(`      unless: ${UNLESS}\n`, "");
    expect(without).not.toBe(SHIPPED);
    const { emitted, reason } = hook("git branch -D squashed", without);
    expect(emitted).toBe("deny");
    expect(reason).not.toContain("only command in the call");
  });

  it("leaves the branch where it was: the hook decides, it does not delete", () => {
    expect(git(work, "branch", "--list", "squashed").trim()).toBe("squashed");
  });
});
