// `bouncer export`: a real decision log in, candidate fixtures out.
//
// The claim the exporter makes is narrow and checkable: every candidate is a tool call that
// rebuilds the state the classifier was shown, and it is keyed so that `calibrate --from`
// joins the log's own answers to it. So the end-to-end half writes its log the way a user's
// is written — the built hook, fed payloads, into a scratch data directory — rather than
// hand-writing lines that could agree with the exporter by construction. The unit half
// covers what a live hook cannot be made to write any more: lines from older builds.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadPolicy } from "../src/engine/policy.js";
import { parseFixtures, scoreFromLog, stateFor, type Fixture } from "../src/calibrate.js";
import { candidateLine, exportCandidates, HEADER } from "../src/export.js";
import { parseLog, type DecisionRecord } from "../src/io/log.js";

const BIN = "bin/bouncer.cjs";

const POLICY = (() => {
  const { policy } = loadPolicy(readFileSync("policy/default.yaml", "utf8"));
  if (!policy) throw new Error("default policy failed to load");
  return policy;
})();

const GATE_FIXTURES = parseFixtures(readFileSync("fixtures/gate.jsonl", "utf8"));

/**
 * A gate line as the hook writes one, around a given state. An override set to undefined
 * removes the field, which is how a line from an older build or another path is spelled.
 */
function line(overrides: { [K in keyof DecisionRecord]?: DecisionRecord[K] | undefined }): DecisionRecord {
  return {
    ts: "2026-09-20T10:00:00.000Z",
    session_id: "s",
    tool_use_id: "toolu_a",
    tool: "Bash",
    permission_mode: "default",
    mode: "observe",
    backend: "jev",
    emitted: null,
    reason: { kind: "no-rule-matched" },
    source: "judge",
    answers: { destructive: 0.2 },
    latency_ms: { total: 1 },
    ...overrides,
  } as DecisionRecord;
}

function bashState(command: string, project = "project"): string {
  return JSON.stringify({ tool: "Bash", action: { kind: "run_shell_command", command }, project, permission_mode: "default" });
}

describe("every shipped gate fixture survives the trip through a log line", () => {
  // Generative, like the fast-path suite: a fixture added later is checked without anyone
  // remembering to. It covers Write and Edit outside the project, sensitive paths, and the
  // two fixtures that differ only in their project's name.
  const toolCalls = GATE_FIXTURES.filter((f) => f.kind === "tool_call");
  const records = toolCalls.map((f) => {
    const built = stateFor(f);
    const item = f.item as { tool: string; permission_mode?: string };
    return line({
      tool_use_id: f.id,
      tool: item.tool,
      // Undefined rather than absent, so the helper's default of "default" does not add one.
      permission_mode: item.permission_mode,
      state: built.text,
      ...(built.truncated ? { truncated: true } : {}),
    });
  });
  const result = exportCandidates(records);

  it("loses none of them", () => {
    expect(result.skipped).toMatchObject({ unrebuildable: 0, duplicate: 0 });
    expect(result.candidates.map((c) => c.id)).toEqual(toolCalls.map((f) => f.id));
  });

  it.each(toolCalls.map((f) => [f.id, f] as const))("%s rebuilds its exact state", (id, fixture) => {
    const candidate = result.candidates.find((c) => c.id === id);
    expect(candidate).toBeDefined();
    const rebuilt = parseFixtures(uncomment(candidateLine(candidate!), { question: true }))[0] as Fixture;
    expect(stateFor(rebuilt).text).toBe(stateFor(fixture).text);
  });
});

