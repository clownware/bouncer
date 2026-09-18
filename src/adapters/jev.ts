// TypeSafe Jev, over raw fetch.
//
// No SDK: the plugin bundle ships committed and must stay small, and the API is one POST.
// The official @typesafe-ai/sdk exists and is fine; it just is not worth the bytes here.
//
// Wire shape verified live (scripts/jev-latency.mjs, 2026-09-18):
//   POST https://api.typesafe.ai/v1/systemone
//   { "model": "jev-latest", "state": "...", "questions": { "<name>": { type, instructions, criteria } } }
//   -> { "model": "jev-1.13.0", "answers": { "<name>": { "type": "noul", "noul": 0.97 } }, "usage": {...} }

import {
  AdapterError,
  type Adapter,
  type Answer,
  type DecideRequest,
  type DecideResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

/** One retry. The whole point of this call is to be fast; a retry storm defeats it. */
const MAX_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 120;
/** Never start a retry unless this much of the deadline remains. */
const MIN_REMAINING_FOR_RETRY_MS = 150;

export interface JevOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export class JevAdapter implements Adapter {
  readonly name = "jev";
  private readonly options: JevOptions;

  constructor(options: JevOptions) {
    if (!options.apiKey) {
      throw new AdapterError("auth", "no API key: set BOUNCER_TYPESAFE_API_KEY or TYPESAFE_API_KEY");
    }
    this.options = options;
  }

  async decide(request: DecideRequest): Promise<DecideResponse> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const url = this.options.baseUrl ?? DEFAULT_BASE_URL;
    const started = Date.now();
    const deadline = started + request.timeoutMs;

    const body = JSON.stringify({
      model: this.options.model ?? DEFAULT_MODEL,
      state: request.state,
      questions: request.questions,
    });

    let lastError: AdapterError | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw lastError ?? new AdapterError("timeout", `no time left in the ${request.timeoutMs}ms budget`);
      }

      // The timeout is against the caller's deadline, not per attempt: a retry must not
      // extend the budget. A hook that takes twice as long because it retried is a hook
      // the user notices.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      const onAbort = () => controller.abort();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await errorFor(response);
          if (error.retryable && attempt < MAX_ATTEMPTS && deadline - Date.now() > MIN_REMAINING_FOR_RETRY_MS) {
            lastError = error;
            await delay(backoffFor(attempt, response), deadline);
            continue;
          }
          throw error;
        }

        return parseResponse(await response.json(), Date.now() - started);
      } catch (err) {
        const error = asAdapterError(err, request.timeoutMs);
        if (error.retryable && error.kind !== "timeout" && attempt < MAX_ATTEMPTS && deadline - Date.now() > MIN_REMAINING_FOR_RETRY_MS) {
          lastError = error;
          await delay(backoffFor(attempt), deadline);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    }

    throw lastError ?? new AdapterError("unavailable", "exhausted attempts");
  }
}

async function errorFor(response: Response): Promise<AdapterError> {
  const detail = await safeText(response);
  const suffix = detail.length > 0 ? `: ${detail.slice(0, 200)}` : "";

  switch (response.status) {
    case 401:
    case 403:
      return new AdapterError("auth", `rejected the API key (${response.status})${suffix}`, { status: response.status });
    case 422:
      return new AdapterError("invalid_request", `rejected the request (422)${suffix}`, { status: 422 });
    case 429:
      return new AdapterError("rate_limited", `rate limited (429)${suffix}`, { status: 429 });
    case 529:
      return new AdapterError("unavailable", `overloaded (529)${suffix}`, { status: 529 });
    default:
      if (response.status >= 500) {
        return new AdapterError("unavailable", `server error (${response.status})${suffix}`, { status: response.status });
      }
      return new AdapterError("invalid_request", `unexpected status ${response.status}${suffix}`, { status: response.status });
  }
}

function asAdapterError(err: unknown, timeoutMs: number): AdapterError {
  if (err instanceof AdapterError) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new AdapterError("timeout", `no answer within ${timeoutMs}ms`, { cause: err });
  }
  return new AdapterError("unavailable", err instanceof Error ? err.message : String(err), { cause: err });
}

function parseResponse(payload: unknown, latencyMs: number): DecideResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new AdapterError("malformed_response", "response was not an object");
  }

  const record = payload as Record<string, unknown>;
  const rawAnswers = record["answers"];
  if (typeof rawAnswers !== "object" || rawAnswers === null) {
    throw new AdapterError("malformed_response", "response had no answers object");
  }

  const answers: Record<string, Answer> = {};
  for (const [name, value] of Object.entries(rawAnswers as Record<string, unknown>)) {
    const answer = parseAnswer(value);
    // A single unreadable answer is dropped rather than failing the whole call. The rule
    // evaluator treats a missing answer as absence of evidence and skips that rule, which
    // is the right reading — four good answers still decide.
    if (answer !== undefined) answers[name] = answer;
  }

  if (Object.keys(answers).length === 0) {
    throw new AdapterError("malformed_response", "no readable answers in the response");
  }

  const usage = record["usage"];
  const inputTokens =
    typeof usage === "object" && usage !== null && typeof (usage as Record<string, unknown>)["input_tokens"] === "number"
      ? ((usage as Record<string, unknown>)["input_tokens"] as number)
      : undefined;

  return {
    answers,
    ...(typeof record["model"] === "string" ? { model: record["model"] } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    latencyMs,
  };
}

function parseAnswer(value: unknown): Answer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;

  switch (record["type"]) {
    case "noul": {
      const noul = record["noul"];
      if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) return undefined;
      return { type: "noul", noul };
    }
    case "choice": {
      const choice = record["choice"];
      const probabilities = record["probabilities"];
      if (typeof choice !== "string" || !isNumberRecord(probabilities)) return undefined;
      return {
        type: "choice",
        choice,
        probabilities,
        confidence: typeof record["confidence"] === "number" ? record["confidence"] : Number.NaN,
      };
    }
    case "score": {
      const score = record["score"];
      const probabilities = record["probabilities"];
      if (typeof score !== "number" || !isNumberRecord(probabilities)) return undefined;
      return {
        type: "score",
        score,
        probabilities,
        confidence: typeof record["confidence"] === "number" ? record["confidence"] : Number.NaN,
      };
    }
    default:
      return undefined;
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "number")
  );
}

/** Honours Retry-After when the server sends one, capped so it cannot blow the deadline. */
function backoffFor(attempt: number, response?: Response): number {
  const header = response?.headers?.get?.("retry-after");
  if (header !== undefined && header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 1000);
  }
  // Jitter so that several hooks firing at once do not retry in lockstep.
  return BASE_BACKOFF_MS * attempt + Math.floor(Math.random() * BASE_BACKOFF_MS);
}

function delay(ms: number, deadline: number): Promise<void> {
  const capped = Math.max(0, Math.min(ms, deadline - Date.now()));
  return new Promise((resolve) => setTimeout(resolve, capped));
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
