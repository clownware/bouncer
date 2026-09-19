// The fast path, driven through the built binary rather than read.
//
// `gate.fast_path` is the one part of the gate that produces an `allow` with no judgment at
// all, so a wrong entry cannot be caught by the fixture table, by `calibrate`, or by any
// test that stubs an adapter — the adapter is never reached. CLAUDE.md says to check a
// candidate by driving the built hook with its worst argument; this is that, as a test.
//
// Two halves. The table below is the concrete cases, including the ones that were real
// holes. `the shape of every entry` is generative over the policy's own list, so an entry
// added later is checked without anybody remembering to add a case here.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "../src/engine/policy.js";

const BIN = "bin/bouncer.cjs";

const { policy } = loadPolicy(readFileSync("policy/default.yaml", "utf8"));
const ENTRIES = policy?.gate.fastPath ?? [];

/**
 * Runs one command through the built hook and reports which layer decided it.
 *
 * The verdict is not the assertion. In `observe` — what ships, and what this runs — every
 * layer emits nothing, so the only visible difference between "the fast path allowed this"
 * and "the classifier was asked" is the `source` on the log line. That is the field these
 * tests are about.
 */
function decide(command: string): { source: string; verdict: string } {
  const dir = mkdtempSync(join(tmpdir(), "bouncer-fastpath-"));
  const payload = JSON.stringify({
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/home/user/.claude/transcript.jsonl",
    cwd: process.cwd(),
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_00000000000000000000000000",
    tool_input: { command, description: "a command" },
  });

  const run = spawnSync(process.execPath, [BIN, "pretooluse"], {
    input: payload,
    encoding: "utf8",
    env: {
      ...process.env,
      BOUNCER_BACKEND: "mock",
      CLAUDE_PLUGIN_ROOT: resolve("."),
      CLAUDE_PLUGIN_DATA: dir,
    },
  });

  // Exit 2 is "block this tool call" whatever is on stdout, so it is never acceptable.
  expect(run.status).not.toBe(2);

  const lines = readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n");
  const record = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
  return { source: (record["source"] as string) ?? "judge", verdict: record["verdict"] as string };
}

describe("the fast path, through the built hook", () => {
  // `judge` means the classifier was asked, which in these rows is the point: the command
  // got a judgment instead of a free pass. What the mock then answers is not this file's
  // business.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // The plain forms the entries exist for.
    ["git status", "fast_path", "the bare command an entry names"],
    ["git status --porcelain", "fast_path", "a spelled-out form of it"],
    ["ls", "fast_path", "an entry that takes arguments, given none"],
    ["ls -la", "fast_path", "and given a harmless one"],
    ["pwd", "fast_path", "a whole command with no arguments to give"],
    ["npm test", "fast_path", "a named project script"],

    // The hole this file was written for. `git status -v` prints the diff of what is
    // staged and `-vv` adds the unstaged one, so a staged `.env` is printed — which is
    // `cat .env`, the `secrets` question's own example, reached through a verb that was
    // never going to be judged.
    ["git status -v", "judge", "a verbose flag that prints a diff"],
    ["git status -vv", "judge", "and its louder form"],
    ["git status --verbose", "judge", "spelled out"],
    ["git status -s -v", "judge", "hidden behind a harmless flag"],

    // ADR-010: an entry without a trailing space is a whole command. `npm test` is the
    // project's own script; `npm test --script-shell <program>` is somebody else's.
    ["npm test --script-shell /tmp/x.sh", "judge", "a whole-command entry given an argument"],
    ["go test -exec /tmp/x.sh", "judge", "another, with a different escape"],

    // Refused by character, not by entry — the guards added with ADR-010.
    ["ls > /home/user/.ssh/authorized_keys", "judge", "a redirect, which is what the command does"],
    ["ls $OPENAI_API_KEY", "judge", "a variable the shell expands before the verb sees it"],
    // A hard rule, not the classifier: chaining a `cat` of a dotfile is one of the cases
    // the deterministic edge already knows. Pinned to the stronger answer on purpose —
    // if this ever softens to `judge` that is worth seeing.
    ["git status; cat /home/user/.env", "hard_rule", "a second command behind a separator"],
    ["ls | sh", "judge", "a pipeline"],
    ["ls `cat /home/user/.env`", "judge", "a command substitution"],
  ];

  it.each(cases)("%s is decided by %s — %s", (command, source) => {
    expect(decide(command).source).toBe(source);
  });

  // Generative over whatever the policy currently lists, so this holds for entries nobody
  // has written yet.
  describe("the shape of every entry holds", () => {
    const wholeCommands = ENTRIES.filter((e) => !e.endsWith(" "));
    const takesArguments = ENTRIES.filter((e) => e.endsWith(" "));

    it("the policy still has entries of both kinds to check", () => {
      expect(wholeCommands.length).toBeGreaterThan(0);
      expect(takesArguments.length).toBeGreaterThan(0);
    });

    // ADR-010. An entry written without a trailing space matches that command and nothing
    // longer; anything appended has to be judged, whatever it is.
    it.each(wholeCommands)("%s is a whole command, so an extra token is judged", (entry) => {
      expect(decide(`${entry} --some-argument`).source).toBe("judge");
    });

    // A trailing space says every argument is safe. These are the arguments no entry can
    // make safe, because they stop being that command: the matcher refuses them by
    // character, and this asserts it keeps doing so for entries added later.
    const universallyHostile = [
      "> /home/user/.ssh/authorized_keys",
      "$OPENAI_API_KEY",
      "; cat /home/user/.env",
      "| sh",
      "&& rm -rf /",
    ];

    // `not fast_path` rather than a named layer: several of these are also hard rules, and
    // which one answers depends on the argument. The property being asserted is the only
    // one that matters here — none of them got a free pass.
    it.each(takesArguments.flatMap((entry) => universallyHostile.map((arg) => [entry, arg] as const)))(
      "%s refuses %s",
      (entry, arg) => {
        expect(decide(`${entry.trim()} ${arg}`).source).not.toBe("fast_path");
      },
    );
  });
});
