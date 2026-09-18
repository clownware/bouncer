import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BIN = "bin/bouncer.mjs";

function run(args: string[], input: string) {
  return spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8" });
}

const PRETOOLUSE_BASH = JSON.stringify({
  session_id: "00000000-0000-0000-0000-000000000000",
  transcript_path: "/home/user/.claude/transcript.jsonl",
  cwd: "/home/user/project",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: "toolu_00000000000000000000000000",
  tool_input: { command: "git push --force origin main", description: "push" },
});

describe("the hook binary", () => {
  it("is built", () => {
    expect(existsSync(BIN), `${BIN} missing — run \`npm run build\``).toBe(true);
  });

  // The single most important property in the project. Claude Code treats exit 2 from
  // PreToolUse as "block this tool call" regardless of stdout, so any input that can make
  // bouncer exit 2 is a way to silently break a user's session. See ADR-003.
  describe("never exits 2, whatever it is fed", () => {
    const hostileInputs: ReadonlyArray<readonly [string, string[], string]> = [
      ["a well-formed payload", ["pretooluse"], PRETOOLUSE_BASH],
      ["empty stdin", ["pretooluse"], ""],
      ["whitespace only", ["pretooluse"], "   \n\t  "],
      ["truncated JSON", ["pretooluse"], '{"tool_name": "Bash", "tool_inp'],
      ["JSON that is not an object", ["pretooluse"], '"just a string"'],
      ["a JSON array", ["pretooluse"], "[1, 2, 3]"],
      ["null", ["pretooluse"], "null"],
      ["an empty object", ["pretooluse"], "{}"],
      ["deeply nested input", ["pretooluse"], JSON.stringify({ tool_input: { a: { b: { c: { d: {} } } } } })],
      ["no command at all", [], PRETOOLUSE_BASH],
      ["an unknown command", ["nonsense"], PRETOOLUSE_BASH],
      ["a flag that looks like a command", ["--block"], PRETOOLUSE_BASH],
    ];

    it.each(hostileInputs)("%s", (_label, args, input) => {
      const r = run([...args], input);
      expect(r.status).not.toBe(2);
    });
  });

  // Observe mode is the shipped default and must be indistinguishable from not having
  // the plugin installed. Emitting anything on stdout here would be a real decision.
  it("emits no decision in observe mode, so the normal permission flow runs", () => {
    const r = run(["pretooluse"], PRETOOLUSE_BASH);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("survives a payload with no tool_input", () => {
    const r = run(["pretooluse"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("reports its version", () => {
    const r = run(["--version"], "");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.1.0");
  });

  it("exits 1 — a non-blocking error — on an unknown command", () => {
    const r = run(["nonsense"], "");
    expect(r.status).toBe(1);
  });
});
