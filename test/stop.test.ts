// The Stop hook: it watches, and it never speaks. docs/adr/015.
//
// Every other consumer in this repository can at worst add a prompt. A Stop hook can keep an
// agent working after it chose to stop, by printing one JSON object or by exiting 2. So the
// tests that matter most here are the ones that run the built bundle and look at what it
// wrote to stdout, which has to be nothing, whatever it was handed and whatever the set
// concluded. The rest pins what a stop becomes, what the log says, and how the log is scored
// against what the user typed next.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapters/mock.js";
import { formatStops, reportStops } from "../src/commands/stops.js";
import { loadPolicy } from "../src/engine/policy.js";
import type { Policy } from "../src/engine/types.js";
import { STOPS_FILE, runStop, type StopRecord } from "../src/hooks/stop.js";
import { stopPolicyPath } from "../src/io/config.js";
import { nextTypedPrompt, typedPrompts } from "../src/io/transcript.js";
import { CLOSING_TAIL_CHARS, STOP_SET, isGoAhead, scoreStops, stopItem } from "../src/stop.js";

const SHIPPED = resolve("policy/stop.yaml");
const POLICY = loadPolicy(readFileSync(SHIPPED, "utf8")).policy as Policy;
const PAYLOAD = JSON.parse(readFileSync("test/fixtures/payloads/stop-main.json", "utf8")) as Record<string, unknown>;

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bouncer-stop-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let data: string;
beforeEach(() => {
  data = temp();
  process.env["CLAUDE_PLUGIN_DATA"] = data;
});
afterEach(() => {
  delete process.env["CLAUDE_PLUGIN_DATA"];
  delete process.env["BOUNCER_STOP_POLICY"];
  delete process.env["BOUNCER_BACKEND"];
});

const logged = (dir = data): StopRecord[] =>
  existsSync(join(dir, STOPS_FILE))
    ? readFileSync(join(dir, STOPS_FILE), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as StopRecord)
    : [];

/** Answers that read as a plain go-ahead; each case below moves one of them. */
const GO = { asks_go_ahead: 0.95, needs_a_decision: 0.05, irreversible_step: 0.05 };

describe("the captured payload", () => {
  it("carries the closing message, so no transcript is read to judge a stop", () => {
    // Captured from Claude Code 2.1.201 on 2026-10-12 with scripts/capture-hook.mjs. If a
    // later version drops the field the hook goes quiet; it does not go looking elsewhere.
    expect(PAYLOAD["hook_event_name"]).toBe("Stop");
    expect(typeof PAYLOAD["last_assistant_message"]).toBe("string");
    expect(PAYLOAD["stop_hook_active"]).toBe(false);
    expect(PAYLOAD["background_tasks"]).toEqual([]);
  });
});

describe("the shipped stop policy", () => {
  const set = POLICY.sets[STOP_SET]!;

  it("has a rule reading every question, since an unread answer is decoration", () => {
    const read = new Set(set.rules.flatMap((r) => (r.condition !== undefined ? [r.condition.question] : [])));
    for (const name of Object.keys(set.questions)) expect(read.has(name), name).toBe(true);
  });

  it("leaves a stop alone unless a rule says otherwise", () => {
    expect(set.rules.at(-1)).toMatchObject({ verdict: "ask" });
    expect(set.rules.filter((r) => r.verdict === "allow")).toHaveLength(1);
  });
});

describe("what a stop becomes", () => {
  it("is the closing message, whole when it is short", () => {
    expect(stopItem("  Shall I proceed?  ")).toEqual({ closing_message: "Shall I proceed?", closing_message_cut: false });
  });

  it("is the end of a long one, and says the head is gone", () => {
    const item = stopItem(`${"report ".repeat(2000)}Shall I merge it?`);
    expect((item["closing_message"] as string).length).toBe(CLOSING_TAIL_CHARS);
    expect(item["closing_message"]).toMatch(/Shall I merge it\?$/);
    expect(item["closing_message_cut"]).toBe(true);
  });
});

