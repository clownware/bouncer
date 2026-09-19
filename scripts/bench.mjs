// Measures cold-start overhead of the hook binary: process spawn, bundle parse,
// policy load, and the synchronous decision path with the mock adapter.
//
// This is the number the whole "TypeScript bundled to one file" bet rests on. If it
// regresses, the fix is almost always a new dependency pulled into the bundle, not the
// decision code itself.
//
// Both paths are measured: a command the classifier judges, and one a hard rule stops
// before the adapter. Each gets its own line, printed beside the 80 ms design target.
//
// The target is printed and not enforced, because an absolute number measures the machine
// as much as the code (#73). On unchanged code it read p95 34 to 38 ms on an M4 laptop,
// 102.0 ms on an agent container and 151.3 ms on a CI runner: loose enough on the first
// that the hook could double and pass, and failing on the other two before anyone had
// changed anything. Passing `--budget` explicitly turns it back into a gate, for whoever
// knows the machine they are standing on. The gate that fails a change is the paired one,
// `--against` with `--max-regression-pct`, below.
//
// The policy is compiled once and cached on disk (ADR-007), and the warm-up runs populate
// that cache, so what is measured here is what a user experiences on every call after their
// first. To measure the YAML parse instead, run with BOUNCER_NO_CACHE=1.
//
//   node scripts/bench.mjs [--runs 30]                  prints, exits 0
//   node scripts/bench.mjs --budget 80 [--runs 30]      fails when a p95 exceeds it
//   node scripts/bench.mjs --against <other-bundle.cjs> [--runs 40]
//   node scripts/bench.mjs --against <other-bundle.cjs> --max-regression-pct 15
//
// A p95 is only as good as the sample behind it: at 20 runs it rests on one observation.
// Keep --runs high enough that the tail means something.
//
// `--against` answers a different question, and it is the one asked after every change:
// did *this diff* cost anything? A single-arm number cannot answer it. Two runs minutes
// apart on the same machine differ by more than most regressions worth finding — CI has
// reported p50 45.9 ms and 64.1 ms for the same hook path on different days, and 60.9 ms
// against 122.3 ms at p95 for a byte-identical bundle nineteen seconds apart. So comparing
// a fresh number against a remembered one measures the machine, not the diff.
//
// `--against` interleaves the two bundles, A B A B, and reports the median of the per-pair
// differences. Each pair ran under the same conditions, so drift lands in both arms and
// cancels; what survives is the change. The per-arm spread is printed alongside, because a
// paired median is only readable next to the noise it had to beat. To compare against a
// commit rather than a file:
//
//   git show <ref>:bin/bouncer.cjs > /tmp/before.cjs
//   node scripts/bench.mjs --against /tmp/before.cjs
//
// Both arms run with CLAUDE_PLUGIN_ROOT pinned to this checkout, and that is not a
// convenience. `pluginRoot()` falls back to `dirname(argv[1])/..` and checks it for
// `policy/default.yaml`, so a bundle run from /tmp finds no policy and takes the
// no-policy path — skipping the load and the decision this script exists to measure.
// It comes back about 20 ms faster on a checkout measured at 65 ms, which reads as a
// large win for whichever arm happened to be the copy. Pinning the root puts both arms
// on the same code path, which is the only way the difference means anything.
//
// Each arm gets its own data directory, for the same reason and against a subtler trap.
// The compiled policy is cached on disk under a key that includes `CACHE_VERSION`
// (docs/adr/007), so two bundles that disagree about that number evict each other's entry
// on every call: both arms then re-parse the whole policy every time, both read about 32 ms
// slower, and the difference being reported is the cold parse rather than the path a user
// pays. That is not hypothetical — it is what made `8384ad0` against `b213fe7` read +4.4 ms
// when the same pair, each with its own cache, reads +1.1 ms. So the versions are printed
// in the header and a mismatch says so out loud.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const TARGET_MS = 80;
const BUDGET_MS = arg("budget", undefined);
const RUNS = arg("runs", 30);
const AGAINST = flag("against");
// No default, here or anywhere in this file. How much slower a change may make the hook is
// a threshold, and the caller owns it: CI's lives in the workflow, beside the step.
const MAX_REGRESSION_PCT = arg("max-regression-pct", undefined);
const WARMUP = 5;
const BIN = "bin/bouncer.cjs";

if (!existsSync(BIN)) {
  console.error(`${BIN} not found — run \`npm run build\` first.`);
  process.exit(1);
}

