# Local-adapter response shapes

One `/v1/completions` answer per shape the adapter must read, each for the same
distribution: p(yes) = 0.75 over the two label tokens. `test/local.test.ts` asserts that
every `.json` file here parses to that p, so a server whose shape drifts fails by file name.

- `legacy-top-logprobs.json`: the OpenAI legacy completions shape, as vLLM returns it.
  `choices[0].logprobs.top_logprobs[0]` is a map of token to logprob.
- `llamacpp-0.4.1-content.json`: llama.cpp 0.4.1 (build 10964), which answers
  `/v1/completions` in the chat shape. `choices[0].logprobs.content[0].top_logprobs[]` is an
  array of `{ id, token, bytes, logprob }` (clownware/bouncer#105).

**Provenance.** Both are written from the shapes recorded in #105, not saved verbatim from
a live server; the Clownbot seats were down when these were made. When a seat is up,
replace a file with a real `/v1/completions` response (one token, `logprobs: 5`, the label
ids biased) and edit only the two logprob values so p(yes) stays 0.75.
