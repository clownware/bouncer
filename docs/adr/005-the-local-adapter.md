# ADR-005: The local adapter reads a probability off the logits, or refuses to run

- **Status:** accepted
- **Date:** 2026-09-18
- **Context for:** v0.2 (promoted from v0.3)

## Decision

`src/adapters/local.ts` answers a `noul` question by constraining the next token to the
label set and taking a softmax over the label logprobs. It talks to an OpenAI-compatible
`/v1/completions` endpoint that exposes `logprobs` and `logit_bias` — llama.cpp's server or
vLLM. If the endpoint cannot constrain, the adapter refuses to start.

One state, prefilled once, forked per question:

```
state  (identical bytes across every request in a batch)
  └─ "\n---\nQuestion: …\nAnswer with one word, yes or no.\nAnswer:"  →  1 token  →  p
  └─ … one per gate question
```

Four things follow from that shape, and each is the reason for a piece of the code.

## Why not a chat completion asked for JSON

The policy's rules are thresholds on a probability. `unreviewed_execution` fires at 0.65;
the uncertainty band is 0.40 to 0.60. A chat turn returns a string. Prompting a model for
`{"answer": "yes", "confidence": 0.8}` gets a number the model wrote down, not a number
read off its distribution — self-reported confidence, which is a well-known way to produce
a table that looks calibrated and is not. Since the gate's whole claim is the calibration
table, a backend that cannot produce a real probability cannot be compared to Jev on it at
all, and the `--compare` table would be measuring two different kinds of quantity in the
same column.

Constrained decoding gives the actual quantity: with the next token forced to `{yes, no}`,
`P(yes)` is the model's probability, on the same footing as a Noul.

## Why it refuses to start

An unconstrained decode still returns *a* number. That is precisely the failure this
project exists to avoid — a confident-looking verdict with nothing behind it — and it is
invisible, because every answer after it looks fine. So the adapter proves the constraint
before it trusts one, rather than inferring it from a version string:

1. **Resolve label token ids** via the server's `/tokenize`. llama.cpp and vLLM both serve
   it at the root and disagree only about the request body, so both shapes are tried. No
   ids means no `logit_bias`, which means no constraint: refuse.
2. **Drop multi-token surface forms.** Biasing the first token of a two-token label says
   nothing about what follows, and the probability read off it would be the probability of
   a prefix. If every form of either label is multi-token under this model's tokenizer,
   refuse and say so — the fix is to configure labels that are single tokens for it.
3. **Probe once.** One real completion with the bias applied. No logprobs in the response,
   or neither label token in the returned distribution, means the server accepted
   `logit_bias` and ignored it: refuse.

The refusal is an `AdapterError` like any other, so at hook time `on_error` decides what
happens and the default is still to emit nothing (ADR-003). Refusing to start is not
refusing to let the tool call through.

## Why the first question is issued alone

"One shared prefill, forked per question" is exact on the server and impossible on the
wire: HTTP gives no way to hold a KV cache open and branch it. What makes it one prefill in
practice is the prefix cache — llama.cpp's and vLLM's both key on byte-identical leading
tokens — so the state is the first thing in every request and the per-question text is
appended after it.

That only works if the cache is populated before the fan-out. Issuing all seven questions
at once has seven workers prefill the same state concurrently and store nothing useful, so
the first question is awaited alone and the rest follow in a bounded pool. On a seven-
question gate this turns seven state prefills into one plus seven short suffixes.

`inputTokens` still sums the prompt tokens of every request, because that is what the
server reported. Whether it recomputed them is the cache's business, not the harness's.

## Why softmax over the label logprobs, summed per class

`p = Σexp(l) over true-forms / (Σ true + Σ false)`.

- **Softmax is shift-invariant**, so this is correct whether the server returns raw logits
  or normalised logprobs, and whether or not the bias already renormalised the distribution
  over the allowed set. Three servers, one formula, no version sniffing.
- **Surface forms are summed, not split.** `" yes"` and `"Yes"` are the same answer.
  Leaving their mass split reads as uncertainty that is not there — 0.4 and 0.4 against a
  0.2 `" no"` is an 0.8, not a hung jury — and the uncertainty band would catch it.
