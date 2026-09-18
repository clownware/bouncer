---
name: bouncer
description: Use when the user asks why a tool call was blocked, questioned or allowed by bouncer, or wants to read or change their own bouncer policy file — thresholds, questions, fast path, hard rules, modes — or asks about bouncer's decisions log or calibration output. Scoped to this user's log and policy file. It does not cover the classifier itself: questions about Jev, System One models, the API or how to word a question for one belong to the `typesafe` skill.
---

# Explaining and tuning bouncer

Bouncer is a `PreToolUse` hook that classifies proposed tool calls against a policy the
user owns. You cannot see its judgments while working — by design, so that the gate is
not something you can reason around. Everything you need is in its log.

## Answering "why did that get blocked"

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/bouncer.cjs" explain` for the most recent judged
call, or pass a `tool_use_id`. Read the actual output rather than guessing; the verdict
depends on the user's thresholds, not on what you would have judged.

The output names the rule that matched and the probability for every question. Three
readings are worth distinguishing:

- **A high probability on one question** — the classifier was confident. If the user
  disagrees, the question's wording is wrong for their situation, or the threshold is.
- **Everything near 0.5** — genuine uncertainty, which the `any` range rule converts into
  a prompt. Working as intended.
- **`fast-path` in the reason** — the classifier was never called. The command matched a
  prefix in `gate.fast_path` and was allowed without judgment.

## Editing the policy

Find the file with `/bouncer:status`; precedence is `$BOUNCER_POLICY`, then
`.bouncer.yaml` in the repo, then `~/.bouncer/bouncer.yaml`, then the bundled default.
Copy the bundled default before editing it — it is inside the plugin and will be replaced
on update.

Rules to hold to when changing it:

**A `fast_path` entry must be safe for every argument it could be given**, because its
arguments are never judged. `cat` looks harmless and `cat .env` is the thing the gate
exists to catch. Anything that prints file contents does not belong there.

**Adding a question means adding a rule.** A question with no rule reading it costs
latency and changes nothing.

**Write question `instructions` positively.** The model reads negations and scoping words
literally, so put exclusions in `criteria.false` rather than writing "does not touch
anything outside the project". Never ask it to count or compare dates.

**Rules are first match wins**, top to bottom, with `default` last. A rule placed after
`default` never runs; the loader warns about this.

## When the user wants to enforce

Enforcement is opt-in on purpose. `observe` changes nothing, `guard` can only add prompts,
`full` can suppress them. Before recommending `guard`, check `/bouncer:status` for how
many decisions have been logged — enforcing thresholds nobody has looked at is the thing
the observe default exists to prevent. Before `full`, suggest `bouncer calibrate`.

If the user asks you to enable `deny` rules, point out what makes them different: a
false-positive `ask` costs a keystroke, but a false-positive `deny` returns a reason to
the model, which then quietly tries something else — so the user gets a degraded agent and
never sees the decision that caused it. The default policy ships with deny rules commented
out for that reason.

## What bouncer is not

It is a safety net against mistakes, not a security boundary. The command text it judges
can come from a repository the user did not write. Do not describe it to the user as
protection against a deliberate attacker.
