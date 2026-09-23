import { describe, expect, it, vi } from "vitest";
import { JevAdapter } from "../src/adapters/jev.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { AdapterError, noulProbability, type Question } from "../src/adapters/types.js";

const QUESTIONS: Record<string, Question> = {
  destructive: { type: "noul", instructions: "It destroys something." },
  secrets: { type: "noul", instructions: "It exposes a credential." },
};

const OK_BODY = {
  model: "jev-1.13.0",
  answers: {
    destructive: { type: "noul", noul: 0.97 },
    secrets: { type: "noul", noul: 0.12 },
  },
  usage: { input_tokens: 603, output_tokens: 12 },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function adapterWith(fetchImpl: typeof globalThis.fetch) {
  return new JevAdapter({ apiKey: "test-key", fetch: fetchImpl });
}

const request = { state: '{"tool":"Bash"}', questions: QUESTIONS, timeoutMs: 800 };

describe("noulProbability", () => {
  it("reads a noul answer", () => {
    expect(noulProbability({ type: "noul", noul: 0.42 })).toBe(0.42);
  });

  it("returns undefined for anything that is not a noul", () => {
    expect(noulProbability(undefined)).toBeUndefined();
    expect(noulProbability({ type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 })).toBeUndefined();
  });
});

describe("MockAdapter", () => {
  it("returns the answers it was given", async () => {
    const adapter = new MockAdapter({ answers: { destructive: 0.9, secrets: 0.1 } });
    const result = await adapter.decide(request);
    expect(noulProbability(result.answers["destructive"])).toBe(0.9);
    expect(noulProbability(result.answers["secrets"])).toBe(0.1);
  });

  it("is deterministic across calls, which is what CI depends on", async () => {
    const adapter = new MockAdapter();
    const a = await adapter.decide(request);
    const b = await adapter.decide(request);
    expect(a.answers).toEqual(b.answers);
  });

  it("answers every noul question it is asked", async () => {
    const result = await new MockAdapter().decide(request);
    expect(Object.keys(result.answers).sort()).toEqual(["destructive", "secrets"]);
  });

  it("scores a dangerous command higher than a harmless one", async () => {
    const adapter = new MockAdapter();
    const dangerous = await adapter.decide({ ...request, state: "command: rm -rf /" });
    const harmless = await adapter.decide({ ...request, state: "command: ls -la" });
    expect(noulProbability(dangerous.answers["destructive"])!).toBeGreaterThan(
      noulProbability(harmless.answers["destructive"])!,
    );
  });

  it("throws what it was told to throw, for exercising failure paths", async () => {
    const adapter = new MockAdapter({ error: new AdapterError("timeout", "nope") });
    await expect(adapter.decide(request)).rejects.toThrow(AdapterError);
  });
});

describe("JevAdapter", () => {
  it("refuses to construct without a key rather than failing at call time", () => {
    expect(() => new JevAdapter({ apiKey: "" })).toThrow(AdapterError);
  });

  it("sends the verified wire shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    await adapterWith(fetchImpl as unknown as typeof globalThis.fetch).decide(request);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer test-key");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("jev-latest");
    expect(body.state).toBe(request.state);
    // A map keyed by our names, not an array of objects with ids.
    expect(Array.isArray(body.questions)).toBe(false);
    expect(Object.keys(body.questions).sort()).toEqual(["destructive", "secrets"]);
    expect(body.questions.destructive.type).toBe("noul");
  });

  it("reads noul answers, the model and the token count", async () => {
    const result = await adapterWith((async () => jsonResponse(200, OK_BODY)) as typeof globalThis.fetch).decide(request);
    expect(noulProbability(result.answers["destructive"])).toBe(0.97);
    expect(noulProbability(result.answers["secrets"])).toBe(0.12);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(603);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  describe("error mapping", () => {
    const cases: ReadonlyArray<readonly [number, string, boolean]> = [
      [401, "auth", false],
      [403, "auth", false],
      [422, "invalid_request", false],
      [429, "rate_limited", true],
      [529, "unavailable", true],
      [500, "unavailable", true],
      [503, "unavailable", true],
      [418, "invalid_request", false],
    ];

    it.each(cases)("maps %s to %s", async (status, kind, retryable) => {
      const fetchImpl = (async () => jsonResponse(status, { error: "nope" })) as typeof globalThis.fetch;
      const error = await adapterWith(fetchImpl).decide({ ...request, timeoutMs: 200 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).kind).toBe(kind);
      expect((error as AdapterError).retryable).toBe(retryable);
    });

    // Auth failures are not the network's fault and retrying cannot help. Burning the
    // second attempt on them would eat the latency budget for nothing.
    it("does not retry an auth failure", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "bad key" }));
      await adapterWith(fetchImpl as unknown as typeof globalThis.fetch).decide(request).catch(() => undefined);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("retries a 429 once, then gives up", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "slow down" }, { "retry-after": "0" }));
      const error = await adapterWith(fetchImpl as unknown as typeof globalThis.fetch)
        .decide(request)
        .catch((e: unknown) => e);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect((error as AdapterError).kind).toBe("rate_limited");
    });

    it("succeeds when the retry succeeds", async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return calls === 1 ? jsonResponse(529, { error: "busy" }, { "retry-after": "0" }) : jsonResponse(200, OK_BODY);
      }) as typeof globalThis.fetch;
      const result = await adapterWith(fetchImpl).decide(request);
      expect(noulProbability(result.answers["destructive"])).toBe(0.97);
      expect(calls).toBe(2);
    });

    // A retry must not extend the deadline. A hook that takes twice as long because it
    // retried is a hook the user notices.
    it("does not retry when the budget is nearly spent", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "slow down" }));
      await adapterWith(fetchImpl as unknown as typeof globalThis.fetch)
        .decide({ ...request, timeoutMs: 60 })
        .catch(() => undefined);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports a timeout when the server never answers", async () => {
      const fetchImpl = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })) as unknown as typeof globalThis.fetch;

      const error = await adapterWith(fetchImpl).decide({ ...request, timeoutMs: 80 }).catch((e: unknown) => e);
      expect((error as AdapterError).kind).toBe("timeout");
    });

    it("reports a network failure as unavailable", async () => {
      const fetchImpl = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof globalThis.fetch;
      const error = await adapterWith(fetchImpl).decide({ ...request, timeoutMs: 100 }).catch((e: unknown) => e);
      expect((error as AdapterError).kind).toBe("unavailable");
    });
  });

  describe("malformed responses", () => {
    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      ["a bare string", "hello"],
      ["null", null],
      ["no answers key", { model: "jev-1.13.0" }],
      ["answers that is not an object", { answers: "nope" }],
      ["answers with nothing readable", { answers: { a: { type: "noul", noul: "high" } } }],
      ["a noul out of range", { answers: { a: { type: "noul", noul: 1.5 } } }],
      ["a negative noul", { answers: { a: { type: "noul", noul: -0.2 } } }],
      ["an unknown answer type", { answers: { a: { type: "vibes", value: 1 } } }],
    ];

    it.each(malformed)("rejects %s", async (_label, body) => {
      const fetchImpl = (async () => jsonResponse(200, body)) as typeof globalThis.fetch;
      const error = await adapterWith(fetchImpl).decide(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).kind).toBe("malformed_response");
    });

    // Four good answers still decide an ask or a deny. They cannot decide an allow:
    // `evaluate` refuses one while a question is unanswered, which is what makes dropping
    // the broken answer here safe rather than a way to approve a call half-assessed.
    it("keeps the readable answers and drops only the broken one", async () => {
      const body = {
        answers: {
          destructive: { type: "noul", noul: 0.97 },
          secrets: { type: "noul", noul: "very" },
        },
      };
      const result = await adapterWith((async () => jsonResponse(200, body)) as typeof globalThis.fetch).decide(request);
      expect(Object.keys(result.answers)).toEqual(["destructive"]);
    });

    it("reads a choice answer with its confidence, for the v0.2 router", async () => {
      const body = {
        answers: { skill: { type: "choice", choice: "debug", probabilities: { debug: 0.8, none: 0.2 }, confidence: 0.8 } },
      };
      const result = await adapterWith((async () => jsonResponse(200, body)) as typeof globalThis.fetch).decide(request);
      const answer = result.answers["skill"];
      expect(answer?.type).toBe("choice");
      expect(answer?.type === "choice" && answer.confidence).toBe(0.8);
    });
  });

  it("never puts the API key in an error message", async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: "invalid key test-key" })) as typeof globalThis.fetch;
    const error = await adapterWith(fetchImpl).decide(request).catch((e: unknown) => e);
    // The server echoing something is outside our control; what we assert is that the
    // adapter does not add the key itself.
    expect((error as Error).message).not.toContain("Bearer");
  });
});

