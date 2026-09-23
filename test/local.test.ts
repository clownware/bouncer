// The local adapter, with the HTTP layer stubbed.
//
// Nothing here touches a real endpoint, and CI has no model to talk to. What is being
// tested is the part that can be wrong silently: whether the request actually constrains
// the decode, whether the probability read back off the logprobs is the right one, and
// whether the adapter refuses rather than degrades when the engine cannot constrain.

import { describe, expect, it, vi } from "vitest";
import { LocalAdapter } from "../src/adapters/local.js";
import { AdapterError, noulProbability, type Question } from "../src/adapters/types.js";

const QUESTIONS: Record<string, Question> = {
  destructive: { type: "noul", instructions: "It destroys something." },
  secrets: { type: "noul", instructions: "It exposes a credential.", criteria: { true: "cat .env" } },
};

const STATE = '{"tool":"Bash","command":"rm -rf build"}';
const request = { state: STATE, questions: QUESTIONS, timeoutMs: 5_000 };

/** Single-token ids for every default surface form. Multi-token labels are opted into. */
const TOKEN_IDS: Record<string, number[]> = {
  yes: [9891],
  " yes": [9891],
  Yes: [5297],
  " Yes": [5297],
  no: [1738],
  " no": [1738],
  No: [2360],
  " No": [2360],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `{ " yes": logprob, " no": logprob }` as the OpenAI legacy completions shape spells it. */
function completion(top: Record<string, number>, extra: Record<string, unknown> = {}): unknown {
  return {
    model: "qwen3-4b",
    choices: [{ text: Object.keys(top)[0] ?? "", logprobs: { top_logprobs: [top] } }],
    usage: { prompt_tokens: 412 },
    ...extra,
  };
}

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/**
 * A server that tokenizes, then answers every completion with the same distribution.
 *
 * `tokens` overrides the tokenizer for particular strings, which is how the multi-token
 * label case is reached without inventing a second fake server.
 */
function server(options: {
  top?: Record<string, number>;
  tokens?: Record<string, number[]>;
  tokenizeStatus?: number;
  completionBody?: unknown;
  onCall?: (call: Call) => void | Promise<void>;
}) {
  const calls: Call[] = [];
  const top = options.top ?? { " yes": Math.log(0.75), " no": Math.log(0.25) };

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const call = { url: href, body };
    calls.push(call);
    await options.onCall?.(call);

    if (href.endsWith("/tokenize")) {
      if (options.tokenizeStatus !== undefined) return json({ error: "nope" }, options.tokenizeStatus);
      const text = String(body["content"] ?? body["prompt"] ?? "");
      const ids = options.tokens?.[text] ?? TOKEN_IDS[text];
      if (ids === undefined) return json({ error: "unknown" }, 400);
      return json({ tokens: ids });
    }

    return json(options.completionBody ?? completion(top));
  });

  return { fetchImpl, calls, completions: () => calls.filter((c) => c.url.endsWith("/completions")) };
}

