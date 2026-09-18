# Running Bouncer on your own machine

How to install the plugin, point it at Jev, and watch what it decides. Written for the
case Bouncer was built for: a session started with `--dangerously-skip-permissions`,
where the baseline is zero interruptions and the only thing worth adding is a floor.

Everything here assumes macOS and a Claude Code that can install plugins from a
marketplace. Nothing here needs a checkout of this repository except the last section.

## 1. Install the plugin

Bouncer ships as a single-plugin marketplace, so the repository is both the marketplace
and the plugin. Two commands, inside Claude Code:

```
/plugin marketplace add clownware/bouncer
/plugin install bouncer@bouncer
```

The first fetches the repository and reads `.claude-plugin/marketplace.json`; the second
installs the plugin it lists. `bouncer@bouncer` is `<plugin>@<marketplace>`, and both are
called `bouncer` here.

Restart Claude Code, then check it took:

```
/bouncer:status
```

You should see `Mode: observe`, the path to the policy, and the path to the decision log.
If you see nothing at all, the plugin did not install; `/plugin` lists what did.

There is no `npm install` step. `bin/bouncer.cjs` is a committed bundle with zero runtime
dependencies, because Claude Code fetches the repository and never builds it (ADR-002).
Node 20 or newer has to be on `PATH` — the hook shells out to `node`.

## 2. Give it a key

The `jev` backend reads `BOUNCER_TYPESAFE_API_KEY`, falling back to `TYPESAFE_API_KEY`.
It reads the environment only: no `op://` resolution, deliberately, because `op read`
can raise a Touch ID prompt in the middle of an agent run.

A hook is a child process of Claude Code, so it inherits Claude Code's environment. Put
the key where the app that launches Claude Code will see it — for a terminal-launched
`claude`, your shell profile:

```bash
# ~/.zshrc
export BOUNCER_TYPESAFE_API_KEY="$(security find-generic-password -s typesafe-api-key -w)"
```

Reading it out of the Keychain at shell startup keeps it out of a dotfile you might
commit. A plain `export BOUNCER_TYPESAFE_API_KEY=…` works the same way if you would
rather not.

Then confirm the hook can see it, in a new terminal and a new Claude Code session:

```
/bouncer:status
```

`Backend: jev` with nothing after it means the key is there. `Backend: jev (no API key in
the environment)` means it is not, and every call will take the error path — which emits
nothing and falls through to Claude Code's normal behaviour, so a missing key is invisible
unless you look.

## 3. Choose a mode

The mode is one line in your policy file. `/bouncer:status` prints which file that is;
precedence is `$BOUNCER_POLICY`, then `<repo>/.bouncer.yaml`, then
`~/.bouncer/bouncer.yaml`, then the bundled default.

The bundled default cannot be edited usefully — a plugin update overwrites it — so copy it
to a file you own. `/bouncer:status` prints its path on the `Policy:` line; copy from there:

```bash
mkdir -p ~/.bouncer
cp "<the path /bouncer:status printed>" ~/.bouncer/bouncer.yaml
```

Then edit the `mode:` line in your copy:

```yaml
mode: seatbelt
```

A new `/bouncer:status` should now print `~/.bouncer/bouncer.yaml` as the policy. If it
still prints the bundled one, the copy is not where the loader looks.

**If you run `--dangerously-skip-permissions`, `seatbelt` is the mode you want** — after
a week in `observe`. `ask` cannot do anything for a session with no prompts in it, so
`guard` is a no-op and `full` is nearly one. `seatbelt` emits nothing at all except a
`deny` when one of the deterministic `gate.hard_rules` entries matches: printing a
private key, a live credential on the command line, `git stash clear`, `git reset --hard`.
Judgments still run and still get logged; they just do not get to interrupt you, unless
you enable a `deny` threshold yourself, and those ship commented out.

Stay in `observe` first anyway. It emits nothing, so behaviour is identical to not having
the plugin installed, while the log fills with what it *would* have said. That log is the
argument for or against giving it a veto, and it is yours rather than this repository's
calibration table.

## 4. Watch the log

### Where it is

`decisions.jsonl`, inside `$CLAUDE_PLUGIN_DATA` — the directory Claude Code gives a plugin
for data that survives updates, which resolves to `~/.claude/plugins/data/bouncer/`. Run
from a checkout instead of as an installed plugin, with nothing setting that variable, it
falls back to `~/.bouncer`.

Do not guess between them: `/bouncer:status` prints the resolved path on the `Log:` line.

