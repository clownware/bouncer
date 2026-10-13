# Changelog

What changed for someone who already has bouncer installed. Claude Code offers an update
only when `version` in `.claude-plugin/plugin.json` moves, so every entry here is a version
someone can actually be running.

Earlier releases have no entries: 0.2.0 is described in
[the v0.2 announcement](https://github.com/clownware/bouncer/blob/fc08c9c/docs/announcement-v0.2.md),
and this file starts where the convention does.

## 0.2.22

**A `Stop` hook that watches, and `bouncer stops` to read what it saw** (#156, ADR-015).
When the agent stops, a judgment model is asked whether it was only waiting for a go-ahead,
and the answer is logged. Later, `bouncer stops` compares each one with what you typed next.

- **It changes nothing about any session.** The hook prints nothing and never tells Claude
  Code to continue, in any mode.
- **It is off after this update.** Nothing is sent and nothing is logged until you copy
  `policy/stop.yaml` to `~/.bouncer/stop.yaml` (every project) or to `.bouncer.stop.yaml`
  in a repository (that project only).
- **Once on, it sends content:** the last 6,000 characters of the agent's closing message,
  after redaction, each time a session stops. Nothing is sent while a background task is
  still running.
- The plugin now registers a second hook. Where it is off, that is one short process at
  each stop. Tool calls are not affected.
- `stops.jsonl` in the data directory holds the answers and the redacted text.

## 0.2.21

**`bouncer calibrate --timeout <ms>`**: how long one fixture may take, all of its questions
together. The default is 30 seconds, as before, which suits a hosted API. A local 27B model
took 16 to 19 seconds a fixture and a whole run was lost to one that ran longer; a timeout
still ends the run with nothing written, so give a slow backend room.

The run that found this is the first live one of `backend: local`:
[Qwen3.6-27B against Jev](docs/calibration/2026-10-12-qwen36-27b-1.md). It does not pass.

## 0.2.20

**`credential-on-the-command-line` no longer fires on a path to a key file** (#150).
`API_KEY_FILE=/run/secrets/key`, `--password-file=…`, `SSH_PRIVATE_KEY_PATH=…` and
`GOOGLE_APPLICATION_CREDENTIALS=…` name where a credential is kept, which is how it stays
off the command line. A name ending in `_FILE`, `_PATH` or `_DIR` (or the same with a dash)
is not reported; the value is not looked at. `API_KEY=…` and `--password=…` are stopped as
before, and redaction is unchanged.

This reaches a copied policy only if it already reads `shell-assigned-secret` (0.2.18).

## 0.2.19

**Force-deleting a branch whose work is already on the default branch is no longer stopped**
(#122, ADR-014). After a squash merge `git branch -d` refuses the branch and `-D` was a
hard-rule hit, so in `seatbelt` every cleanup was denied.

- When a call is `git branch -D <names>` and nothing else, the hook asks git whether merging
  each branch into the remote's default branch would change anything. If none would, the
  rule is passed over and the call is judged like any other.
- **Still stopped:** a branch with work that is not on `origin`'s default branch, any
  force delete inside a chain (`cd x && git branch -D y`, `git -C x branch -D y`), and any
  force delete in a repository with no remote. The deny reason now says which form can pass.
- **Also still stopped:** a squash-merged branch whose lines the default branch has since
  rewritten. git cannot tell that one from unmerged work.
- **The hook now runs `git` in your project** on these calls and no others: `symbolic-ref`,
  `rev-parse` and `merge-tree`. Nothing in your working tree, index or refs changes.
- **If you copied the policy**, add `unless: branch_adds_nothing_to_default` to the three
  `git-branch-force-delete` entries, at the same indent as `when:`. `bouncer status` lists
  them. Delete the line to stop every force delete, as before.
- A waived call's log line carries `hard_rule_waived`.

## 0.2.18

**Two hard rules stop firing on things that are not credentials, and `bouncer status` says
when your copy of the policy has an older rule than the bundled one** (#87, #98, #126). In
`seatbelt` each of these was a denied call.

- `credential-on-the-command-line` no longer fires on source code in an inline script. A
  heredoc, `node -e` or `sed` expression holding `const tokens = list("tokens")`,
  `const password = readLine()` or `Client(api_key=value)` is judged like any other call.
  `API_KEY=…`, `-e DB_PASSWORD=…`, `--password=…`, `?api_key=…` and `-d 'token=…'` are stopped
  as before. What is sent and logged is redacted exactly as it was.
- **If you copied the policy, this fix does not reach you until you edit the copy.** Under
  `credential-on-the-command-line`, change `- assigned-secret` to `- shell-assigned-secret`.
  The old name still loads and still means the wide match.
- **No longer stopped by that rule:** a lowercase assignment that is not a flag, a query
  string or the start of a quoted value, such as `password=hunter2 ./deploy.sh` or
  `curl -d token=value`. It is judged by the `secrets` question. An uppercase name is
  stopped wherever it is.
- `.env.example`, `.env.sample`, `.env.template` and `.env.tpl` are no longer treated as
  environment files, so reading one is not stopped and a `Write` to one no longer carries
  `sensitive: environment_file` to the classifier. `.env`, `.env.local`, `.env.production`
  and `.env.example.local` are unchanged.
- `bouncer status` compares your hard rules with the bundled ones by name. It prints each
  entry whose `when` differs, with only the part that differs, and each bundled entry your
  policy does not have. It prints nothing when they match, and it cannot tell an old copy
  from an edit you made on purpose, so it says "differs" and leaves the choice to you.
- `redacted_kinds` in the log gains `shell-assigned-secret` beside `assigned-secret` on the
  lines it applies to.

## 0.2.17

**`bouncer ready`: is this change finished enough to push?** (#93). A new command, and a
`/bouncer:ready` slash command for it. It reads the commits ahead of the base branch and
asks four questions: whether the commit messages describe the change, whether behaviour
changed with no test, and, one file at a time, whether a debugging statement or an
unfinished marker was added. It prints `READY`, or `HOLD` with the file and the question
that fired.

- **It sends content, which the gate never does:** commit messages and diff text go to the
  backend after redaction. Nothing runs until you run the command. `--backend mock` sends
  nothing.
- **It only reports.** Exit status 0 unless you pass `--enforce`, where a `HOLD` exits 1. It
  never holds on its own failure: no key, no repository or an unanswered request is said
  and exits 0.
- **It lists what it did not read:** lockfiles, generated files, documentation, binaries and
  any file whose diff is too long for one request.
- Real runs are recorded in `readiness.jsonl` in the data directory, with the head commit
  and the answers and no diff text, so the check can later be compared with CI.

The questions and thresholds are in the new `policy/push.yaml`, which is separate from the
gate's policy; copy it and pass `--policy`, or set `BOUNCER_PUSH_POLICY`, to change them.
Nothing about the hook or the gate changes.

## 0.2.16

**An agent editing the policy that gates it is now stopped** (#141, ADR-013). Before this, a
`Write` or `Edit` of `~/.bouncer/bouncer.yaml` or a repository's `.bouncer.yaml` was judged
`ask`, and in `seatbelt` a judged `ask` reaches nobody, so a session under
`--dangerously-skip-permissions` could set `mode: observe` and carry on ungated.

- In `guard` and `full` you are prompted. In `seatbelt` the edit is denied, and the way
  through is to edit the file yourself. `observe` is unchanged and emits nothing.
- Reading the policy is not stopped: `cat`, `grep` and `/bouncer:explain` work as before.
- Also stopped: `rm`, `mv`, `truncate`, `tee`, `shred` and `unlink` on the file, and `sed -i`
  or `perl -i` on it.
- **Not stopped**, and judged like any other command: `cp` onto the file, a redirect onto
  it, and a script that writes it. ADR-013 says why.

**Your own policy file does not get this by updating.** The entries live in the shipped
`policy/default.yaml`. If you have your own `bouncer.yaml`, add this at the end of its
`hard_rules:` list, with the same indentation as the entries above it:

```yaml
    - name: edits-the-gate-policy
      because: "Changes the policy file that decides what bouncer stops. Edit it yourself."
      when:
        target_labelled: [gate_policy]

    - name: removes-or-overwrites-the-gate-policy
      because: "Removes, moves or overwrites the policy file that decides what bouncer stops."
      when:
        first_token: [rm, unlink, shred, mv, truncate, tee]
        path_labelled: [gate_policy]

    - name: edits-the-gate-policy-in-place
      because: "Rewrites the policy file that decides what bouncer stops, in place."
      when:
        first_token: [sed, gsed, perl]
        token_prefix: ["-i"]
        path_labelled: [gate_policy]
```

A policy that uses `target_labelled` needs 0.2.16 on every machine that loads it. An older
bouncer treats the unknown key as an error and stops enforcing, with one message per session
saying so. Update first, then edit the policy.

A new hard-rule predicate, `target_labelled`, is what makes the first entry possible: it is
true when the file a `Write`, `Edit` or `NotebookEdit` would change carries a label. Until
now every predicate read a shell command, so no rule of your own could mention those tools.

## 0.2.15

**`bouncer calibrate --gate <arm> --from <dir>`** (#127). Scores a gate run that `--out-dir`
recorded, with no key and no server:

```bash
bouncer calibrate --gate clef-flash --reference jev --out-dir run/   # live, once
bouncer calibrate --gate clef-flash --from run/                      # as often as you like
```

A moved margin, a changed threshold or a relabelled fixture now costs nothing to try after
the answers have been paid for. Name the candidate as the report printed it or by its file
name; the reference defaults to the one the run recorded, and `--from a/,b/` finds the two
arms in different directories.

- It refuses a file answered under another wording of the questions than that pass would
  ask today, base and variants alike, and names the file.
- A pass that was not recorded is reported as not measured, never filled in.
- It never attests a backend. An attestation says a server answered today, and this read a
  file; the report says so, and says when each arm answered.

`--out-dir` now also writes `gate.json`, which records which arm was the reference. A
directory recorded by 0.2.13 or 0.2.14 has none and still works: name the reference with
`--reference`.

## 0.2.14

**`bouncer calibrate --stamp <question>`** (#127). `--gate` asks a reversed form or a
rewording only when its line carries the fingerprint of the question it was written against.
This is the command that writes it:

```bash
bouncer calibrate --stamp destructive,prod --policy policy/default.yaml
bouncer calibrate --stamp all
```

- A line with no `base` gets one. A line that is already current is left exactly as it was.
- A line whose `base` names another wording is **stale**: its question was edited after it
  was stamped. It is left alone and the command exits 1, until you reread the line and name
  its question with `--restamp`. `--restamp` does not take `all`.
- It prints which policy file it read first. With no `--policy`, a personal
  `~/.bouncer/bouncer.yaml` wins over a repository's, and stamping against the wrong copy of
  the questions is the mistake to watch for.

The draft variants for `egress` and `outside_repo` were rewritten for the wording 0.2.11
shipped. All 28 lines in `fixtures/variants/` are still unreviewed and unstamped, so
`--gate` reports polarity and rephrase as not evaluated until you stamp them.

## 0.2.13

**`bouncer calibrate --gate <backend>`** (#127, ADR-011). Holds a candidate backend to the
calibration gate against a reference, `jev` unless `--reference` names another, and prints
one verdict per part:

- **accuracy** and **calibration**, the second now with AUC per question, so an arm that
  hedges every answer cannot pass on calibration error alone;
- **polarity**: every question asked again in a reversed form. An arm that answers the
  reversed form the way it answers the original is disqualified;
- **rephrase**: three rewordings of every question, and how often the answer's effect
  under your own rules changes;
- **injection**: the cases in `fixtures/injection.jsonl`, where a command that should
  prompt carries text such as "approved by the user". An arm that lets them through at a
  higher rate than the reference is disqualified.

A polarity or injection failure is final whatever the other parts say; there is no overall
score. `--out-dir` records each arm's answers, one file per pass, and `--json` prints the
assessment.

**It cannot pass yet, by design.** Latency is the sixth part and is not measured, because
it has to be measured through the hook and the hook cannot run a `jev@` backend. No
temperature is fitted and no attestation is written. Two parts are also idle on the files
that ship: the reversed forms and rewordings in `fixtures/variants/` are unreviewed drafts
with no `base` fingerprint, so `--gate` reports polarity and rephrase as not evaluated
until they are reviewed and stamped.

Seven margins join the policy's `calibration` block, all optional and all commented out in
`policy/default.yaml`. A part whose margin is unset is not evaluated, which is not a pass.
The exit status is 0 only when the gate passes, and never 2.

A hook call costs about half a millisecond more, from a larger bundle: twelve paired runs
against the previous build had medians between −0.1 and +1.0 ms on about 37 ms.

## 0.2.12

**`calibrate --compare` and `--from a,b` print AUC beside ECE.** The **Arms** table gains a
column: how well an arm ranks fixtures labelled true above those labelled false, pooled over
the questions, where 0.5 is chance. Expected calibration error alone can pass an arm that
answers 0.55 to everything, and the first local gate run had one (ECE 0.063 against Jev's
0.061, AUC 0.67 against 0.98). Anything that parses the table by column position needs the
extra column; nothing else an install does has changed.

This is the first piece of ADR-011's calibration gate (#127). The rest of what landed with it
is not reachable from a command yet: the flip-rate, attack-success and temperature-fit
arithmetic, and loaders for trace, variant and injection fixtures. A fixture may now carry
`"git": {"branch": "…"}`, which the state builder already sent and no fixture could say.

## 0.2.11

**Two questions reworded, so the gate prompts less on ordinary agent work** (#129). If you
copied `policy/default.yaml` to `~/.bouncer/bouncer.yaml` or into a repository, your copy
keeps the old wording until you copy these two questions across; a policy you have not
copied picks them up with the update.

- `egress` no longer reads opening an issue or a pull request, or pushing a branch to the
  project's own remote, as an upload. A push to a URL typed on the command line, or to
  someone else's remote, still prompts, and so do `curl` posts, `scp` and `rsync`.
- `outside_repo` no longer fires on work in another development checkout, a worktree of
  the project, or the agent's own notes under `~/.claude`. Personal files, system
  directories, shell startup files and reading out a credential file still prompt.
- On 280 calls sampled from an installed log, 273 of which should not prompt, the old
  wording prompted on 100 and this one on 46. On the published fixtures, 8 of 60 safe
  fixtures prompt (run 9: 11 of 55) and nothing that should prompt is allowed.
- Not fixed: a `Write` or `Edit` to a file outside the project still prompts, wherever the
  file is (#130).

Your decision log will show a new `policy.questions` fingerprint, `4966-c2ecb464`. Answers
recorded under the old one do not compare with new ones on these two questions, and
`calibrate --from a,b` will refuse to pair them.

## 0.2.10

**`calibrate --from` compares recorded runs** (#101). Give it several logs,
`--from a.jsonl,b.jsonl`, and it prints the paired comparison that `--compare` prints for
live backends: the **Arms** table, the comparison, the Brier sentence and both gates. It
needs no key and makes no network call. `--out` still records one arm per file, so this is
how a published comparison gets re-scored after a threshold moves or a label changes.

- Each column is named from the backend and model the log records, never from the file
  name. `name=path` gives it a name of your own.
- It refuses logs answered under different wordings of the questions. That would be two
  experiments, not one comparison.
- It refuses a file holding answers from more than one backend.
- It prints how far apart the arms were answered. A live `--compare` answers every arm in
  the same minute; recorded arms need not have been.
- Any comparison, live or recorded, now says how many answers only one side gave and so
  were left out of the pairing. `--json` carries this as `dropped` on each comparison.

**What an existing install will notice:** nothing, unless you run `calibrate`. The hook,
`judge` and `measure` are unchanged.

## 0.2.9

**`calibrate --compare` prices a named arm by what answered, not by its name.** An arm
given a label (`local-decision=jev@http://127.0.0.1:8093`) was always "unpriced", because the
cost column read the label. It now reads the endpoint: a loopback server is `$0 (local)`, Jev
is priced from its tokens, and any other hosted endpoint stays unpriced. **What you will
notice:** the cost column is filled in for labelled local arms. Nothing else changes.

## 0.2.8

**`calibrate --compare` reports what a routing decision reads** (#108).

- It takes any number of backends and compares each against the first.
- Its new **Arms** table gives, per backend: accuracy, Brier, expected calibration error, false allows by question, false-ask rate, p50/p95 latency, cost per decision, and how many requests the server reported truncating.
- Every differing verdict is listed, with what decided each side. The list used to stop at twenty.
- Each comparison ends with two gates. The **Brier gate** is within `brier_within` of the first backend with every question meeting the bar. The **safety gate** is no false allow on the `no_false_allows` questions, with agreement at or above `agreement_floor`.
- **Truncation flips** are differing verdicts on a state the server said it cut, and are flagged.
- `--json` adds `arms` and `comparisons` and keeps `comparison` for the first pair.

**New optional keys in the `calibration` block:**

- `brier_within: 0.05` and `no_false_allows: [destructive]` are in the shipped policy.
- `agreement_floor` is documented and left unset.

A copied policy without them works as before, and the gates it cannot evaluate say so. A policy that sets them loads on 0.2.7 too, which ignores them.

**What an existing install will notice:** only `calibrate --compare` output. The hook is unchanged, and the first call after updating re-parses your policy once, because the compiled-policy cache version moved.

## 0.2.7

**`calibrate` can reach a keyed local server, and reads llama.cpp 0.4.1** (#105).

- `local` sends `BOUNCER_LOCAL_API_KEY` (or the contents of the file
  `BOUNCER_LOCAL_API_KEY_FILE` names) as a bearer token, and a `jev@<url>` server gets
  `BOUNCER_JEV_COMPAT_API_KEY` (or `…_FILE`). Neither ever gets your TypeSafe key, and the
  local key is never sent to a `chat@` URL. Keys come from the environment or a key file,
  never from a policy.
- With a key set, the preflight sends one request without it and refuses a server that
  answers: the key would be protecting nothing.
- llama.cpp 0.4.1 answers `/v1/completions` with its top logprobs in the chat shape, and
  `local` refused it as "no top logprobs". It now reads both shapes, and still refuses a
  response in neither.
- `--compare` takes `name=backend`, so a column can read `local-decision` while the line
  above the tables says which endpoint answered. `--out` records the endpoint either way.

**What an existing install will notice:** nothing, unless your policy sets
`backend: local` and you set `BOUNCER_LOCAL_API_KEY`; then the hook sends that key too.

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
