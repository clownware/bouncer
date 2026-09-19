# ADR-003: Fail to the prompt, observe by default, and ship no deny rules

- **Status:** accepted; the steady-state latency figures and the list of failure paths
  corrected on 2026-09-18 and 2026-09-19, in place
- **Date:** 2026-09-18
- **Context for:** v0.1

## Decision

Three defaults, each chosen so that the worst case is "Claude Code behaves exactly as it
would without Bouncer installed":

1. **Fail to the prompt, never fail open.** Adapter timeout, 429, 401, unreachable host,
   invalid policy file, or an internal crash all resolve to "emit no decision" — the normal
   permission flow runs. Bouncer being broken must never be the reason something dangerous
   ran unchallenged, and must never be the reason a session is bricked either.

   > **Corrected on 2026-09-18.** That list missed a failure with no error attached: a
   > response that answers part of the request. The Jev adapter keeps whatever parsed, and
   > `evaluate()` skipped each rule whose answer was missing — which is right for a rule
   > that stops, and wrong for the walk as a whole, because every skipped rule is a step
   > nearer `default: allow`. With the shipped policy in `full` mode, a response carrying
   > `destructive: 0.01` and nothing else emitted `allow` with six questions never
   > assessed. Found by `docs/adr-review-2026-09-18.md` and confirmed in the code; no test
   > saw it, because the mock adapter answers everything it is asked.
   >
   > `evaluate()` now refuses an `allow` while any question in the set is unanswered. An
   > `ask` or a `deny` from a partial response still stands, since it rests on an answer
   > that arrived. In the gate the refusal takes this same path — `malformed_response`,
   > nothing emitted, counted by the breaker, logged with an error and no answers — and in
   > `bouncer judge` it is a failed item, outside the denominator. The check lives in the
   > engine rather than in each caller so the next consumer cannot forget it.

   > **Corrected on 2026-09-19.** Two more, from the same review and from checking it.
   >
   > *A state the classifier only saw the head of.* The gate cuts a command to its first
   > 512 characters once the state passes 4 KB, and nothing read the `truncated` flag, so
   > seven confident low answers about `echo ok` could approve whatever followed the
   > padding. The review found this in `bouncer judge`; the gate had it too. One installed
   > log held 10 truncated states in 410 judged calls, all Bash, two of them allowed.
   > `evaluate()` now takes the flag and refuses an `allow` on a truncated state, as it does
   > on a partial response. It is not an error, though: every answer arrived and is a real
   > judgment of what was shown, so the line keeps its answers and gains `truncated: true`.
   > An `ask` stands, having found its reason in the part that was read.
   >
   > *`on_error: deny`, which this ADR never mentioned.* The sentence above says every
   > failure emits no decision. The policy has always offered one opt-in exception —
   > `on_error: deny`, documented in `policy/default.yaml` as a footgun and honoured because
   > a user who set it meant it. That stays, and is now written down here. What does not
   > stay is that the error path ignored the mode: `mode: observe` with `on_error: deny`
   > denied a tool call on a timeout, which breaks decision 2 below outright. The error path
   > now goes through the same mode table as every verdict, so observe emits nothing there
   > too, and the loader warns that the combination has no effect.

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

  > **Corrected on 2026-09-18, from the first real traffic.** The hook never reaches the
  > steady state this describes. The five fast calls were made by `scripts/jev-latency.mjs`
  > inside one process, where Node keeps the connection open between them. The hook is a
  > new process per tool call, so every call opens its own connection and every call is the
  > cold one. Over the first 66 judged calls from an installed plugin the two warm-up calls
  > took 426 and 479 ms and the other 64 had a median of 437 ms — there is no difference for
  > the exclusion to be protecting. It is harmless, one uncounted call per session, and it
  > stays; the reasoning for it does not.

## Measured end-to-end budget

| | | |
|---|---|---|
| hook overhead (bundled, mock adapter) | 44 ms mean | 52 ms p95 |
| Jev call, steady state, 5 nouls over a 603-token state | ~190 ms | ~350 ms |
| Jev call, first of a session | 513 ms | — |

Steady state lands around 400 ms end to end against the 600 ms target. The first call of a
session lands near 565 ms — inside budget, but with little margin, which is the other
reason it is excluded from the breaker rather than merely tolerated.

> **Corrected on 2026-09-18.** The steady-state row does not describe the hook, for the
> reason given under Consequences: it was measured over a connection the hook never gets to
> reuse. Measured from an installed plugin over 66 judged calls, seven questions, one
> machine: the adapter call has a median of 437 ms (min 382, p95 549, max 653), and the hook
> from payload to verdict 441 ms, p95 551 — before the ~35 ms of process start it cannot
> see. One call of 66 went over 600 ms.
>
> Where it goes: eight cold connections to the API host from the same machine each took
> ~95 ms to open a socket and ~193 ms to finish TLS, which is two round trips before the
> request is sent. The remaining ~245 ms is the request, the model and the response. So the
> figure is a property of the distance to the host and of the process model, not of Jev and
> not of the question count, and it will be different from somewhere else. It is still the
> number to plan against: about 480 ms end to end at the median, and the 600 ms target is
> met at p95 with nothing to spare.
