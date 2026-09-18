import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapters/mock.js";
import { AdapterError } from "../src/adapters/types.js";
import { runPreToolUse } from "../src/hooks/pretooluse.js";
import * as breaker from "../src/io/breaker.js";

let dir: string;
let policyPath: string;

const POLICY = readFileSync("policy/default.yaml", "utf8");

function usePolicy(mode: "observe" | "guard" | "full", extra = "") {
  writeFileSync(policyPath, POLICY.replace(/^mode: observe$/m, `mode: ${mode}`) + extra, "utf8");
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "test-session",
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_test",
    tool_input: { command: "rm -rf ~/Documents" },
    ...overrides,
  };
}

const dangerous = new MockAdapter({ answers: { destructive: 0.95 } });
const harmless = new MockAdapter({ answers: { destructive: 0.01, secrets: 0.01, outside_repo: 0.01, egress: 0.01, prod: 0.01, sensitive_target: 0.01, unreviewed_execution: 0.01 } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bouncer-test-"));
  policyPath = join(dir, "policy.yaml");
  process.env["CLAUDE_PLUGIN_DATA"] = dir;
  process.env["BOUNCER_POLICY"] = policyPath;
  usePolicy("observe");
});

afterEach(() => {
  delete process.env["CLAUDE_PLUGIN_DATA"];
  delete process.env["BOUNCER_POLICY"];
  rmSync(dir, { recursive: true, force: true });
});

