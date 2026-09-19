import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as breaker from "../src/io/breaker.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bouncer-breaker-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One failing gated call, as the hook makes it: read, check, record, write. */
function fail(sessionId: string): { tripped: boolean; message?: string } {
  const state = breaker.read(dir, sessionId);
  const status = breaker.check(state);
  if (status.tripped) return { tripped: true };

  const next = breaker.record(state, { failed: true, overBudget: false, warmup: status.warmup });
  breaker.write(dir, next.state);
  return { tripped: next.state.tripped !== undefined, ...(next.message !== undefined ? { message: next.message } : {}) };
}

describe("two sessions sharing one data directory", () => {
  // The data directory is one per machine, so two windows share it whatever repositories
  // they are in. The file used to hold one record: each session found the other's, started
  // fresh, and a fresh session's first call is the uncounted warm-up. Every call was a
  // warm-up, the count went back as zero, and the classifier could stay down all day.
  it("trips each of them, however their calls interleave", () => {
    const tripped = { a: false, b: false };
    for (let i = 0; i <= breaker.FAILURE_LIMIT; i++) {
      tripped.a = fail("session-a").tripped;
      tripped.b = fail("session-b").tripped;
    }
    expect(tripped).toEqual({ a: true, b: true });
  });

  it("counts each session's failures apart from the other's", () => {
    for (let i = 0; i < 3; i++) fail("session-a");
    fail("session-b");

    // The warm-up is not counted, so three calls are two failures and one call is none.
    expect(breaker.read(dir, "session-a").consecutive_failures).toBe(2);
    expect(breaker.read(dir, "session-b").consecutive_failures).toBe(0);
  });

  it("says it is standing down once per session, not once per machine", () => {
    const messages: string[] = [];
    for (let i = 0; i <= breaker.FAILURE_LIMIT + 2; i++) {
      for (const id of ["session-a", "session-b"]) {
        const { message } = fail(id);
        if (message !== undefined) messages.push(id);
      }
    }
    expect(messages.sort()).toEqual(["session-a", "session-b"]);
  });

  it("keeps a once-per-session notice shown when another session writes in between", () => {
    breaker.write(dir, breaker.markNotified(breaker.read(dir, "session-a"), "broken-policy"));
    breaker.write(dir, breaker.markNotified(breaker.read(dir, "session-b"), "broken-policy"));

    expect(breaker.shouldNotify(breaker.read(dir, "session-a"), "broken-policy")).toBe(false);
    expect(breaker.shouldNotify(breaker.read(dir, "session-c"), "broken-policy")).toBe(true);
  });

  it("starts a session it has not seen clean", () => {
    for (let i = 0; i <= breaker.FAILURE_LIMIT; i++) fail("session-a");
    expect(breaker.check(breaker.read(dir, "session-a")).tripped).toBe(true);
    expect(breaker.check(breaker.read(dir, "session-b"))).toEqual({ tripped: false, warmup: true });
  });
});

describe("the breaker file", () => {
  it("remembers a bounded number of sessions and drops the one written longest ago", () => {
    for (let i = 0; i < breaker.MAX_SESSIONS + 3; i++) fail(`session-${i}`);

    const ids = breaker.readAll(dir).map((s) => s.session_id);
    expect(ids).toHaveLength(breaker.MAX_SESSIONS);
    expect(ids).not.toContain("session-0");
    expect(ids.at(-1)).toBe(`session-${breaker.MAX_SESSIONS + 2}`);
  });

  it("keeps a session that is still calling, by moving it to the end", () => {
    fail("busy");
    for (let i = 0; i < breaker.MAX_SESSIONS - 1; i++) fail(`other-${i}`);
    fail("busy");
    fail("one-more");

    const ids = breaker.readAll(dir).map((s) => s.session_id);
    expect(ids).toContain("busy");
    expect(ids).not.toContain("other-0");
  });

  // What every build before this one wrote. It is one session's state and has to read as it.
  it("reads the single record an older build left behind", () => {
    const old = { session_id: "session-a", warmed: true, consecutive_failures: 4, consecutive_slow: 0 };
    writeFileSync(join(dir, breaker.BREAKER_FILE), JSON.stringify(old), "utf8");

    expect(breaker.read(dir, "session-a").consecutive_failures).toBe(4);
    expect(fail("session-a").tripped).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, breaker.BREAKER_FILE), "utf8"))).toHaveProperty("sessions");
  });

  it.each([
    ["no file", undefined],
    ["half a file", '{"sessions":[{"session_id":"a"'],
    ["a file that is not a breaker", '"hello"'],
    ["a list holding things that are not sessions", '{"sessions":[1,null,{"warmed":true}]}'],
  ])("treats %s as nothing remembered", (_name, contents) => {
    if (contents !== undefined) writeFileSync(join(dir, breaker.BREAKER_FILE), contents, "utf8");
    expect(breaker.readAll(dir)).toEqual([]);
    expect(breaker.check(breaker.read(dir, "session-a"))).toEqual({ tripped: false, warmup: true });
  });

  it("leaves no temporary file behind", () => {
    for (let i = 0; i < 5; i++) fail("session-a");
    expect(readdirSync(dir)).toEqual([breaker.BREAKER_FILE]);
  });

  it("does not throw when the directory cannot be written", () => {
    const blocked = join(dir, "a-file");
    writeFileSync(blocked, "", "utf8");
    expect(() => breaker.write(join(blocked, "under-a-file"), breaker.read(dir, "session-a"))).not.toThrow();
  });
});
