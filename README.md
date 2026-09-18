# Bouncer

A decision layer for [Claude Code](https://claude.com/claude-code) hooks.

A `PreToolUse` hook classifies each proposed tool call against a policy you own and returns
allow / ask / deny — using a fast System One model ([TypeSafe Jev](https://typesafe.ai))
rather than a frontier LLM, so it can run on every call for about four cents a day.

The problem it exists for: Claude Code's permission prompt is binary. Either every `Bash`,
`Edit` and `Write` interrupts you, or you run `--dangerously-skip-permissions` and hope.
There is no cheap middle — let the obvious through, stop the dangerous, ask about the
ambiguous — because that middle needs judgment, and judgment used to mean either brittle
regex or an LLM in the hot path.

> **Status: v0.1.** The hook runs end to end in observe mode, and the calibration table
> below comes from a live run against Jev, on the policy in this repository, in which all
> seven questions clear the PRD's 0.85 bar in the high-confidence buckets. One of them,
> `sensitive_target`, passes on 12 confident answers with the same 11 correct in four
> runs; it has flipped twice as one miss moved across 0.80, so read its pass as a
> coin landing, not a trend. See [docs/PRD.md](docs/PRD.md) for the spec and
> [docs/adr/](docs/adr/) for what has been decided and why.

## Calibration

Bouncer ships observing because you should not enable enforcement on the strength of a
README claiming the classifier is good. Run it yourself:

```bash
BOUNCER_TYPESAFE_API_KEY=… node bin/bouncer.cjs calibrate
```

It prints the bucket table below, then a pass/fail row per question against the
`calibration` block in the policy — 0.85 accuracy among answers at 0.8 confidence or
higher, which you can raise before trusting a question. That bar is compared on the exact
ratio and printed to one decimal, because 11 of 13 is 84.6% and rounds to a passing-looking
85%.

<!-- CALIBRATION-TABLE:START -->
Live run against `jev-1.13.0` on 2026-09-18, on the policy in this repository. Confidence
is `max(p, 1 − p)`.

| question | n | accuracy | Brier | 0.5–0.6 | 0.6–0.7 | 0.7–0.8 | 0.8–0.9 | 0.9–1.0 |
|---|---|---|---|---|---|---|---|---|
| destructive | 26 |  92% | 0.088 |  75% (4) | 100% (4) | 100% (3) |  50% (2) | 100% (13) |
| egress | 20 |  95% | 0.030 |  —  |  —  |   0% (1) |  —  | 100% (19) |
| outside_repo | 20 |  90% | 0.070 |  50% (2) | 100% (2) |  50% (2) |  —  | 100% (14) |
| prod | 16 |  94% | 0.032 |   0% (1) |  —  | 100% (1) | 100% (3) | 100% (11) |
| secrets | 19 |  84% | 0.098 |   0% (1) |  75% (4) |  —  |  75% (4) | 100% (10) |
| sensitive_target | 16 |  81% | 0.128 | 100% (2) |   0% (1) |   0% (1) |   0% (1) | 100% (11) |
| unreviewed_execution | 24 | 100% | 0.020 |  —  | 100% (2) | 100% (1) | 100% (4) | 100% (17) |

Against the gate (≥ 0.85 accuracy at confidence ≥ 0.80):

| question | correct / n | accuracy | passes |
|---|---|---|---|
| destructive | 14 / 15 | 93.3% | yes |
| egress | 19 / 19 | 100.0% | yes |
| outside_repo | 14 / 14 | 100.0% | yes |
| prod | 14 / 14 | 100.0% | yes |
| secrets | 13 / 14 | 92.9% | yes |
| sensitive_target | 11 / 12 | 91.7% | yes |
| unreviewed_execution | 21 / 21 | 100.0% | yes |

Every question clears the bar (7 of 7).

Accuracy is scored at 0.5 and the rules fire at their own thresholds, so the tables above
cannot show what the policy would actually do. The harness now reports that too: this run
has no fixture the labels say should prompt that the policy allows, and 25 of 96 that the
policy prompts on although the labels say it should not, 12 of them
through the uncertainty rule. The full report, with that section, every disagreement and
why each label is what it is, is in
[docs/calibration/2026-09-18-jev-7.md](docs/calibration/2026-09-18-jev-7.md).
<!-- CALIBRATION-TABLE:END -->

**Read the row, not the bucket.** Only the 0.9–1.0 bucket has enough fixtures to mean
anything; every bucket below it rests on one to five. Runs
[2](docs/calibration/2026-09-18-jev-2.md) and [3](docs/calibration/2026-09-18-jev-3.md)
used identical fixtures and an identical policy. Every overall accuracy came back the same
and no Brier score moved by more than 0.01, yet `destructive` in the 0.8–0.9 bucket went
from 0% of 3 to 20% of 5 and `secrets` in the same bucket from 67% of 3 to 100% of 3.
No verdict changed: fixtures near a bucket edge drift across it from run to run and take
their correctness with them. So the `n`, `accuracy` and `Brier` columns are the numbers
worth acting on, and the lower buckets show only the rough shape of where the model is
unsure. Making them mean more needs the ~150 fixtures the PRD asks for, not the 96 that
ship.

**What this table measures.** The 96 fixtures in [`fixtures/gate.jsonl`](fixtures/gate.jsonl)
are hand-labelled, and the labels are judgments about what *should* warrant a prompt. So
the number is the classifier's agreement with one person's policy intuitions, not accuracy
against ground truth. Since you are also the one setting the thresholds, that is the right
thing to measure — but it is not the same claim as "97% accurate", and it should not be
read as one.

They are written as **near-miss pairs**: `git push --force-with-lease origin feature/x`
against `git push --force origin main`, `terraform plan -var-file=prod.tfvars` against
`terraform apply -auto-approve`, `ssh-keygen -y -f ~/.ssh/id_ed25519` against
`cat ~/.ssh/id_ed25519`. A set of obviously-safe and obviously-dangerous commands would
score beautifully and tell you nothing, because no threshold ever sits there. As a
sanity check on that: the built-in keyword-matching mock adapter scores 38–82% on these,
which is roughly what a regex deserves on them.

The useful part is the buckets, not the headline. A question that is right 95% of the time
when it answers above 0.9 is one you can set a high threshold on and trust; a question
that is wrong at high confidence needs rewording, not a different threshold.

## Design commitments

These are the parts worth arguing with, stated up front.

**It ships observing only.** The default mode emits no decision at all, which means
behaviour identical to not having the plugin installed. You turn on enforcement after
looking at your own calibration numbers, not because a README told you the model is good.

**It cannot fail open, and it cannot fail loud.** Every error path — timeout, bad key,
rate limit, unparseable policy, internal crash — falls through to Claude Code's normal
permission flow. Bouncer being broken is never the reason something dangerous ran, and
never the reason your session is unusable.

**Adding friction is treated as a bug.** Even a correct verdict is a regression if it
prompts you on something that would not have prompted you before. This is why observe mode
emits nothing rather than `ask` — see [ADR-003](docs/adr/003-fail-to-prompt-and-observe-by-default.md).

**No thresholds in code.** The questions are plain English and the thresholds are numbers,
both living in a YAML file you own and can commit next to your `CLAUDE.md`. Re-tuning the
policy never means re-asking the model.

**It is a safety net, not a security boundary.** The command text being judged can come
from a repository you do not control, and the model's own documentation notes that state
content can be adversarially framed. Bouncer is built to catch Claude's mistakes. It is not
built to withstand someone deliberately trying to get past it.

## Performance

Hook overhead, measured on Node 22 (`npm run bench`), and the classifier call measured
against live Jev:

| | mean | p95 |
|---|---|---|
| bare `node -e ''` | 28 ms | 33 ms |
| bouncer hook, full engine, mock adapter | 51 ms | 63 ms |
| Jev call, steady state, 5 questions | ~190 ms | ~350 ms |
| Jev call, first of a session | 513 ms | — |

The Jev rows were measured when the policy asked five questions; it now asks seven, which
are evaluated in one call and in parallel, and the rows have not been re-measured since.
Steady state lands around 400 ms end to end. The first call of a session is nearer 565 ms:
connection setup, not the model, which is why the latency circuit breaker ignores it.

Budget is 80 ms p95 for hook overhead and 600 ms p95 end to end. CI enforces the former. See [ADR-002](docs/adr/002-bundled-single-file-on-node.md).

## Development

```bash
npm install
npm run build      # bundles src/ -> bin/bouncer.cjs (committed; see ADR-002)
npm test
npm run typecheck
npm run bench      # asserts hook overhead against the budget
```

`bin/bouncer.cjs` is a build artifact that lives in git, because Claude Code installs
plugins by fetching the repo and never runs `npm install`. Rebuild and commit it whenever
`src/` changes; CI checks that it matches.

To capture real hook payloads to develop against, see [scripts/CAPTURE.md](scripts/CAPTURE.md).

## License

MIT
