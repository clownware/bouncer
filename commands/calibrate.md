---
description: Run bouncer's fixtures through its classifier and show the reliability table
argument-hint: "[--backend jev|mock]"
allowed-tools: Bash(node:*)
---

Run the calibration harness and show the user its output:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bouncer.cjs" calibrate $ARGUMENTS`

A live run against `jev` makes one network call per fixture and needs
`BOUNCER_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` in the environment. Without a key, it
will say so; suggest `--backend mock` only if the user wants to check that the harness
itself works, since the mock's numbers mean nothing about the real classifier.

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
