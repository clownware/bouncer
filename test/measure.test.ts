import { describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapters/mock.js";
import { parseFixtures, type Fixture } from "../src/calibrate.js";
import { loadPolicy } from "../src/engine/policy.js";
import type { PolicySet } from "../src/engine/types.js";
import { formatMeasurement, measure } from "../src/measure.js";
import type { ReasoningBackend, ReasoningRequest, ReasoningResponse } from "../src/io/reasoning.js";

const POLICY = (() => {
  const { policy, diagnostics } = loadPolicy(`
version: 1
mode: observe
policies:
  content:
    questions:
      unsupported_claim:
        instructions: "The draft states a fact with no source."
    rules:
      - when: { unsupported_claim: { p: ">=0.80" } }
        then: ask
      - when: { any: { p: "0.40..0.60" } }
        then: ask
      - default: allow
`);
  if (policy === undefined) throw new Error(JSON.stringify(diagnostics));
  return policy;
})();

const SET = POLICY.sets["content"] as PolicySet;

/** Two fixtures with distinguishable text, so a scripted adapter can answer them apart. */
const pair = (): Fixture[] =>
  parseFixtures(
    [
      JSON.stringify({ id: "confident", kind: "item", item: { text: "the confident one" }, expect: { unsupported_claim: true }, note: "n" }),
      JSON.stringify({ id: "uncertain", kind: "item", item: { text: "the uncertain one" }, expect: { unsupported_claim: true }, note: "n" }),
    ].join("\n"),
  );

/** Answers `confident` wrong and confidently; leaves `uncertain` in the escalation band. */
const splitAdapter = {
  name: "split",
  async decide(request: { state: string }) {
    const p = request.state.includes("confident") ? 0.02 : 0.5;
    return { answers: { unsupported_claim: { type: "noul" as const, noul: p } }, latencyMs: 0, inputTokens: 10 };
  },
};

const fixtures = (labels: readonly boolean[]): Fixture[] =>
  parseFixtures(
    labels
      .map((expected, i) =>
        JSON.stringify({
          id: `f${i}`,
          kind: "item",
          item: { text: `draft ${i}` },
          expect: { unsupported_claim: expected },
          note: "n",
        }),
      )
      .join("\n"),
  );

/** A reasoning backend that always answers `answer`, and records what it was asked. */
class Scripted implements ReasoningBackend {
  readonly name = "scripted";
  readonly seen: ReasoningRequest[] = [];
  constructor(
    private readonly says: boolean,
    private readonly tokens?: { in?: number; out?: number },
  ) {}
  async answer(request: ReasoningRequest): Promise<ReasoningResponse> {
    this.seen.push(request);
    return {
      answers: Object.fromEntries(Object.keys(request.questions).map((q) => [q, this.says ? 1 : 0])),
      ...(this.tokens?.in !== undefined ? { inputTokens: this.tokens.in } : {}),
      ...(this.tokens?.out !== undefined ? { outputTokens: this.tokens.out } : {}),
    };
  }
}

const run = (labels: readonly boolean[], p: number, reasoning: ReasoningBackend) =>
  measure(fixtures(labels), {
    setName: "content",
    set: SET,
    mode: POLICY.mode,
    adapter: new MockAdapter({ answers: { unsupported_claim: p } }),
    reasoning,
    timeoutMs: 1000,
  });

describe("the three passes", () => {
  it("scores each pass against the same labels", async () => {
    // Every label true; the judge says 0.02 (wrong on all), the reasoning model says yes.
    const m = await run([true, true], 0.02, new Scripted(true));
    expect(m.passes.map((p) => p.name)).toEqual(["judge", "reasoning", "cascade"]);
    expect(m.passes[0]?.accuracy).toBe(0);
    expect(m.passes[1]?.accuracy).toBe(1);
  });

  // The cascade is the claim: the judge everywhere, the reasoning model only where the
  // manifest said so. With nothing escalated it must equal the judge exactly.
  it("equals the judge when nothing escalated", async () => {
    const m = await run([true, true], 0.02, new Scripted(true));
    expect(m.escalated).toBe(0);
    expect(m.passes[2]?.accuracy).toBe(m.passes[0]?.accuracy);
  });

  it("takes the reasoning model's answer on exactly the escalated items", async () => {
    // 0.5 sits in the uncertainty band, so every item escalates.
    const m = await run([true, true], 0.5, new Scripted(true));
    expect(m.escalated).toBe(2);
    expect(m.passes[0]?.accuracy).toBe(1); // 0.5 >= 0.5 reads as true, which the labels agree with
    expect(m.passes[2]?.accuracy).toBe(1);
  });

  it("can land between the two, which is the whole point of measuring it", async () => {
    const m = await measure(pair(), {
      setName: "content",
      set: SET,
      mode: POLICY.mode,
      adapter: splitAdapter,
      reasoning: new Scripted(true),
      timeoutMs: 1000,
    });
    expect(m.escalated).toBe(1);
    expect(m.passes[0]?.accuracy).toBe(0.5);
    expect(m.passes[1]?.accuracy).toBe(1);
    expect(m.passes[2]?.accuracy).toBe(0.5);
    // The judge got `uncertain` right at 0.5 already, so the escalation changed no verdict
    // here — which is exactly the case the cascade row exists to expose rather than assume.
    expect(m.passes[2]?.accuracy).toBeGreaterThanOrEqual(m.passes[0]?.accuracy as number);
    expect(m.passes[2]?.accuracy).toBeLessThan(m.passes[1]?.accuracy as number);
  });

  it("hands the reasoning model what the judge was unsure about", async () => {
    const scripted = new Scripted(true);
    await run([true], 0.5, scripted);
    const escalated = scripted.seen.find((r) => r.signals !== undefined);
    expect(escalated?.signals?.[0]?.question).toBe("unsupported_claim");
    expect(escalated?.signals?.[0]?.asks).toBe("The draft states a fact with no source.");
  });

  it("asks the reasoning model once per item, not twice", async () => {
    const scripted = new Scripted(true);
    await run([true, true], 0.5, scripted);
    expect(scripted.seen).toHaveLength(2);
  });
});

describe("tokens", () => {
  it("charges every item to the judge and only escalations to the reasoning model", async () => {
    // Both items escalate, so the cascade pays for both.
    const both = await run([true, true], 0.5, new Scripted(true, { in: 1000, out: 100 }));
    expect(both.passes[1]?.inputTokens).toBe(2000);
    expect(both.passes[2]?.inputTokens).toBe((both.passes[0]?.inputTokens ?? 0) + 2000);

    // Neither escalates, so the cascade pays the judge alone.
    const neither = await run([true, true], 0.02, new Scripted(true, { in: 1000, out: 100 }));
    expect(neither.passes[1]?.inputTokens).toBe(2000);
    expect(neither.passes[2]?.inputTokens).toBe(neither.passes[0]?.inputTokens);
  });

  // "Undefined plus 400 is 400" would print a cascade cost missing whichever half did not
  // count, and print it as a fact.
  it("reports nothing rather than a partial total when a backend counts no tokens", async () => {
    const m = await run([true], 0.5, new Scripted(true));
    expect(m.passes[1]?.inputTokens).toBeUndefined();
    expect(formatMeasurement(m)).toContain("| — |");
  });
});

describe("when a reasoning call fails", () => {
  const failing: ReasoningBackend = {
    name: "broken",
    async answer(): Promise<ReasoningResponse> {
      throw new Error("command not found: claude");
    },
  };

  it("reports the failure and its message rather than scoring it as wrong", async () => {
    const m = await run([true, true], 0.5, failing);
    expect(m.reasoningFailures).toBe(2);
    expect(m.firstReasoningError).toMatch(/command not found/);
    expect(m.passes[1]?.n).toBe(0);
    expect(m.passes[1]?.unanswered).toBe(2);
  });

  it("leaves the cascade on the judge's answer for an item the reasoning pass never returned", async () => {
    const m = await run([true, true], 0.5, failing);
    expect(m.passes[2]?.accuracy).toBe(m.passes[0]?.accuracy);
  });

  it("says so in the output", async () => {
    expect(formatMeasurement(await run([true], 0.5, failing))).toContain("1 reasoning call failed");
  });
});

describe("the printed report", () => {
  it("states the saving and what it cost, never one without the other", async () => {
    // One of two items escalates, so the cascade pays the judge for both and the reasoning
    // model for one — the shape a real batch has.
    const out = formatMeasurement(
      await measure(pair(), {
        setName: "content",
        set: SET,
        mode: POLICY.mode,
        adapter: splitAdapter,
        reasoning: new Scripted(true, { in: 1000, out: 100 }),
        timeoutMs: 1000,
      }),
    );
    expect(out).toMatch(/used \d+% fewer input tokens/);
    expect(out).toMatch(/points of accuracy against the labels/);
  });

  // Past some escalation rate the cascade costs more than simply asking the reasoning
  // model. A harness that could only report savings would never say so.
  it("says plainly when the cascade cost more than the reasoning pass alone", async () => {
    const out = formatMeasurement(await run([true, true], 0.5, new Scripted(true, { in: 1000, out: 100 })));
    expect(out).toMatch(/cost \d+% MORE input tokens/);
    expect(out).toContain("not worth running");
  });

  it("prints the escalation ratio with its denominator", async () => {
    expect(formatMeasurement(await run([true, true], 0.5, new Scripted(true)))).toContain("Escalated 2 of 2 judged");
  });

  it("says what accuracy means here", async () => {
    expect(formatMeasurement(await run([true], 0.5, new Scripted(true)))).toContain(
      "agreement with the fixture labels",
    );
  });
});
