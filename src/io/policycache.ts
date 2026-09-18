// A disk cache of the compiled policy, keyed on the policy text itself. See docs/adr/007.
//
// This reverses ADR-002 item 2, which rejected a compiled-policy cache as "a staleness bug
// for no measurable gain". Both halves were measured wrong. The gain is 21.7 ms of a 52 ms
// cold run, because parsing YAML costs per node and a policy with rules in it has a lot of
// them; and the staleness bug belonged to the mtime key that draft proposed, not to caching.
//
// The key here is the policy source text, stored in the cache entry and compared in full.
// An edit of any kind misses, there is no collision to reason about, and it is cheaper than
// hashing: `require("node:crypto")` costs 10 to 15 ms cold in a CJS file, which is most of
// what the cache saves. `src/engine/registry.ts` reached the same conclusion for the same
// reason — crypto is an import the hot path does not otherwise need.
//
// Every failure here is silent and falls through to a normal load. A cache that cannot be
// read, written, parsed or trusted must never be why a session is worse off than without it.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy, type LoadResult } from "../engine/policy.js";

/**
 * Bumped whenever `loadPolicy`'s output shape changes.
 *
 * The source text guards against a stale *policy*; this guards against a stale *compiler*.
 * A cache entry written by an older build could deserialise into a Policy missing a field
 * the current engine reads — `gate.hardRules` was exactly that field once — and a silently
 * absent rule list is the failure this file must not introduce. `test/policycache.test.ts`
 * pins the compiled shape against this number, so adding a field to `Policy` fails a test
 * until the version moves.
 *
 * 1 → 2: `gate.probeQuestions` (ADR/PR #19). The first time this guard fired, and on the
 * commit after the cache landed — a cache entry written by the previous build deserialises
 * into a policy with no probe questions at all, which is silent rather than noisy.
 */
export const CACHE_VERSION = 2;

const DIR = "policy-cache";

interface CacheEntry {
  readonly version: number;
  /** The policy file's exact text. Equality with this is the whole cache key. */
  readonly source: string;
  readonly result: LoadResult;
}

/**
 * `loadPolicy`, with the compiled result memoised on disk.
 *
 * `path` names the entry rather than keying it: a session that alternates between a repo
 * policy and the bundled one would otherwise evict one with the other on every call.
 */
export function loadPolicyCached(dir: string, path: string, source: string): LoadResult {
  if (disabled()) return loadPolicy(source);

  const file = fileFor(dir, path);
  const hit = read(file, source);
  if (hit !== undefined) return hit;

  const result = loadPolicy(source);
  write(file, source, result);
  return result;
}

/** Set `BOUNCER_NO_CACHE=1` to force a full parse — what `npm run bench` measures against. */
function disabled(): boolean {
  const value = process.env["BOUNCER_NO_CACHE"];
  return value !== undefined && value.length > 0 && value !== "0";
}

function read(file: string, source: string): LoadResult | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Absent, unreadable or truncated. All three mean "parse it properly".
    return undefined;
  }

  if (!isRecord(entry)) return undefined;
  if (entry["version"] !== CACHE_VERSION) return undefined;
  if (entry["source"] !== source) return undefined;

  const result = entry["result"];
  if (!isRecord(result)) return undefined;
  if (!Array.isArray(result["diagnostics"])) return undefined;

  // A policy is either absent — a file that did not load — or a mapping with a gate. This
  // is a sanity check on a file the process wrote itself, not validation: the source text
  // matched, so the only way here is a hand-edited or corrupted cache, and re-parsing is
  // both correct and cheap enough to be the answer to any doubt.
  const policy = result["policy"];
  if (policy !== undefined && !(isRecord(policy) && isRecord(policy["gate"]))) return undefined;

  return result as unknown as LoadResult;
}

function write(file: string, source: string, result: LoadResult): void {
  const entry: CacheEntry = { version: CACHE_VERSION, source, result };

  // Written to a unique temporary name and renamed, because rename is atomic on every
  // platform this runs on and two tool calls can be in flight at once. A reader must never
  // see half a file; a crash mid-write must leave the previous entry intact.
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirOf(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(entry), "utf8");
    renameSync(temp, file);
  } catch {
    // A read-only or full disk is not this process's problem to solve or report. The
    // decision it was asked for has already been computed.
    try {
      unlinkSync(temp);
    } catch {
      // Nothing left to do about it.
    }
  }
}

/**
 * One file per policy path, named by a digest of it.
 *
 * FNV-1a, for the reason `registry.ts` gives: this distinguishes paths, it does not protect
 * them. A collision costs one wasted parse, because the entry's own source text still has
 * to match before it is used.
 */
function fileFor(dir: string, path: string): string {
  let hash = 0x811c9dc5;
  for (const char of path) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return join(dir, DIR, `${hash.toString(16).padStart(8, "0")}.json`);
}

function dirOf(file: string): string {
  const cut = file.lastIndexOf("/");
  return cut <= 0 ? file : file.slice(0, cut);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
