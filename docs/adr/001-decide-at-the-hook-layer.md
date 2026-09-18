# ADR-001: Decide at the hook layer, not as MCP tools

- **Status:** accepted
- **Date:** 2026-09-18
- **Context for:** v0.1

## Decision

Bouncer runs as a `PreToolUse` hook and talks to the classifier itself. The model being
gated never sees the judge, cannot call it, and cannot know what it was asked.

## Why not MCP

Exposing the classifier as MCP tools would let the model consult it — which sounds
useful and is actually backwards. A gate the model can query is a gate the model can
reason about, route around, or pre-emptively satisfy. It also puts the judgment inside
the context window, costing tokens and attention on every call, and makes the decision
non-deterministic in a way a policy file cannot describe.

The hook layer gives us the opposite properties: the decision happens outside the
model's awareness, costs the model nothing, and is reproducible from the logged inputs.

## Also decided: we do not rewrite tool input in v0.1

`PreToolUse` output supports `updatedInput`, which would let Bouncer silently rewrite a
command before it runs — adding `--dry-run`, narrowing an `rm`, pinning a host.

We are not doing that. Gating a command is a claim about risk; rewriting one is a claim
about intent, and getting it wrong produces an action the user never approved and the
model never proposed. That is a much larger trust ask than "this needs a prompt", and it
belongs behind its own decision and its own calibration data, if ever.

## Pinned facts

Verified against https://code.claude.com/docs/en/hooks on 2026-09-18:

- `PreToolUse` stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `tool_name`, `tool_input`, `tool_use_id`, `permission_mode`, and (for subagents)
  `agent_id` / `agent_type`.
- Output is `hookSpecificOutput.permissionDecision` ∈ `allow | deny | ask | defer`, with
  `permissionDecisionReason`. `hookEventName` is required inside `hookSpecificOutput`.
  The older top-level `decision` / `reason` form is deprecated.
- Exit 0 with no decision in the JSON → normal permission flow applies.
- **Exit 2 blocks the tool call regardless of stdout.** An uncaught Node exception exits 1,
  which is a non-blocking error. `src/cli.ts` must never produce exit 2; there is a test
  asserting this.
- Multiple matching hooks run in parallel and merge most-restrictive-wins
  (`deny` → `defer` → `ask` → `allow`). A Bouncer `allow` is therefore not authoritative:
  another hook or a settings rule can still force a prompt.
- Default timeout for `command` hooks is 600 s, configurable per hook via `timeout`.

## Unverified, to confirm from captured payloads

`defer`, `prompt_id`, `scratchpad_dir` and `effort` are cited to the live docs but were
not present in this author's prior knowledge, and `defer`'s position in the merge order
(stricter than `ask`) is surprising enough to be worth checking empirically. See
`scripts/CAPTURE.md` §3. Update this ADR with what the payloads actually show.

## Consequences

- Bouncer can only make Claude Code stricter or quieter; it can never widen permissions
  beyond what the user's own settings allow.
- The hook is in the latency path of every gated tool call. See ADR-002.
- Because the model cannot see the judgment, explaining a verdict requires a log and a
  command to read it — hence `decisions.jsonl` and `/bouncer:explain`.
