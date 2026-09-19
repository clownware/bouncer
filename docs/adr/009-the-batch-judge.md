# ADR-009: `bouncer judge`, the batch consumer — and the three format changes it forced

- **Status:** accepted
- **Date:** 2026-09-18
- **Context for:** v0.3 (`bouncer judge`, `bouncer measure`), v0.4 (package extraction)
- **Numbering:** the next free number, per PRD §13. Nothing planned 009.

## Context

[ADR-008](008-bouncer-is-a-judgment-engine.md) said the engine is the product and the
PreToolUse gate is one consumer of it, then deliberately deferred two format changes —
the policy file naming more than one set, and fixtures being items rather than hook
payloads — on the grounds that a schema change with no second consumer is churn. This is
the change that has the second consumer, so both land here, and a third one turned up
that ADR-008 had not seen: the decision log's line shape.

`bouncer judge` runs a policy set over a batch of items and writes a judgments log and an
escalation manifest. It is also the first thing in this repository that can put a number
on the claim the whole project rests on, so it comes with `bouncer measure`.

## Decision 1 — the policy file names several sets, and `gate:` keeps working forever

```yaml
policies:
  gate:            # the PreToolUse consumer; may carry tools / fast_path / hard_rules
    tools: [Bash, Edit, Write, NotebookEdit]
    questions: { ... }
    rules: [ ... ]
  content:         # any other set: questions, probe_questions, rules. Nothing else.
    questions: { ... }
    rules: [ ... ]
```

**`gate:` at the top level stays a supported spelling, not a deprecated one.** It reads as
`policies.gate` and loads with no warning, now and later. Two reasons, and the second is
the one that decides it:

- Every policy file in existence is written that way, including the one this repository
  ships and the one every calibration run so far was scored against.
- ADR-003's friction rule is not only about the prompt. A deprecation warning on a file
  that works, printed to a user who has nothing to fix, is friction with nothing behind
  it. `gate` is a name the engine has to know anyway — it is what the hook looks up — so
  spelling it at the top level costs the loader one branch and costs the user nothing.

Both spellings at once is an **error**. Which one wins is not guessable, and guessing
would mean silently judging tool calls against rules the user thought they had replaced.

**Only `policies.gate` may carry `tools`, `fast_path` and `hard_rules`.** Those three
reason about a Claude Code tool name or a shell command, so they belong to that consumer
(ADR-008 decision 1). On any other set they are an error rather than a warning, because
the failure mode is silence: a `hard_rules` block on a `content` set would load, read
correctly, and never once fire.

## Decision 2 — a fixture is an item with labels

```jsonc
// before: a hook payload with labels
{"id":"rm-build-dir","tool":"Bash","input":{"command":"rm -rf ./build"},"expect":{...},"note":"..."}

// after: an item with labels, and a kind that picks the state builder
{"id":"draft-42","kind":"item","item":{"title":"...","text":"..."},"expect":{...},"note":"..."}
```

A line with a top-level `tool` and no `kind` is read as `kind: "tool_call"`, with `tool`,
`input`, `cwd`, `permission_mode` and `target_exists` lifted into `item` unchanged. So
`fixtures/gate.jsonl` does not change by a byte, and neither does what it scores:
`bouncer calibrate --backend mock` prints a report identical to the pre-change build's, and
every scored number in `--json` — accuracy, Brier, every bucket, every gate row — is
identical too. (`--json` echoes each miss's fixture, so those objects carry the new shape;
nothing computed from them moves.) That is the check that runs 1 through 8 remain
comparable with whatever run 9 turns out to be. A calibration table whose fixtures quietly
changed shape underneath it is worth nothing, and this is the cheapest possible way to be
able to say they did not.

`kind` selects the `StateBuilder<TItem>` the fixture is built with. `tool_call` is
`toolCallState`; `item` is the generic builder `judge` uses. A fixture set names the policy
set it is scored against on the command line (`calibrate --set content`), not in the file:
the same batch scored against two policy sets is a thing someone will want to do, and a set
name baked into every line would make that an edit rather than a flag.

## Decision 3 — the log line gains `consumer` and `set`; `source` is left alone

`judge` writes the same JSONL line shape the gate writes, into its own file. Two fields are
new and one existing field was **not** reused:

- `consumer`: `"gate"` or `"judge"` — which entrypoint wrote the line.
- `set`: the policy set's name.
- `source` keeps its existing meaning, which is *which layer decided*: `hard_rule`,
  `fast_path` or `judge`. That third value means the classifier, and it predates this
  command. Overloading it with "the `bouncer judge` CLI" would silently reclassify every
  line already written and break the one query the field exists for.

`tool` becomes optional, because an item is not a tool call. Every reader of the log —
`bouncer status`, `/bouncer:explain`, `calibrate --from` — treats an absent `tool` as an
item line rather than a malformed one.

## Decision 4 — the judge's state carries the item's content; the gate's never does

PRD §9 says file contents never leave the machine, and the gate holds to that absolutely:
`Write.content` and `Edit.old_string` become byte counts, because what the gate is judging
is *the action*, and the bytes are not the subject.

For `judge` the item **is** the subject. Scoring a draft against a policy without sending
the draft is not a stricter version of the same feature, it is a different and useless one.
So the generic builder puts the item's own fields in the state, and:

- `redact()` runs over every string, exactly as it does for the gate, so a credential
  pasted into a batch does not leave the machine even when the batch does;
- the state is capped and truncation is recorded, so an oversized item is visibly
  truncated rather than quietly half-judged;
- the README says plainly that `judge` sends the items you point it at, and that the local
  adapter (ADR-005) is the answer for a batch that cannot leave the machine.

