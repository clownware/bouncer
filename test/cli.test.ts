import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BIN = "bin/bouncer.cjs";

// A hook process inherits CLAUDE_PLUGIN_ROOT from Claude Code, which is how it finds the
// bundled default policy. Without it bouncer is correctly silent, which would make these
// tests pass for the wrong reason.
const HOOK_ENV = {
  ...process.env,
  BOUNCER_BACKEND: "mock",
  CLAUDE_PLUGIN_ROOT: resolve("."),
  CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "bouncer-cli-")),
};

function run(args: string[], input: string) {
  return spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8", env: HOOK_ENV });
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

  // The unit tests import src/ directly, so they exercise none of the bundling. A
  // dependency resolving to a CommonJS build inside an ESM bundle throws "Dynamic require
  // of process is not supported" at startup — every unit test still passes, and the plugin
  // is dead on arrival. These tests run the built artifact and assert it actually works,
  // not merely that it exits 0.
  describe("the built bundle actually runs", () => {
    const env = {
      ...process.env,
      BOUNCER_BACKEND: "mock",
      BOUNCER_POLICY: resolve("policy/default.yaml"),
      CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "bouncer-bundle-")),
    };

    function runWithEnv(args: string[], input: string) {
      return spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8", env });
    }

    it("loads its whole module graph without a runtime resolution error", () => {
      const r = runWithEnv(["pretooluse"], PRETOOLUSE_BASH);
      expect(r.stderr).not.toContain("Dynamic require");
      expect(r.stderr).not.toContain("Cannot find module");
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });

    it("parses the YAML policy and reaches a decision", () => {
      // `status` is the cheapest command that forces a full policy parse.
      const r = runWithEnv(["status"], "");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Mode:");
      expect(r.stdout).toContain("observe");
    });

    it("emits a decision when policy says to", () => {
      const guard = mkdtempSync(join(tmpdir(), "bouncer-guard-"));
      const guardPolicy = join(guard, "policy.yaml");
      writeFileSync(guardPolicy, readFileSync("policy/default.yaml", "utf8").replace(/^mode: observe$/m, "mode: guard"));

      const r = spawnSync(process.execPath, [BIN, "pretooluse"], {
        input: PRETOOLUSE_BASH,
        encoding: "utf8",
        env: { ...env, BOUNCER_POLICY: guardPolicy, CLAUDE_PLUGIN_DATA: guard },
      });

      expect(r.status).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(output.hookSpecificOutput.permissionDecision).toBe("ask");
    });

    it("emits nothing in observe mode, through the real binary", () => {
      const r = runWithEnv(["pretooluse"], PRETOOLUSE_BASH);
      expect(r.stdout).toBe("");
    });
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

// `bouncer judge` through the real binary: the second entrypoint, docs/adr/009.
describe("the judge command", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bouncer-judge-"));
  const env = {
    ...process.env,
    BOUNCER_POLICY: resolve("policy/judge-example.yaml"),
    BOUNCER_NO_CACHE: "1",
    CLAUDE_PLUGIN_ROOT: resolve("."),
    CLAUDE_PLUGIN_DATA: dataDir,
  };

  const judge = (args: string[]) =>
    spawnSync(process.execPath, [BIN, "judge", ...args], { encoding: "utf8", env });

  it("judges the example batch and writes both artifacts", () => {
    const out = join(dataDir, "j.jsonl");
    const manifest = join(dataDir, "m.json");
    const r = judge(["fixtures/judge-example.jsonl", "--set", "content", "--backend", "mock", "--out", out, "--manifest", manifest]);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Set: content");
    expect(r.stdout).toMatch(/escalated +\d+ \/ 14/);
    expect(existsSync(out)).toBe(true);

    const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(14);
    expect(lines[0]?.["consumer"]).toBe("judge");
    expect(lines[0]?.["set"]).toBe("content");
    expect(lines[0]?.["item"]).toBe("sourced-stat");
    // An item is not a tool call, so the line carries no tool. Readers treat that as an
    // item line rather than a malformed one.
    expect(lines[0]?.["tool"]).toBeUndefined();
  });

  it("names the sets that exist when asked for one that does not", () => {
    const r = judge(["fixtures/judge-example.jsonl", "--set", "nope", "--backend", "mock"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("content");
  });

  it("says what to do when given no batch", () => {
    const r = judge(["--backend", "mock"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Usage:");
  });

  it("does not mistake a flag's value for the batch path", () => {
    // `--set content` used to leave the parser reading "content" as the file to judge.
    const r = judge(["--set", "content", "--backend", "mock", "fixtures/judge-example.jsonl", "--out", join(dataDir, "k.jsonl"), "--manifest", join(dataDir, "k.json")]);
    expect(r.status).toBe(0);
  });

  it("reports a batch it cannot read rather than throwing", () => {
    const r = judge(["/nonexistent/batch.jsonl", "--set", "content", "--backend", "mock"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Cannot read");
    expect(r.stderr).toBe("");
  });

  // The invariant that matters everywhere in this binary.
  it("never exits 2, whatever it is given", () => {
    for (const args of [[], ["/nonexistent"], ["--set"], ["fixtures/judge-example.jsonl", "--backend", "nonsense"]]) {
      expect(judge(args).status).not.toBe(2);
    }
  });
});
