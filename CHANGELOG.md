# Changelog

What changed for someone who already has bouncer installed. Claude Code offers an update
only when `version` in `.claude-plugin/plugin.json` moves, so every entry here is a version
someone can actually be running.

Earlier releases have no entries: 0.2.0 is described in
[docs/announcement-v0.2.md](docs/announcement-v0.2.md), and this file starts where the
convention does.

## 0.2.6

**`calibrate` can read a probability off an LLM's logprobs.** Name it `chat@<url>` with
the model in `BOUNCER_CHAT_MODEL`: `bouncer calibrate --compare jev,chat@https://api.openai.com`
asks every fixture's questions as one-token chat turns and reads p off `top_logprobs`, then
prints the side-by-side table and the Brier sentence PRD §12 asks for. It works against an
OpenAI model or an open-weights model on vLLM; Anthropic's API returns no logprobs, and
`chat@https://api.anthropic.com` is refused saying so. Before the first fixture it asks one
yes probe and one no probe and refuses to run unless each comes back as a single label token
of the right answer. `OPENAI_API_KEY` goes only to OpenAI's host; `BOUNCER_CHAT_API_KEY` goes
to whatever `chat@` URL you name; `BOUNCER_CHAT_EXTRA_BODY` is merged into each request, for
turning a Qwen model's thinking off on vLLM.

**What you will notice:** nothing, unless you run `calibrate`. The hook, `judge` and
`measure` are unchanged. The `local` backend now reports a 401 from its endpoint as an auth
error and a 429 as rate limiting, where both used to read as a rejected request.

## 0.2.5

**`calibrate` can compare Jev against any server that speaks Jev's wire shape.** Name it
`jev@<url>`: `bouncer calibrate --compare jev,jev@https://your-endpoint` runs the fixtures
through TypeSafe's Jev and through that server, with the same adapter on both sides, and
prints the side-by-side table and the Brier sentence PRD §12 asks for. It was built for
openjev-sglang, which serves `/v1/systemone` from an open-weights model; a bare origin gets
that path appended. **Your TypeSafe key is never sent to it**, whatever the environment
holds, and `jev@https://api.typesafe.ai` is refused because the plain `jev` is the one that
sends the key. `--backend jev@<url> --out run.jsonl` records a run on its own, under the
endpoint's name and the model it reported.

Before the first fixture it waits up to ten minutes for the server to answer one real
question, printing that it is waiting, so an endpoint that scales to zero gets to boot
instead of failing the run on the 30-second per-fixture timeout. A server that answers in
some other shape is refused there, with its own error, before any fixture is spent.

**What you will notice:** nothing, unless you run `calibrate`. The hook, `judge` and
`measure` are unchanged, and the comparison header now says that Jev-shaped servers return
no confidence either.

## 0.2.4

**A plus sign somewhere else on the line no longer reads as a forced push** (#84). The
`git-push-force-refspec` hard rule looked for `git push` and then for a space followed by a
plus anywhere in the whole command, because `text` reads the whole line. So
`git commit -m "p95 is +3% worse" && git push origin feature/x` was a hard-rule hit, and so
was any push chained with a PR body or a heredoc that quoted a signed number. **What you
will notice: in `guard` and `full`, fewer prompts on a commit-and-push; in `seatbelt`, the
commit is no longer denied along with the push.** In `observe`, only the log changes: those
calls are now judged and logged with `source: judge`. `git push origin +main` is stopped
exactly as before, at the end of a chain too.

The rule now uses a new predicate, `token_prefix`: some token **of that one command** starts
with one of the listed strings. `text` is unchanged and still reads the whole line, which is
what the SQL rules need it for.

This is the bundled `policy/default.yaml`. **If you copied it to `~/.bouncer/bouncer.yaml`
or a repo's `.bouncer.yaml`, your copy still has the old rule.** Under
`git-push-force-refspec`, replace `text: [" +"]` with `token_prefix: ["+"]`. A policy that
uses `token_prefix` needs 0.2.4: an older install reports it as an unknown predicate, says it
is not enforcing, and emits no decisions until the policy loads again. So update the plugin
before editing a copied policy, and mind a repo's `.bouncer.yaml` that teammates on an older
version also read.

The first call after updating re-parses your policy once (the compiled-policy cache version
moved, so that a policy an older version had rejected is not still rejected from the cache).

## 0.2.3

**The bundled policy asks on `destructive` and `unreviewed_execution` from 0.60, down from
0.70 and 0.65** (#50). The uncertainty rule prompts on any answer from 0.40 to 0.60, and
these two questions' own rules started above that, so an answer in between prompted on
nothing: "more likely destructive than not" was an allow. In calibration run 9 `rm -rf .git`
scored 0.68 and was only asked about because a different question happened to be unsure,
and `npm install <tarball URL>` has read 0.63, 0.64 and 0.65 across runs, allowed or not by
where the sample fell. **What you will notice: almost certainly nothing.** Re-scoring run 9
at the new thresholds changes no fixture's verdict, and in an installed log of 1,045 judged
calls not one answer fell in either gap. It matters on the day one does. `outside_repo` and
`egress` keep their gap up to 0.65 on purpose — the only thing measured inside it is
labelled safe.

This is the bundled `policy/default.yaml`. **If you copied it to `~/.bouncer/bouncer.yaml`
or a repo's `.bouncer.yaml`, your copy is what runs and it still has the old numbers**;
change the two `p:` values there to pick this up. In the shipped `observe` mode nothing is
emitted either way — it changes what `status` reports bouncer would have asked about.

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