if (AGAINST !== undefined && !existsSync(AGAINST)) {
  console.error(`${AGAINST} not found.`);
  process.exit(1);
}

// A gate that was asked for and cannot be evaluated has to fail rather than pass. `NaN`
// compares false against everything, so `--budget` with its value missing would otherwise
// be a gate that nothing can trip.
for (const [name, value] of [["budget", BUDGET_MS], ["runs", RUNS], ["max-regression-pct", MAX_REGRESSION_PCT]]) {
  if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
    console.error(`--${name} needs a positive number.`);
    process.exit(1);
  }
}

if (MAX_REGRESSION_PCT !== undefined && AGAINST === undefined) {
  console.error("--max-regression-pct compares two bundles, so it needs --against <bundle>.");
  process.exit(1);
}

// Two cases, because there are now two paths through the hook and no single command can
// measure both. A judged command pays the policy load, the state build and the adapter
// round trip; a hard-rule hit pays the policy load, the matcher and the state build, and
// skips the adapter entirely. The budget applies to each — the hard-rule path is not
// obviously the cheaper one, since what it saves on the mock adapter it spends tokenizing
// and labelling the command.
//
// `git push --force origin main` was this script's only payload until `gate.hard_rules`
// landed, at which point it stopped reaching the classifier at all and the gate quietly
// stopped measuring the path it was written for. Dropping `--force` is enough to restore
// it: the hard rule matches on exact tokens, and `git push` is not on the fast path.
const CASES = [
  { name: "judged   ", command: "git push origin feature/bench" },
  { name: "hard-rule", command: "git push --force origin main" },
];

const payloadFor = (command) =>
  JSON.stringify({
    session_id: "bench",
    transcript_path: "/dev/null",
    cwd: process.cwd(),
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_bench",
    tool_input: { command, description: "bench" },
  });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A scratch data directory, thrown away when the run ends.
//
// Not a convenience: without it the hook falls back to ~/.bouncer, and every spawn below
// appends a decision line to the user's real log. A bench run is a few hundred spawns of
// one hardcoded payload answered by the mock adapter, so what it leaves behind is a log
// that says bouncer judged `git push --force origin main` several hundred times and asked
// every time. `bouncer status` then summarises that as the user's own traffic, and the
// "switching to guard would have added N prompts" line — the one number someone reads
// before turning enforcement on — is fed entirely by this script. The same file is what
// `calibrate --from` re-scores and what ADR-006's offline replay is meant to read.
//
// Fresh per run rather than a fixed path, so two benches never share a breaker state, and
// so the policy cache starts cold. The warm-up spawns populate that cache before any
// sample is taken, which is what ADR-007 says the number should be measured against.
const dataFor = (() => {
  const dirs = new Map();
  return (bin) => {
    let dir = dirs.get(bin);
    if (dir === undefined) {
      dir = mkdtempSync(join(tmpdir(), "bouncer-bench-"));
      dirs.set(bin, dir);
      process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    }
    return dir;
  };
})();

/**
 * The cache version a bundle was built with, read out of its text.
 *
 * Crude on purpose: the point is to compare two files on disk, and one of them is usually
 * an old commit's bundle that cannot be asked. `undefined` means the bundle predates the
 * cache or spells the constant some other way, which is itself worth printing.
 */
function cacheVersionOf(bin) {
  try {
    return /CACHE_VERSION = (\d+)/.exec(readFileSync(bin, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

// The shipped policy, unless one is named. Left to resolve, the hook prefers the
// developer's own ~/.bouncer/bouncer.yaml, so the printed number would be for whatever
// policy and mode this machine's owner happens to run, under a label that does not say so.
const POLICY = process.env.BOUNCER_POLICY ?? join(ROOT, "policy", "default.yaml");

function once(command, bin = BIN) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [bin, "pretooluse"], {
    input: payloadFor(command),
    env: {
      ...process.env,
      BOUNCER_BACKEND: "mock",
      BOUNCER_POLICY: POLICY,
      CLAUDE_PLUGIN_ROOT: ROOT,
      CLAUDE_PLUGIN_DATA: dataFor(bin),
    },
  });
  const end = process.hrtime.bigint();
  if (r.status !== 0) {
    throw new Error(`${bin} exited ${r.status}: ${r.stderr?.toString() ?? ""}`);
  }
  return Number(end - start) / 1e6;
}

// Nearest-rank percentile: index ceil(p * n) - 1. The obvious `floor(n * p)` is off by
// one whenever n * p is a whole number, and at p=0.95 with 20 runs that lands on index 19
// of 20 — the maximum. That made the CI gate a max-latency gate, which one scheduling
// hiccup on a shared runner is enough to trip, and is why it had to be loosened to 150 ms
// to be survivable at all.
const pctOf = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];

function summarise(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / s.length);
  return { p50: pctOf(s, 0.5), p95: pctOf(s, 0.95), mean, sd, iqr: pctOf(s, 0.75) - pctOf(s, 0.25) };
}

