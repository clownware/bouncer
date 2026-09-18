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
