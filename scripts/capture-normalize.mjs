#!/usr/bin/env node
// Turns raw captures from scripts/capture-hook.mjs into committable fixtures.
//
// Raw captures contain real absolute paths, a real username, real session ids, and
// whatever command text you happened to run. None of that belongs in git. This
// rewrites the machine-specific parts to stable placeholders and drops anything
// that still looks like a secret, then writes one fixture per distinct tool_name.
//
//   node scripts/capture-normalize.mjs [--in ~/.bouncer-capture] [--out test/fixtures/payloads]
//
// Read the output before committing it. This is a convenience, not a guarantee.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const inDir = arg("in", join(homedir(), ".bouncer-capture"));
const outDir = arg("out", join("test", "fixtures", "payloads"));

if (!existsSync(inDir)) {
  console.error(`No capture directory at ${inDir}. See scripts/CAPTURE.md.`);
  process.exit(1);
}

const USER = userInfo().username;
const HOME = homedir();

// Shapes worth refusing to commit even after path scrubbing. Same list the runtime
// redactor will need; kept duplicated on purpose so this script has no src/ import
// and can be run before the engine exists.
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  /op:\/\/[^\s"']+/g,
];

// Session ids show up inside paths (scratchpad_dir, and any cwd under it), not just in
// the `session_id` field. Zeroing the field while leaving the same uuid in three paths is
// worse than not scrubbing at all, because it reads as scrubbed.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const BARE_UUID = /\b[0-9a-f]{32}\b/gi;

function scrub(value) {
  if (typeof value === "string") {
    let s = value;
    s = s.split(HOME).join("/home/user");
    if (USER.length > 2) s = s.split(USER).join("user");
    s = s.replace(UUID, "00000000-0000-0000-0000-000000000000");
    s = s.replace(BARE_UUID, "0".repeat(32));
    // The per-user temp root encodes the uid, e.g. /private/tmp/claude-501/.
    s = s.replace(/\/claude-\d+\//g, "/claude-0/");
    for (const re of SECRET_SHAPES) s = s.replace(re, "[REDACTED]");
    return s;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

const VOLATILE = {
  session_id: "00000000-0000-0000-0000-000000000000",
  prompt_id: "00000000-0000-0000-0000-000000000001",
  tool_use_id: "toolu_00000000000000000000000000",
  transcript_path: "/home/user/.claude/projects/example/transcript.jsonl",
};

mkdirSync(outDir, { recursive: true });

const files = readdirSync(inDir).filter((f) => f.endsWith(".json"));
const seen = new Map();
let skipped = 0;

for (const f of files) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(join(inDir, f), "utf8"));
  } catch {
    skipped++;
    continue;
  }

  const event = payload.hook_event_name ?? "unknown";
  // Keyed on whether a subagent made the call as well as on the tool. A subagent payload
  // carries agent_id and agent_type as extra top-level keys, so collapsing it into the
  // same slot as the main-session payload loses the only example of those fields.
  const subagent = typeof payload.agent_type === "string" ? `-subagent-${payload.agent_type.toLowerCase()}` : "";
  const key = `${event}-${payload.tool_name ?? "none"}${subagent}`;
  if (seen.has(key)) continue; // one fixture per event+tool+subagent; first wins

  const normalized = scrub(payload);
  for (const [k, v] of Object.entries(VOLATILE)) {
    if (k in normalized) normalized[k] = v;
  }

  const name = `${key.toLowerCase()}.json`;
  writeFileSync(join(outDir, name), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  seen.set(key, name);
}

console.log(`read ${files.length} captures from ${inDir}`);
if (skipped > 0) console.log(`skipped ${skipped} unparseable`);
console.log(`wrote ${seen.size} fixtures to ${outDir}:`);
for (const [key, name] of seen) console.log(`  ${key.padEnd(28)} -> ${basename(name)}`);
console.log(`\nRead every file before committing. Keys observed across all captures:`);

const keys = new Set();
for (const f of files) {
  try {
    for (const k of Object.keys(JSON.parse(readFileSync(join(inDir, f), "utf8")))) keys.add(k);
  } catch { /* already counted as skipped */ }
}
console.log(`  ${[...keys].sort().join(", ")}`);
