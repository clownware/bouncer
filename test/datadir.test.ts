// Where bouncer reads the decision log from has to be where the hook wrote it.
//
// It was not. Claude Code exports ${CLAUDE_PLUGIN_DATA} to hook processes but not to
// commands it runs through the Bash tool, which is what a slash command is — so the hook
// wrote ~/.claude/plugins/data/bouncer-bouncer/decisions.jsonl while `/bouncer:status`
// read ~/.bouncer/decisions.jsonl and reported "No decisions logged yet" over a log with
// a thousand real decisions in it. Reported from a live install on 2026-09-19.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataDir } from "../src/io/config.js";
import { LOG_FILE } from "../src/io/log.js";

const BIN = "bin/bouncer.cjs";
const POLICY = readFileSync("policy/default.yaml", "utf8");

/**
 * The layout Claude Code installs into: a plugin cached at
 * `<plugins>/cache/<marketplace>/<plugin>/<version>` with its data at
 * `<plugins>/data/<plugin>-<marketplace>`.
 */
function install(root: string, opts: { readonly data: boolean } = { data: true }) {
  const version = join(root, "plugins", "cache", "bouncer", "bouncer", "0.2.0");
  mkdirSync(join(version, "policy"), { recursive: true });
  mkdirSync(join(version, "bin"), { recursive: true });
  writeFileSync(join(version, "policy", "default.yaml"), POLICY, "utf8");

  const data = join(root, "plugins", "data", "bouncer-bouncer");
  if (opts.data) mkdirSync(data, { recursive: true });
  return { version, data };
}

let root: string;
let saved: Record<string, string | undefined>;

const VARS = ["CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "BOUNCER_POLICY"] as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bouncer-datadir-"));
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("dataDir", () => {
  it("uses CLAUDE_PLUGIN_DATA when Claude Code set it, which is the hook's case", () => {
    const { version, data } = install(root);
    process.env["CLAUDE_PLUGIN_ROOT"] = version;
    process.env["CLAUDE_PLUGIN_DATA"] = join(root, "explicit");

    expect(dataDir()).toBe(join(root, "explicit"));
    expect(dataDir()).not.toBe(data);
  });

  it("derives the plugin's data directory when the variable is absent", () => {
    const { version, data } = install(root);
    process.env["CLAUDE_PLUGIN_ROOT"] = version;

    expect(dataDir()).toBe(data);
  });

  it("falls back to ~/.bouncer when the derived directory does not exist", () => {
    // The guard on a derivation: nothing is created, and a layout that stopped matching
    // sends the caller back to where it was reading before rather than to a guess.
    const { version } = install(root, { data: false });
    process.env["CLAUDE_PLUGIN_ROOT"] = version;

    expect(dataDir()).toBe(join(homedir(), ".bouncer"));
  });

  it("falls back to ~/.bouncer from a checkout, which is not a plugin cache path", () => {
    process.env["CLAUDE_PLUGIN_ROOT"] = resolve(".");

    expect(dataDir()).toBe(join(homedir(), ".bouncer"));
  });
});

describe("the hook and the commands beside it", () => {
  it("read and write one log, with only the hook given the environment", () => {
    const { version, data } = install(root);
    copyFileSync(BIN, join(version, "bin", "bouncer.cjs"));
    const installed = join(version, "bin", "bouncer.cjs");

    // A fresh HOME so a fallback to ~/.bouncer cannot silently pass by finding the
    // developer's own log, and so this test can never write to it.
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const base: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, BOUNCER_BACKEND: "mock" };
    for (const k of VARS) delete base[k];

    const hook = spawnSync(
      process.execPath,
      [installed, "pretooluse"],
      {
        // What Claude Code gives a hook process, and nothing else.
        env: { ...base, CLAUDE_PLUGIN_ROOT: version, CLAUDE_PLUGIN_DATA: data },
        input: JSON.stringify({
          session_id: "00000000-0000-0000-0000-000000000000",
          transcript_path: join(home, "transcript.jsonl"),
          cwd: home,
          permission_mode: "default",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "toolu_00000000000000000000000000",
          tool_input: { command: "rm -rf /tmp/scratch", description: "clean up" },
        }),
        encoding: "utf8",
      },
    );
    expect(hook.status).not.toBe(2);
    expect(readFileSync(join(data, LOG_FILE), "utf8").trim()).not.toBe("");

    // What a slash command gets: neither variable, because Claude Code runs it through
    // the Bash tool. This is the process that used to read a different file.
    const status = spawnSync(process.execPath, [installed, "status"], { env: base, encoding: "utf8" });

    expect(status.status).toBe(0);
    expect(status.stdout).toContain(join(data, LOG_FILE));

    // It resolved the same file *and* read it. The record is the mock backend's, which
    // status excludes from its counts by design (PR #30) and says so — that sentence is
    // only printable by a process that opened the log the hook wrote. Before the fix this
    // run printed a ~/.bouncer path and no mention of any record at all.
    expect(status.stdout).toContain("Ignoring 1 record answered by the mock backend");
  });
});
