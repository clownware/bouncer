# ADR-008: Bouncer is a judgment engine; the gate is its first consumer

- **Status:** accepted
- **Date:** 2026-09-18
- **Context for:** v0.2 (naming), v0.3 (`bouncer judge`), v0.4 (package extraction)
- **Numbering:** proposed as ADR-006, written as ADR-008. ADR-006 is the skill router and
  ADR-007 is the policy cache, both already written. PRD §13's rule is that a used number
  is never reused, so this one took the next free number.

## Decision

Three decisions, all taken now because all three are cheap now and expensive in four weeks.

**1. The engine judges items. The gate is one consumer of it, not the thing itself.**
Nothing tool-call-shaped exists below `src/cli.ts` and `src/hooks/`. Concretely:

- The state builder is an interface (`StateBuilder<TItem>` in `src/engine/types.ts`) and
  the tool-call builder is one implementation of it (`toolCallState` in
  `src/engine/state.ts`).
- A `PolicySet` — questions, probe questions, rules — is the engine's unit of work.
  `GatePolicy` is that set plus the three things only a tool call has: `tools`,
  `fast_path` and `hard_rules`. `gate:` is one named set rather than the only possible one.
- `calibrate` scores items, not hook payloads. A decisions log is one source of items.

**2. Escalation is a first-class output.** This is TypeSafe's own "verify and escalate"
pattern — check the uncertain cases, send those and only those to a person or a reasoning
model — made into an artifact rather than left as a shape each consumer reinvents; the
vendored skill at `.claude/skills/typesafe-ai/` links their cookbooks for it. The engine
emits, for every item it judged and
did not settle, which questions crossed which thresholds at what probability, and what
each of those questions asked. The gate writes that onto its decision-log line and turns
it into an `ask`; `bouncer judge` will collect the items into a manifest and build one
reasoning pass over them. `escalated / judged` is the number that says what the
substitution bought.

**3. No `packages/core` until a second consumer exists and has bent the interface.**
Not when the interface looks ready, not when v0.3 starts — when `bouncer judge` has shipped
and its needs have already changed the engine's shape. Monorepo churn is a poor use of a
three-week window.

## Why this is a naming pass and not a refactor

The engine was already right. `evaluate()` takes probabilities and returns a verdict; it
has never known what a tool call is. `redact()` takes a string. The adapters take a state
string and a question map. What was hook-shaped was the *vocabulary* — one type called
`GatePolicy` holding both the questions and the shell-command allowlist, one function
called `buildState` that only builds one kind of state — and vocabulary is what decides
whether the second consumer is a fork or an implementation.

So the code change here is small on purpose, and two of the three items in decision 1 are
type-level:

| Item | Shipped in this change | Deferred, and why |
|---|---|---|
| State builder as an interface | `StateBuilder<TItem>`, `BuiltState` moved to `types.ts`, `toolCallState` implements it. `buildState` keeps its signature and every caller is unchanged. | — |
| `PolicySet` separate from the gate | `GatePolicy extends PolicySet`. Zero call-site changes; `policy.gate.questions` still resolves. | The **policy file schema** is unchanged: it still spells this set `gate:` and only `gate:`. Letting the file name several sets is a user-facing format change with a migration, and it belongs in the PR that has a second set to put in it. |
| `calibrate` over any decisions log | — | `Fixture` is `{ tool, input, cwd, permission_mode, target_exists }` — a hook payload with labels. Making it `{ state, expect }` with the tool-call shape as one item kind touches `fixtures/gate.jsonl` and every calibration run's comparability. It lands with `bouncer judge` in v0.3, which is the change that needs it. |

The deferred rows are not blocked on anything; they are held because a schema change with
no second consumer is churn, and this window is not the time to spend on it.

## The escalation manifest

### What it is

```ts
interface EscalationSignal {
  question: string;    // which question
  p: number;           // at what probability
  criterion: string;   // which threshold it crossed, as the policy writes it: ">=0.70"
  asks: string;        // the question's own instructions — the reasoning prompt
  ruleIndex: number;   // which rule, matching the log's reason.ruleIndex
  verdict: Verdict;    // what that rule produces on its own
  decided: boolean;    // true for the rule that actually produced the verdict
}

interface EscalationItem {
  item: string;                  // tool_use_id, fixture id, input line — the consumer's key
  verdict: Verdict;
  signals: EscalationSignal[];
  state?: string;                // set only when the item must stand alone
}

interface EscalationManifest {
  itemsJudged: number;
  items: EscalationItem[];
  escalationRate: number;        // items.length / itemsJudged
}
```

### Four things it does that the existing `Decision` does not

**It reports every threshold crossed, not the first.** `evaluate()` stops at the first
matching rule because a verdict is one decision. A re-adjudication is not: an item that
tripped `secrets` at 0.71 *and* `prod` at 0.66 is a different item from one that tripped
only `secrets`, and a reasoning model asked to settle it needs both. Under an `any` rule
it names every question in the band rather than the one the iteration reached first.

**It carries the question's own words.** `asks` is the `instructions` string from the
policy. That is what makes the manifest a prompt rather than a log: the reasoning pass is
"here is the item, here is the question the fast model was unsure about, in the user's own
English, settle it" — and because the wording comes from the policy file, a user who
rewrites a question rewrites the escalation prompt with it. No question text in `src/`,
same as the thresholds.

