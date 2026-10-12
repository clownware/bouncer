# ADR-013: The gate's own policy file is a hard-rule target

- **Status:** accepted on 2026-10-12, by the merge of the pull request that added it
- **Date:** 2026-10-12
- **Context for:** 0.2.16
- **Decides:** the question ADR-012 decision 4 left open (#141)
- **Amends:** ADR-004, with an eighth predicate, `target_labelled`

## Context

ADR-001, as corrected on 2026-09-30, rests on one sentence: the acting model "cannot change
the policy from inside a tool call without that call itself being judged". Judged was true.
What the judgment did depended on the mode, and in the mode that matters it did nothing.

One installed log, read on 2026-10-12, holds two agent `Edit` calls on the user-level
`bouncer.yaml`. Both were judged `ask`, on `outside_repo`. Neither emitted anything, because
in `seatbelt` a judged `ask` is dropped: there is no prompt for it to reach (ADR-004). So
under `--dangerously-skip-permissions`, the population `seatbelt` exists for, an agent could
set `mode: observe` in the file that gates it and continue ungated, with a log line as the
only trace.

Two things stood in the way of saying anything about it:

- **The state had no word for the file.** `describeSensitivity` labelled git internals, ssh
  configuration, CI workflows and credential files. The policy came through as
  `outside_location: user_dotfiles`, or as an ordinary file inside the project.
- **A hard rule could not see a `Write` or an `Edit` at all.** Every predicate read a command
  line, and `commandOf` returns the empty string for any tool but `Bash`. The 19 shipped
  entries could stop `cat .env` and had no way to mention the tool an agent edits a file with.

ADR-012 decides the opposite for this repository's own records, and the difference is the
whole argument. A record is supposed to be edited; correcting one is the work. The policy
file is the thing the gate reads to decide, and an agent loosening it is not doing the work,
it is choosing its own supervision.

## Decision

### 1. A label: `gate_policy`

`describeSensitivity` returns `gate_policy` for the two names `resolvePolicy` looks for: a
file called `.bouncer.yaml` or `.bouncer.yml` anywhere, and `bouncer.yaml` or `bouncer.yml`
inside a `.bouncer` directory. By name, because the engine does no I/O and is not told which
file was loaded.

Not labelled, each on purpose:

- **`policy/default.yaml` in a checkout of this repository.** It is source (ADR-012).
- **A file that only shares the name**, such as `docs/bouncer.yaml`, and a backup beside the
  policy, such as `bouncer.yaml.bak`.
- **A policy named by `$BOUNCER_POLICY`.** It can be called anything. The override is
  documented as mostly for tests; someone who points it at a real policy has a file this
  does not recognise, and the comment in the code says so.
- **The data directory**: the decision log, the breaker state and the policy cache. See "What
  this does not decide".

### 2. An eighth predicate: `target_labelled`

`target_labelled: [label, …]` holds when the file a `Write`, `Edit` or `NotebookEdit` would
change carries one of the labels. It is never true of `Bash`, which names no target.

It is a new predicate rather than a wider reading of `path_labelled` because the two mean
different things and the difference is the friction. `path_labelled` is true of any command
that mentions the path, including `cat` and `grep`. An entry that stopped every mention of
the policy would stop an agent reading it, which is how it explains a verdict and what
`/bouncer:explain` is for.

`matchHardRule` takes the target as a third argument. A call with a target and no command is
given one empty command's worth of facts, so the predicate has something to be asked about
and every predicate about a command line fails on it.

### 3. Three shipped entries

| entry | when | catches |
|---|---|---|
| `edits-the-gate-policy` | `target_labelled: [gate_policy]` | every `Write` and `Edit` of the file |
| `removes-or-overwrites-the-gate-policy` | verb is `rm`, `unlink`, `shred`, `mv`, `truncate` or `tee`, and a path is labelled | deleting it, moving it away, emptying it, piping onto it |
| `edits-the-gate-policy-in-place` | verb is `sed`, `gsed` or `perl`, a token starts with `-i`, and a path is labelled | the in-place edit |

They ship as `ask`, like every entry. `seatbelt` promotes them to `deny`.

The test for a hard-rule entry is whether every command it can match deserves the verdict
(ADR-004), and that is what kept the list this short. With no policy file bouncer is not set
up and says nothing at all, so `rm` and `mv` are the quietest way to stop being gated, and
neither has a harmless reading with the policy as an argument. `sed -n` on the policy is a
read, and `-i` is what makes it a change.

### 4. In `seatbelt`, the way through is to edit the file yourself

A user who asks an agent to change their policy gets a prompt in `guard` and `full`, which is
one keystroke. In `seatbelt` the edit is denied and the reason says to edit it yourself.

That is friction, chosen. ADR-003's case against `deny` is that a false positive sends the
model off to do something else, unseen. Here the denial is the product working: the session
is one nobody is watching, the file is the one that says what such a session may not do, and
the edit is rare. In the log this started from it is 2 calls in 5,022.

## What it does not catch

Stated because a gap that is known and written down is a different thing from one that is
found later. Both are in `test/holdout/cases.jsonl` as named dangerous false accepts, so the
suite asserts them rather than hiding them.

- **`cp <something> ~/.bouncer/bouncer.yaml`.** `cp` is on no entry because the verb cannot
  say which argument is written: the same command with the arguments swapped is a backup,
  and a deny on a backup is the friction this project exists to avoid. It is judged.
- **A redirect, `echo … > ~/.bouncer/bouncer.yaml`.** The matcher does not resolve
  redirections. It is judged.
- **A script.** `python -c`, `node -e`, a heredoc into an interpreter. Nothing deterministic
  reads those, here or for any other entry.

Judged, in `seatbelt`, means silent. So this closes the route an agent takes without trying,
which is the `Edit` tool, and the obvious shell verbs. It does not make the policy
tamper-proof against a model that is looking for a way round, and ADR-001's sentence should
be read with that limit. Closing the redirect needs a predicate for a redirect's target,
which is its own change.

## Consequences

- **Version 0.2.16**, because an installed bouncer behaves differently once its policy
  carries the entries.
- **A copied policy does not get them.** The entries live in `policy/default.yaml`, and a
  user's own file keeps what it had (#126 is the same gap). The changelog gives the block to
  paste.
- **A policy with `target_labelled` needs 0.2.16.** An older bouncer rejects an unknown
  predicate as an error and stops enforcing, with one message per session saying so. That is
  the loader's rule for a misspelt key and is the safe direction, and the policy's comment
  names the version, as `token_prefix`'s does.
- **`CACHE_VERSION` moves from 7 to 8**: `HardRuleWhen` gained a field, and
  `test/policycache.test.ts` pins the compiled shape to that number.
- **Latency.** Three entries are YAML nodes, about 0.37 ms each on a cold parse and nothing
  on a cached one (ADR-004, ADR-007). The label is two regular expressions on a path, run
  only when an entry asks. The paired bench against the base commit is in the pull request.
- **The state changes for a write to the policy file**: it carries `sensitive: gate_policy`.
  No fixture in `fixtures/gate.jsonl` targets one, so no calibration run moves.
- **No question was reworded.** `sensitive_target` could have named the file in its
  `criteria.true`; that would move the questions fingerprint and set every recorded answer
  aside for a case a rule already decides.
- **Attack surface is reduced**, not added: no new endpoint, input or file read.

## What was considered and rejected

- **`path_labelled` alone, on every tool.** Decision 2: it stops reads.
- **A question and an `ask` rule.** Emits nothing in `seatbelt`, which is where the problem
  is, and was already the behaviour: `outside_repo` asked and nobody heard.
- **Passing the resolved policy path into the engine**, so a `$BOUNCER_POLICY` file is
  recognised too. It makes `matchHardRule` depend on where the hook found its configuration,
  which is the kind of thing ADR-008 keeps out of the engine, for an override meant for tests.
- **Listing `cp`.** "What it does not catch".
- **Making the entries `deny` in every mode.** A prompted user can be asked, and should be.

## What this does not decide

Whether the data directory deserves the same treatment. The policy cache holds a compiled
policy beside the source text it was compiled from (ADR-007); an entry whose text matches and
whose compiled half was rewritten would be loaded as the policy. The breaker file can stand
bouncer down for a session. Neither has been observed and both need a write no agent makes by
accident, so they are recorded here and not built. A redirect-target predicate, likewise.
