# Changelog

What changed for someone who already has bouncer installed. Claude Code offers an update
only when `version` in `.claude-plugin/plugin.json` moves, so every entry here is a version
someone can actually be running.

Earlier releases have no entries: 0.2.0 is described in
[docs/announcement-v0.2.md](docs/announcement-v0.2.md), and this file starts where the
convention does.

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
