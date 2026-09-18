# Where this skill came from

`SKILL.md` and `LICENSE` in this directory are copied **byte for byte** from TypeSafe's
public skills marketplace. Nothing in them has been edited, which is the point: drift is a
one-line `diff` rather than a judgment call.

| | |
|---|---|
| Source | `https://github.com/typesafe-ai/skills` |
| Path | `skills/typesafe-ai/` |
| Commit | `65a39f393687675ce170e6094757de20370365b9` (2026-09-12) |
| Vendored | 2026-09-18 |
| License | MIT, © 2026 TypeSafe AI — the notice is beside this file, unmodified |

## Why it is vendored rather than assumed

A skill enabled on someone's claude.ai account is not visible to a session that started
before it was enabled, and is not visible to a remote or CI session at all. `CLAUDE.md`
tells every thread writing questions, adapters or the local compare to read this skill;
a rule that half the threads cannot follow is not a rule. Checked in, it is reviewable,
it is the same text for everyone, and it travels with the branch.

**It is not the source of truth.** The skill's own first instruction is that the live docs
at `https://docs.typesafe.ai` are, and this copy can only be as current as its commit.
Read the docs as part of the task; use this for direction and for the parts of it that
this repo's own rules were derived from.

## Why it is here and not in `skills/`

`skills/` is the plugin's own payload — what ships to anyone who installs bouncer. A
third-party skill shipped there would land beside a copy the user may already have
installed themselves, and the two would compete on the same questions. `.claude/skills/`
is project-local: only sessions working in a clone of this repository see it, which is
exactly the audience the `CLAUDE.md` rule is addressed to. `test/plugin.test.ts` asserts
the plugin payload stays free of it.

## Updating it

```
git clone --depth 1 https://github.com/typesafe-ai/skills /tmp/ts
diff -u .claude/skills/typesafe-ai/SKILL.md /tmp/ts/skills/typesafe-ai/SKILL.md
```

If it differs, copy it across, update the commit and date above, and re-read this repo's
question guidance against it — the pinned Jev facts in `CLAUDE.md` are downstream of it.