describe("LocalAdapter", () => {
  it("reads p as a softmax over the label logprobs", async () => {
    const { fetchImpl } = server({ top: { " yes": Math.log(0.75), " no": Math.log(0.25) } });
    const result = await new LocalAdapter({ fetch: fetchImpl }).decide(request);

    expect(noulProbability(result.answers["destructive"])).toBeCloseTo(0.75, 6);
    expect(noulProbability(result.answers["secrets"])).toBeCloseTo(0.75, 6);
  });

  it("is shift-invariant, so raw logits give the same p as normalised logprobs", async () => {
    // The server may return either; softmax cannot tell them apart and neither should we.
    const asLogprobs = server({ top: { " yes": Math.log(0.6), " no": Math.log(0.4) } });
    const asLogits = server({ top: { " yes": Math.log(0.6) + 7.3, " no": Math.log(0.4) + 7.3 } });

    const a = await new LocalAdapter({ fetch: asLogprobs.fetchImpl }).decide(request);
    const b = await new LocalAdapter({ fetch: asLogits.fetchImpl }).decide(request);

    expect(noulProbability(a.answers["destructive"])).toBeCloseTo(noulProbability(b.answers["destructive"])!, 9);
  });

  it("sums the surface forms of a label rather than splitting its mass", async () => {
    // " yes" and "Yes" are the same answer. Left unsummed this reads as 0.4 — uncertainty
    // that is not there.
    const { fetchImpl } = server({
      top: { " yes": Math.log(0.4), Yes: Math.log(0.4), " no": Math.log(0.2) },
    });
    const result = await new LocalAdapter({ fetch: fetchImpl }).decide(request);
    expect(noulProbability(result.answers["destructive"])).toBeCloseTo(0.8, 6);
  });

  it("matches labels through a SentencePiece word boundary", async () => {
    const { fetchImpl } = server({ top: { "▁yes": Math.log(0.9), "▁no": Math.log(0.1) } });
    const result = await new LocalAdapter({ fetch: fetchImpl }).decide(request);
    expect(noulProbability(result.answers["destructive"])).toBeCloseTo(0.9, 6);
  });

  it("asks for one constrained token on /v1/completions, not a chat turn", async () => {
    const s = server({});
    await new LocalAdapter({ fetch: s.fetchImpl }).decide(request);

    const body = s.completions()[0]?.body as Record<string, unknown>;
    expect(s.completions()[0]?.url).toBe("http://127.0.0.1:8080/v1/completions");
    expect(s.calls.some((c) => c.url.includes("/chat/"))).toBe(false);
    expect(body["max_tokens"]).toBe(1);
    expect(body["temperature"]).toBe(0);
    expect(Object.keys(body["logit_bias"] as object).length).toBeGreaterThan(0);
    expect(body["logprobs"]).toBe(Object.keys(body["logit_bias"] as object).length);
  });

  it("biases every label token id it resolved", async () => {
    const s = server({});
    await new LocalAdapter({ fetch: s.fetchImpl }).decide(request);

    const bias = s.completions()[0]?.body["logit_bias"] as Record<string, number>;
    expect(Object.keys(bias).sort()).toEqual(["1738", "2360", "5297", "9891"]);
    expect(new Set(Object.values(bias))).toEqual(new Set([100]));
  });

  it("puts the state first, byte-identical across questions", async () => {
    const s = server({});
    await new LocalAdapter({ fetch: s.fetchImpl }).decide(request);

    // The probe is not a question and carries no state; the questions all share the prefix.
    const prompts = s.completions().map((c) => String(c.body["prompt"])).filter((p) => p.startsWith(STATE));
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt.slice(0, STATE.length)).toBe(STATE);
    expect(prompts[0]).not.toBe(prompts[1]);
  });

  it("issues the first question alone so the prefix cache is warm before the fork", async () => {
    // Fanning out immediately would have every worker prefill the same state at once and
    // cache nothing, which is the whole reason for the serialised first call.
    let inFlight = 0;
    let sawConcurrentPrefill = false;
    const seen: number[] = [];

    const s = server({
      onCall: async (call) => {
        if (!call.url.endsWith("/completions") || !String(call.body["prompt"]).startsWith(STATE)) return;
        inFlight += 1;
        seen.push(inFlight);
        if (seen.length === 1 && inFlight > 1) sawConcurrentPrefill = true;
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
    });

    const questions = Object.fromEntries(
      ["a", "b", "c", "d"].map((n) => [n, { type: "noul", instructions: n } as Question]),
    );
    await new LocalAdapter({ fetch: s.fetchImpl }).decide({ ...request, questions });

    expect(sawConcurrentPrefill).toBe(false);
    expect(seen[0]).toBe(1); // the first question had the endpoint to itself
    expect(Math.max(...seen)).toBeGreaterThan(1); // and the rest did fan out
  });

  it("resolves the label tokens once across several decides", async () => {
    const s = server({});
    const adapter = new LocalAdapter({ fetch: s.fetchImpl });
    await adapter.decide(request);
    await adapter.decide(request);

    expect(s.calls.filter((c) => c.url.endsWith("/tokenize"))).toHaveLength(8);
  });

  it("falls back to the vLLM tokenize shape when the llama.cpp one is refused", async () => {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url: href, body });

      if (href.endsWith("/tokenize")) {
        if (body["content"] !== undefined) return json({ error: "unsupported field" }, 400);
        return json({ tokens: TOKEN_IDS[String(body["prompt"])] ?? [1] });
      }
      return json(completion({ " yes": Math.log(0.8), " no": Math.log(0.2) }));
    });

    const result = await new LocalAdapter({ fetch: fetchImpl }).decide(request);
    expect(noulProbability(result.answers["destructive"])).toBeCloseTo(0.8, 6);
    expect(calls.some((c) => c.body["prompt"] !== undefined && c.url.endsWith("/tokenize"))).toBe(true);
  });
});

