// `bouncer ready`: a change read out of git, turned into items, judged, and reported (#93).
//
// Three layers, each tested where it is cheapest. `pushItems` is pure, so its facts and its
// reasons for not reading a file are checked on hand-built changes. `readChange` is checked
// against a real repository built in a temp directory, because what git prints is the thing
// under test. `assessChange` and the command are driven with the mock adapter given fixed
// answers, so every verdict below follows from a number written in the test.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapters/mock.js";
import { loadFixtures } from "../src/calibrate.js";
import { READINESS_FILE, assessChange, formatReadiness, parseArgs, ready } from "../src/commands/ready.js";
import { MAX_ITEM_STATE_BYTES, buildItemState } from "../src/engine/item.js";
import { loadPolicy } from "../src/engine/policy.js";
import type { Policy } from "../src/engine/types.js";
import { readChange, type ChangedFile, type GitChange } from "../src/io/git.js";
import { PUSH_FILE_SET, PUSH_SET, kindOf, pushItems } from "../src/push.js";

const POLICY = loadPolicy(readFileSync("policy/push.yaml", "utf8")).policy as Policy;

const dirs: string[] = [];
const temp = (prefix = "bouncer-ready-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  added: 3,
  removed: 1,
  binary: false,
  diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,4 @@\n context\n+added one\n+added two\n-removed\n`,
  ...over,
});

const change = (files: ChangedFile[], subject = "feat: a change"): GitChange => ({
  root: "/repo",
  branch: "feature/x",
  baseRef: "origin/main",
  base: "a".repeat(40),
  head: "b".repeat(40),
  commits: [{ subject, body: "" }],
  files,
});

describe("the shipped policy", () => {
  it("defines both sets, and every question has a rule that reads it", () => {
    for (const name of [PUSH_SET, PUSH_FILE_SET]) {
      const set = POLICY.sets[name]!;
      const ruled = new Set(set.rules.flatMap((r) => (r.condition !== undefined ? [r.condition.question] : [])));
      expect([...ruled].sort()).toEqual(Object.keys(set.questions).sort());
    }
  });

  it("has no uncertainty band: an unsure answer is not a reason to stop a push", () => {
    for (const name of [PUSH_SET, PUSH_FILE_SET]) {
      expect(POLICY.sets[name]!.rules.some((r) => r.condition?.question === "any")).toBe(false);
    }
  });

  it("is observing, and is not the gate", () => {
    expect(POLICY.mode).toBe("observe");
    expect(POLICY.gate.tools).toEqual([]);
  });
});

describe("the fixtures", () => {
  it.each([
    ["fixtures/push.jsonl", PUSH_SET],
    ["fixtures/push-file.jsonl", PUSH_FILE_SET],
  ])("%s labels only questions its set asks, with both answers for each, and pairs that disagree", (path, setName) => {
    const fixtures = loadFixtures(path);
    const questions = Object.keys(POLICY.sets[setName]!.questions);
    const byId = new Map(fixtures.map((f) => [f.id, f]));
    for (const f of fixtures) {
      for (const q of Object.keys(f.expect)) expect(questions, `${f.id} labels ${q}`).toContain(q);
      expect(buildItemState(f.item).truncated, `${f.id} is over the item cap`).toBe(false);
      if (f.pair === undefined) continue;
      const other = byId.get(f.pair);
      expect(other?.pair, `${f.id} and ${f.pair} do not point at each other`).toBe(f.id);
      const shared = Object.keys(f.expect).filter((q) => q in (other?.expect ?? {}));
      expect(shared.some((q) => f.expect[q] !== other?.expect[q]), `${f.id} and ${f.pair} agree on everything they share`).toBe(true);
    }
    for (const q of questions) {
      const labels = new Set(fixtures.flatMap((f) => (q in f.expect ? [f.expect[q]] : [])));
      expect([...labels].sort(), `${q} in ${path}`).toEqual([false, true]);
    }
  });

  it("are in the shape pushItems builds, field for field", () => {
    const built = pushItems(change([file("src/a.ts"), file("test/a.test.ts")]));
    const whole = loadFixtures("fixtures/push.jsonl")[0]!.item;
    const one = loadFixtures("fixtures/push-file.jsonl")[0]!.item;
    expect(Object.keys(whole).sort()).toEqual(Object.keys(built.summary).sort());
    expect(Object.keys(one).sort()).toEqual(Object.keys(built.files[0]!.item).sort());
  });
});

describe("kindOf", () => {
  it.each([
    ["src/cart/total.ts", "source"],
    ["test/cart.test.ts", "test"],
    ["src/__tests__/cart.tsx", "test"],
    ["internal/store/store_test.go", "test"],
    ["tests/test_sync.py", "test"],
    ["docs/adr/011.md", "docs"],
    ["README.md", "docs"],
    ["CHANGELOG.md", "docs"],
    ["package-lock.json", "lockfile"],
    ["services/api/uv.lock", "lockfile"],
    ["dist/app.js", "generated"],
    ["fixtures/push-file.jsonl", "test data"],
    ["test/fixtures/payloads/bash.json", "test data"],
    ["internal/store/testdata/rows.sql", "test data"],
    ["src/__snapshots__/cart.test.ts.snap", "generated"],
    ["public/app.min.js", "generated"],
    ["package.json", "source"],
  ])("%s is %s", (path, kind) => {
    expect(kindOf(path)).toBe(kind);
  });
});

describe("pushItems", () => {
  it("computes the facts the questions read, so nothing countable is asked", () => {
    const { summary } = pushItems(change([file("src/a.ts"), file("src/b.ts"), file("README.md"), file("package-lock.json", { added: 200, removed: 180 })]));
    expect(summary).toMatchObject({
      kind: "push",
      files_changed: 4,
      lines_added: 209,
      lines_removed: 183,
      source_files_changed: 2,
      test_files_changed: 0,
      tests_changed: false,
      docs_only: false,
    });
    expect(pushItems(change([file("src/a.ts"), file("test/a.test.ts")])).summary["tests_changed"]).toBe(true);
    expect(pushItems(change([file("README.md"), file("docs/guide.md")])).summary["docs_only"]).toBe(true);
  });

  it("does not count a deleted test as a test that changed with the code", () => {
    const { summary } = pushItems(change([file("src/a.ts"), file("test/a.test.ts", { status: "deleted", diff: "" })]));
    expect(summary["tests_changed"]).toBe(false);
  });

  it("gives the whole-push item added lines only, from source and tests, never a lockfile", () => {
    const { summary } = pushItems(change([file("src/a.ts"), file("package-lock.json"), file("README.md")]));
    const excerpt = summary["added_excerpt"] as string;
    expect(excerpt).toBe("--- src/a.ts\nadded one\nadded two");
  });

  it("spreads the excerpt across files rather than spending it on the first", () => {
    const big = (path: string) => file(path, { diff: `+++ b/${path}\n${Array.from({ length: 400 }, (_, i) => `+line ${i} of ${path}`).join("\n")}\n` });
    const { summary } = pushItems(change(Array.from({ length: 6 }, (_, i) => big(`src/f${i}.ts`))));
    const excerpt = summary["added_excerpt"] as string;
    for (let i = 0; i < 6; i += 1) expect(excerpt).toContain(`--- src/f${i}.ts`);
    expect(buildItemState(summary).truncated).toBe(false);
  });

  it("makes one item per file worth reading, carrying that file's diff and nothing of the others", () => {
    const { files } = pushItems(change([file("src/a.ts"), file("test/a.test.ts")], "feat: add a"));
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "test/a.test.ts"]);
    expect(files[0]?.item).toMatchObject({ kind: "push_file", path: "src/a.ts", is_test: false, commit_subjects: ["feat: add a"] });
    expect(files[1]?.item["is_test"]).toBe(true);
    expect(files[0]?.item["diff"]).not.toContain("test/a.test.ts");
  });

  it.each([
    ["a deleted file", file("src/gone.ts", { status: "deleted", diff: "" }), /deleted/],
    ["a binary file", file("assets/logo.png", { binary: true, diff: "" }), /binary/],
    ["a lockfile", file("pnpm-lock.yaml"), /lockfile/],
    ["a generated file", file("dist/bundle.js"), /generated/],
    ["test data", file("fixtures/push-file.jsonl"), /test data/],
    ["documentation", file("docs/guide.md"), /documentation/],
    ["a file whose diff could not be read", file("src/huge.ts", { diff: "" }), /could not be read/],
    ["a diff longer than one item", file("src/long.ts", { diff: `+${"x".repeat(MAX_ITEM_STATE_BYTES)}` }), /longer than one item can carry/],
  ])("names %s as not checked, and asks nothing of it", (_name, f, why) => {
    const { files, unchecked } = pushItems(change([f]));
    expect(files).toEqual([]);
    expect(unchecked).toEqual([{ path: f.path, why: expect.stringMatching(why) }]);
  });

  it("never hands the state builder a file it would cut", () => {
    const nearCap = file("src/near.ts", { diff: `+${"x".repeat(MAX_ITEM_STATE_BYTES - 2000)}` });
    const { files } = pushItems(change([nearCap]));
    expect(files).toHaveLength(1);
    expect(buildItemState(files[0]!.item).truncated).toBe(false);
  });
});

/** A repository with `main`, an `origin/main` ref at the same commit, and a branch ahead of it. */
function repository(): string {
  const dir = temp("bouncer-ready-repo-");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/total.ts"), "export function total(n: number) {\n  return n;\n}\n");
  writeFileSync(join(dir, "old.txt"), "going away\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: start");
  git("update-ref", "refs/remotes/origin/main", "HEAD");

  git("checkout", "-q", "-b", "feature/discount");
  writeFileSync(join(dir, "src/total.ts"), "export function total(n: number) {\n  console.log(n);\n  return n * 0.9;\n}\n");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git("rm", "-q", "old.txt");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: ten percent off", "-m", "Applies the discount to every total.");
  writeFileSync(join(dir, "uncommitted.ts"), "not part of the push\n");
  return dir;
}

describe("readChange", () => {
  const dir = repository();
  const read = readChange(dir) as GitChange;

  it("measures from the merge base with the remote's default branch", () => {
    expect(read.baseRef).toBe("origin/main");
    expect(read.branch).toBe("feature/discount");
    expect(read.commits).toEqual([{ subject: "feat: ten percent off", body: "Applies the discount to every total." }]);
  });

  it("reads each file's status, line counts and diff, and only committed work", () => {
    const byPath = Object.fromEntries(read.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["README.md", "blob.bin", "old.txt", "src/total.ts"]);
    expect(byPath["src/total.ts"]).toMatchObject({ status: "modified", added: 2, removed: 1, binary: false });
    expect(byPath["src/total.ts"]?.diff).toContain("+  console.log(n);");
    expect(byPath["README.md"]?.status).toBe("added");
    expect(byPath["old.txt"]).toMatchObject({ status: "deleted", diff: "" });
    expect(byPath["blob.bin"]).toMatchObject({ binary: true, added: 0, diff: "" });
  });

  it("says why instead of throwing when there is nothing to read", () => {
    expect(readChange(temp())).toBe("not inside a git repository");
    expect(readChange(dir, "no-such-ref")).toMatch(/^no merge base between HEAD and no-such-ref/);
  });
});

describe("assessChange", () => {
  const files = [file("src/a.ts"), file("src/b.ts"), file("package-lock.json")];
  const assess = (answers: Record<string, number>, over: Partial<Parameters<typeof assessChange>[0]> = {}) =>
    assessChange({ change: change(files), policy: POLICY, adapter: new MockAdapter({ answers }), ...over });

  it("is ready when no question fires, and says how many files it read", async () => {
    const result = await assess({});
    expect(result).toMatchObject({ verdict: "ready", holds: [], filesChecked: 2, backend: "mock" });
    expect(result.unchecked).toEqual([{ path: "package-lock.json", why: "a lockfile" }]);
    expect(Object.keys(result.answers).sort()).toEqual(["push", "src/a.ts", "src/b.ts"]);
  });

  it("holds on a whole-push question, naming the question and its own words", async () => {
    const result = await assess({ untested_behaviour: 0.91 });
    expect(result.verdict).toBe("hold");
    expect(result.holds).toEqual([
      { where: "push", question: "untested_behaviour", p: 0.91, asks: POLICY.sets[PUSH_SET]!.questions["untested_behaviour"]!.instructions },
    ]);
  });

  it("holds on a file-level question, once per file it fired on", async () => {
    const result = await assess({ debug_leftover: 0.88 });
    expect(result.holds.map((h) => [h.where, h.question])).toEqual([
      ["src/a.ts", "debug_leftover"],
      ["src/b.ts", "debug_leftover"],
    ]);
  });

  it("does not hold under the threshold, however close", async () => {
    expect((await assess({ debug_leftover: 0.69, untested_behaviour: 0.69 })).verdict).toBe("ready");
  });

  it("is unchecked, not ready, when the backend answered nothing", async () => {
    const result = await assess({}, { adapter: new MockAdapter({ error: new Error("down") }) });
    expect(result.verdict).toBe("unchecked");
    expect(result.holds).toEqual([]);
    expect(result.unchecked.filter((u) => u.why.startsWith("the backend did not answer"))).toHaveLength(3);
  });

  it("asks the push set of the push and the file set of the files, and of nothing else", async () => {
    const asked: Array<{ questions: string[]; kind: string }> = [];
    const adapter = new MockAdapter();
    const spy = { name: "mock", decide: async (request: Parameters<MockAdapter["decide"]>[0]) => {
      asked.push({ questions: Object.keys(request.questions).sort(), kind: JSON.parse(request.state).kind });
      return adapter.decide(request);
    } };
    await assessChange({ change: change(files), policy: POLICY, adapter: spy });
    expect(asked.filter((a) => a.kind === "push")).toEqual([{ kind: "push", questions: ["message_mismatch", "untested_behaviour"] }]);
    expect(asked.filter((a) => a.kind === "push_file")).toHaveLength(2);
    expect(asked.find((a) => a.kind === "push_file")?.questions).toEqual(["debug_leftover", "unfinished"]);
  });
});

describe("the report", () => {
  it("says what fired, in the question's words, and what was not read", async () => {
    const c = change([file("src/a.ts"), file("package-lock.json")]);
    const result = await assessChange({ change: c, policy: POLICY, adapter: new MockAdapter({ answers: { unfinished: 0.93 } }) });
    const text = formatReadiness(c, result, { policy: "policy/push.yaml", enforce: false });
    expect(text).toContain("Push readiness: feature/x against origin/main, 1 commit, 2 files (+6 −2)");
    expect(text).toContain("HOLD (observing: nothing is blocked; pass --enforce to make this exit 1)");
    expect(text).toContain("  src/a.ts  unfinished 0.93");
    expect(text).toContain(POLICY.sets[PUSH_FILE_SET]!.questions["unfinished"]!.instructions);
    expect(text).toContain("Not checked (1):\n  package-lock.json: a lockfile");
  });
});

describe("the command", () => {
  const BIN = resolve("bin/bouncer.cjs");
  const run = (args: readonly string[], cwd: string, data = temp()) => {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: resolve(".") };
    for (const name of ["BOUNCER_BACKEND", "BOUNCER_PUSH_POLICY", "BOUNCER_TYPESAFE_API_KEY", "TYPESAFE_API_KEY"]) delete (env as Record<string, string | undefined>)[name];
    return { ...spawnSync(process.execPath, [BIN, "ready", ...args], { cwd, encoding: "utf8", env }), data };
  };

  it("reads a real repository and reports, exiting 0", () => {
    const r = run(["--backend", "mock"], repository());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Push readiness: feature/discount against origin/main, 1 commit, 4 files (+3 −2)");
    expect(r.stdout).toContain("READY: no question fired on the push or on the 1 file read.");
    expect(r.stdout).toMatch(/Not checked \(3\):\n {2}README\.md: documentation\n {2}blob\.bin: binary\n {2}old\.txt: deleted/);
  });

  it("writes no readiness line for the mock, which judged nothing", () => {
    const r = run(["--backend", "mock"], repository());
    expect(existsSync(join(r.data, READINESS_FILE))).toBe(false);
  });

  it("prints the same result as JSON", () => {
    const r = run(["--backend", "mock", "--json"], repository());
    const payload = JSON.parse(r.stdout);
    expect(payload).toMatchObject({ branch: "feature/discount", base: "origin/main", verdict: "ready", enforce: false, filesChecked: 1 });
    expect(payload.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each([
    ["outside a repository", () => temp(), [], "bouncer ready did not run: not inside a git repository"],
    ["with no key for the backend the policy names", repository, [], "bouncer ready did not run: cannot ask jev"],
    ["with a base that does not exist", repository, ["--backend", "mock", "--base", "nope"], "bouncer ready did not run: no merge base between HEAD and nope"],
    ["with a policy that has no push sets", repository, ["--backend", "mock", "--policy", resolve("policy/default.yaml")], "defines no set named push or push_file"],
  ])("does not hold a push when it cannot run: %s, even with --enforce", (_name, where, args, message) => {
    const r = run([...args, "--enforce"], where());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(message);
  });

  it("has nothing to say about a branch with nothing ahead of its base", () => {
    const dir = repository();
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
    const r = run(["--backend", "mock", "--enforce"], dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Nothing to push: main has no commits ahead of origin/main.\n");
  });

  it("refuses a flag it does not know", () => {
    const r = run(["--force"], repository());
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("--force");
  });
});

describe("--enforce", () => {
  const BIN = resolve("bin/bouncer.cjs");
  // The mock answers 0.05 to a question it has no heuristic for, so a policy whose
  // thresholds sit under that is one where every question fires. That makes a HOLD without
  // a classifier, which is all this needs: what the exit status does with one.
  const eager = () => {
    const path = join(temp(), "push.yaml");
    writeFileSync(path, readFileSync("policy/push.yaml", "utf8").replace("backend: jev", "backend: mock").replaceAll('">=0.70"', '">=0.01"'));
    return path;
  };
  const run = (args: readonly string[], cwd: string) => {
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: temp(), CLAUDE_PLUGIN_ROOT: resolve(".") };
    for (const name of ["BOUNCER_BACKEND", "BOUNCER_PUSH_POLICY"]) delete (env as Record<string, string | undefined>)[name];
    return spawnSync(process.execPath, [BIN, "ready", ...args], { cwd, encoding: "utf8", env });
  };

  it("parses, and is off unless asked for", () => {
    expect(parseArgs([]).enforce).toBe(false);
    expect(parseArgs(["--enforce", "--base", "origin/dev"])).toMatchObject({ enforce: true, base: "origin/dev" });
  });

  it("observes by default: a HOLD is reported and the exit status is still 0", () => {
    const r = run(["--policy", eager()], repository());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("HOLD (observing: nothing is blocked; pass --enforce to make this exit 1)");
    expect(r.stdout).toMatch(/ {2}push +message_mismatch 0\.05/);
    expect(r.stdout).toMatch(/ {2}src\/total\.ts +debug_leftover 0\.05/);
  });

  it("exits 1 on a HOLD when asked to, which is what stops a push from a pre-push hook", () => {
    const r = run(["--policy", eager(), "--enforce"], repository());
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("\nHOLD\n");
  });

  it("reads the policy from $BOUNCER_PUSH_POLICY when --policy is not given", async () => {
    const dir = repository();
    const out: string[] = [];
    process.env["CLAUDE_PLUGIN_DATA"] = temp();
    process.env["BOUNCER_PUSH_POLICY"] = eager();
    try {
      expect(await ready({ enforce: true }, (text) => out.push(text), dir)).toBe(1);
    } finally {
      delete process.env["BOUNCER_PUSH_POLICY"];
      delete process.env["CLAUDE_PLUGIN_DATA"];
    }
    expect(out.join("")).toContain("HOLD");
  });
});