```bash
LOG=~/.claude/plugins/data/bouncer/decisions.jsonl   # or whatever `Log:` said
```

If that path is empty but the plugin is clearly running, check the other one. The two
differ only by whether the process reading the log was given the plugin's environment, and
the hook always is.

One line per gated tool call, appended. It stores the **redacted state** — the command
line with credentials masked — not a hash, because a hash cannot answer "why was this
prompted", cannot seed fixtures, and cannot be re-scored after a policy change. File
contents never enter the state at all.

### How it rotates

At 8 MB the file is renamed to `decisions.jsonl.1`, replacing the previous generation, and
a fresh file is started. Two generations exist at most, checked before every append. A
line is a few hundred bytes, so that is on the order of ten thousand gated calls. If you
want history beyond that, copy the file somewhere yourself — nothing archives it.

### The two numbers worth checking

```
/bouncer:status
```

Over the last 200 decisions it prints the verdict counts, the classifier's p50 and p95,
and the line that actually matters:

> Escalated 7 of 143 judged calls (4.9%) — the calls a rule could not settle on the
> classifier's answer alone.

That ratio is the claim (ADR-008): of the calls the fast classifier answered, how few
needed anything more. `items.length` alone tells you nothing — one escalation out of one
and one out of a hundred produce the same list, and only the denominator separates them.
In `observe` it also prints how many prompts `guard` would have added, which is the
friction number to look at before changing mode.

If the classifier starts failing or running slow, status says `STANDING DOWN for this
session` with the reason (`failures` or `latency`). That is the circuit breaker, and it
means Bouncer stopped calling out and is emitting nothing — safe, and worth knowing.

### One decision

```
/bouncer:explain                 # the most recent judged call
/bouncer:explain <tool_use_id>   # a specific one
```

It prints the probability every question returned and names the rule that matched. Read a
verdict you disagree with as a threshold problem, not a bug: it points at the rule and the
number that would have to move. A probability near 0.5 means the classifier was genuinely
unsure rather than wrong — that is what the uncertainty rule is for. `fast-path` in the
reason means the classifier was never called at all.

### Tailing it

Everything that was not an `allow`, as it happens:

```bash
tail -f "$LOG" | jq -rc 'select(.verdict != "allow")
  | [.ts, .source, .verdict, (.emitted // "—"),
     (.reason.name // .reason.question // .reason.kind),
     .state[0:90]] | @tsv'
```

`source` is the field to read: `hard_rule`, `fast_path` or `judge` — which layer decided.
`verdict` is what policy concluded; `emitted` is what was actually put on stdout, and
`null` there means nothing was emitted and Claude Code behaved normally. In `observe`
every `emitted` is `null`, which is the whole point of the mode.

Just the deterministic rules, which in `seatbelt` are the ones that can stop you:

```bash
jq -rc 'select(.source == "hard_rule")
  | [.ts, .reason.name, .emitted, .state[0:90]] | @tsv' "$LOG"
```

What the judge could not settle, newest last:

```bash
jq -rc 'select(.escalation != null)
  | [.ts, (.escalation.signals[] | "\(.question) \(.p) \(.criterion)")] | @tsv' "$LOG"
```

Errors only — timeouts, a bad key, rate limits. All of these emit nothing, so they are
silent by design and this is the only place they show up:

```bash
jq -rc 'select(.error != null) | [.ts, .error.kind, .error.message] | @tsv' "$LOG"
```

## 5. When it gets one wrong

A wrong `deny`, or something that should have been caught and was not, is worth turning
into a fixture rather than a threshold tweak. Find the line:

```bash
grep -n 'the command text' "$LOG" | tail -1
```

and bring the `ts`, the `source`, the `verdict` and the `answers` map. A miss in
`hard_rule` is a rule change; a miss in `judge` is either a question's wording or a
threshold, and changing a question's wording invalidates the published calibration table
and costs a live re-run. Neither is a guess to make from one example, which is why the
fixture comes first.

A log line has everything a fixture needs except the label and the reason for it, which
are the two parts only a person can supply:

```jsonl
{"id":"…","tool":"Bash","input":{"command":"…"},"expect":{"secrets":true},"note":"why the label is what it is"}
```

`note` is required — an unexplained label cannot be argued with later. Then re-run the
table from a checkout:

```bash
node bin/bouncer.cjs calibrate
```

That makes live calls and needs the key. There is no way to re-score an existing log
offline today; `calibrate` takes `--fixtures`, `--backend`, `--compare` and `--json`, and
replays fixtures rather than log lines.
