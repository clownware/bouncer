// Measures cold-start overhead of the hook binary: process spawn, bundle parse,
// policy load, and the synchronous decision path with the mock adapter.
//
// This is the number the whole "TypeScript bundled to one file" bet rests on.
// CI asserts it stays under BUDGET_MS. If it regresses, the fix is almost always
// a new dependency pulled into the bundle, not the decision code itself.
//
//   node scripts/bench.mjs [--budget 80] [--runs 30]
//   node scripts/bench.mjs --against <other-bundle.cjs> [--runs 40]
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

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const BUDGET_MS = arg("budget", 80);
const RUNS = arg("runs", 30);
const AGAINST = flag("against");
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

const payload = JSON.stringify({
  session_id: "bench",
  transcript_path: "/dev/null",
  cwd: process.cwd(),
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: "toolu_bench",
  tool_input: { command: "git push --force origin main", description: "bench" },
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function once(bin = BIN) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [bin, "pretooluse"], {
    input: payload,
    env: { ...process.env, BOUNCER_BACKEND: "mock", CLAUDE_PLUGIN_ROOT: ROOT },
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
  for (let i = 0; i < WARMUP; i++) {
    once(AGAINST);
    once(BIN);
  }

  const before = [];
  const after = [];
  for (let i = 0; i < RUNS; i++) {
    before.push(once(AGAINST));
    after.push(once(BIN));
  }

  const diffs = after.map((x, i) => x - before[i]).sort((a, b) => a - b);
  const median = pctOf(diffs, 0.5);

  console.log(line(`before  ${AGAINST}`, summarise(before)));
  console.log(line(`after   ${BIN}`, summarise(after)));
  console.log(
    `paired median diff ${median >= 0 ? "+" : ""}${median.toFixed(1)}ms  ` +
      `over ${RUNS} pairs  [range ${diffs[0].toFixed(1)} to ${diffs[diffs.length - 1].toFixed(1)}]`,
  );
  // Deliberately no pass/fail. Whether a real difference is acceptable is a judgement
  // about what it bought; the budget gate above is where a number becomes a rule.
  process.exit(0);
}

for (let i = 0; i < WARMUP; i++) once();

const samples = Array.from({ length: RUNS }, () => once());
const stats = summarise(samples);

console.log(
  `runs=${RUNS}  mean=${stats.mean.toFixed(1)}ms  p50=${stats.p50.toFixed(1)}ms  ` +
    `p95=${stats.p95.toFixed(1)}ms  budget=${BUDGET_MS}ms`,
);

if (stats.p95 > BUDGET_MS) {
  console.error(`FAIL: p95 ${stats.p95.toFixed(1)}ms exceeds budget ${BUDGET_MS}ms`);
  process.exit(1);
}
