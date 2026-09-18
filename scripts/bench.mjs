// Measures cold-start overhead of the hook binary: process spawn, bundle parse,
// policy load, and the synchronous decision path with the mock adapter.
//
// This is the number the whole "TypeScript bundled to one file" bet rests on.
// CI asserts it stays under BUDGET_MS. If it regresses, the fix is almost always
// a new dependency pulled into the bundle, not the decision code itself.
//
//   node scripts/bench.mjs [--budget 80] [--runs 30]
//
// A p95 is only as good as the sample behind it: at 20 runs it rests on one observation.
// Keep --runs high enough that the tail means something.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const BUDGET_MS = arg("budget", 80);
const RUNS = arg("runs", 30);
const WARMUP = 5;
const BIN = "bin/bouncer.cjs";

if (!existsSync(BIN)) {
  console.error(`${BIN} not found — run \`npm run build\` first.`);
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

function once() {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [BIN, "pretooluse"], {
    input: payload,
    env: { ...process.env, BOUNCER_BACKEND: "mock" },
  });
  const end = process.hrtime.bigint();
  if (r.status !== 0) {
    throw new Error(`hook exited ${r.status}: ${r.stderr?.toString() ?? ""}`);
  }
  return Number(end - start) / 1e6;
}

for (let i = 0; i < WARMUP; i++) once();

const samples = Array.from({ length: RUNS }, once).sort((a, b) => a - b);
// Nearest-rank percentile: index ceil(p * n) - 1. The obvious `floor(n * p)` is off by
// one whenever n * p is a whole number, and at p=0.95 with 20 runs that lands on index 19
// of 20 — the maximum. That made the CI gate a max-latency gate, which one scheduling
// hiccup on a shared runner is enough to trip, and is why it had to be loosened to 150 ms
// to be survivable at all.
const pct = (p) => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * p) - 1))];
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

console.log(`runs=${RUNS}  mean=${mean.toFixed(1)}ms  p50=${pct(0.5).toFixed(1)}ms  p95=${pct(0.95).toFixed(1)}ms  budget=${BUDGET_MS}ms`);

if (pct(0.95) > BUDGET_MS) {
  console.error(`FAIL: p95 ${pct(0.95).toFixed(1)}ms exceeds budget ${BUDGET_MS}ms`);
  process.exit(1);
}
