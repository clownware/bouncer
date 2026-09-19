# Bouncer — working notes for Claude

A decision layer for Claude Code hooks. A `PreToolUse` hook classifies the proposed tool
call against a policy the user owns and returns allow / ask / deny, using a fast System One
model (TypeSafe Jev) instead of a frontier LLM. Ships observing only.

Read `docs/PRD.md` for the product spec and `docs/adr/` for decisions already made and
the reasoning behind them. The ADRs win over the PRD where they disagree — several PRD
details were corrected once the hook payloads and the Jev API were actually verified.

## The rules that matter

**Never exit 2.** Claude Code treats exit 2 from `PreToolUse` as "block this tool call",
regardless of stdout. A crash that exits 2 silently breaks the user's session. Uncaught
Node exceptions exit 1, which is a safe non-blocking error. There is a test asserting this;
do not weaken it.

**Never fail open, never fail loud.** Every error path — timeout, 401, 429, unparseable
policy, internal crash — resolves to emitting no decision, which falls through to Claude
Code's normal permission flow. Bouncer being broken must never be why something dangerous
ran, and must never be why a session is unusable.

**Adding friction is the failure mode.** The entire premise is reducing interruptions. A
change that makes Bouncer prompt more often than not having it installed is a bug, even if
every individual verdict is correct. This is why observe mode emits nothing rather than
`ask` (ADR-003).

