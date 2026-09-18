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
- `Edit` — a small edit to an existing file
- `MultiEdit` — two or more edits in one call
- `Write` — a new file, and an overwrite of an existing file
- `NotebookEdit` — if you have a notebook handy; skip if not
- A `Task`/subagent call, so we capture `agent_id` / `agent_type`
- One `UserPromptSubmit`, for the v0.2 router

Then run once under `--permission-mode plan` and once under `acceptEdits`, so we capture
more than one value of `permission_mode`.

## 3. What to check while you are in there

These are the open questions from ADR-001 that only a real payload can settle:

- Is `permissionDecision: "defer"` actually accepted, and where does it sit in the
  most-restrictive-wins merge order relative to `ask`?
- Do `prompt_id`, `scratchpad_dir`, `effort` and `tool_use_id` appear, spelled that way?
- Does `permission_mode` report `bypassPermissions` when started with that flag?
- On `UserPromptSubmit`, is the field `prompt_text` or `prompt`?

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

## 5. Uninstall

Remove the hook entries from settings. The capture directory can be deleted freely.
