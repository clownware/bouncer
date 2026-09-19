---
description: Explain why bouncer decided the way it did about a tool call
argument-hint: "[tool_use_id]"
allowed-tools: Bash(node:*)
---

Run the bouncer explain command for `$1` (omit the argument to explain the most recent
judged call) and show the user its output:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bouncer.cjs" explain $1`

The output lists each question with the probability the classifier returned. When helping
the user act on it:

- A verdict they disagree with is a threshold problem, not a bug. Point at the specific
  rule in their policy file and the number that would need to move.
- A probability near 0.5 means the classifier was genuinely unsure, not that it was
  wrong. That is what the uncertainty rule exists for.
- If the reason says the fast path matched, the classifier was never called at all, and
  the fix is to remove that entry from `gate.fast_path`, or to take the trailing space off
  it so that it stops matching arguments.
