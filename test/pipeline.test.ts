// The full-pipeline suite: payload in at one end of the built binary, decision out at the
// other.
//
// Review finding 10 in docs/adr-review-2026-09-18.md, in one line: good classifier scores
// are not safe gate behaviour. `bouncer calibrate` measures probabilities against
// fixtures/gate.jsonl, and cannot say anything at all about the two layers that answer
// without a probability — the fast path and the hard rules — because the adapter is never
// reached on either. Every other test in this directory imports src/ and stubs something.
// This one stubs nothing below the process boundary: it spawns bin/bouncer.cjs, writes a
// real PreToolUse payload to its stdin, and reads the emitted decision off its stdout and
// the source off the decision log the run actually wrote.
//
// The corpus is test/holdout/cases.jsonl and is frozen by checksum. See its header for what
// a case means and for what this suite is NOT evidence about — every judgment here is the
// mock backend's, so a judged expectation is a claim about routing and disposition, never
// about whether the answer was right.
//
// The suite is deliberately not generative. test/fastpath.test.ts already walks
// `gate.fast_path` entry by entry; a holdout that regenerated itself from the policy would
// move whenever the policy moved, which is the one thing a holdout must not do.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const BIN = "bin/bouncer.cjs";
const CASES = "test/holdout/cases.jsonl";
const FROZEN = "test/holdout/FROZEN";

interface Expectation {
  readonly emitted: string | null;
  readonly source: string | null;
  readonly reason: string | null;
  readonly logged: number;
}

interface Case {
  readonly id: string;
  readonly group: string;
  readonly risk?: "dangerous" | "safe";
  readonly tool?: string;
  readonly input: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly policy?: { readonly mode?: string; readonly on_error?: string };
  readonly env?: Record<string, string>;
  readonly expect: Expectation;
  readonly note: string;
}

function loadCases(): Case[] {
  const text = readFileSync(CASES, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.startsWith("//"))
    .map((line) => JSON.parse(line) as Case);
}

const cases = loadCases();

// One policy file per (mode, on_error) the corpus asks for, written from the shipped
// default so the suite tests what users get rather than a policy invented here. Only the
// two scalars are substituted; the fast path, the hard rules, the questions and the
// thresholds are policy/default.yaml's own.
const policies = new Map<string, string>();
let policyDir = "";

function policyFor(mode: string, onError: string): string {
  const key = `${mode}/${onError}`;
  const cached = policies.get(key);
  if (cached !== undefined) return cached;

  const source = readFileSync("policy/default.yaml", "utf8");
  const next = source
    .replace(/^mode: \w+$/m, `mode: ${mode}`)
    .replace(/^on_error: \w+$/m, `on_error: ${onError}`);

  // A silent no-op substitution would make every case in that mode test `observe` instead.
  expect(next, `policy/default.yaml no longer has a top-level mode: line`).toContain(`mode: ${mode}`);
  expect(next, `policy/default.yaml no longer has a top-level on_error: line`).toContain(`on_error: ${onError}`);

  const path = join(policyDir, `${mode}-${onError}.yaml`);
  writeFileSync(path, next);
  policies.set(key, path);
  return path;
}

interface Observed {
  readonly status: number | null;
  readonly emitted: string | null;
  readonly source: string | null;
  readonly reason: string | null;
  readonly logged: number;
  readonly stderr: string;
}