describe("exportCandidates", () => {
  const cases: ReadonlyArray<readonly [string, DecisionRecord, keyof ReturnType<typeof exportCandidates>["skipped"]]> = [
    ["a judge line", line({ consumer: "judge", item: "x", state: bashState("ls") }), "notGate"],
    ["a fast-path line, which keeps no state", line({ source: "fast_path" }), "noState"],
    ["a mock verdict", line({ backend: "mock", state: bashState("ls") }), "mock"],
    ["a line with no tool_use_id", line({ tool_use_id: undefined, state: bashState("ls") }), "noId"],
    ["a truncated state", line({ truncated: true, state: bashState("ls") }), "truncated"],
    ["a state that is not JSON", line({ state: '{"tool":"Bash","action":{"comm' }), "unrebuildable"],
    ["a state naming another tool", line({ state: bashState("ls").replace('"Bash"', '"Write"') }), "unrebuildable"],
  ];

  it.each(cases)("sets aside %s", (_label, record, reason) => {
    const result = exportCandidates([record]);
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped[reason]).toBe(1);
  });

  it("keeps mock verdicts when told the policy runs the mock on purpose", () => {
    expect(exportCandidates([line({ backend: "mock", state: bashState("ls") })], { keepMock: true }).candidates).toHaveLength(1);
  });

  it("keeps a hard-rule line: it has a state, and a live run of another arm can ask about it", () => {
    const hard = line({ source: "hard_rule", answers: undefined, state: bashState("cat .env") });
    expect(exportCandidates([hard]).candidates).toHaveLength(1);
  });

  it("collapses repeats onto the first call's id and counts them", () => {
    const result = exportCandidates([
      line({ tool_use_id: "toolu_1", ts: "2026-09-20T10:00:00.000Z", state: bashState("npm test") }),
      line({ tool_use_id: "toolu_2", ts: "2026-09-21T10:00:00.000Z", state: bashState("npm test") }),
      line({ tool_use_id: "toolu_3", ts: "2026-09-22T10:00:00.000Z", state: bashState("npm test") }),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ id: "toolu_1", seen: 3, first: "2026-09-20T10:00:00.000Z", last: "2026-09-22T10:00:00.000Z" });
    expect(result.skipped.duplicate).toBe(2);
    expect(candidateLine(result.candidates[0]!)).toContain("Logged 3 times, first 2026-09-20");
  });

  it("keeps the same command in two projects apart, because the project's name reaches the classifier", () => {
    const result = exportCandidates([
      line({ tool_use_id: "toolu_1", state: bashState("npm run lint", "notes") }),
      line({ tool_use_id: "toolu_2", state: bashState("npm run lint", "production-api") }),
    ]);
    expect(result.candidates.map((c) => c.cwd)).toEqual(["/home/user/notes", "/home/user/production-api"]);
  });

  it("skips a call a known fixture already covers, whatever its permission mode", () => {
    // A hand-written fixture names no permission mode, as gate.jsonl's do; every logged call carries one.
    const known = parseFixtures('{"id":"k","tool":"Bash","input":{"command":"rm -rf node_modules"},"expect":{"destructive":false},"note":"n"}');
    const result = exportCandidates([line({ state: bashState("rm -rf node_modules") })], { known });
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.known).toBe(1);
  });

  it("drops a subagent's type rather than refusing the call", () => {
    const state = JSON.stringify({ ...JSON.parse(bashState("ls -la")), running_as_subagent: "Explore" });
    expect(exportCandidates([line({ state })]).candidates).toHaveLength(1);
  });

  it("redacts what an older build let through, and says it did", () => {
    // `PASSWORD=` in front of a value went to the log in clear before the pattern was fixed.
    // The synthetic value is a plain word, as CLAUDE.md asks of a pattern keyed on the name.
    const result = exportCandidates([line({ state: bashState("PASSWORD=plainword ./deploy.sh") })]);
    expect(result.redactedOnExport).toBe(1);
    const text = candidateLine(result.candidates[0]!);
    expect(text).not.toContain("plainword");
    expect(text).toContain("PASSWORD=[REDACTED:assigned-secret]");
  });

  it("never carries the classifier's answers into a candidate", () => {
    const result = exportCandidates([line({ answers: { destructive: 0.8765 }, state: bashState("ls") })]);
    expect(candidateLine(result.candidates[0]!)).not.toContain("0.8765");
  });
});

describe("the file it writes", () => {
  const records = [line({ tool_use_id: "toolu_1", state: bashState("rm -rf ./dist") })];
  const file = `${HEADER}\n${exportCandidates(records).candidates.map(candidateLine).join("\n")}\n`;

  it("loads as a fixture file with nothing in it until a line is labelled", () => {
    expect(parseFixtures(file)).toEqual([]);
  });

  it("refuses a line uncommented without labels, rather than scoring nothing in silence", () => {
    expect(() => parseFixtures(uncomment(file))).toThrow(/has no expectations/);
  });

  it("joins the log's own answers once a line is labelled", () => {
    const labelled = parseFixtures(uncomment(file, { question: true }));
    const log = records.map((r) => JSON.stringify(r)).join("\n");
    expect(scoreFromLog(log, labelled, POLICY).matched).toBe(1);
  });
});

