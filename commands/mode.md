---
description: Explain how to change bouncer's mode, and what each mode does
argument-hint: "[observe|guard|full]"
---

The user wants to know about or change bouncer's mode. The mode lives in their policy
file — find it with `/bouncer:status`, which prints the path.

The three modes:

- **observe** — logs verdicts, emits nothing. Claude Code behaves exactly as it would
  without bouncer installed. This is the default and the only mode that is safe to run
  without having looked at your own numbers.
- **guard** — emits `ask` (and `deny`, if the user has enabled any deny rules) where
  policy says so. It can add a prompt but never removes one.
- **full** — also emits `allow`, suppressing the normal permission prompt on calls it
  judges safe. This is the only mode that makes Claude Code quieter, and the only one
  where a wrong judgment lets something through.

If the user is asking to move to `guard` or `full`, first run `/bouncer:status` and look
at how many decisions have actually been logged. Moving to `guard` on a handful of
decisions means enforcing thresholds nobody has checked. Say so plainly, then do what
they asked — it is their machine and `guard` can only add prompts.

Moving to `full` deserves more caution: suggest running `bouncer calibrate` first, since
that is the mode where a false `allow` means something ran that would otherwise have been
questioned.

Edit the `mode:` line in their policy file. Do not change anything else.
