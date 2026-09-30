# Architecture decision records

One file per decision, numbered in the order they were written; a used number is never
reused (PRD §13). A decision that later changed is not rewritten: it gains a dated
`> **Corrected on …**` block in place and its status line says so, so a reader can see what
was believed, when it stopped being true, and why. Where the PRD and these files disagree,
these win. Every date below is 2026.

| ADR | decides | status | changed by |
|---|---|---|---|
| [001](001-decide-at-the-hook-layer.md) | Bouncer is a `PreToolUse` hook, not MCP tools; no input rewriting | accepted | narrowed 09-30 (the model sees a deny's reason); 004 settled whether deny holds under bypass |
| [002](002-bundled-single-file-on-node.md) | one committed esbuild bundle on Node; no daemon for now | accepted | item 2 reversed by 007; the four parts of latency separated 09-30; the daemon question is #51 |
| [003](003-fail-to-prompt-and-observe-by-default.md) | every error emits nothing; `observe` is the default; no `deny` rules ship | accepted | corrected 09-18, 09-19, 09-30; 004 adds the fourth mode and reads the bypass sentence differently |
| [004](004-hard-rules-before-the-judge.md) | `gate.hard_rules` decide before the classifier; `seatbelt` for bypass sessions | accepted | amended 09-18 (per-command matching), 09-19 (`token_prefix`, #84), 09-30 (counts and the no-friction caveat) |
| [005](005-the-local-adapter.md) | the local backend reads p off constrained logits or refuses; `jev@` and `chat@` arms | accepted | added to 09-23, 09-26; corrected 09-30; preflight gap is #55; live rows are #109, #110, #111 |
| [006](006-the-skill-router.md) | the `UserPromptSubmit` skill router | accepted, **not built**; execution contract open | four open questions in #58; v0.5 in the PRD roadmap |
| [007](007-cache-the-compiled-policy.md) | the compiled policy is cached on disk, keyed on its text | accepted | reverses 002 item 2; invalidation rule completed 09-30; #73 made the bench a paired gate |
| [008](008-bouncer-is-a-judgment-engine.md) | the engine judges items; the gate is one consumer; escalation is an output | accepted | corrected 09-19 (record identity; which consumer matters); deferred items landed by 009 |
| [009](009-the-batch-judge.md) | `bouncer judge` and `bouncer measure`; `policies:` sets; fixtures as items; `consumer` and `set` on the log line | accepted | corrected 09-19 (decisions 4 and 5) |
| [010](010-a-fast-path-entry-is-a-whole-command.md) | a fast-path entry is a whole command unless it ends in a space | accepted | `git status` corrected 09-19; what a whole command still trusts said 09-30 |

[`../adr-review-2026-09-18.md`](../adr-review-2026-09-18.md) is the outside review that
produced most of the corrections above; its header says what was done about each finding.
Issues that are decisions still to make rather than corrections: #51 (daemon), #53 (chunking
long items), #54 (pinning the Jev model), #55, #56, #58.