describe("the command, end to end over a log the built hook wrote", () => {
  let dir = "";
  let policy = "";
  let log = "";

  const payloads: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["Bash", { command: "rm -rf ~/Documents", description: "clean up" }],
    ["Bash", { command: "npm test 2>&1 | tail -20", description: "run tests" }],
    ["Bash", { command: "npm test 2>&1 | tail -20", description: "run tests" }],
    ["Bash", { command: "cat .env" }],
    ["Bash", { command: "git status" }],
    ["Write", { file_path: "/home/user/project/src/a.ts", content: "export const a = 1;\n" }],
    ["Write", { file_path: "/home/user/.bashrc", content: "alias x=y\n" }],
    ["Edit", { file_path: "/home/user/project/.github/workflows/ci.yml", old_string: "a", new_string: "bb" }],
    ["Edit", { file_path: "/etc/hosts", old_string: "a", new_string: "bb" }],
    ["NotebookEdit", { notebook_path: "/home/user/project/n.ipynb", cell_id: "c1", new_source: "print(1)", edit_mode: "replace" }],
  ];

  const env = () => ({ ...process.env, CLAUDE_PLUGIN_DATA: dir, CLAUDE_PLUGIN_ROOT: resolve("."), BOUNCER_POLICY: policy });
  // No known fixtures, so the counts below are about the log and not about what gate.jsonl
  // happens to hold this week.
  const exportCmd = (...args: string[]) =>
    spawnSync(process.execPath, [BIN, "export", "--fixtures", join(dir, "none.jsonl"), ...args], { encoding: "utf8", env: env() });

  beforeAll(() => {
    // A scratch data directory, per CLAUDE.md: anything driving the hook in bulk must not
    // write into the developer's real log. The policy names `mock` itself so the mock's
    // lines are kept, which is the rule `status` applies.
    dir = mkdtempSync(join(tmpdir(), "bouncer-export-"));
    policy = join(dir, "mock.yaml");
    writeFileSync(join(dir, "none.jsonl"), "");
    writeFileSync(policy, readFileSync("policy/default.yaml", "utf8").replace(/^backend: \w+$/m, "backend: mock"));

    payloads.forEach(([tool, input], i) => {
      const payload = {
        session_id: "00000000-0000-0000-0000-000000000000",
        transcript_path: "/home/user/.claude/transcript.jsonl",
        cwd: "/home/user/project",
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_use_id: `toolu_${String(i).padStart(2, "0")}`,
        tool_input: input,
      };
      spawnSync(process.execPath, [BIN, "pretooluse"], { input: JSON.stringify(payload), encoding: "utf8", env: env() });
    });
    log = join(dir, "decisions.jsonl");
  });

  it("reads the log through dataDir when no --from is given", () => {
    const r = exportCmd();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(log);
  });

  it("exports one candidate per distinct state and every one rebuilds what the hook logged", () => {
    const r = exportCmd("--from", log);
    expect(r.status).toBe(0);
    // Ten calls: `npm test` twice, and `git status` on the fast path with no state.
    expect(r.stderr).toMatch(/Exported 8 candidate fixtures/);

    const logged = new Map(parseLog(readFileSync(log, "utf8")).map((l) => [l.tool_use_id, l.state]));
    const candidates = parseFixtures(uncomment(r.stdout, { question: true }));
    expect(candidates).toHaveLength(8);
    for (const c of candidates) expect(stateFor(c).text, c.id).toBe(logged.get(c.id));
  });

  it("writes a file calibrate --from scores against the log it came from", () => {
    const out = join(dir, "candidates.jsonl");
    expect(exportCmd("--from", log, "--out", out).status).toBe(0);

    const labelled = join(dir, "labelled.jsonl");
    writeFileSync(labelled, uncomment(readFileSync(out, "utf8"), { question: true }));
    const r = spawnSync(process.execPath, [BIN, "calibrate", "--fixtures", labelled, "--from", log], { encoding: "utf8", env: env() });
    expect(r.status).toBe(0);
    // `cat .env` is decided by a hard rule, which logs no answers, so seven of eight score.
    expect(r.stdout).toMatch(/Scored 7 logged items/);
  });

  const refusals: ReadonlyArray<readonly [string, () => string[], RegExp]> = [
    ["an --out that exists, which may hold labels", () => ["--from", log, "--out", log], /Refusing to overwrite/],
    ["an --out under the frozen holdout", () => ["--from", log, "--out", "test/holdout/more.jsonl"], /frozen/],
    ["a log that is not there", () => ["--from", join(dir, "missing.jsonl")], /Cannot read the log/],
    ["an unknown flag", () => ["--form", log], /Unknown flag/],
  ];

  it.each(refusals)("refuses %s with exit 1, never 2", (_label, args, message) => {
    const r = exportCmd(...args());
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(message);
  });
});

/**
 * Uncomments every candidate line. With `question`, labels each one first, the way a person
 * promoting it would: one question, and a note saying why.
 */
function uncomment(text: string, options: { question?: boolean } = {}): string {
  return text
    .split("\n")
    .map((l) => {
      if (!l.startsWith("// {")) return l;
      const fixture = JSON.parse(l.slice(3)) as Record<string, unknown>;
      if (options.question === true) {
        fixture["expect"] = { destructive: false };
        fixture["note"] = "Labelled in a test.";
      }
      return JSON.stringify(fixture);
    })
    .join("\n");
}