const line = (label, s) =>
  `${label}  p50=${s.p50.toFixed(1)}ms  p95=${s.p95.toFixed(1)}ms  mean=${s.mean.toFixed(1)}ms  ` +
  `[sd=${s.sd.toFixed(1)}ms iqr=${s.iqr.toFixed(1)}ms]`;

if (AGAINST !== undefined) {
  const beforeVersion = cacheVersionOf(AGAINST);
  const afterVersion = cacheVersionOf(BIN);
  console.log(
    `policy cache version: before=${beforeVersion ?? "?"}  after=${afterVersion ?? "?"}  ` +
      `(one data directory per arm, so each runs warm)`,
  );
  if (beforeVersion !== afterVersion) {
    console.log(
      `  note: the two bundles compile to different cache entries. They share no cached policy,\n` +
        `  which is why each arm gets its own data directory. A single shared one would make\n` +
        `  every call in both arms a cache miss and report the cold parse as the difference.`,
    );
  }
  console.log("");

  let regressed = false;

  for (const { name, command } of CASES) {
    for (let i = 0; i < WARMUP; i++) {
      once(command, AGAINST);
      once(command, BIN);
    }

    const before = [];
    const after = [];
    for (let i = 0; i < RUNS; i++) {
      before.push(once(command, AGAINST));
      after.push(once(command, BIN));
    }

    const diffs = after.map((x, i) => x - before[i]).sort((a, b) => a - b);
    const median = pctOf(diffs, 0.5);

    console.log(`${name}  ${command}`);
    console.log(line(`  before  ${AGAINST}`, summarise(before)));
    console.log(line(`  after   ${BIN}`, summarise(after)));
    console.log(
      `  paired median diff ${median >= 0 ? "+" : ""}${median.toFixed(1)}ms  ` +
        `over ${RUNS} pairs  [range ${diffs[0].toFixed(1)} to ${diffs[diffs.length - 1].toFixed(1)}]`,
    );

    // The paired median as a share of the before arm's own median, so the margin means the
    // same thing on a 35 ms laptop and a 60 ms runner. Both halves are medians: a tail is
    // what a shared runner's scheduler produces, and a gate resting on one fails on
    // unchanged code, which is the defect this replaced.
    if (MAX_REGRESSION_PCT !== undefined) {
      const pct = (median / summarise(before).p50) * 100;
      console.log(`  ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% of the before median  (limit +${MAX_REGRESSION_PCT}%)`);
      if (pct > MAX_REGRESSION_PCT) {
        console.error(
          `FAIL: ${command} is ${pct.toFixed(1)}% slower than ${AGAINST}, over the ${MAX_REGRESSION_PCT}% limit`,
        );
        regressed = true;
      }
    }
  }
  // Without a limit there is deliberately no pass/fail. Whether a real difference is
  // acceptable is a judgement about what it bought; the caller who passes a limit has made it.
  process.exit(regressed ? 1 : 0);
}

let failed = false;

for (const { name, command } of CASES) {
  for (let i = 0; i < WARMUP; i++) once(command);

  const samples = Array.from({ length: RUNS }, () => once(command));
  const stats = summarise(samples);

  console.log(
    `${name}  runs=${RUNS}  mean=${stats.mean.toFixed(1)}ms  p50=${stats.p50.toFixed(1)}ms  ` +
      `p95=${stats.p95.toFixed(1)}ms  ` +
      (BUDGET_MS === undefined ? `target=${TARGET_MS}ms (not enforced)` : `budget=${BUDGET_MS}ms`),
  );

  if (BUDGET_MS !== undefined && stats.p95 > BUDGET_MS) {
    console.error(`FAIL: ${command} p95 ${stats.p95.toFixed(1)}ms exceeds budget ${BUDGET_MS}ms`);
    failed = true;
  }
}

if (failed) process.exit(1);
