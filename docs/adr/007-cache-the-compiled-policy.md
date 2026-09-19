# ADR-007: Cache the compiled policy on disk, keyed on the policy text

- **Status:** accepted, with a measurement consequence added on 2026-09-19, in place
- **Date:** 2026-09-18
- **Context for:** v0.2
- **Reverses:** ADR-002, item 2 — "Caching the parsed policy as JSON is not worth doing …
  that would add a staleness bug for no measurable gain."

## Decision

`resolvePolicy` memoises the compiled policy in `<data dir>/policy-cache/<digest of the
policy's path>.json`. The entry holds the policy file's **full source text** and the
compiled `LoadResult`. On the next call the file is read, its stored source compared with
the source just read from disk, and the compiled result used when they are identical.

Any failure — absent, unreadable, unparseable, wrong version, mismatched source, unwritable
directory — falls through to a normal `loadPolicy`, silently. `BOUNCER_NO_CACHE=1` disables
it, which is how the numbers below were measured.

## Why ADR-002 item 2 was wrong, in both halves

It said the cache would be "a staleness bug for no measurable gain". Neither half survives
measurement.

**The gain.** Paired and interleaved on one machine, 50 pairs, the real bundle, only the
cache varied:

| policy | no cache | cached | paired difference |
|---|---|---|---|
| the shipped `policy/default.yaml` | 75.1 ms | 53.0 ms | **−22.6 ms** |
| the same plus 30 hard rules a user might write | 86.7 ms | 54.8 ms | **−32.1 ms** |

The second row is the more important one. Uncached, the hook costs more the more policy you
write; cached, 53.0 ms and 54.8 ms are the same number. The cache makes hook overhead
independent of policy size, which is the property the project actually wants, and it is
worth more to users than to us because their policies will be larger than the shipped one.

A miss costs +0.46 ms over no cache at all (40 pairs, a fresh data directory per spawn), so
the first call after every policy edit is not measurably worse than today.

ADR-002's own measurement is not contradicted. It compared a *pre-parsed policy baked into
the bundle* against *shipping the YAML parser*, and found 45 ms against 47 ms — 2 ms, on a
skeleton policy with no rules in it. That number was true and is still true. What was wrong
was generalising it: parse cost tracks YAML **node count**, not file size, and the skeleton
had almost no nodes. On the shipped policy today the parse is 22 ms of a 52 ms cold run.
ADR-004 has the per-node figure; the short version is 0.37 ms per hard rule, cold, forever,
on every gated tool call.

**The staleness bug.** That belonged to the key the rejected draft proposed — mtime — not
to caching. An mtime key is wrong whenever two edits land in the same clock tick, and an
mtime-plus-size key is wrong whenever an edit preserves the size, which for a policy file
means any threshold change: `>=0.70` to `>=0.20` is the same number of bytes. Keying on the
text removes the false-hit class rather than trading against it. There is no hash, so there
is no collision to reason about either.

## Why the key is the text and not a hash of it

A content hash was the obvious design and it is the wrong one here, for a reason specific to
this process shape: **`require("node:crypto")` costs 10 to 15 ms cold in a CJS file.** Not
the digest — that is 0.5 ms for 16 KB — but the first load of the module. Measured on
Node 22.22.2, 40 cold spawns, in a plain `.cjs` file, which is exactly what `bin/bouncer.cjs`
is. (In `node -e` the same require reports 0.015 ms, which is how this cost stays hidden from
a quick check.)

| cache hit by | work in the hot path | end-to-end against a full parse |
|---|---|---|
| sha256 of the source | 11.7 ms | −11.0 ms |
| comparing the source text | 0.24 ms | −21.7 ms |

So hashing would have given away half the win to protect against a collision class that
storing the text does not have. Storing the text costs 17 KB of disk per entry.

`src/engine/registry.ts` had already reached this conclusion for the skill fingerprint,
citing ADR-002: "`node:crypto` is an import the hot path does not otherwise need". The
filename still needs a short token for the policy's *path*, and uses the same FNV-1a for the
same reason — a collision there costs one wasted parse, because the entry's own source text
still has to match before anything is used.

## What guards against a stale compiler

