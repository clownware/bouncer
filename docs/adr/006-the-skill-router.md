# ADR-006: The skill router

- **Status:** proposed
- **Date:** 2026-09-18
- **Context for:** v0.2
- **Supersedes:** PRD §5.3 (router half), §6 `router:` block, §12 v0.2 DoD

## What this is

The second question set. A `UserPromptSubmit` hook reads the prompt, asks the same
adapter which of the user's installed skills fits, and — only when the answer is strong
enough — injects one line of context naming it. Same binary, same policy file, same log,
same calibration harness. Nothing about the gate changes.

This is the half of the product that was supposed to reduce tokens, so it is worth being
exact about how much it can, before designing for it.

## The token claim, stated honestly

The gate does not save tokens. Nothing in Claude Code's permission path was calling a
model, so what the gate buys is fewer interruptions and fewer rollbacks. That was already
noted in the README's framing and is not a complaint.

The router is where the token argument actually lives, and it is narrower than it sounds:

- **It cannot lower the floor.** Every installed skill's name and description already sit
  in the model's context, put there by Claude Code. A hook cannot remove them. The fixed
  cost of having thirty skills installed is unchanged by anything in this document.
- **What it can remove is the wrong load and the missed load.** A wrong `SKILL.md` is
  one to five thousand tokens of instructions for the wrong job, plus the work done under
  them, plus the redo. A missed one is the model solving from scratch something the user
  had already written down.
- **So the saving is variance, not a fixed cut**, and it is signed. A suggestion that
  causes a skill to load where none was needed spends the same one to five thousand
  tokens the router exists to avoid. Expected value is roughly
  `P(model wrong ∧ router right) × cost_of_redo − P(model right ∧ router wrong ∧ model
  complies) × cost_of_load`, and the second term is not small.

Every design decision below falls out of that last line.

## The asymmetry is inverted relative to the gate

This is the single most important difference and it is easy to get wrong by analogy.

For the gate, a false positive costs one keystroke and a false negative costs a silent
dangerous action. The costs are wildly asymmetric in the direction of asking, so the gate
is tuned to over-ask, and `ask` is its safe default.

For the router, the false positive *is* the expensive event. Silence costs nothing that
was not already being paid: the model still picks a skill exactly the way it does today.
A confident wrong suggestion actively causes the outcome the feature exists to prevent.

> **Silence is the router's `allow`.** It should answer rarely and be right when it does.

The practical consequence is that the router's default thresholds are set high, its
abstention rate is expected to be most prompts, and its release gate carries a
false-suggestion rate, not only an accuracy (§ Calibration).

It also means CLAUDE.md's "adding friction is the failure mode" reads differently here.
In `suggest` mode the router is in the human's critical path — between pressing enter and
Claude starting — so its latency is *felt*, where the gate's never is. That is why its
budget is tighter than the gate's and why observe mode does not make a network call at
all.

## Decisions

### 1. `UserPromptSubmit`, one more subcommand, nothing else moves

`bin/bouncer.cjs userpromptsubmit`, registered as a second entry in `hooks/hooks.json`.
The engine, adapter, policy loader, redactor, log and breaker are reused unchanged. This
is a second question set on the existing machinery, not a second product.

From the captured payload in `test/fixtures/payloads/userpromptsubmit-none.json`:
`session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
`hook_event_name`, `prompt`. Note two things against ADR-001's notes: the field is
`prompt`, and `permission_mode` **is** present, so `skip_permission_modes` applies here
too and `plan` mode costs nothing.

**Unverified, and must be verified before any code is written:** what
`UserPromptSubmit` does with an exit-0 process's **plain stdout**. For `PreToolUse`,
non-JSON stdout is ignored. The documentation describes `UserPromptSubmit` as injecting
stdout into the context. If that is right, this entrypoint has a hazard `pretooluse` does
not — any stray `console.log` becomes text in the user's conversation — and the structured
`hookSpecificOutput.additionalContext` form is mandatory rather than merely preferred.
Capture it with the recorder (`scripts/CAPTURE.md`) rather than trusting the docs, the way
ADR-001's payload facts were settled.

### 2. Two questions, not one, and not one per skill

Asked in a single fan-out, as the gate does:

```yaml
needs_skill:                 # noul
  instructions: "The request calls for specialised instructions the user has written down."
