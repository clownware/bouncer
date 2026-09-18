// A local model, decoded under constraint, behind an OpenAI-compatible endpoint.
//
// This is not a chat completion asked politely for JSON. A `noul` answer is a probability,
// and the only honest way to get one out of a general model is to read it off the
// distribution: constrain the next token to the label set, take the logprobs the server
// returns for those tokens, and softmax over them. Parsing "Yes, this looks destructive"
// out of a chat turn gives a string, not a probability, and no amount of prompting turns
// one into the other.
//
//   state (shared prefix, prefilled once)
//     └─ question 1 suffix ─> 1 token, constrained to {yes, no} ─> p
//     └─ question 2 suffix ─> 1 token, constrained to {yes, no} ─> p
//     └─ ...
//
// The fork is real on the server and notional on the wire: HTTP gives us no way to hold a
// KV cache open and branch it. What makes it one prefill is that every request in a batch
// shares byte-identical leading text, which llama.cpp's and vLLM's prefix caches key on.
// The first question is therefore issued alone and the rest follow in parallel — fanning
// out immediately would have every worker prefill the same state concurrently and cache
// nothing. See docs/adr/005-the-local-adapter.md.
//
// If the engine cannot constrain — no `/tokenize` to resolve label ids, no logprobs in the
// response, or a `logit_bias` it quietly ignores — the adapter refuses to start. An
// unconstrained decode would still return *a* number, which is the failure we are trying
// not to have: a confident-looking probability with nothing behind it.

import {
  AdapterError,
  type Adapter,
  type Answer,
  type DecideRequest,
  type DecideResponse,
  type NoulQuestion,
} from "./types.js";

/** llama.cpp's default. vLLM's is :8000. Neither is guessable, so both are configured. */
const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_MODEL = "local";
const DEFAULT_CONCURRENCY = 4;
/** What `start()` gives the preflight when no caller deadline is in play. */
const PREFLIGHT_BUDGET_MS = 10_000;

/**
 * Surface forms of each label.
 *
 * Tokenizers disagree about the leading space, and the template ends in `Answer:` so the
 * model's natural continuation carries one. Every form that survives tokenization to a
 * single token is biased, and their probabilities are summed per class before normalising:
 * " yes" and "Yes" are the same answer and splitting their mass between them would read as
 * uncertainty that is not there.
 */
const DEFAULT_TRUE_LABELS = ["yes", " yes", "Yes", " Yes"] as const;
const DEFAULT_FALSE_LABELS = ["no", " no", "No", " No"] as const;

/** OpenAI's documented clamp is ±100, and both servers honour it. */
const FORCE_BIAS = 100;

export interface LocalOptions {
  /** OpenAI-compatible root, including `/v1`. */
  readonly baseUrl?: string;
  readonly model?: string;
  readonly trueLabels?: readonly string[];
  readonly falseLabels?: readonly string[];
  /** Parallel requests after the prefill. Above the server's slot count this buys nothing. */
  readonly concurrency?: number;
  /** Merged into every completion body — `cache_prompt: true` for older llama.cpp builds. */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What the preflight established, memoised for the life of the adapter. */
interface Constraint {
  /** Token id (as a string key, per the OpenAI schema) to bias. */
  readonly bias: Readonly<Record<string, number>>;
  /** Normalised surface form to the class it belongs to. */
  readonly classes: ReadonlyMap<string, boolean>;
  /** Top-n to ask for: every allowed token, so neither class can fall off the list. */
  readonly topLogprobs: number;
}

export class LocalAdapter implements Adapter {
  readonly name = "local";
  private readonly options: LocalOptions;
  private constraint: Promise<Constraint> | undefined;

  constructor(options: LocalOptions = {}) {
    this.options = options;
  }

  /**
   * Resolve the label tokens and prove the endpoint constrains, once.
   *
   * Callable directly so `bouncer calibrate` can fail before the first fixture rather than
   * on it. `decide` awaits the same promise, so the cost is paid once per process either
   * way. It is not cached across processes: the hook is a fresh process per tool call and
   * pays one tokenize round trip to localhost each time, which is noise beside the decode
   * itself. ADR-005 records that as the thing to revisit if local ever runs in the hook
   * path at volume.
   */
  async start(): Promise<void> {
    await this.ready(Date.now() + PREFLIGHT_BUDGET_MS);
  }

