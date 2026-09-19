# ADR-002: A single bundled JS file on Node, with the bundle committed

- **Status:** accepted; item 2 reversed by ADR-007
- **Date:** 2026-09-18
- **Context for:** v0.1

## Decision

Write the source in TypeScript, bundle it with esbuild into one file at `bin/bouncer.cjs`,
and commit that file. Claude Code plugins are installed by fetching the repo; nothing runs
`npm install`, so anything the hook needs at runtime has to already be on disk.

## The measurement this rests on

The concern was that Node process startup would eat the latency budget. Measured on
Node 22.22.2, 30 runs each:

| Variant | mean | p95 |
|---|---|---|
| bare `node -e ''` | 28 ms | 33 ms |
| bundled, policy pre-parsed to JSON (914 B bundle) | 45 ms | 51 ms |
| bundled, YAML parser included (264 KB bundle) | 47 ms | 50 ms |
| **unbundled**, same code resolving `yaml` from `node_modules` | 87 ms | 102 ms |

Two conclusions, one of which reversed an earlier recommendation:

1. **Bundling is the whole win.** It roughly halves startup. Nearly all of the cost is
   module resolution, not parsing.
2. **Caching the parsed policy as JSON is not worth doing.** Including a full YAML parser
   in the bundle costs about 2 ms. An earlier draft proposed a compiled-policy cache keyed
   on mtime; the measurement says that would add a staleness bug for no measurable gain.
   Parse the YAML on every invocation.

   > **Reversed by ADR-007 on 2026-09-18.** Both halves turned out to be wrong once the
   > policy had rules in it. The 2 ms above was measured on a skeleton policy, and parse
   > cost tracks YAML node count rather than file size: on the shipped policy the parse is
   > 22 ms of a 52 ms cold run, and caching it saves 22.6 ms — 32.1 ms on a policy with
   > thirty user rules in it. The staleness bug belonged to the mtime key, not to caching;
   > ADR-007 keys on the policy's full text instead, which has no false-hit class at all.
   > The status line above stands for everything else in this ADR.

Current skeleton measures p95 46.8 ms against an 80 ms budget (`npm run bench`), leaving
room for policy parsing, state building, and logging before the adapter call.

## Why not Go, Rust, or Bun

A compiled binary would start in ~2 ms, but plugin distribution then needs per-platform
artifacts and a release pipeline, and the whole budget saved is ~45 ms against a target of
600 ms end-to-end where the network call dominates. Node is already a hard dependency of
Claude Code. Revisit only if measured hook overhead exceeds 80 ms.

## Why not a persistent daemon

A long-lived process on a unix socket would cut per-call overhead to single-digit ms. It
also introduces lifecycle, staleness, orphaned-process and multi-session-contention
problems, for a saving that is small next to the adapter call. Not for v0.1.

> **The premise changed on 2026-09-18; the decision has not been revisited.** This priced a
> daemon's saving as process overhead alone. A long-lived process would also keep its
> connection to the classifier, and a process per call cannot: measured from an installed
> plugin, ~190 ms of a ~437 ms adapter call is TCP and TLS setup paid again on every tool
> call (ADR-003, corrected the same day). So the saving is not small next to the adapter
> call — it is most of half of it. The lifecycle problems listed above are exactly as real
> as they were, which is why this is a note and not a reversal.

## Consequences

- `bin/bouncer.cjs` is a build artifact **in git**. It must be rebuilt and committed
  whenever `src/` changes; CI verifies the committed bundle matches a fresh build.
- Adding a dependency has a direct, measurable latency cost. `npm run bench` is the gate.
- The bundle is not minified. Users are being asked to let this run in their tool path;
  it should be readable.