describe("the hook", () => {
  const run = (answers: Record<string, number>, payload: Record<string, unknown> = PAYLOAD) =>
    runStop(payload, { adapter: new MockAdapter({ answers }), policyPath: SHIPPED });

  it("returns nothing, whatever the set concluded", async () => {
    expect(await run(GO)).toBeUndefined();
    expect(await run({ ...GO, irreversible_step: 0.95 })).toBeUndefined();
  });

  const verdicts: ReadonlyArray<readonly [string, Record<string, number>, string, string]> = [
    ["a plain go-ahead", GO, "continue", "asks_go_ahead"],
    ["a choice only the user can make", { ...GO, needs_a_decision: 0.8 }, "leave", "needs_a_decision"],
    ["a step that is hard to undo", { ...GO, irreversible_step: 0.8 }, "leave", "irreversible_step"],
    ["an answer in the uncertain band", { ...GO, irreversible_step: 0.5 }, "leave", "irreversible_step"],
    ["a go-ahead it is not sure of", { ...GO, asks_go_ahead: 0.65 }, "leave", "default"],
    ["a finished report", { ...GO, asks_go_ahead: 0.05 }, "leave", "default"],
  ];

  it.each(verdicts)("logs %s", async (_label, answers, would, decidedBy) => {
    await run(answers);
    const [line] = logged();
    expect(line).toMatchObject({ would, decided_by: decidedBy, answers, stop_hook_active: false, backend: "mock" });
    expect(line?.transcript_path).toBe(PAYLOAD["transcript_path"]);
    expect(line?.policy.questions).toBe(POLICY.sets[STOP_SET]!.questionsFingerprint);
  });

  it("redacts the message before it is judged or logged", async () => {
    await run(GO, { ...PAYLOAD, last_assistant_message: "I set API_KEY=opensesame in the shell. Shall I proceed?" });
    const [line] = logged();
    expect(line?.state).not.toContain("opensesame");
    expect(line?.redacted_kinds).toContain("assigned-secret");
  });

  it("judges nothing while a task is still running, because the agent is not waiting on the user", async () => {
    let asked = 0;
    const adapter = new MockAdapter({ answers: GO });
    const counting = { name: adapter.name, decide: (r: Parameters<typeof adapter.decide>[0]) => (asked++, adapter.decide(r)) };
    await runStop({ ...PAYLOAD, background_tasks: [{ id: "t1" }] }, { adapter: counting, policyPath: SHIPPED });

    expect(asked).toBe(0);
    expect(logged()).toMatchObject([{ skipped: "work-still-running" }]);
    expect(logged()[0]?.would).toBeUndefined();
    expect(logged()[0]?.state).toBeUndefined();
  });

  it("logs a backend failure as a failure, with no opinion", async () => {
    await runStop(PAYLOAD, { adapter: new MockAdapter({ error: new Error("unreachable") }), policyPath: SHIPPED });
    const [line] = logged();
    expect(line?.error).toBeDefined();
    expect(line?.would).toBeUndefined();
  });

  it.each([
    ["an event that is not Stop", { ...PAYLOAD, hook_event_name: "SubagentStop" }],
    ["a payload with no closing message", { ...PAYLOAD, last_assistant_message: undefined }],
    ["an empty closing message", { ...PAYLOAD, last_assistant_message: "   " }],
  ])("does nothing on %s", async (_label, payload) => {
    await runStop(payload, { adapter: new MockAdapter({ answers: GO }), policyPath: SHIPPED });
    expect(logged()).toEqual([]);
  });

  it("does nothing when the policy it is pointed at has no stop set", async () => {
    await runStop(PAYLOAD, { adapter: new MockAdapter({ answers: GO }), policyPath: resolve("policy/default.yaml") });
    expect(logged()).toEqual([]);
  });
});

describe("where a stop policy is looked for", () => {
  it("is nowhere by default: the bundled file is not on the list", () => {
    // The whole opt-in. If this ever returned policy/stop.yaml, installing the plugin would
    // start sending closing messages from every project to the backend.
    const home = temp();
    const before = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      expect(stopPolicyPath(temp()), "docs/adr/015: the Stop hook is off until a stop policy is put in place by the user.").toBeUndefined();

      mkdirSync(join(home, ".bouncer"));
      writeFileSync(join(home, ".bouncer", "stop.yaml"), "x", "utf8");
      const repo = temp();
      mkdirSync(join(repo, ".git"));
      expect(stopPolicyPath(join(repo))).toBe(join(home, ".bouncer", "stop.yaml"));

      writeFileSync(join(repo, ".bouncer.stop.yaml"), "x", "utf8");
      expect(stopPolicyPath(repo), "a repository's own file wins over the user's").toBe(join(repo, ".bouncer.stop.yaml"));

      process.env["BOUNCER_STOP_POLICY"] = SHIPPED;
      expect(stopPolicyPath(repo)).toBe(SHIPPED);
    } finally {
      if (before === undefined) delete process.env["HOME"];
      else process.env["HOME"] = before;
    }
  });
});

