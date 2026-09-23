---
description: Run bouncer's fixtures through its classifier and show the reliability table
argument-hint: "[--backend jev|jev@<url>|chat@<url>|local|mock] [--compare a,b] [--out run.jsonl] [--from run.jsonl] [--set name] [--fixtures path]"
allowed-tools: Bash(node:*)
---

Run the calibration harness and show the user its output:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bouncer.cjs" calibrate $ARGUMENTS`

A live run against `jev` makes one network call per fixture and needs
`BOUNCER_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` in the environment. Without a key, it
will say so; suggest `--backend mock` only if the user wants to check that the harness
itself works, since the mock's numbers mean nothing about the real classifier.

A run against `local` needs an OpenAI-compatible endpoint that exposes `logprobs` and
`logit_bias` — llama.cpp's server or vLLM — pointed at by `BOUNCER_LOCAL_URL` (default
`http://127.0.0.1:8080/v1`) with `BOUNCER_LOCAL_MODEL` naming the model. If the endpoint
cannot constrain the decode, the adapter refuses to start and says which of the three
checks failed; it does not fall back to an unconstrained answer, because that would be a
number with nothing behind it.

`--compare jev,local` runs both over the same fixtures and prints a side-by-side table
after the two reports. It compares `p` and Brier only: a noul answer has no confidence
field on either backend, and the confidence in the gate table is the derived statistic
max(p, 1 - p). The row worth reading first is how many fixtures reach the same verdict
under both, since that is what the user would actually feel.

`--out run.jsonl` keeps what the classifier said about every fixture, and `--from run.jsonl`
scores that file instead of calling a backend — no key, no network. Reach for the pair when
the user asks what moving a threshold would do: edit the threshold, re-run with `--from`,
and the answer comes from the run they already paid for rather than from a fresh sample.
`--from` also reads `decisions.jsonl` and a `bouncer judge` log. `--set` names the policy
set to score against (default `gate`) and `--fixtures` the labelled file (default the
bundled `fixtures/gate.jsonl`).

Reading the result with the user:

- **Accuracy** is agreement with the fixture labels, which are hand-written judgments
  about what should warrant a prompt. It is not accuracy against ground truth. Say this
  if they start treating the number as objective.
- **Brier** is mean squared error against the label. 0.25 is a coin flip; lower is better.
- **The buckets** are the useful part. A question that is right 95% of the time when it
  answers above 0.9, and 60% when it answers around 0.55, is well calibrated — the
  threshold can sit high and the uncertainty rule catches the rest. A question that is
  wrong at high confidence is the one to fix, by rewording it or lowering its threshold.
- **The disagreements** are listed most confident first. A confident disagreement means
  either the label is wrong or the question is worded badly. Check the label first.

If the user is calibrating to decide whether to leave observe mode, the question to answer
is per-question, not overall: they can enable `guard` on the questions that calibrate well
and leave the others at thresholds high enough that they rarely fire.