**It has a denominator.** `itemsJudged` is passed in rather than derived from
`items.length`. One escalation out of one and one out of a hundred produce the same list;
only the denominator tells them apart, and the whole claim of the substitution pattern
lives in that ratio. `bouncer status` prints it over the last 200 logged calls.

**It is mode-blind.** `observe` emits nothing to Claude Code and still escalates here. The
manifest is what a mode is observed *with* — a run that recorded no escalations because it
was observing would make the ratio meaningless, which is exactly the number someone in
observe mode is trying to read.

### Who reads it

| Consumer | What it takes | Status |
|---|---|---|
| The `ask` reason at the prompt | The deciding signal is the headline, as ADR-004 left it, and the others are appended: `secrets 0.71; also prod 0.66`. A user deciding whether to approve needs to know the call tripped two things, not one. | shipped |
| `/bouncer:explain` | The full signal list off the log line, each with its threshold, its rule, and the question's own words, with `→` marking the one that decided. The judgments table above it is every answer; this is the subset a rule acted on. | shipped |
| `/bouncer:status` | `escalated / judged` over the last 200 calls. | shipped |
| `bouncer judge` | The manifest as a standalone artifact, and the input to the reasoning pass. | v0.3 |

### What is not an escalation

A fast-path hit, a hard rule, an ungated tool, a skipped permission mode. None of them was
judged, so there is nothing for a reasoning model to second-guess. A hard rule in
particular: ADR-004's argument is that the edges are code and the judge decides the
ambiguous middle, and code does not ask for help. This is also what keeps the ratio honest
— `fast_path` and `hard_rules` shrink the denominator rather than inflating it.

An `allow` is not an escalation either. The judge settled it; that is the case the
substitution is trying to produce.

### Where the state goes

The gate's item carries no `state`. It is written onto a `decisions.jsonl` line whose
`state` field is the same redacted string, and duplicating it would double the largest
field in the highest-volume file bouncer owns. A standalone manifest — what `bouncer judge`
will emit — sets it, because there the item has to be readable on its own. Whoever sets it
is responsible for the string having been through `redact()` first; §9's rule that file
contents never enter a state applies to a manifest exactly as it does to the log.

### What this costs

One extra pass over a handful of rules per judged call, no I/O, no new imports in the
bundle. Measured paired against `main`'s bundle, 40 pairs per run, repeated across the
change: the paired median never left **±1.1 ms** on either the judged or the hard-rule
path, against a per-arm spread of 4–7 ms. Quoting one run's number would be quoting noise;
what the repeats say is that there is nothing here to measure. That is nothing, which is the expected answer and the reason to check
rather than assume — see [[ADR-002]](002-bundled-single-file-on-node.md) on why a paired
measurement is the only readable one.

## The four things that are not TypeSafe's SDK

"Judgment engine" is a bigger claim than "hook plugin", and it invites the obvious
question: why not just call the SDK. The answer is four things TypeSafe does not ship, and
they are the test every roadmap item has to pass. An item that points at none of them does
not go in.

1. **Policy as YAML the user owns.** Questions are plain English and thresholds are
   numbers, in a file that sits next to `CLAUDE.md` and gets reviewed like code. No
   question and no threshold in `src/`.
2. **Hard rules at the edges.** `fast_path` and `hard_rules` decide deterministically
   before a model is asked anything. The judge gets the ambiguous middle (ADR-004).
3. **Calibration as a release gate.** `bouncer calibrate` holds each question to an
   accuracy bar at a confidence floor, both read from the policy, and the README publishes
   the table before enforcement is recommended. A model vendor will not gate your release
   on your own fixtures.
4. **Backend-pluggable, with the open-weights comparison published.** The same fixtures,
   the same `score()`, `--compare` printing Jev against a local constrained decode
   side by side (ADR-005). The claim is the layer, not the backend.

## Consequences

**Good.** The prompt reason and `/bouncer:explain` both now answer from one record instead
of from the single first-matching rule. `bouncer judge` is a new state builder, a new policy set and a new entrypoint
over unchanged engine code, rather than a fork. The escalation manifest makes the cost
argument measurable from day one instead of retro-fitted. The four moat items give roadmap
items a test they either pass or don't.

**The cost.** Two of decision 1's three items are deferred, so for the length of v0.2 the
policy file's `gate:` and `calibrate`'s hook-shaped fixtures contradict the naming. That
is deliberate — see the table above — and the contradiction is visible in the types, which
is the cheapest place for it to sit until v0.3 resolves it.

**The risk to watch.** The bigger claim invites scope. The rule in decision 3 is the brake:
no package extraction until a second consumer has forced the interface, and no roadmap item
that does not point at one of the four.

## What was considered and rejected

**Extracting `@clownware/bouncer-core` now.** The interface would be designed against one
consumer, which is how you get an interface shaped exactly like that consumer with a
package boundary making it expensive to change. v0.4, after v0.3 has bent it.

**Putting the escalation on `Decision`.** `Decision` is what the hook needs to answer
Claude Code — a verdict, a reason, and what may be emitted — and it is on the hot path of
every gated call including the allowed ones. The manifest is a different artifact with a
different consumer, so it is a separate pure function over the same inputs, computed only
when something actually escalated.

**Doing the policy-file schema change in this PR.** Rejected on timing, not on merit; see
the table.