which_skill:                 # choice
  criteria: { <skill name>: <its description>, … }   # built from the discovered registry
```

A suggestion is emitted only when **all three** hold: `needs_skill.p` clears its
threshold, the top option's probability clears its own, and the **margin** between the
top option and the runner-up clears a third.

Why not one `choice` with a `none` option, which is what PRD §6 proposed (`include_none:
true`). "None of these" is not a positive category, and jev-1.13 is documented to read
scoping and negation words literally — asking it to allocate probability mass to an
absence is asking it to do the thing it is worst at. A noul phrased positively is the
shape it is good at. The split also separates two errors that want different thresholds
and have different fixes: *routed when nothing was needed* (reword `needs_skill`, or raise
its threshold) versus *routed to the wrong skill* (the skill descriptions are too alike,
or the margin threshold is too low). One number cannot tell you which happened.

Why not one noul per skill ("this request is about X"). Cost scales with the skill count
because each question repeats its own instructions; independent probabilities are not
comparable, so two skills can both come back 0.9; and there is no margin signal at all.

**Margin is deliberately the uncertainty signal.** `choice` answers do carry a
`confidence` field, unlike `noul`, but the vendor documents it as a statistic derived from
the distribution — so it carries nothing the distribution does not, and policy is written
on the probabilities themselves. That is the same reasoning as ADR-003's, applied to a
different question type.

### 3. The skills are the question, not the state

The skill registry goes in the `choice` question's `criteria` map, because the answer
comes back keyed by option name. The state carries the request and its setting:

```json
{"request":"<redacted prompt, capped>","project":"bouncer","git_branch":"main",
 "recent_tools":["Read","Edit","Bash"]}
```

Same discipline as `src/engine/state.ts`: structured JSON so a prompt containing
`needs_skill: false` cannot impersonate a field, the prompt redacted through the existing
redactor, and a hard cap (2 KB; PRD §7).

Budget against the API's 32k limit for state plus the longest question: a registry of
forty skills at a one-sentence description each is roughly 1.2k tokens, so the limit is
not the binding constraint — latency is. Descriptions are truncated to their first
sentence or 200 characters, whichever is shorter. `choice` accepts at most 255 options; a
user past that has the router disable itself with one `systemMessage`, not a silently
truncated registry.

Nothing new leaves the machine: skill names and descriptions are already in the model's
context, and the prompt is the user's own text.

### 4. Skill discovery reads frontmatter, and is cached per session

`name` and `description` from the YAML frontmatter of every `SKILL.md` under the user's
skills directory, the project's, and installed plugins'. `skills: auto` in the PRD, and it
stays the default; an explicit list is supported for users who want to route over a
subset.

This is N file reads on a hot path with an 80 ms budget (ADR-002), which is exactly the
kind of thing that budget exists to catch. Discovery is therefore cached in the session
state file the breaker already writes, keyed on the skills directories' mtimes.

**Needs a measurement before it is committed to:** `npm run bench` with a realistic
registry (Chris runs 10+ skills; the plugin marketplace pushes that well past 40). If cold
discovery is more than a few milliseconds, the cache is load-bearing rather than an
optimisation, and the ADR-002 finding — that caching the parsed policy bought nothing and
cost a staleness bug — does not transfer, because that was one file and this is N.

**Also unverified:** the on-disk layout of *plugin* skills after install. User and project
skills are well known; plugin skill paths depend on how the plugin was installed. Read one
rather than assume.

### 5. Observe mode does **not** call the classifier

This is the sharpest departure from the gate, and it is deliberate.

The gate's observe mode calls Jev on every gated tool call, because it needs live latency
numbers for the breaker and because nobody is waiting on the answer. Neither is true here.
In `suggest`, the router's call sits between a human pressing enter and Claude beginning to
answer; in `observe` it would sit there too, costing ~300 ms per turn to produce a log line
the user cannot see.

So in `observe` the router builds the state and the registry, writes them to
`decisions.jsonl`, and exits. Hook overhead only. `bouncer calibrate --router` replays
those records against Jev **offline and in batch**, which is strictly better than scoring
live:

- No per-prompt API call, and no latency in the human's path during the weeks of
  measurement that the product's whole trust story depends on.
- A question reword can be re-scored against the *same* prompts, instead of waiting
  another week to re-live them.

That second property is only available because the log stores the redacted state rather
than a hash — the decision recorded in PRD §9, made for precisely this reason. This is the
first thing that cashes it in.

### 6. Its own three-state mode, independent of the gate's

```
off       nothing runs, not even discovery
observe   records state + registry, no network call, no output   (default)
suggest   asks, and injects one line when the thresholds clear
```

Reusing `observe | guard | full` would be a false parallel: `guard` versus `full` is about
withholding `allow`, and the router has no analogue — it either speaks or it does not.
Keeping `router.mode` separate also lets someone run the gate in `guard` while the router
is still being measured, which is the expected path.

### 7. A skip list, which is the fast path with its sign flipped

Most prompts cannot need a skill. Before anything else: prompts under a length floor,
prompts beginning with `/` (the user already chose), and a short list of continuations —
`yes`, `go`, `continue`, `do it`, `ship it`, `thanks`.

Note the rule is much weaker than `gate.fast_path`'s, and in the opposite direction. A
fast-path entry must be safe for *every* argument, because skipping the gate risks
allowing something dangerous. Skipping the router risks a missed suggestion, which costs
nothing. Being generous here is free; being generous there is the bug CLAUDE.md warns
about.

### 8. What it emits

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit",
  "additionalContext":"bouncer: the \"brand-review\" skill may apply to this request."}}
```

