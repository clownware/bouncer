# Handoff

The state of work in flight, for the next session. Created 2026-10-11; there was no handoff
document before this one. `CLAUDE.md` holds the standing rules and the pinned facts; this
file holds only what is open right now. Update it when a thread ends, and delete what has
landed.

## In flight: the local decision backend (ADR-011)

**Where it stands.** [ADR-011](docs/adr/011-the-local-backend-is-chosen-by-a-gate.md) is
**proposed, not accepted**. [`docs/calibration-gate.md`](docs/calibration-gate.md) is the
spec it decides on. No code, no fixtures and no models: the ADR says none of that starts
before it is accepted. The work is tracked in #127, and Clownbot's side in
clownware/clownbot#190.

**What it proposes, in four lines.**

- No local model is named. A backend other than `jev` gates only with an attestation that
  `bouncer calibrate --gate` writes when six parts pass against Jev: accuracy, calibration
  (with AUC), polarity, rephrase, injection, latency. Polarity and injection disqualify.
- Candidates in order: Clef-flash, Clef 27B, Kev 9B, all as `jev@<loopback>`. Laya is
  unsupported for gating (it already failed the existing gate, clownware/clownbot#94).
- The questions fingerprint is the wording version. A changed question un-attests a backend.
- A backend failure still emits nothing (ADR-003). `on_error: ask` is offered as an opt-in.

**Waiting on the owner, in order.**

1. Read ADR-011 and accept or amend it. The three choices that depart from the original
   brief are decisions 5 and 6 and the provisional margins in decision 4; each says what was
   asked for and why it proposes something else.
2. Run `bouncer export` on the real decision log (#113) and label the result into
   `fixtures/traces.jsonl` with `strata` and `split` (spec §2.1). Only the owner can label.
3. Write, or review a draft of, the 7 reversed forms and 21 rewordings (spec §2.2).

**Next for a session, once 1 is done.** The `calibrate` half of #127 can be built and tested
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

## Other open threads

Unchanged by this session; see the issues. The ones that touch this work: #55 (the logit
preflight gap), #109 to #111 (first live rows for the existing arms), #114 (the Brier bar),
#75 and #113 (real labelled data), #51 (a daemon).