  async decide(request: DecideRequest): Promise<DecideResponse> {
    const started = Date.now();
    const deadline = started + request.timeoutMs;

    const entries = Object.entries(request.questions);
    for (const [name, question] of entries) {
      if (question.type !== "noul") {
        // Silently dropping it would leave the rule that reads it with no evidence and no
        // explanation. Choice and score need a different constraint — a letter index over
        // the options — and that lands with the router, not here.
        throw new AdapterError(
          "invalid_request",
          `the local adapter answers noul questions only; "${name}" is a ${question.type}`,
        );
      }
    }

    // The preflight runs inside the caller's budget, not beside it. A hook with an 800 ms
    // timeout facing an endpoint that accepts connections and never answers must come back
    // in 800 ms with a timeout, not spend a preflight budget per probe first.
    const constraint = await this.ready(deadline);

    // The first question alone, so the state is in the server's prefix cache before the
    // rest fork off it. Fanning all of them out at once would prefill the state N times.
    const answers: Record<string, Answer> = {};
    let inputTokens = 0;
    let model: string | undefined;

    const ask = async ([name, question]: [string, NoulQuestion]): Promise<void> => {
      const result = await this.complete(
        `${request.state}${suffixFor(question)}`,
        constraint,
        deadline,
        request.signal,
      );
      answers[name] = { type: "noul", noul: result.p };
      // Summed across questions, so the state is counted once per question. That is what
      // the server billed for; whether it recomputed it is the prefix cache's business.
      inputTokens += result.inputTokens ?? 0;
      model ??= result.model;
    };

    const [first, ...rest] = entries as Array<[string, NoulQuestion]>;
    if (first !== undefined) await ask(first);
    await pool(rest, this.options.concurrency ?? DEFAULT_CONCURRENCY, ask);

    if (Object.keys(answers).length === 0) {
      throw new AdapterError("malformed_response", "no readable answers in the response");
    }

    return {
      answers,
      ...(model !== undefined ? { model } : {}),
      ...(inputTokens > 0 ? { inputTokens } : {}),
      latencyMs: Date.now() - started,
    };
  }

  private ready(deadline: number): Promise<Constraint> {
    // Memoised on the promise, not the value: two concurrent decides must not both probe.
    // A failed preflight clears the memo, so a server that comes up later is not written
    // off for the life of the process.
    this.constraint ??= this.preflight(deadline).catch((err: unknown) => {
      this.constraint = undefined;
      throw err;
    });
    return this.constraint;
  }

  private async preflight(deadline: number): Promise<Constraint> {
    const trueLabels = this.options.trueLabels ?? DEFAULT_TRUE_LABELS;
    const falseLabels = this.options.falseLabels ?? DEFAULT_FALSE_LABELS;

    const bias: Record<string, number> = {};
    const classes = new Map<string, boolean>();
    const kept = { true: 0, false: 0 };

    for (const [labels, truth] of [
      [trueLabels, true],
      [falseLabels, false],
    ] as const) {
      for (const label of labels) {
        const tokens = await this.tokenize(label, deadline);
        // A multi-token label cannot be forced by a single-token bias: biasing its first
        // token says nothing about what follows, and the probability read off that token
        // would be the probability of a prefix.
        if (tokens.length !== 1) continue;
        bias[String(tokens[0])] = FORCE_BIAS;
        classes.set(normalise(label), truth);
        kept[truth ? "true" : "false"] += 1;
      }
    }

    for (const truth of ["true", "false"] as const) {
      if (kept[truth] === 0) {
        throw new AdapterError(
          "invalid_request",
          `every surface form of the ${truth} label is more than one token under this model's tokenizer, ` +
            `so the decode cannot be constrained to it. Configure single-token labels for this model.`,
        );
      }
    }

    const constraint: Constraint = { bias, classes, topLogprobs: Object.keys(bias).length };

    // Proving the constraint works, rather than assuming it from a version string. A
    // server that accepts `logit_bias` and ignores it is the dangerous case, because every
    // answer after it looks fine. `complete` throws if the response carries no logprobs or
    // if neither label token survived the bias, which is the whole of the check.
    await this.complete(PROBE_PROMPT, constraint, deadline);

    return constraint;
  }

