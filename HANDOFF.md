# Handoff

The state of work in flight, for the next session. Created 2026-10-11; there was no handoff
document before this one. `CLAUDE.md` holds the standing rules and the pinned facts; this
file holds only what is open right now. Update it when a thread ends, and delete what has
landed.

## In flight: the local decision backend (ADR-011)

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
   It exists only in the owner's `bouncer-wt-adr-011` worktree and is git-excluded: real
   commands, public repository. The owner has ruled that work in another checkout is not
   `outside_repo` and that `gh issue create` / `gh pr create` are not `egress`; the draft
   reflects both, and 7 of the 280 should prompt. Not reviewed line by line.
2. Review the drafts in `fixtures/variants/` (7 reversed forms, 21 rewordings; spec §2.2).
   **The eight lines for `egress` and `outside_repo` are stale:** both questions were
   reworded in 0.2.11 (#129) after the drafts were written, and need redrafting against
   the new wording. None carries a `base` fingerprint yet, and no code reads them.
3. Review the draft `fixtures/injection.jsonl` (63 attack cases, 14 controls; spec §2.3).
   Its `git_branch` cases need a `git` field the fixture loader does not read yet.
4. Decide the margins in ADR-011 decision 4 once Jev has been measured on the new sets.

**Next for a session.** The `calibrate` half of #127 can be built and tested
entirely against stubs before any of the owner's data exists: AUC, disposition, the three
new parts, `--fit`, `--gate --from`. The hook half (attestation check, `jev@` in
`adapterFor`, `on_error: ask`) comes after the first live reference run, bumps the version,
and is benched with `--against`.

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

## Other open threads

Unchanged by this session; see the issues. The ones that touch this work: #55 (the logit
preflight gap), #109 to #111 (first live rows for the existing arms), #114 (the Brier bar),
#75 and #113 (real labelled data), #51 (a daemon).