The source text catches a stale *policy*. Nothing in it catches a stale *compiler*: an entry
written by an older build could deserialise into a `Policy` missing a field the current
engine reads. `gate.hardRules` was that field three hours ago, and a silently absent hard
rule list is the worst outcome this file could produce.

So an entry carries `CACHE_VERSION`, and a test pins the compiled shape against it: adding a
field to `Policy`, `GatePolicy`, `HardRule`, `HardRuleWhen`, `Rule` or `CalibrationPolicy`
fails `test/policycache.test.ts` until the number moves. It is pinned against a fixture
rather than the shipped policy on purpose, so that a thread editing the questions does not
have to bump a cache version to do it.

## Consequences

- **Hook overhead stops scaling with policy size.** Writing rules is no longer something a
  user pays for on every tool call, which is what makes `gate.hard_rules` a feature they can
  actually use rather than a budget they spend.
- **`npm run bench` now measures the cached path**, because that is what a user experiences
  after the first call. Its five warm-up runs populate the cache before anything is
  recorded. To measure the parse itself, run it with `BOUNCER_NO_CACHE=1`.
- **The cache is not a correctness boundary.** It returns what `loadPolicy` returns or it
  falls through; `test/policycache.test.ts` asserts that for a hit, a miss, an unloadable
  policy, eight kinds of corrupt entry, a wrong version and an undirectory-able cache path.
- **One file per policy path, and nothing evicts them.** An entry is 17 KB or so and the
  number of distinct policy paths a machine sees is small. Alternating between a repo policy
  and the bundled one does not thrash, which a single-entry cache would.
- **Writes are atomic** — a unique temporary name and a rename — because two tool calls can
  be in flight at once and a reader must never see half a file.
- **The 80 ms local bench default is now the wrong number**, and this is the change that
  makes it worth saying. On agent containers `main` measured p95 102.0 ms in the same minute
  a branch measured 82.9, so the default was already failing on hardware rather than on
  code; cached, the same path runs at 53 ms median. Whether the local default becomes a
  tighter number against the cached path, or stops being a gate, is its own decision. CI's
  gate is 150 ms and is unaffected.
  **Decided 2026-09-19 (#73): it stops being a gate, and so does CI's.** The same day, CI's
  150 ms failed `main` at p95 151.3 ms on unchanged code and passed on a rerun, so neither
  absolute number was measuring the code. `npm run bench` prints 80 ms as the target and
  exits 0 unless `--budget` is passed; CI runs `--against` the base commit's committed
  bundle with `--max-regression-pct 10` and fails on the paired median. A byte-identical
  bundle reads within 1% of itself over 50 pairs, which is the noise that margin has to
  clear.

## What this costs a paired bench (added 2026-09-19)

`CACHE_VERSION` is part of the key, so two bundles built either side of a bump share no
cached policy. That is correct, and it has a consequence nothing said out loud until a
thread tripped over it: `scripts/bench.mjs --against` gave both arms one scratch
`CLAUDE_PLUGIN_DATA`, so the two bundles wrote the same entry and rejected each other's on
every call. Both arms then ran uncached, and the interleaving the flag exists for kept that
invisible — the pairing still cancelled machine drift, so the numbers looked as trustworthy
as any other.

Measured here on 2026-09-19, `8384ad0` against `9d0b90c`, 60 pairs, the same machine within
the same minute:

| | before p50 | after p50 | paired median |
|---|---|---|---|
| one data directory per arm | 72.6 ms | 73.9 ms | +1.3 ms |
| one shared directory | 103.6 ms | 108.1 ms | +4.1 ms |

Two things are wrong in the second row and only one of them is the obvious one. The
absolute is about 32 ms high, which is the cache doing its job being undone. And the
*difference* is the cold-parse difference rather than the warm one, which is larger here —
the same pair reads +5.5 ms with `BOUNCER_NO_CACHE=1` set honestly on both arms. So the
shared directory does not merely add a constant to both sides; it silently swaps the
question for a different one.

The fix is one data directory per arm, which is also what a real installation looks like:
one bundle, one entry, warm. `--against` now does that, and prints each bundle's
`CACHE_VERSION` so a cross-version comparison says so in its own header.

The general rule, which is not specific to this cache: an arm's *environment* is part of
the control. Interleaving equalises the machine, not a resource the two arms fight over.
