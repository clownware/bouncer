# ADR-014: A hard rule may name one fact the hook asks git for

- **Status:** accepted on 2026-10-12, by the merge of the pull request that added it
- **Date:** 2026-10-12
- **Context for:** 0.2.19
- **Decides:** #122, the force delete of a squash-merged branch
- **Amends:** ADR-004, whose predicates were all string operations and whose match was final

## Context

`git-branch-force-delete` stops `git branch -D`, because a branch deleted by force can hold
commits that are nowhere else. In `seatbelt` that is a deny.

A repository that squash-merges produces that command as routine. The pull request merges as
one new commit, the branch's own commits are on no other branch, `git branch -d` refuses with
"not fully merged", and `-D` is the only way to remove a branch whose work has in fact
landed. #122 reports four of these in one session, each denied, each done by hand, each on a
branch whose content was provably on the default branch.

ADR-004 answers a false positive by editing the rule, and the two before this one were
fixed that way (#87, #98). This one cannot be. `git branch -D merged-by-squash` and
`git branch -D a-week-of-unpushed-work` are the same string. What separates them is in the
repository.

## Decision

### 1. An entry may carry `unless`, naming a fact the engine does not establish

```yaml
- name: git-branch-force-delete
  because: "Deletes a branch whose commits are not merged anywhere else."
  when:
    tokens: [git, branch, -D]
  unless: branch_adds_nothing_to_default
```

`unless` takes one value from a list in `src/engine/types.ts`, and the list has one entry.
A value not on it is a load error. The engine stays pure: `matchHardRule` takes the
exemptions its caller has established and passes over an entry that names one. It never
asks.

### 2. The hook asks, after the entry has matched and only then

`shortCircuit` runs as before. If the entry it returns names an exemption, the hook tries to
establish it, and if it holds runs `shortCircuit` again with it established. Whatever comes
back stands: another entry, or nothing.

Nothing means the call is **judged like any other**. The exemption does not approve
anything. In `seatbelt` a judged call emits nothing unless it clears a `deny` rule; in
`guard` the `destructive` question may still prompt.

A call no such entry matched pays nothing for this. `bench --against` measures the paths
that are not a force delete, and they do not change.

### 3. The fact: merging the branch into the remote's default branch would change nothing

For each branch named, `git merge-tree --write-tree <default> refs/heads/<branch>` is run and
its tree compared with the default branch's own. Equal means the branch contributes nothing
the default branch lacks.

- **A merge and not a diff of two trees**, as #122 first proposed, because the default
  branch has usually moved on since the squash. A tree comparison would fail on the next
  unrelated commit.
- **The default is a remote-tracking ref**: `origin/HEAD`, else `origin/main`, else
  `origin/master`. Never a local branch. Measured against a local `main`, a commit that was
  only ever local adds nothing to it, and deleting the branch loses nothing until `main` is
  reset. In a repository with no remote the fact never holds.
- **Not the forge.** #122 also proposed asking `gh` whether the pull request merged. That is
  a network call with the user's credentials from inside a hook, which ADR-003 and the
  note in `apiKey()` both decline for the same reason: it can prompt, and it can hang.
- **Every way of not knowing is no.** No remote default, a branch that does not exist, a
  conflict, unrelated histories, a git before 2.38, or the budget running out. The budget is
  the policy's `timeout_ms`, the time a decision was already allowed to take.

### 4. Only a call that is the force delete and nothing else

The hook asks git in its own working directory. That is the command's directory only when
nothing in the command moves it, so `forceDeletedBranches` accepts one command, in the three
spellings the shipped entries stop, with names made of the characters a branch name
ordinarily has. A chain, `git -C`, a variable, a glob, `-r` or a wrapper is not understood,
and the entry's verdict stands.

An agent chains by habit, so the chained form is the one it will be stopped on. The deny
reason therefore ends with the form that can pass. The acting model reads a deny's reason
(ADR-001), which makes that sentence the instruction.

### 5. The log says an entry was passed over

A waived call's line is whatever decided instead, with
`hard_rule_waived: { rule, unless }` beside it. Without that, a judged `git branch -D` in a
log reads as a rule that failed to match.

## What it does not catch, and what it costs

- **A squash-merged branch whose lines the default branch later rewrote.** The merge
  conflicts or differs, git cannot say the branch adds nothing, and the delete is stopped.
  It was merged. This is the price of not asking the forge.
- **The session's directory.** The hook trusts the `cwd` in its payload to be where the
  command will run. If a previous call left the shell somewhere else and the payload does not
  say so, the question is asked of the wrong repository. A branch of the same name whose
  merge into that repository's default branch changes nothing would have to exist there.
- **The hook runs `git` in the project's directory**, which it did not before; only `bouncer
  ready` did. git reads the repository's configuration. The commands used (`symbolic-ref`,
  `rev-parse`, `merge-tree`) touch no index and no working file, and the agent's own command
  is a `git` invocation in the same directory.
- **`merge-tree` writes tree objects** into the object database. No ref, index or file
  changes, and `git gc` collects them. It is the first thing the hook writes outside its
  data directory.
- **Latency when git is asked** is three git processes or more. On the M4 Pro, 21 runs of
  the built hook with the mock backend: 54 ms median for a call that is not a force delete,
  90 ms for one that is, whether the answer was yes or no. About 35 ms, on these calls only.

## Consequences

- `CACHE_VERSION` goes to 9: a build before this ignores `unless`, so its cached compile of
  a policy that carries one is that policy without the exemption.
- A copied policy does not gain the line. `bouncer status` reports `unless` as a difference
  (#126), and an older bouncer reading a policy that has it ignores the key and stops every
  force delete, which is the safe direction.
- `test/exemption.test.ts` builds a repository with a branch in each state and drives the
  built hook in it, and pins which entries carry `unless`.

## What was considered and rejected

- **Removing the entry.** It is the right verdict for the unmerged case, which is the one
  that loses work.
- **Leaving it to the judge.** In `seatbelt` a judged `ask` reaches nobody; that mode is
  what the entry is for.
- **A general `unless_command:` that runs a command from the policy.** A repository's
  `.bouncer.yaml` is adopted by cloning it, so that is arbitrary execution by checkout.

## What this does not decide

Whether any other entry should get an exemption. Each would be a new value on the list, a
new question asked of something outside the command, and its own argument for why every way
of not knowing is no.