describe("LocalAdapter refuses to start rather than degrading", () => {
  const refuses = async (adapter: LocalAdapter, message: RegExp) => {
    await expect(adapter.start()).rejects.toThrow(AdapterError);
    await expect(adapter.start()).rejects.toThrow(message);
    // decide() refuses on the same grounds, so nothing gets an unconstrained answer by
    // going round start().
    await expect(adapter.decide(request)).rejects.toThrow(message);
  };

  it("when the endpoint has no tokenize endpoint to resolve label ids with", async () => {
    const { fetchImpl } = server({ tokenizeStatus: 404 });
    await refuses(new LocalAdapter({ fetch: fetchImpl }), /cannot resolve label token ids/);
  });

  it("when every surface form of a label is more than one token", async () => {
    const { fetchImpl } = server({
      tokens: { ...TOKEN_IDS, no: [1, 2], " no": [1, 2], No: [1, 2], " No": [1, 2] },
    });
    await refuses(new LocalAdapter({ fetch: fetchImpl }), /every surface form of the false label/);
  });

  it("when the response carries no logprobs", async () => {
    const { fetchImpl } = server({
      completionBody: { model: "m", choices: [{ text: " yes" }], usage: { prompt_tokens: 1 } },
    });
    await refuses(new LocalAdapter({ fetch: fetchImpl }), /no top logprobs/);
  });

  it("when the endpoint accepts logit_bias and ignores it", async () => {
    // The dangerous case: every answer after this one looks fine.
    const { fetchImpl } = server({ top: { " maybe": Math.log(0.5), " perhaps": Math.log(0.5) } });
    await refuses(new LocalAdapter({ fetch: fetchImpl }), /ignored logit_bias/);
  });

  it("and says so again on the next call rather than caching the refusal as a state", async () => {
    const { fetchImpl, calls } = server({ tokenizeStatus: 404 });
    const adapter = new LocalAdapter({ fetch: fetchImpl });
    await expect(adapter.start()).rejects.toThrow(AdapterError);
    const first = calls.length;
    await expect(adapter.start()).rejects.toThrow(AdapterError);
    expect(calls.length).toBeGreaterThan(first);
  });
});

describe("LocalAdapter errors", () => {
  it("refuses a question type it cannot constrain", async () => {
    const { fetchImpl } = server({});
    const questions: Record<string, Question> = {
      skill: { type: "choice", instructions: "Which skill?", criteria: { a: null, b: null } },
    };
    await expect(new LocalAdapter({ fetch: fetchImpl }).decide({ ...request, questions })).rejects.toThrow(
      /answers noul questions only/,
    );
  });

  it("reports a timeout as a timeout", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const error = await new LocalAdapter({ fetch: fetchImpl })
      .decide({ ...request, timeoutMs: 20 })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).kind).toBe("timeout");
  });

  it("reports a dead endpoint as unavailable, not as an answer", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
    }) as unknown as typeof globalThis.fetch;

    const error = await new LocalAdapter({ fetch: fetchImpl }).decide(request).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).kind).toBe("invalid_request"); // surfaced as "cannot resolve label token ids"
    expect((error as AdapterError).message).toMatch(/ECONNREFUSED/);
  });

  it("reports the model and prompt tokens the server billed", async () => {
    const { fetchImpl } = server({});
    const result = await new LocalAdapter({ fetch: fetchImpl }).decide(request);
    expect(result.model).toBe("qwen3-4b");
    expect(result.inputTokens).toBe(824); // 412 per question, two questions
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("honours a configured base URL and model", async () => {
    const s = server({});
    await new LocalAdapter({ fetch: s.fetchImpl, baseUrl: "http://10.0.0.4:8000/v1/", model: "qwen" }).decide(request);

    expect(s.completions()[0]?.url).toBe("http://10.0.0.4:8000/v1/completions");
    expect(s.completions()[0]?.body["model"]).toBe("qwen");
    expect(s.calls[0]?.url).toBe("http://10.0.0.4:8000/tokenize");
  });
});

