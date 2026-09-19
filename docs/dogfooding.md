# Running Bouncer on your own machine

How to install the plugin, point it at Jev, and watch what it decides. Written for the
case Bouncer was built for: a session started with `--dangerously-skip-permissions`,
where the baseline is zero interruptions and the only thing worth adding is a floor.

Everything here assumes macOS and a Claude Code that can install plugins from a
marketplace. Nothing here needs a checkout of this repository except the last section.

## 1. Install the plugin

Bouncer ships as a single-plugin marketplace, so the repository is both the marketplace
and the plugin. `bouncer@bouncer` is `<plugin>@<marketplace>`, and both are called
`bouncer` here.

Adding the marketplace and installing the plugin are two separate steps, and the second one
is the one that actually puts Bouncer on your disk. There are two places to do them.

**From any shell**, including the Claude desktop app's own terminal:

```bash
claude plugin marketplace add clownware/bouncer
claude plugin install bouncer@bouncer
```

`claude plugin install` needs no interactive session and installs to user scope, so this is
the route to use when you are not already sitting at a Claude Code prompt. It does not
affect a session that is already running — Claude Code picks the plugin up the next time it
starts, so quit and reopen afterwards.

**Or at a Claude Code prompt**, which is a different thing from a shell prompt — these go
to Claude, and your shell will reject them:

```
/plugin marketplace add clownware/bouncer
/plugin install bouncer@bouncer
```

Either way, restart Claude Code and check it took:

```
/bouncer:status
```

You should see `Mode: observe`, the path to the policy, and the path to the decision log.
If you see nothing at all, the plugin did not install; `/plugin` lists what did.

### What the settings file does and does not do

You will also see `extraKnownMarketplaces` and `enabledPlugins` in the settings file, and
they look like they should be an install on their own. They are not, for a plugin like this
one that comes from a GitHub repository. Since Claude Code v2.1.195, adding a marketplace
"doesn't install plugins that come from an external source, on any path that loads
plugins", and such a plugin "doesn't load until the team member installs it". So the keys
register the catalog and record that you want the plugin; the install step above is still
what fetches it.

Setting both and restarting therefore does nothing visible, which is a confusing way to
fail: the settings look right and no error appears anywhere. If you have already added
them, they are harmless — run the install commands above and they will agree.

Those keys are worth setting deliberately for a repository your team shares, in the
project's `.claude/settings.json`, so a collaborator who trusts the folder gets the
marketplace without adding it by hand. Merge them into whatever the file already holds
rather than replacing it; a paste-over drops every other marketplace and plugin already
listed.

There is no `npm install` step. `bin/bouncer.cjs` is a committed bundle with zero runtime
dependencies, because Claude Code fetches the repository and never builds it (ADR-002).
Node 20 or newer has to be on `PATH` — the hook shells out to `node`.

### In the Claude desktop app

The desktop app's **Code** tab is Claude Code, and it reads the same `~/.claude` that the
terminal does: the same `settings.json`, the same installed plugins and marketplaces, and
the same hooks. So if you have already installed it anywhere, it is there in the Code tab
too — nothing to install twice.

If you have not installed it yet, run the two `claude plugin` commands above. The Code tab
has its own terminal for exactly this — the **Views** menu, or `Ctrl` + `` ` `` — so you
never have to leave the app; it opens in the session's working directory and is available
in local sessions only, not cloud or WSL. Then quit and reopen the app, since a shell
install lands on the next launch rather than in the running session.

There is a plugin browser too — the **+** beside the prompt box, then **Plugins**, then
**Add plugin** — but it installs from marketplaces that are already configured, and nothing
documents a way to register a new one from it. **Manage plugins**, in that same menu, is
where you enable, disable and uninstall afterwards.

The one thing that genuinely differs in the desktop app is the key, and it differs
silently. See the next section.

The **Chat** tab is a different product and cannot run any of this: it extends through MCP
servers and connectors, not through Claude Code hooks. Bouncer gates tool calls in Claude
Code sessions only.

## 2. Give it a key

The `jev` backend reads `BOUNCER_TYPESAFE_API_KEY`, falling back to `TYPESAFE_API_KEY`.
It reads the environment only: no `op://` resolution, deliberately, because `op read`
can raise a Touch ID prompt in the middle of an agent run.

