---
description: Check whether the commits on this branch are finished enough to push
argument-hint: "[--base ref] [--enforce] [--backend jev|jev@<url>|local|mock] [--policy path] [--json]"
allowed-tools: Bash(node:*)
---

Run bouncer's push-readiness check on the current branch and show the user its output:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bouncer.cjs" ready $ARGUMENTS`

It reads the commits ahead of the base branch and asks four questions: whether the commit
messages describe the change, whether behaviour changed with no test, and, file by file,
whether a debugging statement or an unfinished marker was added. `READY` means none fired.
`HOLD` lists each one that did, with the file and the question's own words.

If it reports a HOLD, read each line and say whether it is right. Fix the ones that are;
for one that is not, say why in a sentence rather than working around the check. It only
reports unless `--enforce` was passed, so a HOLD does not stop anything by itself.

This sends the commit messages and the diff text to the backend, after redaction. If the
user has not agreed to that for this repository, run it with `--backend mock`, which sends
nothing and shows only what would be read. Files listed under "Not checked" were not
judged: lockfiles, generated files, documentation, and any file whose diff is too long.

A live run needs `BOUNCER_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY`. Without one it says it
did not run, which is not a `READY`.
