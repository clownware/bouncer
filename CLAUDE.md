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

**No thresholds in code.** Questions are plain English and thresholds are numbers, both
living in the user's YAML. If you find yourself writing `if (p > 0.8)` in `src/`, the
number belongs in `policy/default.yaml` instead.

**A fast-path entry must be safe for every argument it could be given.** Entries in
`gate.fast_path` are never judged, so the test is not "is this command usually harmless"
but "is every form of it harmless". That excludes anything printing file contents —
`cat`, `head`, `tail`, `wc`, `git diff`, `git show`, `git log` — because `cat .env` and
`echo $OPENAI_API_KEY` are the literal examples in the `secrets` question's own criteria.
Fast-pathing the verb means the gate's headline question can never fire.

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
- Zero runtime dependencies. Dev dependencies are fine; anything reaching `bin/bouncer.cjs`
  is not.
- `bin/bouncer.cjs` is a committed build artifact. Rebuild and commit it whenever `src/`
  changes; CI verifies it matches a fresh build.
- Tests are table-driven where the logic is (policy, redaction, rules). The engine is pure
  functions and should stay that way — no I/O below `src/cli.ts` and `src/io/`.
- **No real API key in any thread.** Jev calls are stubbed in tests; live calibration runs
  are done by Chris locally.