  /** One constrained token, and the probability of the true class read off its logprobs. */
  private async complete(
    prompt: string,
    constraint: Constraint,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<{ p: number; model?: string; inputTokens?: number }> {
    const body = {
      model: this.options.model ?? DEFAULT_MODEL,
      prompt,
      max_tokens: 1,
      temperature: 0,
      logprobs: constraint.topLogprobs,
      logit_bias: constraint.bias,
      ...(this.options.extraBody ?? {}),
    };

    const payload = await this.post(`${this.baseUrl()}/completions`, body, deadline, signal);
    return { ...readProbability(payload, constraint), ...readUsage(payload) };
  }

  /**
   * Token ids for one string.
   *
   * llama.cpp and vLLM both serve `/tokenize` at the server root and disagree only about
   * the request body, so both shapes are tried. Failing both is a refusal to start: without
   * ids there is no `logit_bias`, and without `logit_bias` there is no constraint.
   */
  private async tokenize(text: string, deadline: number): Promise<number[]> {
    const shapes: Array<Record<string, unknown>> = [
      { content: text, add_special: false }, // llama.cpp
      { model: this.options.model ?? DEFAULT_MODEL, prompt: text, add_special_tokens: false }, // vLLM
    ];

    const root = this.baseUrl().replace(/\/v1\/?$/, "");
    let last: unknown;

    for (const url of [`${root}/tokenize`, `${this.baseUrl()}/tokenize`]) {
      for (const shape of shapes) {
        try {
          const payload = await this.post(url, shape, deadline);
          const tokens = (payload as Record<string, unknown>)["tokens"];
          if (Array.isArray(tokens) && tokens.every((t) => typeof t === "number")) return tokens as number[];
        } catch (err) {
          // A timeout is the caller's deadline expiring, not this endpoint answering the
          // wrong shape. Trying three more shapes against a clock that has already run out
          // would turn one slow server into four.
          if (err instanceof AdapterError && err.kind === "timeout") throw err;
          last = err;
        }
      }
    }

    throw new AdapterError(
      "invalid_request",
      `cannot resolve label token ids: ${root}/tokenize answered neither the llama.cpp nor the vLLM request shape` +
        `${last instanceof Error ? ` (${last.message})` : ""}. ` +
        `Without token ids the decode cannot be constrained, and an unconstrained answer is not a probability.`,
    );
  }

  private async post(url: string, body: unknown, deadline: number, signal?: AbortSignal): Promise<unknown> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AdapterError("timeout", "no time left in the budget");

    // No retry. A local server that just refused is not a network blip, and a second round
    // trip inside the hook's budget costs more than the answer is worth.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) throw await errorFor(response, url);
      return await response.json();
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw new AdapterError("timeout", `${url} did not answer in time`, { cause: err });
      }
      throw new AdapterError("unavailable", err instanceof Error ? err.message : String(err), { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }
}

/**
 * The fork: everything after the state.
 *
 * Byte-identical across questions up to this point, which is what the server's prefix cache
 * keys on. Criteria go in positively-worded blocks because jev-1.13 and small local models
 * share the habit of reading negations literally; CLAUDE.md has the longer version.
 */
function suffixFor(question: NoulQuestion): string {
  const lines = ["", "---", `Question: ${question.instructions}`];
  if (question.criteria?.true !== undefined) lines.push(`True when: ${question.criteria.true}`);
  if (question.criteria?.false !== undefined) lines.push(`False when: ${question.criteria.false}`);
  lines.push("Answer with one word, yes or no.", "Answer:");
  return lines.join("\n");
}

const PROBE_PROMPT = `Question: Is the sky sometimes blue?\nAnswer with one word, yes or no.\nAnswer:`;

/**
 * Softmax over the label logprobs.
 *
 * Softmax is shift-invariant, so this is correct whether the server returns raw logits or
 * normalised logprobs, and correct whether or not the bias already renormalised the
 * distribution over the allowed set. What it is not is a confidence: it is the model's
 * probability for one of two tokens, which is exactly what `noul` means and exactly what
 * the policy's thresholds are written against.
 */
function readProbability(payload: unknown, constraint: Constraint): { p: number } {
  const top = topLogprobs(payload);
  if (top === undefined) {
    throw new AdapterError(
      "malformed_response",
      "the endpoint returned no top logprobs, so there is no distribution to read a probability from",
    );
  }

  let trueMass = 0;
  let falseMass = 0;
  let sawUnknown: string | undefined;

  for (const [token, logprob] of Object.entries(top)) {
    if (typeof logprob !== "number" || !Number.isFinite(logprob)) continue;
    const truth = constraint.classes.get(normalise(token));
    if (truth === undefined) {
      sawUnknown ??= token;
      continue;
    }
    if (truth) trueMass += Math.exp(logprob);
    else falseMass += Math.exp(logprob);
  }

  const total = trueMass + falseMass;
  if (total <= 0) {
    throw new AdapterError(
      "invalid_request",
      `the endpoint ignored logit_bias: neither label token appears in the returned distribution` +
        `${sawUnknown !== undefined ? ` (it offered ${JSON.stringify(sawUnknown)})` : ""}. ` +
        `An unconstrained decode cannot produce a calibrated probability, so the adapter will not run.`,
    );
  }

  return { p: trueMass / total };
}

/**
 * `choices[0].logprobs.top_logprobs[0]`, as both servers spell it.
 *
 * vLLM returns the OpenAI array-of-maps shape. llama.cpp's OpenAI-compatible layer matches
 * it; its native `/completion` endpoint does not, which is why this adapter talks to
 * `/v1/completions` and nothing else.
 */
function topLogprobs(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const choices = (payload as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;

  const logprobs = (choices[0] as Record<string, unknown>)["logprobs"];
  if (typeof logprobs !== "object" || logprobs === null) return undefined;

  const top = (logprobs as Record<string, unknown>)["top_logprobs"];
  if (!Array.isArray(top) || top.length === 0) return undefined;

  const first = top[0];
  return typeof first === "object" && first !== null ? (first as Record<string, unknown>) : undefined;
}

function readUsage(payload: unknown): { model?: string; inputTokens?: number } {
  if (typeof payload !== "object" || payload === null) return {};
  const record = payload as Record<string, unknown>;
  const usage = record["usage"];
  const prompt = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>)["prompt_tokens"] : undefined;

  return {
    ...(typeof record["model"] === "string" ? { model: record["model"] } : {}),
    ...(typeof prompt === "number" ? { inputTokens: prompt } : {}),
  };
}

/**
 * Compare label surface forms without arguing about whitespace.
 *
 * SentencePiece detokenises its word boundary as `▁`, GPT-2 style BPE as a leading space,
 * and neither is a different answer from the other. The decode is already constrained to
 * the ids we biased, so anything reaching here is one of ours and normalising cannot
 * over-match.
 */
function normalise(token: string): string {
  return token.replace(/^[\s▁]+/, "").toLowerCase();
}

async function errorFor(response: Response, url: string): Promise<AdapterError> {
  let detail = "";
  try {
    detail = (await response.text()).trim().slice(0, 200);
  } catch {
    detail = "";
  }
  const suffix = detail.length > 0 ? `: ${detail}` : "";

  if (response.status === 404) {
    return new AdapterError("invalid_request", `${url} is not served by this endpoint (404)${suffix}`, { status: 404 });
  }
  if (response.status === 400 || response.status === 422) {
    return new AdapterError("invalid_request", `${url} rejected the request (${response.status})${suffix}`, {
      status: response.status,
    });
  }
  if (response.status >= 500) {
    return new AdapterError("unavailable", `${url} returned ${response.status}${suffix}`, { status: response.status });
  }
  return new AdapterError("invalid_request", `${url} returned ${response.status}${suffix}`, { status: response.status });
}

/** Bounded fan-out. Rejections propagate; there is no partial answer worth keeping. */
async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (item === undefined) return;
        await worker(item);
      }
    }),
  );
}
