# Capturing real hook payloads

Everything else in this repo is built against the payloads captured here, not against
the documentation. Docs drift and omit fields; a recorded stdin does not.

The capture hook is inert by construction: it always exits 0 with empty stdout, which
Claude Code treats as "no decision, proceed normally". It cannot block a tool call.

## 1. Install

Add to `~/.claude/settings.json` (or a project `.claude/settings.json`). Use the absolute
path to your clone:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node /ABSOLUTE/PATH/TO/bouncer/scripts/capture-hook.mjs", "timeout": 5 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node /ABSOLUTE/PATH/TO/bouncer/scripts/capture-hook.mjs", "timeout": 5 }
        ]
      }
    ]
  }
}
```

Captures land in `~/.bouncer-capture/`, one JSON file per invocation, plus an `index.log`.
Override with `BOUNCER_CAPTURE_DIR`.

## 2. Exercise every tool we gate

In a scratch repo, get Claude to run at least one of each. The payload shape differs
per tool and the state builder needs all of them:

- `Bash` — one plain command, one with a heredoc, one multi-line chain
- `Edit` — a small edit to an existing file. There is no `MultiEdit` to exercise: it does
  not exist as a tool in Claude Code 2.1.201; `Edit` absorbed it (ADR-001)
- `Write` — a new file, and an overwrite of an existing file
- `NotebookEdit` — if you have a notebook handy; skip if not
- A `Task`/subagent call, so we capture `agent_id` / `agent_type`
- One `UserPromptSubmit`, for the skill router — v0.5 in PRD §12, and not built

Then run once under `--permission-mode plan` and once under `acceptEdits`, so we capture
more than one value of `permission_mode`.

## 3. What to check while you are in there

These were the open questions from ADR-001 that only a real payload could settle. As of
2026-09-30 the committed payloads in `test/fixtures/payloads/` answer all but the first:

- Is `permissionDecision: "defer"` actually accepted, and where does it sit in the
  most-restrictive-wins merge order relative to `ask`? **Still open.** The recorder is inert
  and the deny probe in §5 did not exercise it; nothing in the repo emits it.
- Do `prompt_id`, `scratchpad_dir`, `effort` and `tool_use_id` appear, spelled that way?
  **Yes** — all four are in `pretooluse-bash.json`, and `effort` is an object,
  `{"level": "high"}`, not a string.
- Does `permission_mode` report `bypassPermissions` when started with that flag? **Yes** —
  every one of the seven `pretooluse-*.json` fixtures carries it; the eighth file,
  `userpromptsubmit-none.json`, was captured under `acceptEdits`.
- On `UserPromptSubmit`, is the field `prompt_text` or `prompt`? **`prompt`**, per
  `userpromptsubmit-none.json`.

## 4. Normalize and commit

```bash
node scripts/capture-normalize.mjs
```

This rewrites your home directory and username to placeholders, zeroes the volatile ids,
strips anything matching a known secret shape, and writes one fixture per event+tool to
`test/fixtures/payloads/`.

**Read every file before you commit it.** The scrubber is a convenience, not a guarantee —
it cannot recognise a secret that does not match a known shape, and your command history
is your own.

## 5. Probing deny under bypass

**Done.** The probe below was run on 2026-09-18 and the sentinel command was blocked, so a
hook `deny` is honoured under `--dangerously-skip-permissions`; ADR-004 records the result
under "What is verified, and what is not", and `seatbelt` mode was built on it. The
procedure is kept so it can be re-run against a new Claude Code.

`--dangerously-skip-permissions` is the mode Bouncer is most useful in, and `seatbelt`
mode (ADR-004) assumes a hook `deny` is still honoured there. The captured payloads prove
the *first* half of that — all seven `PreToolUse` fixtures carry
`"permission_mode": "bypassPermissions"`, so the hook demonstrably fires under the flag —
and can never prove the second, because the recorder is inert. That is the same reason
ADR-001 still lists `permissionDecision: "defer"` as unverified.

`scripts/deny-probe-hook.mjs` answers it. It denies exactly one thing: a `Bash` command
containing the string `BOUNCER_DENY_PROBE`. Every other tool call gets empty stdout and
exit 0, so it cannot interfere with anything else in the session.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /ABSOLUTE/PATH/TO/bouncer/scripts/deny-probe-hook.mjs", "timeout": 5 }
        ]
      }
    ]
  }
}
```

In a scratch directory, start Claude Code with `--dangerously-skip-permissions` and ask it
to run `echo BOUNCER_DENY_PROBE`. Then, as a control, ask it to run `echo hello`, which the
probe ignores.

- **The command is blocked and Claude reports the reason** → deny is honoured under bypass.
  `seatbelt` is viable. This is what happened on 2026-09-18, and ADR-004 records it with
  the date.
- **The command runs and prints `BOUNCER_DENY_PROBE`** → deny is ignored under bypass, and
  `seatbelt` is a mode that cannot do anything. On a newer Claude Code that would be a
  regression to report, since `seatbelt` is already built and shipped.

Remove the hook entry afterwards.

## 6. Uninstall

Remove the hook entries from settings. The capture directory can be deleted freely.
