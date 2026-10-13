# ADR-015: The Stop hook watches and never speaks

- **Status:** accepted on 2026-10-12, by the merge of the pull request that added it
- **Date:** 2026-10-12
- **Context for:** 0.2.22
- **Decides:** proposal B of #156
- **Relates to:** ADR-003 (observe by default), ADR-008 and ADR-009 (the engine has consumers; a consumer that sends content says so)

## Context

In thirty days of the owner's session transcripts, 315 of 2,345 typed prompts were short
go-aheads: "proceed" 110 times, "merge it" 25, "go ahead" 15. In each, the agent had
stopped, a person read its last message, decided the next step was already covered, and
typed two words. The cost is not tokens. It is the wait and the attention.

That moment is a bounded judgment made often, which is the shape the research this project
draws on says a judgment model fits (#156 has the sources). It is also one where the labels
already exist: what the user typed after a stop says whether the stop was needed.

Claude Code runs a `Stop` hook at that moment. A payload was captured from 2.1.201 on
2026-10-12 (`test/fixtures/payloads/stop-main.json`). It carries `last_assistant_message`,
`stop_hook_active`, `background_tasks` and `session_crons`, so the closing message is in
the payload and no transcript has to be read to judge it.

A `Stop` hook is not like `PreToolUse`. The worst a gate verdict can do is add a prompt.
A `Stop` hook that prints a `block` decision, or exits 2, keeps the agent working past the
point where it chose to stop. Everything bouncer has promised so far is that it can only
add friction or stay silent. This is the first place it could remove a checkpoint.

## Decision

### 1. The hook emits nothing, in every mode

`bouncer stop` reads the payload, judges, appends one line to `stops.jsonl` in the data
directory, and exits 0 with empty stdout. `runStop` returns nothing, so there is no value
for `src/cli.ts` to print. `mode` in a stop policy is read by nothing.

`test/stop.test.ts` runs the built bundle over hostile input, a broken policy, a missing
key and a go-ahead the set is sure of, and asserts empty stdout and exit 0 each time.

### 2. It is off until the user puts a stop policy in place

The stop set sends content: the end of the agent's closing message, after redaction, to the
backend. That is the judge's rule and not the gate's (ADR-009 decision 4), and unlike
`judge` nobody pointed this at a file. So the bundled `policy/stop.yaml` is not read from
where it ships. A stop policy is looked for in three places and the hook does nothing when
none exists:

1. `$BOUNCER_STOP_POLICY`
2. `<repository>/.bouncer.stop.yaml`
3. `~/.bouncer/stop.yaml`

A repository's file wins over the user's. That is how one project is put in bounds without
the rest, or taken out by a file with no `stop` set.

Redaction catches credential shapes. It does not catch names, paths or prose, and the file
says so where the user copies it from.

### 3. What is asked, and of what

The item is the last 6,000 characters of the closing message, with a field saying whether
the head was cut. A request for a go-ahead is the last thing a message says, and the
vendor's guidance is that accuracy falls as irrelevant state grows.

Three questions, one judgment each, combined by rules in the policy file:

- `asks_go_ahead`: the message ends by asking the user to approve a step it describes.
- `needs_a_decision`: it asks for a choice or for information it does not contain.
- `irreversible_step`: the step it proposes is hard to undo or reaches outside the working copy.

`allow` means "a go-ahead would have followed this" and is logged as `would: continue`.
Anything else is `leave`. A message proposing a merge is `leave` by the third question,
however plainly it asks: that is the cautious reading, and the log keeps every answer so a
different rule can be scored later without a live run.

**Nothing is sent when work is still running.** If `background_tasks` or `session_crons` is
not empty the agent is waiting on a task, not on the user. The line says `skipped` and no
request is made.

### 4. The comparison is a command

`bouncer stops` pairs each logged stop with the next prompt typed in the same session, read
from the transcript the payload named, and prints a two-by-two table: what the set would
have done, against whether the user typed a bare go-ahead. It sends nothing.

The label is a fixed pattern over the user's own words, and it is narrow on purpose:
"proceed" is a go-ahead and "proceed with option 2" is not, because it carries a choice the
agent could not have assumed. The report says it is a heuristic label.

## What would have to be true before the hook does more

Not decided here, and written down so the bar exists before the numbers do.

- A count of stops scored with `bouncer stops` large enough that one session does not move
  it, and the "would have run ahead of you" cell near zero. That cell is the cost: a wrong
  continue is the agent acting where the user would have redirected it.
- Never into anything `irreversible_step` reads as true, and never past a hard rule. A
  continue only ever removes the wait on a step that can be undone.
- The judged text is the agent's own message. An agent that words its stop as "as agreed,
  I will now proceed" is steering its own approver, and a model that has read untrusted
  content may do so on someone else's behalf. The vendor documents that content can steer
  the model. Observing is unaffected; acting on the answer is not, and that change gets its
  own record.
- `stop_hook_active` handled: Claude Code sets it when a stop follows a continuation a hook
  forced, and a hook that continues without reading it loops.

## Consequences

- A second hook process, at each stop and not at each tool call. The `PreToolUse` path does
  not change; the bundle is about 11 KB larger (#134).
- `stops.jsonl` holds the redacted tail of closing messages, on the user's machine, beside
  `decisions.jsonl`, which already holds redacted commands.
- The transcript format is Claude Code's and is not a contract. `src/io/transcript.ts`
  skips what it does not understand, and a format change makes stops unlabelled, not wrong.
- A `Stop` hook registered by a plugin runs for every user of the plugin. For everyone who
  has not opted in it is one process start that finds no policy and exits.

## What was considered and rejected

- **Reading standing instructions into the state** (CLAUDE.md, to ask "is this already
  authorised"). It is the real question. It is also a long, mostly irrelevant state, and
  the first measurement should be the cheap one. If `asks_go_ahead` alone cannot separate
  the cases, this is the next thing to try.
- **Shipping it on in `observe`.** Observe emits nothing here too, but it would send
  closing messages from every project of everyone who updated.
- **A `SubagentStop` hook.** A subagent's stop goes to the agent that called it, not to a
  person, so there is no typed prompt to score against.
- **Continuing on a confident answer from the start.** See the section above.
