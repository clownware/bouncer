# ADR-010: A fast-path entry is a whole command unless it ends in a space

- **Status:** accepted
- **Date:** 2026-09-18
- **Context for:** v0.1
- **Changes:** the matching rule `policy/default.yaml` documented as "a literal prefix"

## Decision

An entry in `gate.fast_path` that ends in a space matches the bare command and the command
followed by anything. An entry that does not matches the command exactly as written, and
nothing longer.

    "ls "        ls        ls -la src/
    "npm test"   npm test                     (not: npm test -- --watch)

Until now both spellings took arguments; the trailing space only decided whether the match
needed a word boundary. The shipped list is respelled to keep what it meant to keep:
`git status `, `ls `, `which ` take arguments; `pwd` and every entry that runs project code
are whole commands; `go test ./...` is added as the exact form most people type.

## Why

CLAUDE.md's rule is that an entry must be safe for every argument it could be given,
because the arguments are never judged. #34 found two entries that were not and removed
them, noting that a prefix list has no way to say "only the bare form". This is that way.

The entries that remained were audited the way #34's were found — by running the worst
argument, not by reading the list. Each of these was run in a scratch project with a
harmless stand-in, and each did what it says:

| command | what ran |
|---|---|
| `npm test --script-shell <program>` | the program, in place of the shell |
| `npm run build --prefix <dir>` | another package's script |
| `go test -exec <program>` | the program, in place of the test binary |
| `cargo check --config build.rustc-wrapper="<program>"` | the program, around every rustc call |

`pytest -p <module>` is the same shape; pytest was not installed to try it.

These entries are on the list because running the project's own tests is a risk the policy
accepts — `unreviewed_execution` says so in its own `criteria.false`. The argument is what
makes the command stop being that. All five took the fast path, and in `full` mode bouncer
would have emitted `allow` for them.

## The same audit found one thing that is not about entries

`"ls "`, `"which "` and `"git status "` take arguments because nothing they can be given
writes or runs anything. One thing they can be given is a variable, and the shell expands
it before the verb sees it. Tried with a fake variable: `ls $VAR` prints
`ls: <value>: No such file or directory` in bash and zsh, and zsh's `which $VAR` prints
`<value> not found`. That is `echo $OPENAI_API_KEY` — the `secrets` question's own example —
by a verb that is never judged. The matcher refused `$(` and let a bare `$` through; it now
refuses any `$`, alongside the operators and redirects it already refused.

## Why not a denylist of flags

Refusing `--script-shell`, `--prefix`, `-exec`, `--config` and `-p` would close these five
and no others. The next one is whatever flag a tool ships next year, and the list would
have to be right about every tool a user adds. An allowlist of whole commands fails the
other way: a form nobody listed gets judged, which costs a round trip and is safe.

## Why not drop the entries

It would be simpler, and on the evidence it would cost nothing — see below. But `npm test`
run bare is exactly the case the fast path is for, a user who runs one command at a time is
a real user, and the whole-command spelling keeps it for them without keeping the hole.

## What the fast path is worth, measured

Less than the docs said. `policy/default.yaml` called it "the single biggest thing you can
do for perceived latency" and the hook called it "the main reason a heavy session stays
responsive". Over the first real traffic from an installed plugin it matched **0 of 88**
Bash calls. 80 of the 88 contained a shell operator — an agent writes
`npm test 2>&1 | tail -5`, not `npm test` — and a chained command is refused, correctly:
`ls; rm -rf x` must not inherit `ls`'s pass.

Allowing a chain when every segment is listed was simulated over the same log, one call longer by
then, and rescues 0 of 89, because the other segment is `tail`, `grep` or `head`, none of which can be listed
(they print file contents). So it is not built. Both comments now say what was measured,
and the latency that matters is ADR-003's: every judged call pays ~190 ms of connection
setup, which is a process-model question (ADR-002's note), not a fast-path one.

## Consequences

- **A copied policy gets stricter, never looser.** Someone whose file says `"git status"`
  stops fast-pathing `git status --short` until they add the space. That is a judged call
  they did not have before, not an unjudged one — the safe direction — and it is the only
  migration. No warning is emitted for it: a warning on every load for a spelling that is
  now simply exact would be noise about a file that is doing what it says.
- **The compiled policy's shape is unchanged**, so `CACHE_VERSION` does not move. The list
  is still strings; what changed is how the engine reads them.
- **No calibration table is invalidated.** `calibrate` does not model the fast path and no
  question's text changed.
- **Not audited:** what a user adds. The comment above the list now says what the space
  means, which is the only place that can be said.
