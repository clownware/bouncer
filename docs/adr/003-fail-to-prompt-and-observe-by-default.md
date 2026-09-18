# ADR-003: Fail to the prompt, observe by default, and ship no deny rules

- **Status:** accepted
- **Date:** 2026-09-18
- **Context for:** v0.1

## Decision

Three defaults, each chosen so that the worst case is "Claude Code behaves exactly as it
would without Bouncer installed":

1. **Fail to the prompt, never fail open.** Adapter timeout, 429, 401, unreachable host,
   invalid policy file, or an internal crash all resolve to "emit no decision" — the normal
   permission flow runs. Bouncer being broken must never be the reason something dangerous
   ran unchallenged, and must never be the reason a session is bricked either.

2. **Observe mode is the shipped default, and it emits nothing at all.**

3. **No `deny` rules are enabled in the default policy.** They exist in the schema, are
   documented, and are commented out.

## Why observe mode emits nothing rather than `ask`

The obvious implementation of a dry run is to return `ask` and let the prompt appear. That
is wrong, and wrong in the exact direction that would sink the product.

`ask` is a real decision: it *forces* a prompt. Claude Code's own settings allowlist, and
permission modes like `acceptEdits` and `bypassPermissions`, mean many tool calls would
otherwise never prompt at all. Returning `ask` on all of them converts a silent observation
mode into a prompt storm — strictly more friction than not installing Bouncer, on a user's
very first run, from the tool whose entire premise is reducing friction.

Observe mode therefore exits 0 with empty stdout, which the docs confirm falls through to
the normal permission flow, and writes a log line. Where a visible signal is wanted,
`systemMessage` can carry a non-blocking one-liner.

## Why the mode is one enum, not two flags

The PRD had `mode: dry-run | enforce` crossed with `auto_allow: true | false` — four cells,
two of which behave identically. Collapsed to one setting with three states, named for the
progression a user actually walks through:

| Mode | Emits | Effect |
|---|---|---|
| `observe` *(default)* | nothing | logs only; behaviour identical to not installing |
| `guard` | `ask` (and `deny` if enabled) | adds prompts where policy says so; never removes one |
| `full` | `ask`, `deny`, and `allow` | also suppresses prompts on calls judged safe |

Note that even in `full`, an `allow` is not authoritative: hooks merge most-restrictive-wins,
so another hook or a settings rule can still force the prompt (ADR-001).

## Why no deny rules on day one

A false-positive `ask` costs the user one keystroke. A false-positive `deny` returns
`permissionDecisionReason` to the model, which then tries to accomplish the goal another
way — so the user gets a silently degraded agent doing something *else*, and never sees the
decision that caused it. The failure is both worse and less visible.

`deny` becomes reasonable once a user has looked at their own calibration table and knows
the false-positive rate for the question they want to enforce on. Until then the strictest
default action is `ask`, which makes `guard` mode mean "adds prompts" — a much easier thing
to trust, and still the whole benefit for someone running in `bypassPermissions`.

## Consequences

- Enabling enforcement is a deliberate act with a number attached to it, which is the
  product's main trust claim.
- The README must publish the fixture table before anyone is asked to move off `observe`.
- Error handling needs a circuit breaker as well as a default: repeated adapter failures
  drop to `observe` with a loud `systemMessage`, so a flaky network degrades to "no
  Bouncer" rather than to friction on every call.
- **The circuit breaker must exclude the first call of a session.** Measured against live
  Jev on 2026-09-18: a cold call took 513 ms and the five that followed took 168–350 ms.
  Connection setup, not the model, accounts for the difference. A latency breaker that
  counts the warm-up would trip on a healthy setup, so the first call of each session is
  observed and logged but not counted toward the consecutive-miss total.

## Measured end-to-end budget

| | | |
|---|---|---|
| hook overhead (bundled, mock adapter) | 44 ms mean | 52 ms p95 |
| Jev call, steady state, 5 nouls over a 603-token state | ~190 ms | ~350 ms |
| Jev call, first of a session | 513 ms | — |

Steady state lands around 400 ms end to end against the 600 ms target. The first call of a
session lands near 565 ms — inside budget, but with little margin, which is the other
reason it is excluded from the breaker rather than merely tolerated.
