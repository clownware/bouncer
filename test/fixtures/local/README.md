# Local-adapter response shapes

One `/v1/completions` answer per shape the adapter must read, each for the same
distribution: p(yes) = 0.75 over the two label tokens. `test/local.test.ts` asserts that
every `.json` file here parses to that p, so a server whose shape drifts fails by file name.

- `legacy-top-logprobs.json`: the OpenAI legacy completions shape, as vLLM returns it.
  `choices[0].logprobs.top_logprobs[0]` is a map of token to logprob.
- `llamacpp-0.4.1-content.json`: llama.cpp 0.4.1 (build 10964), which answers
  `/v1/completions` in the chat shape. `choices[0].logprobs.content[0].top_logprobs[]` is an
  array of `{ id, token, bytes, logprob }` (clownware/bouncer#105).

**Provenance.**
- `llamacpp-0.4.1-content.json` is a real response from Clownbot's `local-plumbing` seat,
  captured 2026-09-27: llama.cpp build `b10964-b29c606e2`, `Qwen3-4B-Instruct-2507` Q8_0,
  one token with `logprobs: 5` and both label ids biased. Only the logprob values were
  edited: " yes" 0.60, " Yes" 0.15, " no" 0.20, " No" 0.05, so p(yes) is 0.75. That keeps
  what the reconstruction had missed. The top five include a token that is not a label
  (" **"), because llama.cpp reports the distribution before `logit_bias`, and each label
  appears in two surface forms that must be summed.
- `legacy-top-logprobs.json` is written from the OpenAI legacy shape, not captured, since no
  vLLM server was available.