function drive(item: Case): Observed {
  // CLAUDE.md's rule, as code: anything driving the hook in bulk gets its own data
  // directory. `npm run bench` inherited the user's and left hundreds of mock verdicts in a
  // real decisions.jsonl, which `bouncer status` then reported as a 100% ask rate.
  const data = mkdtempSync(join(tmpdir(), "bouncer-holdout-"));

  const payload = JSON.stringify({
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/home/user/.claude/transcript.jsonl",
    cwd: "/home/user/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: item.tool ?? "Bash",
    tool_use_id: "toolu_00000000000000000000000000",
    tool_input: item.input,
    ...(item.payload ?? {}),
  });

  const run = spawnSync(process.execPath, [BIN, "pretooluse"], {
    input: payload,
    encoding: "utf8",
    env: {
      ...process.env,
      BOUNCER_BACKEND: "mock",
      CLAUDE_PLUGIN_ROOT: resolve("."),
      BOUNCER_POLICY: policyFor(item.policy?.mode ?? "full", item.policy?.on_error ?? "passthrough"),
      CLAUDE_PLUGIN_DATA: data,
      ...(item.env ?? {}),
    },
  });

  let emitted: string | null = null;
  if (run.stdout.trim().length > 0) {
    const output = JSON.parse(run.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    emitted = output.hookSpecificOutput?.permissionDecision ?? null;
  }

  const log = join(data, "decisions.jsonl");
  const lines = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter((line) => line.trim().length > 0)
    : [];
  const last = lines.length > 0 ? (JSON.parse(lines[lines.length - 1] as string) as Record<string, any>) : undefined;

  return {
    status: run.status,
    emitted,
    source: (last?.["source"] as string | undefined) ?? null,
    reason: (last?.["reason"]?.["kind"] as string | undefined) ?? null,
    logged: lines.length,
    stderr: run.stderr,
  };
}

beforeAll(() => {
  policyDir = mkdtempSync(join(tmpdir(), "bouncer-holdout-policy-"));
  mkdirSync(policyDir, { recursive: true });
});

describe("the frozen holdout", () => {
  // The freeze. A holdout that can be edited in the same pass that tunes the policy is a
  // second training set wearing a holdout's name, which is exactly what finding 10 warns
  // about: the fixture corpus is tuned against, repeatedly and correctly, and there has to
  // be one corpus that is not. Editing a case is fine; editing it without touching this
  // file is what fails.
  it("matches the checksum in test/holdout/FROZEN", () => {
    const digest = createHash("sha256").update(readFileSync(CASES)).digest("hex");
    const frozen = readFileSync(FROZEN, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))[0];

    expect(
      digest,
      `${CASES} changed. If that was deliberate, put this digest in ${FROZEN}:\n  ${digest}`,
    ).toBe(frozen);
  });

  it("is built", () => {
    expect(existsSync(BIN), `${BIN} missing — run \`npm run build\``).toBe(true);
  });

  it("has a unique id and a note on every case", () => {
    const ids = new Set<string>();
    for (const item of cases) {
      expect(ids.has(item.id), `duplicate id ${item.id}`).toBe(false);
      ids.add(item.id);
      expect(item.note.length, `${item.id} has no note`).toBeGreaterThan(20);
    }
  });

  // A corpus that drifted into one group would still pass every case and prove much less.
  it("covers every group and every layer that can decide", () => {
    const groups = new Set(cases.map((item) => item.group));
    expect([...groups].sort()).toEqual([
      "adversarial", "fast_path", "hard_rule", "host", "judged", "mode", "unresolved",
    ]);

    const sources = new Set(cases.map((item) => item.expect.source));
    expect(sources).toContain("fast_path");
    expect(sources).toContain("hard_rule");
    expect(sources).toContain("judge");
    expect(sources).toContain(null);

    const reasons = new Set(cases.map((item) => item.expect.reason));
    expect(reasons).toContain("truncated");
    expect(reasons).toContain("no-rule-matched");

    const modes = new Set(cases.map((item) => item.policy?.mode ?? "full"));
    expect([...modes].sort()).toEqual(["full", "guard", "observe", "seatbelt"]);
  });
});

describe("the built hook over the holdout", () => {
  it.each(cases.map((item) => [item.id, item] as const))("%s", (_id, item) => {
    const seen = drive(item);

    // The single most important property in the project, asserted on every case rather
    // than once: Claude Code reads exit 2 from PreToolUse as "block this tool call",
    // whatever is on stdout. See ADR-003 and test/cli.test.ts.
    expect(seen.status, `exit 2 blocks the tool call. stderr: ${seen.stderr}`).not.toBe(2);
    expect(seen.status, `stderr: ${seen.stderr}`).toBe(0);

    expect(
      { emitted: seen.emitted, source: seen.source, reason: seen.reason, logged: seen.logged },
      `${item.id}\n${item.note}`,
    ).toEqual(item.expect);
  });
});

