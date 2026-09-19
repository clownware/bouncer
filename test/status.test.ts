// `bouncer status` is read by someone deciding whether to turn enforcement on, and the
// line they act on is "switching to guard would have added N prompts". Everything here is
// about keeping that number honest.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { status } from "../src/commands/status.js";
import * as breaker from "../src/io/breaker.js";
import { LOG_FILE, type DecisionRecord } from "../src/io/log.js";

let dir: string;
let policyPath: string;

const POLICY = readFileSync("policy/default.yaml", "utf8");

const record = (backend: string, verdict: NonNullable<DecisionRecord["verdict"]>): DecisionRecord => ({
  ts: "2026-09-19T01:59:00.000Z",
  tool: "Bash",
  mode: "observe",
  backend,
  verdict,
  emitted: null,
  reason: { kind: "rule", ruleIndex: 0, question: "destructive", p: 0.92 },
  source: "judge",
  answers: { destructive: 0.92 },
  latency_ms: { total: 40, adapter: 0 },
});

const seed = (records: readonly DecisionRecord[]) =>
  writeFileSync(join(dir, LOG_FILE), records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bouncer-status-"));
  policyPath = join(dir, "policy.yaml");
  writeFileSync(policyPath, POLICY, "utf8");
  process.env["CLAUDE_PLUGIN_DATA"] = dir;
  process.env["BOUNCER_POLICY"] = policyPath;
});

afterEach(() => {
  delete process.env["CLAUDE_PLUGIN_DATA"];
  delete process.env["BOUNCER_POLICY"];
  rmSync(dir, { recursive: true, force: true });
});

describe("classifier latency", () => {
  // The user waited for the first call of the session too. Leaving it out made sense while
  // it was believed to be the only cold one; from the hook, every call is.
  it("counts the first call of a session along with the rest", () => {
    const timed = (adapter: number, warmup = false): DecisionRecord => ({
      ...record("jev", "allow"),
      latency_ms: { total: adapter + 5, adapter },
      ...(warmup ? { warmup: true } : {}),
    });
    seed([timed(900, true), timed(400), timed(400)]);

    expect(status()).toContain("Classifier latency over 3 calls: p50 400ms, p95 900ms");
  });
});

describe("lines that concluded nothing", () => {
  const failed = (verdict?: "allow"): DecisionRecord => {
    const { verdict: _verdict, source: _source, answers: _answers, ...rest } = record("jev", "allow");
    return {
      ...rest,
      ...(verdict !== undefined ? { verdict } : {}),
      reason: { kind: "no-rule-matched" },
      error: { kind: "timeout", message: "no answer within 800ms" },
    };
  };

  // Under a heading someone reads to decide whether the allow side can be trusted, a
  // timeout was counted as an allow. Old lines say `allow` and new ones say nothing; both
  // are told by their error.
  it("does not count a classifier failure as an allow, old line or new", () => {
    seed([record("jev", "allow"), failed("allow"), failed()]);

    const out = status();
    expect(out).toMatch(/allow +1\n/);
    expect(out).toContain("2 more concluded nothing");
    expect(out).toContain("2 errors; most recent: timeout");
  });

  // A truncated call carries `ask` so a careless reader lands on the safe side, and emits
  // nothing in any mode. This is the reader that must not be careless.
  it("does not project a prompt for a call guard would have emitted nothing on", () => {
    const truncated: DecisionRecord = { ...record("jev", "ask"), reason: { kind: "truncated" }, truncated: true };
    seed([record("jev", "ask"), truncated, failed()]);

    expect(status()).toContain("would have added 1 prompt across");
  });
});

describe("a tripped breaker", () => {
  // This line could never print. `status` runs outside any session, so it asked the breaker
  // for the session named "" and was handed a fresh one every time.
  it("says which session is standing down, and since when", () => {
    const state = breaker.read(dir, "0f3c2a91-aaaa-bbbb-cccc-000000000000");
    breaker.write(dir, { ...state, tripped: { reason: "failures", at: "2026-09-19T04:00:00.000Z" } });
    breaker.write(dir, breaker.read(dir, "a-healthy-session"));

    const out = status();
    expect(out).toContain("STANDING DOWN in session 0f3c2a91 (failures since 2026-09-19T04:00:00.000Z).");
    expect(out).not.toContain("a-health");
  });

  it("says nothing when no session has tripped", () => {
    breaker.write(dir, breaker.read(dir, "a-healthy-session"));
    expect(status()).not.toContain("STANDING DOWN");
  });
});

describe("mock-backend records", () => {
  // The bench wrote seventy of these into a real log, and status reported them as a 100%
  // ask rate with a sub-millisecond classifier. The mock scores from fixed keyword
  // heuristics, so its verdicts are evidence about a keyword matcher, not about jev.
  it("are left out of the counts and the guard projection, and said so", () => {
    seed([...Array.from({ length: 7 }, () => record("mock", "ask")), record("jev", "allow")]);

    const out = status();
    expect(out).toContain("Last 1 decisions:");
    expect(out).toContain("Switching to guard would have added 0 prompts across these 1 calls.");
    expect(out).toContain("Ignoring 7 records answered by the mock backend");
  });

  it("do not leave a real log looking empty without saying why", () => {
    seed(Array.from({ length: 3 }, () => record("mock", "ask")));

    const out = status();
    expect(out).toContain("No decisions logged yet.");
    expect(out).toContain("Ignoring 3 records answered by the mock backend");
    expect(out).not.toContain("Switching to guard");
  });

  // Someone who configured the mock has no other history, and summarising nothing would be
  // worse than summarising the stand-in they chose.
  it("are counted when the policy itself names mock as its backend", () => {
    writeFileSync(policyPath, POLICY.replace(/^backend: .*$/m, "backend: mock"), "utf8");
    seed(Array.from({ length: 3 }, () => record("mock", "ask")));

    const out = status();
    expect(out).toContain("Last 3 decisions:");
    expect(out).toContain("Switching to guard would have added 3 prompts across these 3 calls.");
    expect(out).not.toContain("Ignoring");
  });

  it("leaves an unpolluted log summarised exactly as before", () => {
    seed([record("jev", "ask"), record("jev", "allow")]);

    const out = status();
    expect(out).toContain("Last 2 decisions:");
    expect(out).toContain("Switching to guard would have added 1 prompt across these 2 calls.");
    expect(out).not.toContain("Ignoring");
  });
});
