---
description: Show what bouncer is configured to do and what it has been doing
allowed-tools: Bash(node:*)
---

Run the bouncer status command and show the user its output:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bouncer.cjs" status`

Present the result as it is. If the mode is `observe`, mention that bouncer is only
logging and has changed nothing about how Claude Code behaves, and that the line about
how many prompts `guard` would have added is an estimate that has not been calibrated
yet. Do not recommend switching to `guard` unless the user asks.
