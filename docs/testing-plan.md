# Testing plan

What Bouncer measures today, what those measurements cannot say, and the A/B that is meant
to answer the part they leave open: does installing this plugin make a real agent session
better or worse.

Written 2026-09-19, against `main` at 0.2.3. Everything below is either something the
repository can do today or is marked as not built.

## The one question the existing measurements do not answer

Bouncer's premise is that it reduces interruptions. Every number published so far is about
whether a verdict was *correct*, on a corpus somebody wrote. None of them is about whether
a session with the plugin installed goes better than the same session without it, which is
the claim a user is actually buying.

That is what the A/B in §3 is for. §1 is the ground it stands on, because an A/B that
re-measures what the fixture table already covers is wasted runner time.

## 1. What is measured today

| harness | corpus | what a passing result claims |
|---|---|---|
| `bouncer calibrate` | `fixtures/gate.jsonl`, 104 hand-labelled near-miss cases | the classifier agrees with the labels, per question, in confidence buckets, with a Brier score |
| the §12 gate in the same run | the same fixtures | every question clears 0.85 accuracy among answers at confidence ≥ 0.80 — the release gate, published in the README and written up under [docs/calibration/](calibration/) |
| `calibrate --from <answers>.jsonl` | a committed answers file, e.g. [2026-09-19-jev-9.jsonl](calibration/2026-09-19-jev-9.jsonl) | what a *threshold* change does to a run already paid for, with no key and no network |
| `test/pipeline.test.ts` over `test/holdout/cases.jsonl` | 66 frozen cases in seven groups | the built `bin/bouncer.cjs`, driven over a real PreToolUse payload, emits the right thing and logs the right `source` |
| `test/fastpath.test.ts` | generative over every `gate.fast_path` entry in the policy | no entry can be driven into printing a secret or taking a redirect, whatever argument it is given |
| `test/hardrules.test.ts` | the fixture set | the hard rules fire on exactly the named fixtures and add no friction |
| `scripts/bench.mjs --against <bundle>` | one synthetic payload, interleaved pairs | this change's hook overhead against the base commit's, paired on one machine; CI fails a paired median more than 10% worse ([ADR-007](adr/007-cache-the-compiled-policy.md), `ci.yml`) |
| `bouncer measure` | a labelled batch | judge alone vs a reasoning command alone vs the cascade, with accuracy and tokens on each row |

### What each of them is structurally unable to say

- **`fixtures/gate.jsonl` cannot say anything about the fast path or the hard rules.**
  Neither reaches the classifier. It also cannot say what the policy would *do*: accuracy
  is scored at 0.5 and rules fire at their own thresholds. The harness reports friction
  separately, and that section is the one to read.
- **The holdout says nothing about whether an answer was right.** Every judgment in it is
  the mock backend's. A judged case is a claim about routing and disposition only, which is
  why it keeps dangerous false accepts on purpose.
- **The bench measures one payload on one machine.** It answers "did this change make the
  hook slower", not "what does the hook cost a user". The absolute number is a property of
  the machine: unchanged `main` has read p95 36 ms on an M4, 102 ms on an agent container
  and 151 ms on a CI runner.
