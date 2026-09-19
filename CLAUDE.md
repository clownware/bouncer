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

**Latency is a feature.** `npm run bench` gates hook overhead at 80 ms p95. Adding a
dependency has a direct, measurable cost — bundling is what keeps startup at ~45 ms rather
than ~87 ms (ADR-002). Run the bench before and after anything that touches imports.
Two things measured since: YAML parse cost tracks node count rather than file size, so a
structured block costs about 5x what the same bytes cost as comments (ADR-004), and the
compiled policy is cached on disk, so the bench measures the cached path unless you set
`BOUNCER_NO_CACHE=1` (ADR-007). `node:crypto` is not free either — its first `require` in a
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
longer entries). Check a candidate by driving the built hook with its worst argument, not
by reading the list.

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
- Tests are table-driven where the logic is (policy, redaction, rules). The engine is pure
  functions and should stay that way — no I/O below `src/cli.ts` and `src/io/`.
- **No real API key in any thread.** Jev calls are stubbed in tests; live calibration runs
  are done by Chris locally.