**Latency is a feature.** The design target for hook overhead is 80 ms p95, and the gate is
relative: CI runs `bench --against` the base commit's bundle and fails a change that makes
the paired median more than 10% worse (the number lives in `ci.yml`). `npm run bench` prints
the target and does not enforce it, because an absolute number measures the machine —
unchanged `main` read p95 36 ms on the M4, 102 on an agent container before the policy cache, and 151 on a runner
(#73). Adding a dependency has a direct, measurable cost — bundling is what keeps startup at
~45 ms rather than ~87 ms (ADR-002). After anything that touches imports, run
`git show origin/main:bin/bouncer.cjs > "$TMPDIR/base.cjs"` and
`node scripts/bench.mjs --against "$TMPDIR/base.cjs"`; two unpaired runs cannot answer it.
If the change touched `policy/default.yaml` too, give the base arm the base's policy with
`--against-policy`: a bundle that cannot load the policy it is handed stops enforcing, does
no work, and reads as the faster arm (+8.8% for a change that cost nothing, #84). The bench
now refuses to time an arm in that state.
Two things measured since: YAML parse cost tracks node count rather than file size, so a
structured block costs about 5x what the same bytes cost as comments (ADR-004), and the
compiled policy is cached on disk, so the bench measures the cached path unless you set
`BOUNCER_NO_CACHE=1` (ADR-007). `--against` gives each arm its own `CLAUDE_PLUGIN_DATA` and
prints each bundle's `CACHE_VERSION`, because two bundles either side of a bump evicted each
other's cache entry and the flag then measured the cold parse and called it the diff — 32 ms
on both arms and the wrong question, with the pairing still cancelling machine drift so it
all looked sound (ADR-007, 2026-09-19). `node:crypto` is not free either — its first `require` in a
CJS file costs 10 to 15 ms, which is why nothing in the hot path hashes anything.

**The decision log is evidence, so only real judgments belong in it.** `bouncer status`
summarises it, `calibrate --from` re-scores it and ADR-006's offline replay reads it, so a
line that was not a real judgment is a wrong number in front of someone deciding whether to
enable enforcement. Two consequences. A line names the adapter that answered —
`$BOUNCER_BACKEND ?? policy.backend`, resolved by `backendName()` — never the one the
policy asked for. And anything that drives the hook in bulk sets `CLAUDE_PLUGIN_DATA` to a
scratch directory rather than inheriting the user's: `npm run bench` did not, and left
hundreds of mock verdicts over one hardcoded payload in a real `~/.bouncer/decisions.jsonl`,
which `status` then reported as a 100% ask rate. `status` sets mock-backend lines aside for
the same reason, unless the policy names `mock` itself.

**Anything that reads the decision log resolves it through `dataDir()`.** Claude Code
exports `${CLAUDE_PLUGIN_DATA}` to hook processes and to MCP and LSP subprocesses, and
documents that it is absent from commands run through the Bash tool — which is what a slash
command is. So the hook wrote `~/.claude/plugins/data/bouncer-bouncer/decisions.jsonl` while
`status`, `explain`, `calibrate --from` and the policy cache read `~/.bouncer`, and `status`
reported "No decisions logged yet" over a thousand real decisions with nothing erroring
(PR #69, shipped in 0.2.1). The general rule is the one to carry: never assume a plugin
environment variable reaches anything but a hook, and never hardcode `~/.bouncer` — it is
the fallback, not the location. A unit test on the resolver cannot see this, which is why
`test/datadir.test.ts` runs the built bundle twice, once with a hook's environment and once
with a bare one, and asserts they meet on one file.

**No thresholds in code.** Questions are plain English and thresholds are numbers, both
living in the user's YAML. If you find yourself writing `if (p > 0.8)` in `src/`, the
number belongs in `policy/default.yaml` instead.

**A fast-path entry must be safe for every argument it could be given.** Entries in
`gate.fast_path` are never judged, so the test is not "is this command usually harmless"
but "is every form of it harmless". That excludes anything printing file contents —
`cat`, `head`, `tail`, `wc`, `git diff`, `git show`, `git log` — because `cat .env` and
`echo $OPENAI_API_KEY` are the literal examples in the `secrets` question's own criteria.
Fast-pathing the verb means the gate's headline question can never fire.
"Every argument" includes the ones that are not the verb's: a redirect (`ls > ~/.ssh/authorized_keys`
took the fast path until the matcher refused `<` and `>`) and a subcommand behind a flag
(`git remote -v remove origin` works, which is why `git branch` and `git remote -v` are no
longer entries). It also includes a flag: `git status -v` prints the diff of what is staged
and `-vv` adds the unstaged one, which is `git diff` under another name, so `git status` is
five whole commands rather than one entry taking arguments. Check a candidate by driving the
built hook with its worst argument, not by reading the list — `test/fastpath.test.ts` does
exactly that, and its generative half checks every entry the policy lists, so an entry added
later is checked without anybody remembering to. An entry only takes arguments at all if it
ends in a space (ADR-010):
`npm test` is a whole command, because `npm test --script-shell <program>` is not the
project's script. And do not count on the fast path for latency — agents chain commands,
chained commands are refused, and it matched 0 of 88 real calls.

**A good calibration table is not safe gate behaviour.** `fixtures/gate.jsonl` labels
probabilities and is what `calibrate` tunes against, so it is relabelled every pass and
cannot say anything about the fast path or a hard rule — neither reaches the classifier.
`test/holdout/cases.jsonl` is the other corpus: each line labels an **emitted decision**,
and `test/pipeline.test.ts` spawns the built `bin/bouncer.cjs` over it with the mock backend
and asserts stdout plus the log line's `source`. It is frozen by the SHA-256 in
`test/holdout/FROZEN`, so changing a case takes two edits in one commit and cannot happen as
a side effect of tuning. Add cases freely; relaxing one is the thing to read twice. Every
judgment in it is the mock's, so a judged expectation is a claim about routing and
disposition, never about whether the answer was right — including the dangerous false
accepts it names on purpose (review finding 10 asks for those to be reported, so the suite
asserts the list rather than printing it).

**The engine has two consumers now, and neither is privileged.** `bouncer judge` runs a
policy set over a batch of items and `bouncer measure` compares it against a reasoning
model (ADR-009). Anything below `src/cli.ts` that would have to know which one is calling
is a design mistake: `evaluate()` takes a `PolicySet` and a `Mode`, the judge runner takes
states the caller built, and `calibrate` scores items whatever built them. The gate is the
one that runs hundreds of times a session, so it is the one whose hot path is measured —
that is a performance fact, not a hierarchy.

**`judge` sends item content; the gate never does.** PRD §9 is about a hook that runs on
every tool call over content the user never chose to send. `judge` is a command pointed at
a file, and the document is the subject. Redaction runs either way. If a change ever lets
the gate's state builder near file contents "because judge does it", that is the line.

**Nothing hook-shaped below the entrypoint.** Bouncer is a judgment engine and the gate is
one consumer of it (ADR-008). `evaluate()` takes probabilities, `redact()` takes a string,
the adapters take a state and a question map — none of them knows what a tool call is, and
none of them is allowed to learn. A second consumer should be a new `StateBuilder` and a new
policy set, never a branch inside `src/engine/`. The gate's own pieces — `gate.tools`,
`gate.fast_path`, `gate.hard_rules` — live on `GatePolicy`, not on `PolicySet`.

**A computed fact is decoration until a question reads it.** The state builder labels
sensitive paths, but a label with no question asking about it and no rule reading it
changes no verdict. When adding a fact to the state, add the question and the rule in the
same change, and test the verdict rather than the state.

**Read `.claude/skills/typesafe-ai/SKILL.md` before writing questions, adapters or the
local compare, and read the live docs it points to.** It is TypeSafe's own skill, vendored
into this repo (MIT, provenance in the directory's `VENDORED.md`) because a skill enabled
on someone's account is invisible to a session that started before it and to every remote
or CI session — a rule half the threads cannot follow is not a rule. It is not the source
of truth and says so itself: `https://docs.typesafe.ai` is, and the pinned facts below are
a snapshot of both.

Three of its rules bind work in this repo:

- **A question's name is never sent to the model**, so `instructions` must carry the whole
  meaning. This is why `outside_repo` was reworded rather than renamed.
- **State is named JSON fields, and questions reference them by backticked path** — the
  skill's example is `` `ticket.messages[0].text` ``. `buildState` already emits named
  fields; the questions still describe them in prose. Closing that is a live-run change, so
  it belongs with the next calibration pass, not with a refactor.
- **Verify and escalate** — check the uncertain cases and send those, and only those, to a
  person or a reasoning model. That is the pattern ADR-008's escalation manifest implements;
  the vendor's own cookbooks for it are linked from the skill.

## Verified facts, do not re-derive from memory

Both were checked against live sources on 2026-09-18. If something contradicts these,
re-verify rather than assuming the note is stale.

**Jev** (`POST https://api.typesafe.ai/v1/systemone`, Bearer auth, model `jev-latest`):
- `questions` is a **map** keyed by caller-chosen names (not an array with `id`); answers
  return under the same keys. Each question carries `type` (`noul` | `choice` | `score`),
  `instructions`, and `criteria` — not `prompt` / `options` / `levels`.
- The request body is `{ model, state, questions }`. Confirmed live on 2026-09-18; see
  `scripts/jev-latency.mjs` for a working request.
- **`noul` returns only `{type:"noul", noul: 0..1}`. There is no confidence field.**
  `choice` and `score` do return `confidence`, but the docs describe it as a statistic
  derived from the distribution, so it carries no independent signal. Write uncertainty
  rules as ranges on `p`.
- `choice` takes up to 255 options; `score` takes 2 to 10 ordered levels. Every question in
  the policy is a `noul` today. If one becomes a `score`, that is the range it has.
- Pricing is $0.042 per million input tokens, output free. Cost is not a design constraint.
- **The hook never gets a warm connection.** It is a process per tool call, so every call
  pays TCP and TLS setup: ~193 ms of a ~437 ms median adapter call, measured from an
  installed plugin's log on 2026-09-18 (p95 549 ms, 66 calls, ~95 ms from the host). The
  "~190 ms steady state" in older notes came from `scripts/jev-latency.mjs` looping inside
  one process over a kept-alive connection. Do not quote a latency measured that way as
  the hook's; read `latency_ms.adapter` out of a real `decisions.jsonl` instead.
- Limits: 64k tokens for state + all questions, 32k for state + longest question.
  Rate limits documented as dynamically adjusting — do not hardcode them.
- `jev-1.13` reads negations and scoping words literally, and is unreliable at counting,
  arithmetic and date ordering. Write question `instructions` positively and put exclusions
  in `criteria.false`. Compute anything numeric in the state builder instead of asking.

**Claude Code hooks** — see the pinned facts section of `docs/adr/001`. The parts most
easily got wrong, all confirmed against captured payloads in `test/fixtures/payloads/`:
- `UserPromptSubmit` carries `prompt`, **not** `prompt_text`.
- `MultiEdit` does not exist in Claude Code 2.1.201; `Edit` absorbed it.
- `effort` is an object, `{"level":"high"}`, not a string.
- Subagent calls add `agent_id` and `agent_type` as top-level keys.
- `Bash` input carries `description` alongside `command`.
- `permissionDecision: "defer"` is documented but untested here. Nothing emits it.

When a payload question comes up, read a fixture rather than the docs. The fixtures are
recorded reality; the docs are a description of it.

## Conventions

- Conventional commits. Branch per thread. PRs only, no `--no-verify`.
- **Merged is not landed until the commit is an ancestor of `main`.** A PR based on another
  PR's branch rather than on `main` can merge, report `merged: true` with `merged_by` and
  `merged_at` set, and put its commit on a branch that has already been merged and never
  will be again. GitHub retargets an open stacked PR to the grandparent base only when the
  base branch is **deleted** on merge, and this repository does not delete branches, so the
  base stays alive and leads nowhere. Nothing warns you; the only tell is `base.ref`. PR #64
  went this way on 2026-09-19 and was re-landed as #68. So: prefer not to stack, say so in
  the body when you do and retarget to `main` yourself once the parent merges, and after any
  PR of yours reports merged run
  `git fetch origin main && git merge-base --is-ancestor <head-sha> origin/main` before
  saying it shipped.
- **Before asking for a merge, merge `origin/main` into the branch and re-run the suite** —
  not only when GitHub reports a conflict. The repository does not require a branch to be up
  to date before merging and CI runs per-PR rather than on a merge queue, so two PRs green on
  their own branches can leave `main` red. #19 and #20 did exactly that on 2026-09-18, fixed
  by #22. The collision point is any test that pins a *global* fact — a compiled shape, a
  fixture count, a firing list, an ADR number — because the textual merge succeeds while the
  assertion becomes false, and `mergeable_state: "clean"` says nothing about it. When a
  shape-pinning test fails on a field someone else added, the version bump is the fix and the
  guard is working; do not relax the pin. Concurrent PRs also conflict in `bin/bouncer.cjs`,
  which is the same remedy: merge `main`, rebuild, commit.
- **Two repository settings would close both of those classes** and are the owner's to set
  (issue #74): "Automatically delete head branches" ends the orphaned-stack case outright,
  and branch protection requiring branches to be up to date before merging ends the red-`main`
  case, at the cost of a re-run per merge. Neither is on today, so the two rules above are
  what stands in for them.
- A policy file names its sets under `policies:`; a top-level `gate:` is a permanent alias
  and not a deprecated spelling, so never add a warning to it (ADR-009). `policy/default.yaml`
  deliberately stays on the alias: it is the file every user copies.
- A published calibration run commits its answers beside its write-up: run live with
  `--out docs/calibration/<run>.jsonl`. The markdown lists only the disagreements, so without
  the answers a threshold question ("what falls in `[0.61, 0.64]`?") costs a live rerun to
  ask, and the rerun is a different sample. `calibrate --from` re-scores the file with no key.
- The reasoning model in `bouncer measure` is a command the user supplies, never a client
  bouncer ships. That is what keeps zero runtime dependencies true and keeps the claim about
  a class of model rather than one vendor. `test/fixtures/reasoning/oracle.mjs` is the
  stand-in every automated run uses.
- Zero runtime dependencies. Dev dependencies are fine; anything reaching `bin/bouncer.cjs`
  is not.
- `bin/bouncer.cjs` is a committed build artifact. Rebuild and commit it whenever `src/`
  changes; CI verifies it matches a fresh build.
- **A change to what an installed bouncer does bumps `version` in the same PR.** Claude Code
  pins an installed plugin to the string in `.claude-plugin/plugin.json` and only offers an
  update when it moves, so a fix merged without a bump reaches nobody who already installed —
  it sits on `main` looking shipped. PR #69 fixed the log path every install reads and landed
  without one. The string lives in four places (`plugin.json`, `package.json`,
  `package-lock.json`, and the literal `--version` prints in `src/cli.ts`) and
  `test/plugin.test.ts` pins them to each other, `--version` by running the built bundle. The
  marketplace entry deliberately carries no version: `plugin.json` wins over it, so a copy
  there would be a fifth place to forget. A bump also gets an entry in `CHANGELOG.md` saying
  what an existing install will notice — that file is for the person deciding whether to
  update, not a commit list. Docs and tests alone need neither.
- Tests are table-driven where the logic is (policy, redaction, rules). The engine is pure
  functions and should stay that way — no I/O below `src/cli.ts` and `src/io/`.
- **No real API key in any thread.** Jev calls are stubbed in tests; live calibration runs
  are done by Chris locally.
- A synthetic credential in a test or fixture is the real prefix followed by the alphabet
  (`abcdefghijkl…`), or is a plain word where the pattern keys on the variable's name.
  `.gitleaks.toml` allows a finding only when it is under `test/` or `fixtures/` AND looks
  like that, so a commit hook that scans staged changes passes the fakes and still catches
  a real key seeded into a fixture from someone's history. It also catches a key-shaped
  example written anywhere else, this file included — which is why none is spelled out
  here. Do not widen it to the whole directory, and do not reach for `--no-verify` or an
  inline allow. CI runs the same scan over the whole history on every push and pull
  request, so it is the gate that counts: a thread with no local hook is not thereby free
  to commit a key, it just finds out later.
