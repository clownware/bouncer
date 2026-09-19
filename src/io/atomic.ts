// One way to replace a file, for the things bouncer writes that another process may be
// reading: the compiled policy, the circuit breaker, a judge run's manifest.

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Replaces `file` with `text`, and reports whether it did.
 *
 * Written to a unique temporary name and renamed, because rename is atomic on every
 * platform this runs on and two tool calls can be in flight at once. A reader must never
 * see half a file; a crash mid-write must leave the previous contents intact.
 *
 * Never throws. A read-only or full disk is not the caller's problem to solve, and nothing
 * written this way is worth failing a tool call over.
 */
export function writeAtomic(file: string, text: string): boolean {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, text, "utf8");
    renameSync(temp, file);
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing left to do about it.
    }
    return false;
  }
}