// The chat mode: the LLM one-token-logprob arm. Same adapter, `/v1/chat/completions`, and
// the reply's `top_logprobs` in the chat shape OpenAI and vLLM share.

/** `logprobs.content[0]` for a reply of `token`, with `top` as its alternatives. */
function chatReply(token: string, top: Record<string, number>, extra: Record<string, unknown> = {}): unknown {
  return {
    model: "gpt-4.1-mini-2025-04-14",
    choices: [
      {
        message: { role: "assistant", content: token },
        logprobs: {
          content: [
            {
              token,
              logprob: top[token] ?? -0.01,
              top_logprobs: Object.entries(top).map(([t, logprob]) => ({ token: t, logprob, bytes: [] })),
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 300 },
    ...extra,
  };
}

/**
 * An OpenAI-shaped chat server. It answers the two probes correctly unless told otherwise,
 * and every other request with `answer`. `tokenize: false` is OpenAI, which has none.
 */
function chatServer(options: {
  tokenize?: boolean;
  answer?: (content: string) => unknown;
  probe?: (content: string) => unknown;
}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: href, body, headers: init?.headers } as Call);

    if (href.endsWith("/tokenize")) {
      if (options.tokenize !== true) return json({ error: "Not found" }, 404);
      const ids = TOKEN_IDS[String(body["content"] ?? body["prompt"] ?? "")];
      return ids === undefined ? json({ error: "unknown" }, 400) : json({ tokens: ids });
    }

    const messages = body["messages"] as Array<{ role: string; content: string }>;
    const content = messages[messages.length - 1]?.content ?? "";
    if (content.startsWith("Question: Is the sky")) {
      return json(options.probe?.(content) ?? chatReply("Yes", { Yes: Math.log(0.99), No: Math.log(0.01) }));
    }
    if (content.startsWith("Question: Is fire cold")) {
      return json(options.probe?.(content) ?? chatReply("No", { No: Math.log(0.98), Yes: Math.log(0.02) }));
    }
    return json(options.answer?.(content) ?? chatReply("Yes", { Yes: Math.log(0.7), No: Math.log(0.3) }));
  });

  const chats = () => calls.filter((c) => c.url.endsWith("/chat/completions"));
  return { fetchImpl, calls, chats };
}

