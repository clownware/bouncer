# Changelog

What changed for someone who already has bouncer installed. Claude Code offers an update
only when `version` in `.claude-plugin/plugin.json` moves, so every entry here is a version
someone can actually be running.

Earlier releases have no entries: 0.2.0 is described in
[docs/announcement-v0.2.md](docs/announcement-v0.2.md), and this file starts where the
convention does.

## 0.2.2

**`calibrate`, `judge` and `measure` refuse a flag they do not know** (#60). All three used
to drop one silently, so `--backned mock` ran against whatever backend the policy names —
with a key in the environment, a live and billed run you did not ask for — and
`--concurrency abc` was ignored the same way. Each now prints the token, lists the flags it
accepts, and exits 1 without running. A second bare argument and a value flag with no value
are refused too. **If a script of yours passes one of these commands a flag it never had,
that script now fails where it used to run**; the flag was doing nothing, so deleting it
restores exactly the old behaviour.

**`--policy <file>` on all three.** The only way to choose a policy for one run was the
`BOUNCER_POLICY` environment variable. The flag wins over it, and unlike it a file that
cannot be read is an error rather than a quiet fall-through to the next policy in
precedence. `calibrate` now prints the policy file it scored against, and carries it as
`policy` in `--json`.

**`calibrate` refuses an allow on a truncated state, as the hook does** (#61). The gate will
not approve a call whose state was over the 4 KB cap, since every answer is about the part
that fit. `calibrate` was not told, so for such a call it reported `allow` where the
installed gate stands aside, and could list it under `missed` by a verdict the gate never
gave. `--out` lines now carry `truncated` and `--from` reads it, from gate logs too. No
fixture that ships is near the cap, so no published number moves.

## 0.2.1

**`full` mode no longer emits `allow` for a call bouncer did not look at** (#72). A tool
outside `gate.tools`, and any call in a mode listed under `skip_permission_modes`,
short-circuited with the verdict `allow` — and in `full` that was emitted, suppressing a
host prompt for a call nothing had judged, with no log line to say it happened. Both now
stand aside and the host decides exactly as it would with no plugin installed. The shipped
policy never showed this, because the hook registers exactly the four gated tools and the
only skipped mode is `plan`, where no tool runs; it appeared the moment either was edited.
**If you run `full` with an edited `gate.tools` or `skip_permission_modes`, this changes
what your install does** — you will see host prompts that bouncer used to swallow. The fast
path still emits its `allow`: an allowlist entry is the policy deciding, which is not the
same as nobody deciding.

**`/bouncer:status` and `/bouncer:explain` read the log the hook writes** (#69). Claude Code
exports `${CLAUDE_PLUGIN_DATA}` to hook processes but not to commands it runs through the
Bash tool, which is what a slash command is, so the hook wrote
`~/.claude/plugins/data/bouncer-bouncer/decisions.jsonl` while everything that reports on it
read `~/.bouncer/decisions.jsonl`. On an install with real traffic, `status` said "No
decisions logged yet" over a log with a thousand decisions in it and computed its friction
number over an empty file. `calibrate --from` and the on-disk policy cache resolved through
the same function and were split the same way. Nothing to do on your side: the existing log
is where it always was, and status now finds it.

**`--version` is pinned to the manifest.** The version string lives in four places and
nothing held them together, so `--version` could report a release you were not running.
`test/plugin.test.ts` now runs the built bundle and compares.