// `--compare jev,jev@<url>`: the same adapter pointed at another server's /v1/systemone.
describe("JevAdapter at a Jev-shaped server", () => {
  const BASE = "https://openjev.example/v1/systemone";

  it("constructs without a key and sends none", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    const adapter = new JevAdapter({ baseUrl: BASE, fetch: fetchImpl as unknown as typeof globalThis.fetch });
    await adapter.decide(request);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BASE);
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("authorization");
    expect(JSON.parse(init.body as string).model).toBe("jev-latest");
  });

  // Two Jev-shaped backends under one name would be two classifiers logged as one.
  it("carries the endpoint in its name", () => {
    expect(new JevAdapter({ baseUrl: BASE }).name).toBe("jev@openjev.example");
    expect(new JevAdapter({ baseUrl: "http://127.0.0.1:30000/custom" }).name).toBe("jev@127.0.0.1:30000/custom");
    expect(new JevAdapter({ apiKey: "test-key" }).name).toBe("jev");
  });

  it("does not warm up TypeSafe itself", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_BODY));
    await new JevAdapter({ apiKey: "test-key", fetch: fetchImpl as unknown as typeof globalThis.fetch }).start();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps asking a cold endpoint until it answers", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => (++calls <= 3 ? jsonResponse(503, { error: "booting" }) : jsonResponse(200, OK_BODY)));
    const adapter = new JevAdapter({
      baseUrl: BASE,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      warmup: { deadlineMs: 5_000, intervalMs: 1 },
    });
    await expect(adapter.start()).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("refuses at once on an answer that asking again will not change", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { answers: {} }));
    const adapter = new JevAdapter({
      baseUrl: BASE,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      warmup: { deadlineMs: 5_000, intervalMs: 1 },
    });
    await expect(adapter.start()).rejects.toMatchObject({ kind: "malformed_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up with a sentence when the endpoint never wakes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "booting" }));
    const adapter = new JevAdapter({
      baseUrl: BASE,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      warmup: { deadlineMs: 50, intervalMs: 5 },
    });
    await expect(adapter.start()).rejects.toThrow(/did not answer within/);
  });
});