describe("the built hook", () => {
  const hook = (input: string, env: Record<string, string> = {}) => {
    const home = temp();
    const dir = temp();
    const r = spawnSync(process.execPath, ["bin/bouncer.cjs", "stop"], {
      input,
      encoding: "utf8",
      env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: dir, BOUNCER_BACKEND: "mock", ...env },
    });
    return { stdout: r.stdout, status: r.status, lines: logged(dir) };
  };

  const SAYS =
    "Nothing may reach stdout from the Stop hook, and it may never exit 2: either keeps the agent working " +
    "after it chose to stop. docs/adr/015 is the record; letting this hook speak is a decision to make there.";

  it("is off after a plain install: no policy, no log, no output", () => {
    const { stdout, status, lines } = hook(JSON.stringify(PAYLOAD));
    expect({ stdout, status }, SAYS).toEqual({ stdout: "", status: 0 });
    expect(lines).toEqual([]);
  });

  it("writes a line and prints nothing once a stop policy exists", () => {
    const { stdout, status, lines } = hook(JSON.stringify(PAYLOAD), { BOUNCER_STOP_POLICY: SHIPPED });
    expect({ stdout, status }, SAYS).toEqual({ stdout: "", status: 0 });
    expect(lines).toHaveLength(1);
    // The mock answers 0.05 to every question it has no keyword for, so: leave.
    expect(lines[0]).toMatchObject({ would: "leave", decided_by: "default", backend: "mock" });
  });

  it.each([
    ["nothing at all", ""],
    ["text that is not JSON", "not json"],
    ["a JSON array", "[1,2,3]"],
    ["a payload of the wrong types", JSON.stringify({ hook_event_name: "Stop", last_assistant_message: 7, cwd: 12, background_tasks: "x" })],
    ["a very long message", JSON.stringify({ ...PAYLOAD, last_assistant_message: "x".repeat(400_000) })],
  ])("prints nothing and exits 0 on %s", (_label, input) => {
    const { stdout, status } = hook(input, { BOUNCER_STOP_POLICY: SHIPPED });
    expect({ stdout, status }, SAYS).toEqual({ stdout: "", status: 0 });
  });

  it("prints nothing and exits 0 when the policy it is pointed at is broken or missing", () => {
    const broken = join(temp(), "stop.yaml");
    writeFileSync(broken, "policies: [", "utf8");
    for (const path of [broken, join(temp(), "absent.yaml")]) {
      const { stdout, status, lines } = hook(JSON.stringify(PAYLOAD), { BOUNCER_STOP_POLICY: path });
      expect({ stdout, status }, SAYS).toEqual({ stdout: "", status: 0 });
      expect(lines).toEqual([]);
    }
  });

  it("logs that it has no backend, and still prints nothing, when there is no key", () => {
    const { stdout, status, lines } = hook(JSON.stringify(PAYLOAD), {
      BOUNCER_STOP_POLICY: SHIPPED,
      BOUNCER_BACKEND: "jev",
      BOUNCER_TYPESAFE_API_KEY: "",
      TYPESAFE_API_KEY: "",
    });
    expect({ stdout, status }, SAYS).toEqual({ stdout: "", status: 0 });
    expect(lines[0]?.error?.kind).toBe("no-backend");
  });

  it("is registered for Stop in the plugin's hooks, and for nothing that stops a subagent", () => {
    const hooks = JSON.parse(readFileSync("hooks/hooks.json", "utf8")).hooks as Record<string, { hooks: { command: string }[] }[]>;
    expect(hooks["Stop"]?.[0]?.hooks[0]?.command).toMatch(/bouncer\.cjs" stop$/);
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "Stop"]);
  });
});

describe("a go-ahead, read off the user's own words", () => {
  it.each(["proceed", "Proceed.", "merge it", "go ahead", "yes", "ok proceed", "do it", "lgtm", "merge the PR", "yes please", "sounds good"])(
    "`%s` is one",
    (prompt) => expect(isGoAhead(prompt)).toBe(true),
  );

  // Each carries something the agent could not have assumed.
  it.each([
    "proceed with option 2",
    "merge 147 once CI is green, then do #122",
    "no",
    "wait",
    "why did you pick that?",
    "yes but use the other branch",
    "proceed with 2, the observe-only Stop hook",
    "status on the qwen run",
    "",
  ])("`%s` is not", (prompt) => expect(isGoAhead(prompt)).toBe(false));
});

