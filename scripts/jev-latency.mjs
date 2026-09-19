#!/usr/bin/env node
// Live Jev round-trip check: does the 70–500 ms adapter budget (PRD §latency) hold on
// this network for one fan-out of five noul questions over a realistic PreToolUse state?
//
//   TYPESAFE_API_KEY=... node scripts/jev-latency.mjs [--runs 5]
//
// Reads the key from BOUNCER_TYPESAFE_API_KEY or TYPESAFE_API_KEY. Never prints it.
//
// Read the FIRST number, not the summary. Every call after the first reuses the connection
// Node kept open, and the hook never can: it is a new process per tool call, so each one
// opens a socket and finishes TLS before it sends anything. The runs below the first measure
// the model and the network; the first measures what a user waits for. Quoting the p50 from
// here as the hook's latency is how "~190 ms steady state" got into ADR-003 and the README
// when an installed plugin's own log says 437 ms. `latency_ms.adapter` in a real
// decisions.jsonl is the honest source; this script is for checking the API still answers.
// This is a manual, local-only script. It is not run in CI and must never be.

const key = process.env.BOUNCER_TYPESAFE_API_KEY ?? process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error("no TYPESAFE_API_KEY in env");
  process.exit(1);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const RUNS = arg("runs", 5);
const URL = "https://api.typesafe.ai/v1/systemone";

// Dense state, the shape the state builder will emit. No file contents, no env.
const state = [
  "event: PreToolUse",
  "tool: Bash",
  "cwd: bouncer",
  "branch: claude/bouncer-v01-plan-vccvx9",
  "permission_mode: acceptEdits",
  "command: git push --force origin main",
  "description: push rebased branch",
].join("\n");

const noul = (instructions, t, f) => ({ type: "noul", instructions, criteria: { true: t, false: f } });

const questions = {
  destructive: noul(
    "The command permanently deletes or overwrites data or history.",
    "rm -rf, git push --force, git reset --hard, DROP TABLE, truncating files",
    "read-only commands, creating new files, additive git operations",
  ),
  git_history_rewrite: noul(
    "The command rewrites shared git history.",
    "force push, rebase of a pushed branch, amend of a pushed commit",
    "commits, fetches, merges, pushes without --force",
  ),
  network_egress: noul(
    "The command sends data to a remote host.",
    "curl POST, scp, git push, npm publish",
    "local-only commands, git fetch, reads",
  ),
  secrets: noul(
    "The command reads, prints, or transmits a credential, token, key, or password.",
    "cat .env, echo $API_KEY, printing a private key",
    "commands that mention the word secret without exposing a value",
  ),
  prod_target: noul(
    "The command targets a production system or the main branch.",
    "main, master, prod, production, live",
    "feature branches, staging, local scratch",
  ),
};

const body = JSON.stringify({ model: "jev-latest", state, questions });

async function once() {
  const t0 = process.hrtime.bigint();
  const res = await fetch(URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, status: res.status, text };
}

const warm = await once();
if (warm.status !== 200) {
  console.error(`HTTP ${warm.status} on warm-up:\n${warm.text.slice(0, 1500)}`);
  process.exit(1);
}
console.log(`cold connection, which is every call the hook makes: ${warm.ms.toFixed(0)}ms`);

const samples = [];
for (let i = 0; i < RUNS; i++) {
  const r = await once();
  if (r.status !== 200) {
    console.error(`HTTP ${r.status} on run ${i + 1}: ${r.text.slice(0, 500)}`);
    process.exit(1);
  }
  samples.push(r.ms);
  console.log(`run ${i + 1}: ${r.ms.toFixed(0)}ms`);
  if (i === RUNS - 1) console.log("\nlast response:\n" + JSON.stringify(JSON.parse(r.text), null, 2));
}

const sorted = [...samples].sort((a, b) => a - b);
console.log(`\nruns=${RUNS}  min=${sorted[0].toFixed(0)}ms  p50=${sorted[Math.floor(RUNS / 2)].toFixed(0)}ms  max=${sorted[RUNS - 1].toFixed(0)}ms  (kept-alive connection — not the hook's latency)`);
