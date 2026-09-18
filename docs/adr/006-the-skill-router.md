# ADR-006: The skill router

- **Status:** accepted — the three open decisions were settled by Chris on 2026-09-18,
  and the viability measurement (§10) came back inside budget
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

### 3. Names in the state, descriptions in the question

The `choice` question's `criteria` map carries skill name → description, because the
answer comes back keyed by option name. The skill **names** also go in the state. The
first draft of this ADR put the registry only in the question, and that was wrong.

Measured 2026-09-18: on a prompt that plainly wanted a brand-voice review, `needs_skill`
scored **0.22** with the registry only in the choice question, and **0.61** with the skill
names added to the state. The two questions are evaluated against the same state but not
against each other's criteria, so the noul was being asked whether the user had written
something down for this while being shown nothing the user had written down. A question
that reasons about the registry has to be able to see it. Cost is about 200 tokens.

**What that comparison establishes, and what it does not.** Both sides used the probe's own
wording of `needs_skill`, not the text in decision 2, and only the state varied between
them. So the *delta* is a controlled result and carries the decision. The absolute 0.61 is
not comparable to the 0.70 threshold in the policy block below, because it answers a
differently worded question — an earlier draft of this ADR read it as the router abstaining
on a clear positive, which it is not evidence of. Comparing a number across a changed
question is the mistake that invalidated the run 1 versus run 2 comparison.

```json
{"request":"<redacted prompt, capped>","project":"bouncer","git_branch":"main",
 "skills_available":["brand-review","code-review","…"],
 "recent_tools":["Read","Edit","Bash"]}
```

Same discipline as `src/engine/state.ts`: structured JSON so a prompt containing
`needs_skill: false` cannot impersonate a field, the prompt redacted through the existing
redactor, and a hard cap (2 KB; PRD §7) — which the name list now counts against, so it is
truncated before the request text is.

Budget against the API's 32k limit for state plus the longest question: measured at
roughly **50 tokens per skill**, so forty skills cost about 2k rather than the 1.2k this
ADR first estimated. Still nowhere near the limit, and §10 says latency is not the binding
constraint either. Descriptions are truncated to their first sentence or 200 characters,
whichever is shorter. `choice` accepts at most 255 options; a user past that has the router
disable itself with one `systemMessage`, not a silently truncated registry.

Nothing new leaves the machine: skill names and descriptions are already in the model's
context, and the prompt is the user's own text.

### 4. Discovery completeness is a correctness requirement, not an optimisation

The registry is the namespaced name and one-line description of every skill the model can
actually load. `skills: auto` in the PRD, and it stays the default; an explicit list is
supported for users who want to route over a subset. Where those come from is the survey
below, and the short answer is manifests rather than a walk of every `SKILL.md` on disk.

**A `choice` question cannot abstain**, and that turns an incomplete registry from a gap
into a confident wrong answer. When the right option is absent the distribution
renormalises over what was offered, and the best of a bad set comes back looking certain.
Measured 2026-09-18: a brand-voice copy review returned `ux-optimization` at **0.65
against 0.16 for the runner-up** because `brand-review` was not in the registry at all —
though it is an installed skill in the session that ran the probe. Read that margin again:
0.49 is a wide, clean win, and margin is this design's own uncertainty signal. Every guard
in decision 2 passed, on a wrong answer. A short registry produces the expensive event *by
construction* rather than by bad luck, and no threshold anywhere rescues it. That is the
strongest single argument in this document that discovery is a correctness requirement and
not a coverage nicety.

#### Where the skills actually are

Surveyed on one macOS machine, 2026-09-18. The two documented locations hold 42 skills.
The desktop app provisions **another 60-odd somewhere else**, and `brand-review` is one of
them: roughly sixty percent of the registry was missing. (The survey reported that second
figure as both 62 and 63; it is written loosely here on purpose, and pinning it exactly is
part of building discovery rather than a detail to inherit.)