const logLines = () => {
  try {
    return readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

describe("observe mode", () => {
  // The friction guarantee at the boundary that actually matters: what reaches stdout.
  it("emits nothing even when policy says ask", async () => {
    const output = await runPreToolUse(payload(), { adapter: dangerous });
    expect(output?.hookSpecificOutput).toBeUndefined();
  });

  it("still logs the verdict it withheld, which is what makes observe useful", async () => {
    await runPreToolUse(payload(), { adapter: dangerous });
    const [record] = logLines();
    expect(record.verdict).toBe("ask");
    expect(record.emitted).toBeNull();
    expect(record.answers.destructive).toBe(0.95);
  });
});

describe("guard mode", () => {
  beforeEach(() => usePolicy("guard"));

  it("emits ask with a reason naming the question and the number", async () => {
    const output = await runPreToolUse(payload(), { adapter: dangerous });
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(output?.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("destructive");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("0.95");
  });

  // guard can add a prompt but never remove one.
  it("withholds allow", async () => {
    const output = await runPreToolUse(payload(), { adapter: harmless });
    expect(output?.hookSpecificOutput).toBeUndefined();
  });
});

describe("full mode", () => {
  beforeEach(() => usePolicy("full"));

  it("emits allow, suppressing the prompt", async () => {
    const output = await runPreToolUse(payload(), { adapter: harmless });
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("allow");
  });
});

describe("short circuits", () => {
  beforeEach(() => usePolicy("guard"));

  it("never calls the adapter for a fast-path command", async () => {
    const adapter = { name: "explode", decide: async () => { throw new Error("should not be called"); } };
    const output = await runPreToolUse(payload({ tool_input: { command: "git status" } }), { adapter });
    expect(output?.hookSpecificOutput).toBeUndefined();
    expect(logLines()[0].reason.kind).toBe("fast-path");
  });

  it("never calls the adapter for an ungated tool", async () => {
    const adapter = { name: "explode", decide: async () => { throw new Error("should not be called"); } };
    await expect(runPreToolUse(payload({ tool_name: "Read", tool_input: { file_path: "/x" } }), { adapter })).resolves.toBeUndefined();
  });

  it("never calls the adapter in plan mode, where no tool runs anyway", async () => {
    const adapter = { name: "explode", decide: async () => { throw new Error("should not be called"); } };
    await expect(runPreToolUse(payload({ permission_mode: "plan" }), { adapter })).resolves.toBeUndefined();
  });

  it("does gate bypassPermissions, which is the mode bouncer exists for", async () => {
    const output = await runPreToolUse(payload({ permission_mode: "bypassPermissions" }), { adapter: dangerous });
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });
});

describe("failure handling", () => {
  beforeEach(() => usePolicy("guard"));

  const failing = new MockAdapter({ error: new AdapterError("timeout", "no answer in time") });

  // Never fail closed by default, and never fail open either: emitting nothing means the
  // user's own permission prompt appears exactly as it would without bouncer.
  it("emits nothing when the adapter fails", async () => {
    const output = await runPreToolUse(payload(), { adapter: failing });
    expect(output?.hookSpecificOutput).toBeUndefined();
  });

  it("logs the error so status and explain can show it", async () => {
    await runPreToolUse(payload(), { adapter: failing });
    expect(logLines()[0].error.kind).toBe("timeout");
  });

  it("honours on_error: deny when the user explicitly asked for it", async () => {
    writeFileSync(policyPath, POLICY.replace(/^mode: observe$/m, "mode: guard").replace(/^on_error: passthrough$/m, "on_error: deny"), "utf8");
    const output = await runPreToolUse(payload(), { adapter: failing });
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("emits nothing when the policy file itself is broken", async () => {
    writeFileSync(policyPath, "version: 99\nnonsense: [", "utf8");
    const output = await runPreToolUse(payload(), { adapter: dangerous });
    expect(output?.hookSpecificOutput).toBeUndefined();
    expect(output?.systemMessage).toContain("not enforcing");
  });

  // A systemMessage lands in the transcript. A persistent condition is true on every
  // call, so emitting it per call would be spam by the fiftieth Bash.
  it("mentions a broken policy once per session, not on every call", async () => {
    writeFileSync(policyPath, "version: 99\nnonsense: [", "utf8");
    const first = await runPreToolUse(payload(), { adapter: dangerous });
    const second = await runPreToolUse(payload(), { adapter: dangerous });
    const third = await runPreToolUse(payload(), { adapter: dangerous });

    expect(first?.systemMessage).toContain("not enforcing");
    expect(second).toBeUndefined();
    expect(third).toBeUndefined();
  });

  // Not being set up is not a problem the user created, so there is nothing to say.
  it("says nothing at all when no policy file exists anywhere", async () => {
    process.env["BOUNCER_POLICY"] = join(dir, "does-not-exist.yaml");
    const output = await runPreToolUse(payload({ cwd: dir }), { adapter: dangerous });
    expect(output).toBeUndefined();
  });
});

describe("the circuit breaker", () => {
  beforeEach(() => usePolicy("guard"));
  const failing = new MockAdapter({ error: new AdapterError("unavailable", "network down") });

  it("stands down after repeated failures rather than retrying every call", async () => {
    let message: string | undefined;
    for (let i = 0; i <= breaker.FAILURE_LIMIT; i++) {
      const output = await runPreToolUse(payload(), { adapter: failing });
      message ??= output?.systemMessage;
    }
    expect(message).toContain("standing down");

    // Once tripped, the adapter is not called again for this session.
    const adapter = { name: "explode", decide: async () => { throw new Error("should not be called"); } };
    await expect(runPreToolUse(payload(), { adapter })).resolves.toBeUndefined();
  });

  // Measured: 513 ms cold against 168-350 ms warm. Counting the warm-up would trip the
  // breaker on a healthy setup.
  it("does not count the first call of a session toward the limit", async () => {
    await runPreToolUse(payload(), { adapter: failing });
    const state = breaker.read(dir, "test-session");
    expect(state.consecutive_failures).toBe(0);
    expect(state.warmed).toBe(true);
  });

  it("marks the first call as a warm-up in the log", async () => {
    await runPreToolUse(payload(), { adapter: dangerous });
    expect(logLines()[0].warmup).toBe(true);
  });

  it("counts failures after the warm-up", async () => {
    await runPreToolUse(payload(), { adapter: failing });
    await runPreToolUse(payload(), { adapter: failing });
    expect(breaker.read(dir, "test-session").consecutive_failures).toBe(1);
  });

  it("resets the count after a success", async () => {
    await runPreToolUse(payload(), { adapter: failing });
    await runPreToolUse(payload(), { adapter: failing });
    await runPreToolUse(payload(), { adapter: dangerous });
    expect(breaker.read(dir, "test-session").consecutive_failures).toBe(0);
  });

  it("starts clean in a new session, since yesterday's outage says nothing about today", async () => {
    for (let i = 0; i <= breaker.FAILURE_LIMIT + 1; i++) {
      await runPreToolUse(payload(), { adapter: failing });
    }
    const output = await runPreToolUse(payload({ session_id: "a-new-session" }), { adapter: dangerous });
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("ask");
  });
});

describe("the state handed to the classifier", () => {
  beforeEach(() => usePolicy("guard"));

  it("reports whether a Write target already exists", async () => {
    const existing = join(dir, "exists.txt");
    writeFileSync(existing, "x", "utf8");

    await runPreToolUse(
      payload({ tool_name: "Write", tool_input: { file_path: existing, content: "new" } }),
      { adapter: harmless },
    );

    const state = JSON.parse(logLines()[0].state);
    expect(state.action.kind).toBe("overwrite_existing_file");
    expect(state.action.replaces_existing_file).toBe(true);
  });

  it("reports a Write to a new path as a creation", async () => {
    await runPreToolUse(
      payload({ tool_name: "Write", tool_input: { file_path: join(dir, "brand-new.txt"), content: "new" } }),
      { adapter: harmless },
    );
    const state = JSON.parse(logLines()[0].state);
    expect(state.action.replaces_existing_file).toBe(false);
  });

  it("records a hard-rule hit with its source, its state and no classifier answers", async () => {
    // The log's three jobs — explain a prompt, seed a fixture, re-score after a policy
    // change — all need the command, and this is the one kind of line the classifier never
    // saw. `source` is what lets a query over the log exclude these when it is asking a
    // question about the classifier rather than about the gate.
    await runPreToolUse(payload({ tool_input: { command: "cat .env" } }), { adapter: harmless });

    const record = logLines()[0];
    expect(record.source).toBe("hard_rule");
    expect(record.reason.kind).toBe("hard-rule");
    expect(record.reason.name).toBe("reads-a-credential-file");
    expect(record.verdict).toBe("ask");
    expect(record.answers).toBeUndefined();
    expect(JSON.parse(record.state).action.command).toBe("cat .env");
    expect(record.latency_ms.adapter).toBeUndefined();
  });

  it("records a judged decision as source judge", async () => {
    await runPreToolUse(payload({ tool_input: { command: "npm run something" } }), { adapter: harmless });
    const record = logLines()[0];
    expect(record.source).toBe("judge");
    expect(record.answers).toBeDefined();
  });

  it("records what was redacted without recording the value", async () => {
    await runPreToolUse(
      payload({ tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'" } }),
      { adapter: harmless },
    );
    const record = logLines()[0];
    expect(record.redacted_kinds).toContain("bearer-token");
    expect(record.state).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });
});

describe("malformed payloads", () => {
  beforeEach(() => usePolicy("guard"));

  it.each([
    ["no tool_name", {}],
    ["an empty tool_name", { tool_name: "" }],
    ["a non-object tool_input", { tool_name: "Bash", tool_input: "ls" }],
    ["no tool_input", { tool_name: "Bash" }],
    ["no cwd", { tool_name: "Bash", cwd: undefined, tool_input: { command: "ls -la" } }],
  ])("does not throw on %s", async (_label, overrides) => {
    const malformed = { ...payload(), ...overrides } as Record<string, unknown>;
    await expect(runPreToolUse(malformed, { adapter: harmless })).resolves.not.toThrow();
  });
});

describe("probe questions", () => {
  // Every gate question answered well below any threshold, and both probes parked in the
  // middle of the `any` uncertainty rule's 0.40–0.60 band. If a probe answer ever reached
  // `evaluate`, that band is what would catch it, and the verdict would be `ask`.
  const withProbes = new MockAdapter({
    answers: {
      destructive: 0.01, secrets: 0.01, outside_repo: 0.01, egress: 0.01,
      prod: 0.01, sensitive_target: 0.01, unreviewed_execution: 0.01,
      outside_repo_v2: 0.5, home_dir_tool_cache: 0.5,
    },
  });

  /** Wraps an adapter and keeps the question names it was handed, in order. */
  function spyOn(inner: MockAdapter) {
    const asked: string[][] = [];
    return {
      asked,
      adapter: {
        name: "spy",
        decide: async (request: Parameters<MockAdapter["decide"]>[0]) => {
          asked.push(Object.keys(request.questions));
          return inner.decide(request);
        },
      },
    };
  }

  beforeEach(() => usePolicy("guard"));

  it("asks them in the same call as the gate questions", async () => {
    const spy = spyOn(withProbes);
    await runPreToolUse(payload(), { adapter: spy.adapter });

    expect(spy.asked).toHaveLength(1);
    expect(spy.asked[0]).toEqual([
      "destructive", "secrets", "outside_repo", "egress", "prod",
      "sensitive_target", "unreviewed_execution",
      "outside_repo_v2", "home_dir_tool_cache",
    ]);
  });

  // The whole guarantee, at the boundary that matters: an answer no rule can read.
  it("keeps them out of the verdict even when they land in the uncertainty band", async () => {
    const output = await runPreToolUse(payload(), { adapter: withProbes });

    expect(output?.hookSpecificOutput).toBeUndefined();
    const [record] = logLines();
    expect(record.verdict).toBe("allow");
    // Answered, not merely absent — otherwise this passes for the wrong reason.
    expect(record.probes.outside_repo_v2).toBe(0.5);
    expect(record.probes.home_dir_tool_cache).toBe(0.5);
  });

  it("logs them apart from the judgments rather than among them", async () => {
    await runPreToolUse(payload(), { adapter: withProbes });
    const [record] = logLines();

    expect(Object.keys(record.answers)).not.toContain("outside_repo_v2");
    expect(record.answers.destructive).toBe(0.01);
  });

  it("behaves exactly as before on a policy with no probes", async () => {
    writeFileSync(policyPath, POLICY.replace(/^mode: observe$/m, "mode: guard").replace(/\n  probe_questions:[\s\S]*$/, "\n"), "utf8");

    const spy = spyOn(withProbes);
    const output = await runPreToolUse(payload(), { adapter: spy.adapter });

    expect(spy.asked[0]).toEqual([
      "destructive", "secrets", "outside_repo", "egress", "prod",
      "sensitive_target", "unreviewed_execution",
    ]);
    expect(output?.hookSpecificOutput).toBeUndefined();
    // Absent, not empty: a policy without probes writes the record it always wrote.
    expect(logLines()[0]).not.toHaveProperty("probes");
  });
});
