# ADR-012: Bouncer does not guard this repository's records, and says what does

- **Status:** accepted on 2026-10-12, by the merge of the pull request that added it
- **Date:** 2026-10-12
- **Context for:** how this repository is governed; no shipped behaviour changes

## Context

This repository is governed by `CLAUDE.md`, the records in this directory, and tests that
encode what those decided. Agents write most of all three. It is also the repository of a
gate on agent tool calls, and that gate is installed on the machine the agents run on, so
the question arrives on its own: does Bouncer protect the files that govern it?

It does not, on three counts, each checked on 2026-10-12.

- **The state has no word for them.** `describeSensitivity` in `src/engine/state.ts` labels
  git internals, ssh configuration, CI workflows, environment and credential files and shell
  startup files. A path under `docs/adr/`, `CLAUDE.md`, `test/holdout/` or `policy/` gets no
  label. The `sensitive_target` question's `criteria.false` names "tests, documentation" as
  what it is not about, so an edit to a record is judged as the ordinary edit it looks like.
- **No hard rule reads a path on a write.** The 19 shipped entries are reads of credential
  files, destructive git, and two SQL statements.
- **In `seatbelt` a judged `ask` emits nothing** (ADR-004), and `seatbelt` is what a session
  under `--dangerously-skip-permissions` runs. One installed log, 5,022 decisions: 48
  hard-rule denies, and 1,753 judged asks that reached nobody. The write that created
  ADR-011 is one of them.

Nothing else blocks either. `main` has no branch protection and no rulesets (#74), so every
check in `ci.yml` reports and none prevents a merge or a direct push. An agent that read a
record forbidding a change could make the change, rewrite the record, and rewrite the test
that pinned it, and each step would be an ordinary edit.

## Decision

### 1. No label, question or hard rule for this repository's own governance files

Bouncer will not treat `docs/adr/`, `CLAUDE.md`, `test/`, `fixtures/` or `policy/default.yaml`
as sensitive, here or in the shipped policy.

Editing those files is the work, not an attack on it. Forty of this repository's merged pull
requests touched a record, `CLAUDE.md` or the holdout; the index's own rule is that a
decision which changed is corrected in place with a dated block, and those corrections are
most of what happens to a record after it is accepted. A hard rule on them would deny every
one of those edits in `seatbelt`, and a question would prompt on every one in `guard`. That
is the failure `CLAUDE.md` names first among the things that sink this project: a gate that
adds more interruptions than not installing it. It would also be a rule about one
repository's layout in a policy file every user copies.

### 2. What stands in its place is a diff a person reads

Three mechanisms, none of which stops an edit and all of which make one visible:

- **A check that fails says which decision it is holding.** A test's title and failure
  message are read at the moment an agent is about to edit past them, by an agent that may
  never have opened the record. So a test that pins a decision names the decision and says
  what to do about a deliberate change, in the text that prints on failure and not only in a
  comment above it. `test/pipeline.test.ts` on the frozen checksum is the model: it names the
  file, prints the digest, and says where it goes.
- **Relaxing a pinned fact takes a second, visible edit.** `test/holdout/FROZEN`, the firing
  list in `test/hardrules.test.ts`, the mode and subcommand lists in `test/docs.test.ts`, the
  version in four places, `CACHE_VERSION`'s shape guard, and now the index of this directory.
  None is tamper-proof. Each turns a silent change into a line in a diff.
- **The pull request.** Review is the only thing that can tell a correction from a rewrite
  that makes a violation agree with itself, because the two are the same edit.

### 3. Platform enforcement is the owner's, and is not on

A ruleset on `main` requiring a pull request and green `check` and `secrets` is what would
make any of the above block. It is #74, it needs the repository owner in Settings, and this
record does not pretend it exists. Until it does, "fails CI" means "is red", not "cannot
merge".

### 4. The user's own policy file is a different question, and stays open

ADR-001, as corrected on 2026-09-30, rests on the acting model being unable to "change the
policy from inside a tool call without that call itself being judged". Judged is true. In
`seatbelt` it is also silent: the same log holds two agent edits of the user-level
`bouncer.yaml`, both judged `ask` on `outside_repo`, neither emitted. That file is not a
record of this repository. It is the thing the gate reads to decide, on every user's
machine, and an agent loosening it is the gate being turned off from inside.

Whether the state should label it, and what should read the label, is not decided here. It
changes shipped behaviour, so it needs a fixture, a question or a rule in the same change
(`CLAUDE.md`: a computed fact is decoration until a question reads it), a bench against the
base, and an answer to the legitimate case: a user who asks an agent to edit their policy.
Tracked as #141.

## Consequences

- No behaviour changes, no version bump, nothing in `bin/bouncer.cjs` moves.
- The next proposal to "have Bouncer protect its own ADRs" has an answer to read first.
- A test that pins a decision without naming it in its failure text is a small defect worth
  fixing when the file is next open, not a sweep.
- The honest description of this repository's governance is: written rules, checks that
  explain themselves, and one reviewer. That is weaker than it sounds when sessions run in
  parallel and merge as they go, which is the argument for #74 and not for a rule here.

## What was considered and rejected

- **A `governance_file` label with a hard rule.** Decision 1. Deterministic friction is the
  worse kind: a model can be recalibrated and a rule cannot be argued with.
- **A label with a question and an `ask` rule only.** No friction in `seatbelt`, because it
  emits nothing there, which means no protection for the population that has none; and a
  prompt on every correction in `guard`.
- **A read-only `docs/adr/`** by permission settings. Agents draft the records here, and a
  rule that says "this needs an ADR" beside a folder nobody may write to leaves no legal
  move but to stop.
- **Checksumming the records the way the holdout is frozen.** The holdout is frozen because
  it must not move while a policy is tuned. A record is supposed to move when it is wrong.
