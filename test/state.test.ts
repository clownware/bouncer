import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildState, commandOf, MAX_STATE_BYTES } from "../src/engine/state.js";

const FIXTURE_DIR = "test/fixtures/payloads";

interface Payload {
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly cwd?: string;
  readonly permission_mode?: string;
  readonly agent_type?: string;
}

function fixture(name: string): Payload {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as Payload;
}

function stateFor(name: string) {
  const p = fixture(name);
  return buildState({
    toolName: p.tool_name ?? "",
    toolInput: p.tool_input ?? {},
    ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
    ...(p.permission_mode !== undefined ? { permissionMode: p.permission_mode } : {}),
    ...(p.agent_type !== undefined ? { agentType: p.agent_type } : {}),
  });
}

const preToolUseFixtures = readdirSync(FIXTURE_DIR).filter((f) => f.startsWith("pretooluse-"));

describe("buildState, over the real captured payloads", () => {
  it("has fixtures to run against", () => {
    expect(preToolUseFixtures.length).toBeGreaterThan(0);
  });

  it.each(preToolUseFixtures)("produces valid JSON within the size cap for %s", (name) => {
    const state = stateFor(name);
    expect(() => JSON.parse(state.text)).not.toThrow();
    expect(Buffer.byteLength(state.text, "utf8")).toBeLessThanOrEqual(MAX_STATE_BYTES);
  });

  // The central privacy claim: what leaves the machine describes the action, never its
  // content. If this ever fails, the README's promise is false.
  it.each(preToolUseFixtures)("never includes file contents or diff text for %s", (name) => {
    const payload = fixture(name);
    const state = stateFor(name);
    const contentFields = ["content", "old_string", "new_string", "new_source"];

    for (const field of contentFields) {
      const value = payload.tool_input?.[field];
      if (typeof value !== "string" || value.trim().length < 4) continue;
      expect(state.text).not.toContain(value.trim());
    }
  });

  it("describes a Bash command and keeps Claude's stated intent", () => {
    const state = stateFor("pretooluse-bash.json");
    const parsed = JSON.parse(state.text);
    expect(parsed.tool).toBe("Bash");
    expect(parsed.action.kind).toBe("run_shell_command");
    expect(parsed.action.command).toContain("cat <<'EOF'");
    expect(parsed.action.stated_intent).toBe("Write notes file with a heredoc");
  });

  it("sends only the size of a written file, not the bytes", () => {
    const payload = fixture("pretooluse-write.json");
    const parsed = JSON.parse(stateFor("pretooluse-write.json").text);
    expect(parsed.action.kind).toBe("write_file");
    expect(parsed.action.bytes).toBe(Buffer.byteLength(String(payload.tool_input?.["content"]), "utf8"));
    expect(stateFor("pretooluse-write.json").text).not.toContain("hello world");
  });

  it("sends the magnitude of an edit, not the diff", () => {
    const parsed = JSON.parse(stateFor("pretooluse-edit.json").text);
    expect(parsed.action.kind).toBe("edit_file");
    expect(parsed.action.bytes_removed).toBeGreaterThan(0);
    expect(parsed.action.bytes_added).toBeGreaterThan(0);
    expect(parsed.action.replaces_every_occurrence).toBe(false);
  });

  it("handles a notebook edit without sending the new cell source", () => {
    const parsed = JSON.parse(stateFor("pretooluse-notebookedit.json").text);
    expect(parsed.action.kind).toBe("edit_notebook_cell");
    expect(parsed.action.cell).toBe("c1");
    expect(stateFor("pretooluse-notebookedit.json").text).not.toContain("print(2)");
  });

  it("records that a subagent is making the call", () => {
    const parsed = JSON.parse(stateFor("pretooluse-read.json").text);
    expect(parsed.running_as_subagent).toBe("Explore");
  });

  it("records the permission mode, which is what the gate matters most for", () => {
    const parsed = JSON.parse(stateFor("pretooluse-bash.json").text);
    expect(parsed.permission_mode).toBe("bypassPermissions");
  });

  it("sends only the basename of the working directory", () => {
    const payload = fixture("pretooluse-bash.json");
    const parsed = JSON.parse(stateFor("pretooluse-bash.json").text);
    expect(parsed.project).toBe("bouncer");
    expect(stateFor("pretooluse-bash.json").text).not.toContain(String(payload.cwd));
  });

  // An unknown tool's input could contain anything, including file contents.
  it("summarises an unrecognised tool conservatively", () => {
    const parsed = JSON.parse(stateFor("pretooluse-toolsearch.json").text);
    expect(parsed.action.kind).toBe("other_tool");
    expect(parsed.action.tool).toBe("ToolSearch");
    expect(parsed.action.max_results).toBe(3);
  });
});