| source | what it holds | how to read it |
|---|---|---|
| `~/.claude/skills/` | user skills | directory walk |
| `~/.claude/plugins/installed_plugins.json` | CLI-installed plugins, one `installPath` per version | authoritative list, filtered by `enabledPlugins` in settings |
| `~/Library/Application Support/Claude/local-agent-mode-sessions/<id>/<id>/rpm/manifest.json` | desktop-app plugins: id, name, marketplace | walk `rpm/plugin_<id>/skills/` per entry |
| the same tree, `skills-plugin/<id>/<id>/manifest.json` | Anthropic-managed skills, names and descriptions already listed | no file walk needed |
| `<project>/.claude/skills/` | project skills | directory walk |

Four things follow.

1. **Read manifests, not directories.** The 108-file count came from walking a marketplace
   clone and every cached version. `installed_plugins.json` names the one live path per
   plugin, so reading manifests removes the duplicate problem at its source rather than
   patching it afterwards with name collapsing. Duplicate options would otherwise split
   probability mass between identical entries and depress the margin, which reads as
   uncertainty rather than as the bug it is.
2. **Option names must be the namespaced names the model sees**, `marketing:brand-review`
   and `anthropic-skills:docs`, not bare names. A suggestion naming `brand-review` names
   something the model has never heard of.
3. **The desktop layout is undocumented, macOS-specific, and not passed on argv or env.**
   The path has been stable since February and the manifests were refreshed this week, so
   it is usable, but it is a private layout this repo is reading over the app's shoulder.
   That buys a test fixture of those manifest files and a documented degradation: a
   CLI-only user simply gets a smaller registry, and the router is quieter rather than
   wrong. Two unknowns remain — whether `installationPreference: "available"` means enabled
   or merely installable, and where the Windows equivalent lives.
4. **Cache on manifest mtimes, not directory mtimes.** Three manifest files cover roughly
   170 skill files, which is what makes ADR-002's caching argument transfer: watching three
   paths is cheap and precise, where walking a hundred on every prompt is neither. **Still
   needs `npm run bench`** to confirm the cold path fits the 80 ms budget.

**The acceptance test is the one that would have failed this week:** a registry built on a
machine with the desktop app running contains `marketing:brand-review`. Namespaced, from a
manifest, deduped, and not from a directory walk.

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

**Each observe record carries the registry it saw**, as the ordered name list or a hash of
it. Without that, a replay after the registry changed is a different experiment reported as
the same one — and given §4, the registry *is* expected to change as discovery is fixed.
The same applies to a reworded question: a replay is only comparable when what varied is
known. It is the control-condition problem that bit the run 1 vs run 2 comparison: matching
headline numbers across two runs do not establish that the runs were comparable.

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
3. **Never name a skill the model cannot act on.** Two ways to break this: naming
   something outside the discovered registry (structural, since the options *are* the
   registry, but it still gets a test), and naming it in a form the model does not use.
   The model sees `marketing:brand-review`; a suggestion for `brand-review` is a wasted
   tool call and a confused model.
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

Measured against live Jev on 2026-09-18, five timed calls each, one fan-out carrying the
`needs_skill` noul and a `choice` over a real registry:

| options | input tokens | p50 | max |
|---|---|---|---|
| 10 | 763 | 181 ms | 354 ms |
| 40 | 1949 | 199 ms | 278 ms |
| 42 | 2057 | 219 ms | 239 ms |

**A choice over forty options costs about what five nouls cost.** The open question this
ADR was written around — whether a wide choice is materially slower than the gate's nouls
— is answered, and latency is not the constraint on registry size. The answer carries a
full `probabilities` map, which `src/adapters/jev.ts` already parses, so the margin gate
needs no adapter change.

| | budget |
|---|---|
| hook overhead, including discovery from cache | ≤ 80 ms p95 (ADR-002, unchanged) |
| `router.timeout_ms` | **500 ms**, lower than the gate's 800 |
| total, `suggest` | ≤ 600 ms p95 |

The tighter timeout is the asymmetry again: a missed suggestion costs nothing, and a
prompt that takes an extra second to start is felt by a human. The existing circuit
breaker is reused as is, including the rule that the first call of a session is excluded
from it.

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
failing"*. A set of obviously-matched prompts would score beautifully and tell you nothing
— the same trap `unreviewed_execution`'s first 11/11 row fell into.

**The fixtures route over a real registry, not an invented one.** The Clownware plugins and
the Anthropic skill set are public, so their names and one-line descriptions can be
committed as they are. That makes the published table a measurement over a distribution
that actually exists and that a reader can reproduce, rather than over a straw registry
chosen to be separable. The private run against the full local skill set, which cannot be
committed, stays as the go/no-go.

