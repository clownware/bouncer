#!/usr/bin/env node
// Ground-truth payload capture. Records the exact stdin Claude Code hands a hook,
// so the rest of the project can be built against recorded reality rather than docs.
//
// Deliberately inert: it always exits 0 with empty stdout, which Claude Code treats
// as "no decision, proceed normally". It can slow a tool call slightly. It cannot
// block one. Every failure path is swallowed, because a capture bug must never
// interfere with the session doing the capturing.
//
// Install:  see scripts/CAPTURE.md
// Output:   $BOUNCER_CAPTURE_DIR (default ~/.bouncer-capture)/<event>-<timestamp>.json

import { appendFileSync, mkdirSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.env.BOUNCER_CAPTURE_DIR ?? join(homedir(), ".bouncer-capture");

function readStdin() {
  const chunks = [];
  const fd = 0;
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = readSync(fd, buf, 0, buf.length, null);
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
  mkdirSync(dir, { recursive: true });

  let raw = "";
  try {
    raw = readStdin();
  } catch {
    raw = "";
  }

  let event = "unknown";
  try {
    event = JSON.parse(raw).hook_event_name ?? "unknown";
  } catch {
    // keep the raw text anyway — a payload we cannot parse is the most interesting kind
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${event}-${stamp}-${process.pid}.json`;
  writeFileSync(join(dir, name), raw.length > 0 ? raw : "", "utf8");
  appendFileSync(join(dir, "index.log"), `${new Date().toISOString()}\t${event}\t${name}\t${raw.length}B\n`);
} catch {
  // never interfere with the session
}

process.exit(0);
