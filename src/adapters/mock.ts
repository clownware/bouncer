// Deterministic adapter. Drives every test and all of CI; never touches the network.
//
// Determinism here is not a convenience — it is what lets the rule evaluator be tested
// against exact probabilities, and what lets CI assert hook latency without an API key.
//
// The default scoring is a small set of keyword heuristics. It is not a classifier and is
// not trying to be: it exists so that an end-to-end test of "dangerous command produces a
// high destructive probability" has something to produce that probability. Never ship it
// as a backend anyone relies on.

import {
  type Adapter,
  type Answer,
  type DecideRequest,
  type DecideResponse,
} from "./types.js";

export interface MockOptions {
  /** Fixed answers by question name. Anything omitted falls back to the heuristics. */
  readonly answers?: Readonly<Record<string, number>>;
  /** Added to the reported latency, for exercising timeout handling. */
  readonly latencyMs?: number;
  /** Thrown instead of answering, for exercising the failure paths. */
  readonly error?: Error;
}

const HEURISTICS: ReadonlyArray<readonly [string, RegExp]> = [
  ["destructive", /\brm\s+-[rf]|--force\b|--hard\b|\bDROP\s+TABLE\b|\btruncate\b|>\s*\/dev\/|\bmkfs\b/i],
  ["secrets", /\bsk-|\bghp_|AKIA|PRIVATE KEY|\[REDACTED:|\.env\b|\bcredential/i],
  ["outside_repo", /"inside_project":\s*false|\bsensitive"/i],
  ["egress", /\bcurl\b.*-X\s*(POST|PUT)|\bwget\b.*--post|\|\s*nc\b|\bscp\b/i],
  ["prod", /\bprod(uction)?\b|\bdeploy\b|\brelease\b/i],
];

export class MockAdapter implements Adapter {
  readonly name = "mock";
  private readonly options: MockOptions;

  constructor(options: MockOptions = {}) {
    this.options = options;
  }

  async decide(request: DecideRequest): Promise<DecideResponse> {
    if (this.options.error) throw this.options.error;

    const answers: Record<string, Answer> = {};

    for (const [name, question] of Object.entries(request.questions)) {
      if (question.type !== "noul") continue;
      answers[name] = { type: "noul", noul: this.scoreFor(name, request.state) };
    }

    return {
      answers,
      model: "mock",
      inputTokens: Math.ceil(request.state.length / 4),
      latencyMs: this.options.latencyMs ?? 0,
    };
  }

  private scoreFor(name: string, state: string): number {
    const fixed = this.options.answers?.[name];
    if (fixed !== undefined) return fixed;

    const heuristic = HEURISTICS.find(([question]) => question === name);
    if (heuristic === undefined) return 0.05;
    return heuristic[1].test(state) ? 0.92 : 0.03;
  }
}
