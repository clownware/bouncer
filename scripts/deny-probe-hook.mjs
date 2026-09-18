#!/usr/bin/env node
// Does a PreToolUse `deny` actually block a tool call under --dangerously-skip-permissions?
//
// No captured payload can answer that. `scripts/capture-hook.mjs` is inert by
// construction — it always exits 0 with empty stdout — which is the same reason ADR-001
// still lists `permissionDecision: "defer"` as unverified. Emitting a real decision is the
// only way to find out, and the whole of `seatbelt` mode (ADR-004) rests on the answer.
//
// So this hook denies, and denies exactly one thing: a Bash command containing the
// sentinel below. Everything else — every other command, every other tool — gets an empty
// stdout and exit 0, which Claude Code treats as "no decision, proceed normally". Running
// it cannot interfere with anything except the probe itself.
//
// Install and run:  see the "Probing deny under bypass" section of scripts/CAPTURE.md
// Never exits 2, for the reason in src/cli.ts.

import { readSync } from "node:fs";

const SENTINEL = "BOUNCER_DENY_PROBE";

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      if (err.code === "EOF") break;
      throw err;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const payload = JSON.parse(readStdin());
  const command = payload?.tool_input?.command;

  if (payload?.tool_name === "Bash" && typeof command === "string" && command.includes(SENTINEL)) {
    // stderr, not stdout: stdout is the decision channel and must stay pure JSON.
    process.stderr.write(`deny-probe: denying the sentinel in permission_mode=${payload.permission_mode}\n`);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "deny-probe: this is the bouncer deny probe. If you are reading this, the hook's deny was honoured. Do not retry the command; report that it was blocked and stop.",
        },
      }),
    );
  }
} catch {
  // An unreadable payload is not something to guess about, and a probe bug must never
  // interfere with the session running it.
}

process.exit(0);