- **Matching is whitespace-insensitive.** SentencePiece detokenises its word boundary as
  `▁`, GPT-2 BPE as a leading space. The decode is already constrained to ids we biased, so
  normalising cannot over-match something else.

This is still not a confidence. It is the model's probability over two tokens, which is
what `noul` means and what the policy's thresholds are written against. `max(p, 1 − p)` —
what the gate table calls confidence — remains a derived statistic on both backends.

## What `--compare` can and cannot say

`bouncer calibrate --compare jev,local` runs both backends over the same fixtures through
the same `score()` and prints one side-by-side table. It compares **p and Brier only**, and
the header says so, because Jev returns no confidence field for a `noul` (ADR-002, and
PRD §16 question 3) and the local adapter's softmax is not one either. A confidence column
only one side could fill would invite exactly the comparison neither side supports.

Rows are **paired** on (fixture, question): an answer one backend did not produce is
dropped from both. Comparing a 94-row mean against an 89-row mean and calling the
difference a backend difference is the quiet way for this table to lie.

**A Jev-shaped server is a URL, not an adapter** (added 2026-09-23). `--compare
jev,jev@<url>` points the same `JevAdapter` at another server's `/v1/systemone`, which is
the cheapest first real comparison: openjev-sglang serves Jev's wire shape from an
open-weights model, so both columns go through one request builder and one parser, and the
only thing that differs is the model. It is the second arm of the three-way table, not a
substitute for this adapter — it reads whatever that server computes, and this ADR's
refusals (single-token labels, a proven constraint) are the server's business there, not
ours. Three choices ride on it. The TypeSafe key is never sent to a `jev@` URL, since the
URL is whatever was typed. Before the first fixture the adapter asks one real question and
waits up to ten minutes for an answer, because a scaled-to-zero GPU endpoint boots for
longer than a fixture's 30 s and a timeout on fixture 1 ends the run; the answer goes
through the fixture parser, so a server in the wrong shape is refused there, the same
reason step 3 probes. And the column is named `jev@<host>`, because it is the name the
`--out` line and any judgments line carry, and two Jev-shaped backends under one name
would be two classifiers reported as one.

The table also reports how many fixtures reach the **same verdict** under each backend.
That is the number a user swapping backends actually feels — not "do the probabilities
agree" but "would this have prompted me in different places" — and two backends can differ
by 0.2 on p everywhere and agree on every verdict, or agree closely and diverge at a
threshold.

## Consequences and costs

- **Configuration is environment-only for now:** `BOUNCER_LOCAL_URL`, `BOUNCER_LOCAL_MODEL`,
  `BOUNCER_LOCAL_CONCURRENCY`. An endpoint URL is not a threshold, so the no-thresholds-in-
  code rule does not by itself send it to the YAML, and keeping it out of the schema lets
  this land without touching the policy loader. A `local:` block belongs in the policy once
  local is a supported hook backend rather than a calibration one.
- **The preflight is per process.** The hook is a fresh process per tool call, so a hook
  configured with `backend: local` pays the tokenize round trips and one probe every call.
  Against localhost that is small beside the decode itself, but it is real, and a disk cache
  of resolved ids keyed on (url, model) is the fix if local ever runs in the hook path at
  volume. The preflight runs inside the caller's deadline, not beside it, so a server that
  accepts connections and never answers still returns a timeout within `timeout_ms`.
- **`choice` and `score` are refused,** loudly, rather than answered badly. Constraining a
  choice needs a letter index over the options, which is the router's problem (v0.2) and
  lands with it.
- **Latency is unchanged for everyone else.** `npm run bench` p95 96.9 ms before this
  change and 92.0 ms after, on the same container, against a 150 ms CI budget; the bundle
  grows 320.0 KB to 339.1 KB. Nothing new is imported at module scope on the hook path
  beyond the adapter itself.
- **Nothing here has been run against a real model.** Every test stubs the HTTP layer, and
  no thread has a local endpoint. The wire shapes come from the two servers' documented
  OpenAI-compatible surfaces; the first live run is the thing that will find whatever this
  got wrong, and the `--compare` table is what it should produce.

## What this does not decide

Which local model. The fixture table decides that, not this document. PRD §12's definition
of done — within 5 points of Jev on Brier, or the README says exactly how far off — is the
bar, and `--compare` now prints that sentence itself so nobody has to read it off a table
by eye.
