# ADR-002: A single bundled JS file on Node, with the bundle committed

- **Status:** accepted
- **Date:** 2026-09-18
- **Context for:** v0.1

## Decision

Write the source in TypeScript, bundle it with esbuild into one file at `bin/bouncer.mjs`,
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

## Consequences

- `bin/bouncer.mjs` is a build artifact **in git**. It must be rebuilt and committed
  whenever `src/` changes; CI verifies the committed bundle matches a fresh build.
- Adding a dependency has a direct, measurable latency cost. `npm run bench` is the gate.
- The bundle is not minified. Users are being asked to let this run in their tool path;
  it should be readable.
