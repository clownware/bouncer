# Handoff

The state of work in flight, for the next session. Created 2026-10-11; there was no handoff
document before this one. `CLAUDE.md` holds the standing rules and the pinned facts; this
file holds only what is open right now. Update it when a thread ends, and delete what has
landed.

## Direction, as of 2026-10-12

The priority moved from the gate to the judgment-model consumers, at the owner's suggestion.
On his machine the gate has shown little: he runs with no prompts, so there is no friction
to remove, and most of the denies he saw were hard-rule false positives. The use with
evidence is taking classification and verification off a reasoning model; the first real
`bouncer measure` run is written up on #75, with its caveats.

**The Stop hook (0.2.22, ADR-015) is the consumer in flight.** It watches each stop and
logs whether the agent was only waiting for a go-ahead; `bouncer stops` scores that against
the next typed prompt. It is off until the owner copies `policy/stop.yaml` to
`~/.bouncer/stop.yaml` or to a repository's `.bouncer.stop.yaml`. Next: once a few dozen
stops are logged, read `bouncer stops`. ADR-015 lists what would have to be true before the
hook is allowed to continue anything, and none of it is decided. #156 holds the wider
proposals (stop calling the classifier from the gate in `seatbelt`; move the skill router up).

So the ADR-011 work below is parked, not abandoned, and the order is:

1. Compare `readiness.jsonl` with CI results on the same head commits, once a few real
   `bouncer ready` runs exist. None did on 2026-10-12. Its thresholds are provisional and
   its fixtures were written alongside its questions, so this is its first real evidence.
2. The next consumer: #92, then the skill router (ADR-006, open questions in #58).
3. Filed and not started: #138, #139, #140, #130, #134, #53.