- **`bouncer measure` has no real batch yet** (issue #75). Every number it has produced came
  from `test/fixtures/reasoning/oracle.mjs` answering from a lookup table, which is the
  plumbing working rather than a result.
- **None of them involves an agent doing work.** A fixture is a command somebody typed into
  a JSONL file. The distribution of commands a real Claude Code session makes is not that
  distribution — the fast path matched 0 of 88 real calls the first time real traffic was
  looked at.

## 2. What only an A/B can answer

Three things, in order of how much they matter:

1. **Friction.** How many more prompts does a session with Bouncer see than the same
   session without it. CLAUDE.md's failure mode is stated as a comparison against not having
   the plugin installed, and nothing in §1 makes that comparison.
2. **Wrong denies on real work.** A hard rule or a `deny` threshold that stops a command an
   agent legitimately needed. The fixture corpus cannot contain these, because nobody writes
   a fixture for a command they have not seen an agent issue.
3. **Cost per session.** The classifier's per-call cost is known and small. What is not
   known is the total over a session's real call count, and whether a prompt Bouncer adds
   costs more in re-planning tokens than the call it gated.

A fourth thing an A/B produces as a by-product, and arguably the most valuable: **real
traffic to label**. A decision log from an agent doing a real task is the corpus
`fixtures/gate.jsonl` is missing.

## 3. The A/B

Two Claude Code on the web environments, identical except that one installs the plugin.
The same task runs in each; the decision log and the run's own JSON result are the record.

### 3.1 What is verified

Checked in a cloud container on 2026-09-19, in this repository's own environment:

- `claude plugin marketplace add clownware/bouncer` and
  `claude plugin install bouncer@bouncer` both succeed in the container, non-interactively,
  and write `~/.claude/plugins/` plus the two settings keys.
- The `PreToolUse` hook **fires in a headless `claude -p` session** and appends to
  `~/.claude/plugins/data/bouncer-bouncer/decisions.jsonl`, with the same line shape an
  interactive install writes — `source: fast_path` on `ls -la .`, `source: judge` with the
  seven answers on a chained command.
- `claude -p --output-format json` returns `duration_ms`, `num_turns`, `permission_denials`,
  `total_cost_usd` and a `usage` block on the result object. That is the per-run record, and
  `permission_denials` is the friction counter.

### 3.2 Three traps found while verifying it

- **`--dangerously-skip-permissions` is refused when the container runs as root**, with
  "cannot be used with root/sudo privileges for security reasons". The container this was
  checked in runs as root, so the bypass population — the one `seatbelt` exists for, and the
  stricter of the two baselines in the README's friction table — **cannot be A/B'd this way
  unless the environment runs as a non-root user.** The prompted population (`default`,
  `acceptEdits`) can.
- **`CLAUDE_PLUGIN_DATA` set in the environment does not redirect an installed plugin's
  log.** Set to a scratch directory before launching, the log still landed in
  `~/.claude/plugins/data/bouncer-bouncer/`: Claude Code sets that variable for the plugin
  itself. Separate the arms by giving each run its own `HOME`, or by moving the log aside
  between runs. (`npm run bench` sets the variable and it works there because the bench
  drives `bin/bouncer.cjs` directly rather than through Claude Code.)
- **`session_id` was not per-run.** Three separate `claude -p` invocations in this container
  all logged the same `session_id`. Join a run to its log lines by which log file it wrote,
  not by that field, until it has been checked in whatever environment the runs happen in.

### 3.3 The two environments

Identical, except the Bouncer arm's setup script runs:

```bash
claude plugin marketplace add clownware/bouncer
claude plugin install bouncer@bouncer
```

and the environment carries `BOUNCER_TYPESAFE_API_KEY`. The control arm runs neither and
carries neither.

A caveat that has to be checked before the first real run: the environment's setup script
and the session's Claude Code must share a `HOME`, or the install lands where the session
will not look. The verification above ran both in one shell.

### 3.4 What is held constant

Everything that is not the plugin:

- **the task** — the same prompt, the same repository, the same starting commit;
- **the model**, pinned explicitly rather than left to default;
- **the permission mode**, which decides what a Bouncer `ask` can even do;
- **the plugin version**, recorded from `.claude-plugin/plugin.json`, because a mid-series
  bump changes what the arm is;
- **the policy**, recorded as the `policy.file` and `policy.questions` fingerprints that
  every log line already carries — two runs whose fingerprints differ are not two arms of
  one experiment;
- **the backend**. `mock` answers from keyword heuristics and is not evidence about `jev`;
  a run meant to say something about the shipped product uses `jev`.

Run each task several times per arm. An agent session is not deterministic, and a single
pair cannot separate the plugin from the sample — the same lesson the bench learned the
expensive way (see CLAUDE.md on paired measurement, and
[ADR-007](adr/007-cache-the-compiled-policy.md)).

### 3.5 What to record per run

| field | where it comes from |
|---|---|
| arm, task id, repetition | the harness |
| model, permission mode, plugin version, policy fingerprints | the harness; the fingerprints are on every log line |
| wall clock, turns, cost, token usage | the `--output-format json` result object |
| prompts the session hit | `permission_denials` on the same object |
| every gated call: tool, redacted state, verdict, emitted, source, answers, latency | `decisions.jsonl` (Bouncer arm only) |
| task success | a person, or a task-specific check — see §4 |

The control arm writes no decision log. Its comparable numbers are the result object's, and
the point of comparison is `permission_denials` and the cost.

**Anything driving the hook in bulk keeps out of a real `~/.bouncer/decisions.jsonl`.** The
decision log is evidence, and a line that was not a real judgment is a wrong number in front
of someone deciding whether to enable enforcement. An A/B run is real traffic and belongs in
a log, but it belongs in the run's own log, not in the operator's.

## 4. Scoring a run

Three numbers and a judgment.

- **Friction** is the difference in prompts between the arms on the same task. Under
  `observe` this is expected to be zero, and a non-zero result is a bug in the strongest
  sense CLAUDE.md gives the word. Under `guard`, `full` or `seatbelt` it is the number the
  whole project is measured on.
- **Blocked work** is any call the Bouncer arm stopped that the control arm made and that
  the task needed. Read it off the log: `emitted` is what reached stdout, and `source` says
  which layer decided. A `hard_rule` block and a `judge` block are different problems with
  different fixes (§5).
- **Cost** is the result object's, plus the classifier's calls, which the log counts.
- **Task success** is a person's call unless the task has a check of its own. Prefer tasks
  that do: a task whose success is "did the test suite go green" needs no adjudication, and
  an A/B whose primary outcome is adjudicated by whoever ran it is worth less than one whose
  primary outcome is an exit code.

## 5. Feeding it back

The loop already exists, in [docs/dogfooding.md](dogfooding.md) §5. A wrong verdict on real
traffic becomes a fixture before it becomes a threshold change:

1. Find the line in the log; take its `ts`, `source`, `verdict` and `answers`.
2. Write a fixture in `fixtures/gate.jsonl` with a `note` saying why the label is what it
   is. `note` is required — an unexplained label cannot be argued with later.
3. A miss in `hard_rule` is a rule change and does not touch the classifier. A miss in
   `judge` is either a question's wording or a threshold.

What each of those costs is not the same, and this is the part to get right before
promising a turnaround:

- **A threshold move is cheap.** It is one number in `policy/default.yaml` — never in
  `src/` — and `calibrate --from` re-scores a committed answers file against the new number
  with no key. That is how the dead band was closed in #50 / PR #81, and the CHANGELOG entry
  for 0.2.3 quotes the re-score: no fixture's verdict moved.
- **A rewording is expensive.** It invalidates the published calibration table and costs a
  live run, which only Chris can make. The published table is a claim about the questions
  that ship; a reworded question is a different question.
- **Adding a fixture without a rerun is caught by a test**, by name, since run 9 committed
  its answers. That is deliberate: the table must not quietly start describing something
  else.

A threshold decision wants both corpora, not one. The `#50` decision is the shape of it:
it read the fixture answers for what moved, and an installed log of 1,045 judged calls for
whether anything real fell in the gap. An A/B's decision log is the second of those, and a
better one, because it comes from an agent working rather than from a person using Claude.

## 6. Not built

Marked as such so nothing here reads as if it exists.

- **There is no A/B harness.** No script runs the two arms, no schema for a run record, no
  report. §3 is a design, verified in its load-bearing parts and nothing more.
- **There is no exporter from a decision log to fixtures.** `calibrate --from` joins a gate
  log to fixtures on `tool_use_id`, so re-scoring real traffic means a fixture file whose
  ids are that log's `tool_use_id`s, built by hand today.
- **`bouncer status` has no machine-readable output.** Scoring a run means reading
  `decisions.jsonl` directly.
- **The bypass arm is blocked** by §3.2's root finding until an environment can run as a
  non-root user.
- **`bouncer measure` still has no real batch** (issue #75), which is a separate gap from
  this one: that is about the batch judge's claim, this is about the gate's.