describe("the score", () => {
  it("counts each of the four outcomes, and names what held a missed go-ahead", () => {
    const score = scoreStops([
      { would: "continue", decidedBy: "asks_go_ahead", next: "go-ahead" },
      { would: "continue", decidedBy: "asks_go_ahead", next: "go-ahead" },
      { would: "continue", decidedBy: "asks_go_ahead", next: "other" },
      { would: "leave", decidedBy: "irreversible_step", next: "go-ahead" },
      { would: "leave", decidedBy: "irreversible_step", next: "go-ahead" },
      { would: "leave", decidedBy: "default", next: "go-ahead" },
      { would: "leave", decidedBy: "needs_a_decision", next: "other" },
      { would: "leave", decidedBy: "default", next: "none" },
    ]);
    expect(score).toEqual({
      judged: 8,
      labelled: 7,
      saved: 2,
      ranAhead: 1,
      missed: { irreversible_step: 2, default: 1 },
      rightlyLeft: 1,
      unlabelled: 1,
    });
  });
});

describe("reading what was typed next", () => {
  const line = (over: Record<string, unknown>) => JSON.stringify({ type: "user", timestamp: "2026-10-12T10:00:00.000Z", message: { role: "user", content: "x" }, ...over });

  it("takes typed prompts and leaves out everything the harness put in the user's turn", () => {
    const path = join(temp(), "t.jsonl");
    writeFileSync(
      path,
      [
        line({ timestamp: "2026-10-12T10:00:00.000Z", message: { role: "user", content: "fix the parser" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-10-12T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Shall I proceed?" }] } }),
        line({ timestamp: "2026-10-12T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
        line({ timestamp: "2026-10-12T10:00:07.000Z", message: { role: "user", content: "<system-reminder>x</system-reminder>" } }),
        line({ timestamp: "2026-10-12T10:00:08.000Z", isSidechain: true, message: { role: "user", content: "a subagent's brief" } }),
        "not json",
        line({ timestamp: "2026-10-12T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "proceed" }] } }),
      ].join("\n"),
      "utf8",
    );

    const prompts = typedPrompts(path);
    expect(prompts.map((p) => p.text)).toEqual(["fix the parser", "proceed"]);
    expect(nextTypedPrompt(prompts, "2026-10-12T10:00:05.500Z")?.text).toBe("proceed");
    expect(nextTypedPrompt(prompts, "2026-10-12T10:02:00.000Z")).toBeUndefined();
    expect(typedPrompts(join(temp(), "absent.jsonl"))).toEqual([]);
  });
});

describe("bouncer stops", () => {
  const stop = (over: Partial<StopRecord>): StopRecord => ({
    ts: "2026-10-12T10:00:05.000Z",
    session_id: "s",
    cwd: "/home/user/project",
    transcript_path: "/t/a.jsonl",
    stop_hook_active: false,
    backend: "jev",
    policy: { file: "f", questions: "q" },
    would: "continue",
    decided_by: "asks_go_ahead",
    latency_ms: 300,
    ...over,
  });

  const seed = (records: readonly StopRecord[]) => writeFileSync(join(data, STOPS_FILE), records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");

  it("says how to turn the hook on when nothing is logged, and why it is off", () => {
    const out = formatStops(reportStops(data));
    expect(out).toContain("~/.bouncer/stop.yaml");
    expect(out).toContain("closing message");
  });

  it("pairs each stop with the next prompt in its own session and prints the table", () => {
    seed([
      stop({ transcript_path: "/t/a.jsonl" }),
      stop({ transcript_path: "/t/b.jsonl" }),
      stop({ transcript_path: "/t/c.jsonl", would: "leave", decided_by: "irreversible_step" }),
      stop({ transcript_path: "/t/d.jsonl", would: "leave", decided_by: "default" }),
      stop({ transcript_path: "/t/none.jsonl" }),
      (({ would: _would, decided_by: _by, ...rest }) => ({ ...rest, skipped: "work-still-running" as const }))(stop({})),
      stop({ backend: "mock" }),
    ]);
    const next: Record<string, string> = { "/t/a.jsonl": "proceed", "/t/b.jsonl": "no, revert that", "/t/c.jsonl": "merge it", "/t/d.jsonl": "what about the tests?" };
    const report = reportStops(data, (path) => (next[path] !== undefined ? [{ ts: "2026-10-12T10:01:00.000Z", text: next[path]! }] : []));

    expect(report).toMatchObject({ lines: 7, judged: 5, labelled: 4, saved: 1, ranAhead: 1, missed: { irreversible_step: 1 }, rightlyLeft: 1, unlabelled: 1, skipped: 1, mock: 1 });

    const out = formatStops(report);
    expect(out).toContain("1 prompt you would not have had to type.");
    expect(out).toContain("1 time it would have run ahead of you.");
    expect(out).toContain("by the question that held them: irreversible_step 1.");
    expect(out).toContain("1 answered by the mock backend and set aside");
  });
});