**Proposed v0.2 DoD, replacing §12's:**

- ≥ 60 hand-labelled router fixtures, written as near-miss pairs, at least a third of them
  labelled `none`.
- Top-1 accuracy ≥ 0.85 **among the prompts the router answers on**.
- False-suggestion rate ≤ 0.05 — suggests a skill where the label says none.
- **Coverage ≥ 0.25 among the fixtures labelled as needing a skill**, reported alongside
  both numbers. Accuracy-among-answered and a false-suggestion ceiling can both be met by a
  router that answers five prompts a month; a floor is what lets the DoD return the verdict
  "correct, and too quiet to be worth shipping", which is a real possible outcome.
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

**These three numbers are placeholders, and 0.70 stays where it is.** The temptation was
to lower it: the probe behind decision 3 scored a plainly skill-requiring prompt at 0.61.
But that probe asked its own wording of `needs_skill`, not the text above, so the number
says nothing about this threshold — and moving a threshold to fit one observation of a
different question is two mistakes at once.

The coverage floor in the DoD is the right instrument instead. If 0.70 is too high, the
offline table shows it as coverage under 0.25 on fixtures labelled as needing a skill, and
the threshold then moves on evidence with a number attached. That is the same bargain the
gate made: enforcement is a deliberate act with a calibration run behind it. It is also
another reason the order of work puts `suggest` last.

## Prior art: fast-jev-compaction

`github.com/tamaratran/fast-jev-compaction` is the nearest thing to this on the same
model: a `session.compact` hook that asks Jev two `noul` questions per tool call — keep the
call, keep the result verbatim — and *deletes* what falls below a threshold rather than
summarising it. (Read from its README on 2026-09-18, not from its source.)

Three things about it are worth recording here.

**It is a stronger form of the token argument than the router.** It removes tokens that are
certainly in the context now; the router avoids tokens that might be spent, and the section
above concedes that saving is signed. If token reduction is the goal rather than a
property, compaction has the higher yield.

**Its one-question-per-candidate shape is the one decision 2 rejects, and it is right for
it.** Its candidates are independent keep/drop decisions with no ranking between them. The
router's candidates compete for a single pick and need a normalised distribution and a
margin. The two shapes answer differently structured questions and are not in tension.

**Its `keepThreshold` defaults to 0.5**, the point of maximum uncertainty on a noul, so
every coin flip resolves to "delete this". That is the default ADR-003 refuses for the
gate, and it is the concrete argument for a compactor living behind a calibration harness
rather than beside one.

**Not in v0.2, and not in the README.** Deleting context fails silently and unrecoverably:
the model simply no longer knows something, and nobody sees the decision that caused it —
the `deny`-rule problem from ADR-003 one level worse. It needs its own ADR rather than an
extension of 003. The sequence is the router in observe, two weeks of prompts, the offline
table, and only then a decision about whether the token thesis is better served by routing
or by a calibrated compactor. Until that decision exists, a "see also" in the README would
read as an endorsement of a threshold this repo thinks is wrong, and the reasoning belongs
where this repo keeps reasoning.

## Order of work

1. **Discovery** (decision 4). Every downstream number is wrong if the registry is short,
   so nothing else is worth measuring first. The sources table is the acceptance criteria
   and `marketing:brand-review` is the test. Carries two open questions to answer while
   building it: what `installationPreference: "available"` means, and where the Windows
   equivalent of the desktop tree lives. Neither blocks the macOS path.
2. **The `needs_skill` state change** (decision 3) and the `UserPromptSubmit` stdout
   capture (decision 1).
3. **Observe mode and the offline harness**, including the registry fingerprint
   (decision 5).
4. **`suggest` last**, after the table.

One implementation note for step 3: `src/engine/evaluate.ts` takes
`Record<string, number>` and returns a gate-shaped `Decision`, so it is noul-only by type,
and `noulProbability()` drops choice answers on the floor. The adapter speaks `choice`
already; the engine does not. The router needs its own evaluation path rather than a
widened `evaluate()`, which also keeps the gate's rule evaluator the small pure table-tested
thing it is today.

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
