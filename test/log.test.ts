import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { append, LOG_FILE, MAX_LOG_BYTES, tail, type DecisionRecord } from "../src/io/log.js";

const record = (tool: string): DecisionRecord => ({
  ts: "2026-09-18T00:00:00.000Z",
  tool,
  mode: "observe",
  backend: "mock",
  verdict: "allow",
  emitted: null,
  reason: { kind: "tool-not-gated", tool },
  latency_ms: { total: 1 },
});

describe("log rotation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bouncer-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends in place while the file is under the cap", () => {
    append(dir, record("Bash"));
    append(dir, record("Edit"));
    expect(existsSync(join(dir, `${LOG_FILE}.1`))).toBe(false);
    expect(tail(dir, 10).map((r) => r.tool)).toEqual(["Edit", "Bash"]);
  });

  it("rotates once the file reaches the cap, keeping exactly one previous generation", () => {
    const file = join(dir, LOG_FILE);
    writeFileSync(file, "x".repeat(MAX_LOG_BYTES));

    append(dir, record("Bash"));

    // The oversized file moved aside; the new file holds only the new record.
    expect(statSync(`${file}.1`).size).toBe(MAX_LOG_BYTES);
    expect(tail(dir, 10).map((r) => r.tool)).toEqual(["Bash"]);

    // A second rotation replaces the previous generation rather than stacking a `.2`.
    writeFileSync(file, "y".repeat(MAX_LOG_BYTES));
    append(dir, record("Write"));
    expect(readFileSync(`${file}.1`, "utf8").startsWith("y")).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(false);
    expect(tail(dir, 10).map((r) => r.tool)).toEqual(["Write"]);
  });
});

describe("the state on a logged line", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bouncer-log-state-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const logged = (command: string): string => {
    append(dir, { ...record("Bash"), state: JSON.stringify({ tool: "Bash", action: { command } }) });
    return tail(dir, 1)[0]?.state ?? "";
  };

  // Found in a real log: one line of 145 whose `state` would not parse. `append` redacts the
  // state a second time, and did it over the serialised JSON with patterns written for raw
  // text. `op://[^\s"']+` stops at a quote and not at the backslash escaping it, so on
  // `\"op://\"` it took the backslash and left the quote bare.
  const mustStayJson: ReadonlyArray<readonly [string, string]> = [
    ["a 1Password scheme in quotes, with no reference after it", 'git grep -n "op://" | cut -c1-170'],
    ["a quoted URL with credentials", 'curl "https://user:hunter2@example.com/x" -o "out file"'],
    ["a quoted assignment", 'env "API_KEY=abcdefghijklmnopqrstuvwxyz012345" ./run.sh'],
    ["a Windows path, which is all backslashes", 'type "C:\\Users\\me\\.env"'],
  ];

  it.each(mustStayJson)("is still JSON after redaction: %s", (_label, command) => {
    expect(() => JSON.parse(logged(command))).not.toThrow();
  });

  it("still redacts what it redacted before", () => {
    const state = logged('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" https://example.com');
    expect(state).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(JSON.parse(state).action.command).toContain("[REDACTED:bearer-token]");
  });

  it("leaves a state with nothing to redact byte for byte as it was built", () => {
    // Runs and logs are compared as strings; a rewrite that reordered keys would show up
    // as a difference that is not one.
    const built = JSON.stringify({ tool: "Bash", action: { command: "npm test", n: 1.5, ok: true, none: null } });
    append(dir, { ...record("Bash"), state: built });
    expect(tail(dir, 1)[0]?.state).toBe(built);
  });

  it("still redacts a state that is not JSON at all, as text", () => {
    append(dir, { ...record("Bash"), state: "token ghp_abcdefghijklmnopqrstuvwxyz0123 in plain text" });
    expect(tail(dir, 1)[0]?.state).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });
});