// The report half of finding 10: "Report dangerous false accepts, safe-call friction,
// abstention/coverage, per-question counts and reliability, not just aggregate agreement."
//
// Asserted rather than printed. A number in a test output is read once; a number in an
// assertion has to be changed on purpose, and the diff says who changed it and why. Each of
// these is a property of the corpus's own expectations, so it moves only when a case moves —
// which the checksum has already made deliberate.
describe("what the holdout says about the gate", () => {
  const risky = cases.filter((item) => item.risk === "dangerous");
  const safe = cases.filter((item) => item.risk === "safe");

  // An accept is an emitted `allow`, which suppresses the host's own prompt. Emitting
  // nothing is not an accept: the host still decides, which is what every mode but `full`
  // does and what every error path does in any mode.
  const falseAccepts = risky.filter((item) => item.expect.emitted === "allow");
  const friction = safe.filter((item) => item.expect.emitted === "ask" || item.expect.emitted === "deny");

  it("counts every dangerous false accept, and names them", () => {
    expect(falseAccepts.map((item) => item.id).sort()).toEqual([
      // The classifier's misses, all four under the mock backend. Three are commands the
      // shipped questions' own criteria name explicitly, which is why they are in the
      // corpus: a pipeline suite that only asserted routing would report nothing here.
      "fast-path-git-status-verbose",
      "fast-path-git-status-very-verbose",
      "fast-path-ls-dollar-refused",
      "fast-path-ls-redirect-refused",
      "fast-path-npm-test-script-shell",
      "miss-echo-openai-key",
      "miss-terraform-auto-approve",
    ]);
  });

  // Every one of them reached the classifier. That is the load-bearing claim: the gate's
  // deterministic layers are not letting any of these through unjudged, so each is a
  // calibration problem with a name rather than a hole in the pipeline.
  it("has no dangerous false accept that skipped the classifier", () => {
    for (const item of falseAccepts) {
      expect(item.expect.source, `${item.id} was accepted without being judged`).toBe("judge");
    }
  });

  it("counts safe-call friction, and names it", () => {
    expect(friction.map((item) => item.id).sort()).toEqual([
      // Both are the mock's keyword heuristics firing, not the shipped questions: one on a
      // token inside `--force-with-lease`, one on a literal redaction marker in an echo.
      "adversarial-fake-redaction-marker",
      "hard-rule-force-with-lease-is-not-one",
    ]);
  });

  it("stops every dangerous call it is supposed to stop", () => {
    const stopped = risky.filter(
      (item) => item.expect.emitted === "ask" || item.expect.emitted === "deny",
    );
    // 23 stopped, 7 accepted, 2 abstained. The two abstentions are the truncated state
    // and the adapter failure, both labelled dangerous and both emitting nothing on
    // purpose: incomplete evidence hands the call back to the host rather than guessing
    // at it. An abstention is the safe outcome; an accept is the one that costs something.
    expect({ stopped: stopped.length, accepted: falseAccepts.length, total: risky.length }).toEqual({
      stopped: 24,
      accepted: 7,
      total: 33,
    });
  });

  it("abstains only where the evidence is incomplete, or where it never looked", () => {
    const abstained = cases.filter((item) => item.expect.emitted === null);
    for (const item of abstained) {
      const why =
        item.expect.reason === "truncated" ||
        item.expect.reason === "no-rule-matched" ||
        // An ungated tool or a skipped permission mode: no log line, because bouncer did no
        // work. It has no opinion to emit, so the host decides as if it were not installed.
        item.expect.logged === 0 ||
        (item.policy?.mode ?? "full") !== "full";
      expect(why, `${item.id} emits nothing in full mode with complete evidence`).toBe(true);
    }
  });

  // The other direction, and the one that was wrong until 2026-09-19. An emitted `allow`
  // suppresses the host's own prompt, so it has to come from something that decided: the
  // classifier, or the policy's own allowlist. `full` used to emit one for every call it
  // never looked at.
  it("never accepts a call that nothing decided", () => {
    const accepted = cases.filter((item) => item.expect.emitted === "allow");
    expect(accepted.length).toBeGreaterThan(0);
    for (const item of accepted) {
      expect(["judge", "fast_path"], `${item.id} was accepted with source ${String(item.expect.source)}`).toContain(
        item.expect.source,
      );
    }
  });
});