describe("buildState, constructed cases", () => {
  const cwd = "/home/user/project";

  it("computes inside_project rather than asking the classifier", () => {
    const inside = buildState({ toolName: "Write", toolInput: { file_path: `${cwd}/src/a.ts`, content: "x" }, cwd });
    expect(JSON.parse(inside.text).action.inside_project).toBe(true);
    expect(JSON.parse(inside.text).action.path).toBe("src/a.ts");
  });

  const outside: ReadonlyArray<readonly [string, string, string]> = [
    ["the user's dotfiles", "/home/user/.ssh/config", "user_dotfiles"],
    ["a system directory", "/etc/hosts", "system_directory"],
    ["a sibling project", "/home/user/other/src.ts", "elsewhere_in_home"],
    ["a temp file", "/tmp/scratch.txt", "temp_directory"],
    ["the home directory root", "/home/user", "home_directory_root"],
  ];

  it.each(outside)("labels %s without sending the full path", (_label, path, expected) => {
    const state = buildState({ toolName: "Write", toolInput: { file_path: path, content: "x" }, cwd });
    const parsed = JSON.parse(state.text);
    expect(parsed.action.inside_project).toBe(false);
    expect(parsed.action.outside_location).toBe(expected);
    expect(state.text).not.toContain(path);
  });

  // Being inside the project does not make a path ordinary. These are the in-tree writes
  // that most warrant a prompt, and the gate would miss them if `inside_project` were the
  // only signal it got.
  const sensitiveInProject: ReadonlyArray<readonly [string, string, string]> = [
    ["a git hook", ".git/hooks/pre-commit", "git_internals"],
    ["the git config", ".git/config", "git_internals"],
    ["an env file", ".env", "environment_file"],
    ["a scoped env file", ".env.production", "environment_file"],
    ["an npm credentials file", ".npmrc", "credentials_file"],
    ["a CI workflow", ".github/workflows/deploy.yml", "ci_workflow"],
  ];

  it.each(sensitiveInProject)("flags %s even though it is inside the project", (_label, rel, expected) => {
    const state = buildState({ toolName: "Write", toolInput: { file_path: `${cwd}/${rel}`, content: "x" }, cwd });
    const parsed = JSON.parse(state.text);
    expect(parsed.action.inside_project).toBe(true);
    expect(parsed.action.sensitive).toBe(expected);
  });

  it("flags an ssh key written outside the project on both axes", () => {
    const state = buildState({ toolName: "Write", toolInput: { file_path: "/home/user/.ssh/id_ed25519", content: "x" }, cwd });
    const parsed = JSON.parse(state.text);
    expect(parsed.action.inside_project).toBe(false);
    expect(parsed.action.sensitive).toBe("ssh_configuration");
  });

  it("leaves ordinary project files unflagged", () => {
    for (const rel of ["src/index.ts", "README.md", "test/a.test.ts", "package.json"]) {
      const state = buildState({ toolName: "Write", toolInput: { file_path: `${cwd}/${rel}`, content: "x" }, cwd });
      expect(JSON.parse(state.text).action.sensitive).toBeUndefined();
    }
  });

  it("redacts a secret in a command and reports which kind fired", () => {
    const state = buildState({
      toolName: "Bash",
      toolInput: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://api.example.com" },
      cwd,
    });
    expect(state.redactedKinds).toContain("bearer-token");
    expect(state.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    // The shape has to survive redaction, or the `secrets` question has nothing to judge.
    expect(state.text).toContain("[REDACTED:bearer-token]");
    expect(state.text).toContain("api.example.com");
  });

  it("truncates an enormous command and says so", () => {
    const state = buildState({ toolName: "Bash", toolInput: { command: "echo " + "x".repeat(20_000) }, cwd });
    expect(state.truncated).toBe(true);
    expect(Buffer.byteLength(state.text, "utf8")).toBeLessThanOrEqual(MAX_STATE_BYTES);
    expect(state.text).toContain("truncated");
  });

  it("does not choke on a missing or malformed tool_input", () => {
    for (const toolInput of [{}, { command: 42 }, { file_path: null }, { content: [] }]) {
      expect(() => buildState({ toolName: "Bash", toolInput: toolInput as Record<string, unknown>, cwd })).not.toThrow();
    }
  });

  it("keeps only the last three recent tools", () => {
    const state = buildState({
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd,
      recentTools: ["Read", "Grep", "Edit", "Write", "Bash"],
    });
    expect(JSON.parse(state.text).recent_tools).toEqual(["Edit", "Write", "Bash"]);
  });
});

describe("commandOf", () => {
  it("returns the command for Bash", () => {
    expect(commandOf("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("returns empty for every other tool, so nothing else can hit the fast path", () => {
    expect(commandOf("Write", { command: "ls -la", file_path: "/x" })).toBe("");
    expect(commandOf("Edit", {})).toBe("");
  });

  it("returns empty when the command is not a string", () => {
    expect(commandOf("Bash", { command: 42 })).toBe("");
    expect(commandOf("Bash", {})).toBe("");
  });
});