A hook is a child process of Claude Code, so it gets Claude Code's environment. Where to
put the key depends on how you start Claude Code, and the two cases do not have the same
answer.

**In the terminal**, a shell profile export works and keeps the key out of any file. Add
this line to `~/.zshrc` — as a line in that file, not as something to run:

```bash
export BOUNCER_TYPESAFE_API_KEY="$(security find-generic-password -s typesafe-api-key -w)"
```

**In the desktop app, that export does not arrive.** Launched from the Dock or Finder on
macOS, the app reads your shell profile only to extract `PATH` and a fixed set of Claude
Code's own variables; anything else you export there is dropped. So a key that works in
your terminal will read as missing in the Code tab, with no error to say why. Put it in
the settings file instead:

```json
// ~/.claude/settings.json
{ "env": { "BOUNCER_TYPESAFE_API_KEY": "sk-…" } }
```

The settings block reaches Claude Code however it was started, at the cost of the key
sitting in a file in plaintext. The desktop app also has a local environment editor — the
environment dropdown in the prompt box, hover **Local**, then the gear — which stores
variables encrypted on your machine, and is the better of the two if you are only running
there.

Then confirm the hook can see it, in a new session:

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
for data that survives updates, which resolves to `~/.claude/plugins/data/bouncer-bouncer/`:
the plugin's name, then the marketplace's, and this repository is both. Installed from a
marketplace with another name, the second half is that name. Run
from a checkout instead of as an installed plugin, with nothing setting that variable, it
falls back to `~/.bouncer`.

Do not guess between them: `/bouncer:status` prints the resolved path on the `Log:` line.

Set `LOG` to whatever that line said, so the queries below can use it:

```bash
LOG=~/.claude/plugins/data/bouncer-bouncer/decisions.jsonl
```

If that path is empty but the plugin is clearly running, check the other one. The two
differ only by whether the process reading the log was given the plugin's environment, and
the hook always is.

One line per gated tool call, appended. It stores the **redacted state** — the command
line with credentials masked — not a hash, because a hash cannot answer "why was this
prompted", cannot seed fixtures, and cannot be re-scored after a policy change. File
contents never enter the state at all.

### What answered it

Every line names the backend that produced it in a `backend` field. That is the adapter
that actually answered — `$BOUNCER_BACKEND` when it is set, the policy's otherwise — not
the one the policy asked for. It matters because the mock adapter scores from fixed
keyword heuristics and never touches a network, so a `mock` line is a keyword matcher's
opinion rather than evidence about jev.

`/bouncer:status` leaves those lines out of its counts and says how many it ignored, so a
log that picked some up (from a benchmark run, or from driving the hook by hand with
`BOUNCER_BACKEND=mock`) still reports honestly on the rest. There is nothing to clean up:

```bash
jq -r 'select(.backend == "mock") | .ts' "$LOG" | wc -l   # how many are being ignored
```

`npm run bench` writes to a scratch directory of its own and never to this file.

One exception, for a log older than that fix. Until #30 the bench did write here, and the
same build recorded `backend` as the policy's rather than the adapter's — so those lines
say `jev`, and the filter above cannot see them. They are recognisable by their session:

```bash
jq -r 'select(.session_id == "bench") | .ts' "$LOG" | wc -l
```

If that prints anything but 0, `/bouncer:status` is counting benchmark traffic as yours.
Move the file aside rather than editing it; bouncer starts a new one on the next call.

```bash
mv "$LOG" "${LOG%.jsonl}.pre-30.jsonl"
```

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

`/bouncer:explain` on its own explains the most recent judged call; with an argument it
explains that one:

```
/bouncer:explain
/bouncer:explain <tool_use_id>
```

It prints the probability every question returned, names the rule that matched, and — for
anything the judge did not settle — lists every threshold the call crossed with the
question's own words, marking the one that decided. Read a verdict you disagree with as a
threshold problem, not a bug: it points at the rule and the number that would have to
move. A probability near 0.5 means the classifier was genuinely unsure rather than wrong,
which is what the uncertainty rule is for. `fast-path` in the reason means the classifier
was never called at all.

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