const chat = (s: ReturnType<typeof chatServer>, extra: Partial<ConstructorParameters<typeof LocalAdapter>[0]> = {}) =>
  new LocalAdapter({ api: "chat", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", fetch: s.fetchImpl, ...extra });

describe("LocalAdapter in chat mode", () => {
  it("asks for one token on /v1/chat/completions with top_logprobs, the state first in the user turn", async () => {
    const s = chatServer({});
    await chat(s).decide(request);

    const asked = s.chats().slice(2); // after the two probes
    expect(asked).toHaveLength(2);
    for (const call of asked) {
      expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(call.body).toMatchObject({ model: "gpt-4.1-mini", max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 });
      const messages = call.body["messages"] as Array<{ role: string; content: string }>;
      expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(messages[1]?.content.startsWith(STATE)).toBe(true);
      expect(messages[1]?.content).toMatch(/Answer with one word, yes or no\.\nAnswer:$/);
    }
  });

  it("reads p as a softmax over the label logprobs, summing surface forms", async () => {
    const s = chatServer({
      answer: () => chatReply("Yes", { Yes: Math.log(0.4), yes: Math.log(0.4), No: Math.log(0.15), The: Math.log(0.05) }),
    });
    const result = await chat(s).decide(request);
    // 0.8 / (0.8 + 0.15): the non-label token is not an answer and carries no mass.
    expect(noulProbability(result.answers["destructive"])).toBeCloseTo(0.8 / 0.95, 6);
  });

  it("names itself after the model and host, which is the claim its column makes", () => {
    expect(chat(chatServer({})).name).toBe("chat:gpt-4.1-mini@api.openai.com");
    expect(new LocalAdapter().name).toBe("local");
  });

  it("sends no logit_bias where the server cannot tokenize, and asks /tokenize only once", async () => {
    const s = chatServer({ tokenize: false });
    await chat(s).decide(request);

    expect(s.chats().every((c) => c.body["logit_bias"] === undefined)).toBe(true);
    // One label tried, not every label against every shape: OpenAI has no tokenizer to find.
    expect(s.calls.filter((c) => c.url.endsWith("/tokenize")).length).toBeLessThanOrEqual(4);
  });

  it("biases the label ids where the server tokenizes (vLLM)", async () => {
    const s = chatServer({ tokenize: true });
    await chat(s, { baseUrl: "http://127.0.0.1:8000/v1", model: "Qwen/Qwen3-8B" }).decide(request);

    const bias = s.chats()[0]?.body["logit_bias"] as Record<string, number>;
    expect(Object.keys(bias).sort()).toEqual(["1738", "2360", "5297", "9891"]);
    expect(s.calls[0]?.url).toBe("http://127.0.0.1:8000/tokenize");
  });

  it("sends the key it was given as a bearer token", async () => {
    const s = chatServer({});
    await chat(s, { apiKey: "sk-test-abcdefghijkl" }).decide(request);
    const headers = (s.calls[0] as unknown as { headers: Record<string, string> }).headers;
    expect(headers["authorization"]).toBe("Bearer sk-test-abcdefghijkl");
  });

  it("leaves out an answer whose token is not a label, rather than ending the run", async () => {
    const s = chatServer({
      answer: (content) =>
        content.includes("credential") ? chatReply("I", { I: Math.log(0.6), Yes: Math.log(0.3) }) : chatReply("No", { No: 0 }),
    });
    const result = await chat(s).decide(request);
    expect(result.answers["secrets"]).toBeUndefined();
    expect(noulProbability(result.answers["destructive"])).toBe(0);
  });

  it("merges the extra body into every request", async () => {
    const s = chatServer({ tokenize: true });
    await chat(s, { extraBody: { chat_template_kwargs: { enable_thinking: false } } }).decide(request);
    expect(s.chats().every((c) => (c.body["chat_template_kwargs"] as Record<string, unknown>)?.["enable_thinking"] === false)).toBe(true);
  });
});

describe("LocalAdapter in chat mode refuses to start rather than degrading", () => {
  const refusal = async (s: ReturnType<typeof chatServer>) => {
    const error = await chat(s).decide(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  };

  it("when the endpoint returns no logprobs, as Anthropic's API would not", async () => {
    const s = chatServer({ probe: () => ({ choices: [{ message: { role: "assistant", content: "Yes" } }] }) });
    expect((await refusal(s)).message).toMatch(/no logprobs/);
  });

  it("when a probe's reply is not a single-token label, and says what a <think> means", async () => {
    const s = chatServer({ probe: () => chatReply("<think>", { "<think>": 0 }) });
    const error = await refusal(s);
    expect(error.message).toMatch(/answered "<think>"/);
    expect(error.message).toMatch(/enable_thinking/);
  });

  it("when a multi-token label only shows up as its prefix", async () => {
    // "yes" split as "y" + "es" can only appear as "y", which is no label.
    const s = chatServer({ probe: () => chatReply("y", { y: Math.log(0.9), n: Math.log(0.1) }) });
    expect((await refusal(s)).message).toMatch(/not a single-token yes or no/);
  });

  it("when the served tokenizer splits every form of a label", async () => {
    // Qwen's case: "10" is two tokens, so it cannot be a label under that tokenizer.
    const s = chatServer({ tokenize: true });
    const split = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith("/tokenize")) return s.fetchImpl(url, init);
      const text = String(JSON.parse(String(init?.body))["content"]);
      return json({ tokens: text === "10" ? [16, 15] : [1738] });
    });
    const error = await new LocalAdapter({ api: "chat", model: "qwen", fetch: split, trueLabels: ["10"], falseLabels: ["no"] })
      .decide(request)
      .catch((e: unknown) => e);
    expect((error as AdapterError).message).toMatch(/true label is more than one token/);
  });

  it("when the model answers a probe backwards", async () => {
    const s = chatServer({ probe: () => chatReply("Yes", { Yes: 0 }) });
    expect((await refusal(s)).message).toMatch(/answered yes to a probe whose answer is no/);
  });

  it("reports a refused key as auth", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/tokenize") ? json({}, 404) : json({ error: "bad key" }, 401),
    );
    const error = await new LocalAdapter({ api: "chat", model: "m", fetch: fetchImpl }).decide(request).catch((e: unknown) => e);
    expect((error as AdapterError).kind).toBe("auth");
  });
});