An open-weights backend was measured for the first time on 2026-10-12 (#139):
[Qwen3.6-27B through the logit path](docs/calibration/2026-10-12-qwen36-27b-1.md). It ranks
nearly as well as Jev (AUC 0.966 against 0.986), prompts on 54 of 60 safe fixtures at the
shipped thresholds, and takes 15.7 s a fixture. Fitting thresholds per question on held-out
data (#140) is what would say whether it is usable for the batch commands. #149 lists the
other open-weights models the research corpus records.

The four noisy hard rules are done: #87, #98 and #126 in 0.2.18, #122 in 0.2.19.

**Waiting on the owner.**

- `~/.bouncer/bouncer.yaml` is a copy, and no agent may edit it (0.2.16). Run
  `/bouncer:status`: from 0.2.18 it lists each hard rule that differs from the bundled one.
  Two do after 0.2.19: `credential-on-the-command-line` (0.2.18) and the three
  `git-branch-force-delete` entries, which lack `unless` (0.2.19).
  The `egress` and `outside_repo` questions in the copy also predate 0.2.11's wording, and
  `status` does not compare questions.
- A working Anthropic API key, to rerun the triage measurement with one call per row and
  get the token count #75 lacks.

## Parked: the local decision backend (ADR-011)

**Where it stands.** [ADR-011](docs/adr/011-the-local-backend-is-chosen-by-a-gate.md) was
**accepted on 2026-10-11** (merge of #128) and nothing in it is built.
[`docs/calibration-gate.md`](docs/calibration-gate.md) is the spec. The work is tracked in
#127, and Clownbot's side in clownware/clownbot#190.

**What it decides, in four lines.**

- No local model is named. A backend other than `jev` gates only with an attestation that
  `bouncer calibrate --gate` writes when six parts pass against Jev: accuracy, calibration
  (with AUC), polarity, rephrase, injection, latency. Polarity and injection disqualify.
- Candidates in order: Clef-flash, Clef 27B, Kev 9B, all as `jev@<loopback>`. Laya is
  unsupported for gating (it already failed the existing gate, clownware/clownbot#94).
- The questions fingerprint is the wording version. A changed question un-attests a backend.
- A backend failure still emits nothing (ADR-003). `on_error: ask` is offered as an opt-in.

**Waiting on the owner.**

1. Review the draft trace labels. `bouncer export` has been run (#113 has the counts) and a
   280-case stratified sample is labelled as a first pass in `fixtures/traces.draft.jsonl`.
   It exists only in the owner's main checkout, with `.trace-labelling/`, and both are
   git-excluded: real commands, public repository. The owner has ruled that work in another checkout is not
   `outside_repo` and that `gh issue create` / `gh pr create` are not `egress`; the draft
   reflects both, and 7 of the 280 should prompt. Not reviewed line by line.
2. Review the drafts in `fixtures/variants/` (7 reversed forms, 21 rewordings; spec §2.2).
   All 28 are written against the wording that ships. Stamp each question you accept:
   `bouncer calibrate --stamp <question> --policy policy/default.yaml`. Until then `--gate`
   reports polarity and rephrase as not evaluated.
3. Review the draft `fixtures/injection.jsonl` (63 attack cases, 14 controls; spec §2.3).
   Its `git_branch` cases need a `git` field the fixture loader does not read yet.
4. Decide the margins in ADR-011 decision 4 once Jev has been measured on the new sets.

**Built so far (0.2.15).** `bouncer calibrate --gate <backend> [--reference jev]` runs and
reports five of the six parts: accuracy, calibration (with AUC), polarity, rephrase and
injection. `src/commands/gate.ts` is the runner, `src/gatereport.ts` the verdict and the
report, `src/gatemetrics.ts` the arithmetic, `src/gatefixtures.ts` the loaders. Seven margins
are policy keys, commented out in `policy/default.yaml`. It cannot pass: latency is never
evaluated, and on the files that ship polarity and rephrase are not either, because the
variant drafts carry no `base`.

**Next for a session, in this order.**

1. Nothing to build for the variants: the eight `egress` and `outside_repo` lines were
   redrafted for the 0.2.11 wording, and `bouncer calibrate --stamp <question>` writes
   `base` (0.2.14). What is left is the owner's: read the 28 lines, then stamp with
   `--policy policy/default.yaml`.
2. `--fit` as a command (the arithmetic is `fitTemperature` and `crossValidateTemperature`),
   which needs a `fit` split, which needs the trace set committed.
3. Done in 0.2.15: `--gate <arm> --from <dir>[,<dir>]` scores a recorded run. Live and
   recorded runs both build their arms in `buildArm`, from `planGate`'s passes.
4. Strata: `--traces`, per-stratum tables, `min_stratum_n`.
5. The first live reference run of Jev on the new sets, then choose the margins.
6. The hook half: `jev@` in `adapterFor`, the attestation check, `on_error: ask`, and
   latency measured through the hook. Version bump, `bench --against`.

**Not verified, so do not build on it.**

- The Arize and Respan benchmark figures quoted in the brief. Priors only.
- That llama.cpp serves `/v1/systemone` for the Clef GGUFs on Apple silicon. The
  `ggml-org` cards say it needs llama.cpp PR 29831; the published route is SGLang on CUDA.
- That a GGUF conversion answers as the published weights do.
- Resident memory for any candidate. The ADR's table is file sizes.
- That Workers AI's hosted Clef parses through `JevAdapter`.
- Whether Kev's and Clef's servers report a `model` string stable enough to bind an
  attestation to.

## Shipped since this file was created

- 0.2.11 (#129): `egress` and `outside_repo` reworded from real traffic, eight fixtures,
  [run 10](docs/calibration/2026-10-11-jev-10.md). What it left is #130: a `Write` or `Edit`
  outside the project still prompts wherever the file is, because the state cannot say.
- 0.2.12 to 0.2.15 (#133, #135, #136, #137): the `calibrate --gate` work described above.
- 0.2.16 (#145, ADR-013): an agent editing the gate's own policy file is stopped.
- 0.2.17 (#146): `bouncer ready`, the push-readiness check (#93).
- 0.2.18 (#147): `credential-on-the-command-line` and `reads-a-credential-file` stop firing
  on source code and on env templates, and `status` names hard rules a copy has left behind.
- 0.2.19 (ADR-014, #122): a force delete of a branch that adds nothing to the remote's
  default branch is passed over. The first hard rule that asks anything but the command.

## In flight: judgment-model consumers

The gate has produced almost no value on the owner's machine (117 denies in 10,439 calls,
roughly 90 of them wrong, and the classifier's verdicts emit nothing in `seatbelt`). The
use that has evidence behind it is offloading classification and verification from a
reasoning model: on the corpus's triage set, judging everything with Jev and re-asking a
reasoning model only on the uncertain rows matched the reasoning model's accuracy with 41 to
55 percent fewer calls (#75).

- **`bouncer ready` shipped in 0.2.17** (#93): four questions about a change before it is
  pushed. Observing by default. Fixtures and one live run exist; no real-history evidence
  does. What is next for it: compare `readiness.jsonl` with CI results on the same head
  commits; read long diffs in pieces (#53); repository-specific checks (a version bump, a
  rebuilt bundle) as computed facts.
- **Not started:** #92 (validate an agent's output against criteria), #91, #95, and the
  skill router (ADR-006, four open questions in #58).
- **Parked:** the rest of the ADR-011 gate work, apart from the noisy hard rules (#122,
  #126, #98, #87), which are the denies the owner actually sees.

## Other open threads

Unchanged by this session; see the issues. The ones that touch this work: #55 (the logit
preflight gap), #109 to #111 (first live rows for the existing arms), #114 (the Brier bar),
#75 and #113 (real labelled data), #51 (a daemon).