This is not a reversal of §9. §9 is about a hook that runs on every tool call, on content
the user never chose to send. `judge` is a command the user points at a directory.

## Decision 5 — measurement is three rows, not two

`bouncer measure` runs one labelled batch three ways and prints them side by side:

| row | what runs | what it answers |
|---|---|---|
| `judge` | the policy set over every item | how good is the fast model alone |
| `reasoning` | the reasoning pass over every item | the quality ceiling, and the bill |
| `cascade` | judge everything; send only the escalation manifest's items to the reasoning pass | **the actual claim** |

The third row is the one that matters and the reason not to ship two. "The judgment model
is 0.89 and the reasoning model is 0.94" is not the product; the product is "judge
everything, re-adjudicate the 12% it flagged, and land at 0.93 for a fraction of the
tokens." A cascade's accuracy is not the judge's accuracy, and neither is its bill. Each
row reports accuracy against the fixture labels, input and output tokens per item, and the
cascade row also reports `escalated / judged`.

TypeSafe's own extraction-cascade cookbook builds the same shape and reports it as a
quality-versus-cost frontier, with a max-style gate — escalate if *any* signal crosses,
rather than averaging signals. Bouncer's escalation manifest is already max-style by
construction: it lists every threshold an item crossed (ADR-008), and a single crossing is
an escalation. That the two arrived at the same gate independently is worth recording, and
it is a reason to be suspicious of any later change that starts averaging.

Tokens are reported; money is not. A price per million is a number that goes stale, and
putting one in `src/` would be the same mistake as a threshold in `src/`. The README does
the arithmetic against published rates and dates it.

## Decision 6 — the reasoning pass is a command, not a client

`measure` shells out to a command the user supplies (`BOUNCER_REASONING_CMD`), handing it
the item and the questions as JSON on stdin and reading `{answers, input_tokens,
output_tokens}` back on stdout.

- **Zero runtime dependencies survives.** No second API client, no second auth path, no
  vendor in the bundle.
- **No key handling.** Bouncer never sees one. The user's own CLI already has whatever
  credentials it has.
- **Any reasoning model.** `claude -p`, an `llm` invocation, a local model, a shell script
  that reads from a cache. The claim being measured is about a *class* of model, so
  hardcoding one vendor's client would undercut the claim it is measuring.
- **Testable.** CI runs it against a fixture script; no key exists in any automated run.

The cost is that the recipe is documentation rather than code, so the README carries a
worked invocation that has actually been run.

## What `judge` bent in the interface — the input to v0.4

ADR-008 decision 3 says no `packages/core` until a second consumer has forced the
interface. It has, in four places, and these are what v0.4 extracts against rather than
what the gate happened to need:

1. **`evaluate()` was still gate-shaped one level up.** It took a whole `Policy` and read
   `policy.gate.rules` and `policy.mode` out of it, which is the exact reach-through
   ADR-008 said should not exist below the entrypoint. It now takes a `PolicySet` and a
   `Mode`. This was the only change to a hot-path function in the whole of v0.3.
2. **`StateBuilder<TItem>` had no redaction contract.** `BuiltState.redactedKinds` implied
   one without saying whose job it was; with one implementation the answer was obvious and
   unwritten. It is now written on the interface: a builder redacts, and a consumer may
   assume it did.
3. **The escalation manifest's optional `state` became the point.** For the gate it is
   dead weight beside a log line that already has the string; for a standalone manifest it
   is the artifact. The field was designed for this and is the one part of ADR-008 that
   needed no change at all.
4. **`Fixture` was a hook payload wearing a label set**, which is decision 2 above.

Three of the four are naming or contract; one is a signature. That is roughly what ADR-008
predicted, and it is the evidence that v0.4's extraction is now worth doing.

## Consequences

**Good.** The second consumer exists and is about 300 lines of new code over an unchanged
engine, which is what ADR-008 was buying. The token claim is measurable on the user's own
batch rather than asserted from a benchmark. `calibrate` scores a judge log, so a batch run
in anger becomes fixtures.

**The cost.** Three user-facing formats moved in one release. The policy file and the
fixture file both keep their old spelling working and are covered by tests that assert the
old spelling still produces the same result; the log's new fields are additive. The
migration risk is real and is concentrated in the policy loader, which is why the cache
version is bumped — ADR-007's cache would otherwise deserialise a v2 entry into a policy
with no `sets` at all, which is the failure ADR-007's own version guard exists for and
which #22 had to fix once already.

**The risk to watch.** `judge` sends content, and the gate does not. Those two sentences
are one paragraph apart in the README on purpose. If a later change lets the gate's state
builder near file contents because "judge does it", that is the line being crossed.

## What was considered and rejected

**A `judge:` block beside `gate:` rather than a `policies:` map.** It reads well for
exactly two sets and then stops: the third set has nowhere to go, and `judge` is a command
name, not a policy name. A user scoring support tickets and blog drafts wants two sets,
neither called `judge`.

**Deprecating `gate:` with a warning.** Rejected on the friction rule; see decision 1.

**A `--set` field inside each fixture line.** Rejected in decision 2: it makes scoring one
batch against two sets an edit instead of a flag.

**Escalating on the classifier's own uncertainty rather than the policy's rules.** That is,
"escalate anything between 0.4 and 0.6" as a built-in. It is a threshold in code, and the
policy file already expresses it as a rule (`any: { p: "0.40..0.60" }`) that the user can
move. The manifest reports what the rules said, not what the engine thinks is uncertain.

**Making `measure` call the reasoning model in-process.** See decision 6.