One line, one skill, no probability, no imperative. The number is withheld because the
model has no calibration for it and would weight it as if it did. The wording is
permissive because a hint read as an instruction converts a routing error into a
compliance error — the model follows a wrong suggestion *harder* the more the line sounds
like a rule. The description is not repeated; it is already in context.

### 9. What it must never do

1. **Never block a prompt.** `UserPromptSubmit` supports blocking, and exit 2 blocks and
   erases the prompt. `src/cli.ts`'s never-exit-2 invariant extends to this entrypoint,
   with the same test.
2. **Never modify the prompt.** ADR-001 refused `updatedInput` on the gate: gating is a
   claim about risk, rewriting is a claim about intent. Rewriting a human's prompt is the
   same claim with a human on the other end of it.
3. **Never name a skill that is not in the discovered registry.** Structural, since the
   options are the registry, but it gets a test: a suggestion for a skill that does not
   exist is a wasted tool call and a confused model.
4. **Never suggest more than one skill per prompt.** Two suggestions is a shortlist, a
   shortlist is a decision handed back to the model, and the model already had that
   decision.
5. **Never repeat a suggestion for a skill already loaded this session.**
6. **Never make a network call in `observe`.** §5.
7. **Never send file contents.** The prompt goes through the existing redactor; the
   registry is names and descriptions.
8. **Never fail loud.** Every error path — timeout, 401, 429, bad frontmatter, unreadable
   skills directory — emits nothing. `on_error: deny` has no meaning here and is not
   honoured for the router; the only failure behaviour is silence.
9. **Never let the router's own suggestion become its label.** §Calibration.

### 10. Latency budget

| | budget |
|---|---|
| hook overhead, including discovery from cache | ≤ 80 ms p95 (ADR-002, unchanged) |
| `router.timeout_ms` | **500 ms**, lower than the gate's 800 |
| total, `suggest` | ≤ 600 ms p95 |

The tighter timeout is the asymmetry again: a missed suggestion costs nothing, and a
prompt that takes an extra second to start is felt by a human. The existing circuit
breaker is reused as is, including the rule that the first call of a session is excluded
from it.

**Unmeasured:** every latency number on record (README, ADR-003, run 4) is for five to
seven `noul` questions. Nobody has timed a `choice` question over several dozen options.
It may be materially slower. **This measurement needs Chris's API key** and is the first
thing to run.

## Calibration, and why the PRD's v0.2 DoD is the wrong target

PRD §12 sets the v0.2 bar as *"top-1 agreement ≥ 80% at confidence ≥ 0.7 over one week of
prompts"*, labelled by which skill the user ended up invoking. Agreement with what,
exactly, is the problem:

| label | how it's obtained | what it's worth |
|---|---|---|
| **A** — the user typed `/skill-name` | free, unambiguous | a floor, not a target. Those are precisely the prompts where routing was unnecessary. Useful only as a check that the router does not contradict an explicit choice. |
| **B** — the skill Claude actually loaded (`Skill` calls in `transcript_path`) | free, plentiful | **this is the incumbent.** 100% agreement with B means the router is a perfect imitation of the thing it was built to improve on, which is worth nothing. Optimising toward B optimises toward the coin flip in PRD §1. |
| **C** — hand-labelled fixtures, `fixtures/router.jsonl` | expensive | the only one that measures whether the router is *right*. |

So B's job is not to be the target, it is to **fill C**. `bouncer calibrate --router
--review` pairs each observe-mode record with what the model did in that session, prints
the disagreements most-confident-first, and that list is the hand-labelling queue. That is
the concrete form of "observe-mode logs seed the router's labels", and it is why the
disagreements are the valuable output rather than the agreement rate.

Fixtures follow the gate's near-miss discipline, which is the part that made the gate's
table mean anything: pairs a description-matcher would confuse. *"review this copy against
our voice"* against *"review this PR"*. *"write up what we decided"* against *"write the
migration"*. *"the numbers in the dashboard look off"* against *"the dashboard build is
failing"*. A set of obviously-matched prompts would score beautifully and tell you nothing.

**Proposed v0.2 DoD, replacing §12's:**

- ≥ 60 hand-labelled router fixtures, written as near-miss pairs, at least a third of them
  labelled `none`.
- Top-1 accuracy ≥ 0.85 **among the prompts the router answers on**.
- False-suggestion rate ≤ 0.05 — suggests a skill where the label says none.
- Coverage reported alongside both, so a router that passes by abstaining on 97% of
  prompts is visibly doing that rather than quietly passing.
- The table published in the README before `suggest` is documented as ready, the same
  gate v0.1 held itself to.

**Every live run needs Chris's API key**, as with the gate. Fixture authoring, the harness,
the `--review` pairing and the mock adapter's router heuristic can all be built and tested
without one.

## Proposed policy block

Not added to `policy/default.yaml` yet — shipping a `router:` section for code that does
not exist would be a config surface with nothing behind it. This is the shape being
proposed, for review:

```yaml
router:
  mode: observe              # off | observe | suggest
  timeout_ms: 500

  skills: auto               # auto = discover installed skills; or an explicit list
  max_description_chars: 200

  # Prompts never worth classifying. Skipping costs a missed suggestion and nothing else,
  # so this list is allowed to be generous — the opposite of gate.fast_path.
  skip:
    min_chars: 24
    starts_with: ["/"]
    exact: ["yes", "no", "go", "continue", "do it", "ship it", "thanks", "ok"]

  questions:
    needs_skill:
      instructions: "The request calls for specialised instructions the user has written down."
      criteria:
        "true": "a task with a house style, a checklist, a required format, or a workflow the user has documented"
        "false": "a direct question, a small edit, a follow-up to what was just said, general coding with no special procedure"

    # `which_skill` is a choice question whose options are built from the discovered
    # registry at runtime, so it has no criteria here.

  # All three must hold. See ADR-006 on why margin replaces a confidence field.
  suggest_when:
    needs_skill: { p: ">=0.70" }
    top:         { p: ">=0.60" }
    margin:      { p: ">=0.20" }   # top minus runner-up
```

## Consequences

- One more hook in the user's path, which is one more thing that has to be fast and quiet.
  The observe default means a user who installs v0.2 and changes nothing experiences no
  behaviour change and no added latency beyond ~50 ms of Node startup per prompt.
- `decisions.jsonl` gains router records. They are a different shape from gate records
  (no verdict, no tool) and `/bouncer:explain` needs to read both.
- The mock adapter needs a `choice` path; today it only answers nouls. CI's router
  calibration row depends on it.
- The token claim in the README can finally be made, but it must be made in the form §2
  above allows — a reduction in wrong and missed skill loads, measured, not a headline
  percentage.
- If the fixture table comes back showing the router cannot clear a 0.05 false-suggestion
  rate at useful coverage, the correct outcome is that `suggest` never becomes a
  recommended default and the router ships as a measurement tool. That is a real possible
  result of this design, and it is better to say so now than to discover it after the
  README has promised otherwise.
