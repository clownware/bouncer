import { describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapters/mock.js";
import { AdapterError, type Adapter, type DecideRequest, type DecideResponse } from "../src/adapters/types.js";
import { formatRun, judge, tally, type JudgedItem } from "../src/judge.js";
import { itemState } from "../src/engine/item.js";
import { loadPolicy } from "../src/engine/policy.js";
import type { PolicySet } from "../src/engine/types.js";

const SOURCE = `
version: 1
mode: observe
policies:
  content:
    questions:
      unsupported_claim:
        instructions: "The draft states a fact with no source."
      overclaims:
        instructions: "The draft promises an outcome absolutely."
    probe_questions:
      overclaims_v2:
        instructions: "The draft promises more than it can deliver."
    rules:
      - when: { unsupported_claim: { p: ">=0.65" } }
        then: ask
      - when: { overclaims: { p: ">=0.65" } }
        then: ask
      - when: { any: { p: "0.40..0.60" } }
        then: ask
      - default: allow
`;

const POLICY = (() => {
  const { policy, diagnostics } = loadPolicy(SOURCE);
  if (policy === undefined) throw new Error(`fixture policy did not load: ${JSON.stringify(diagnostics)}`);
  return policy;
})();

const SET = POLICY.sets["content"] as PolicySet;

// Only a judged item has a verdict and only an unjudged one has an error, so a test has to
// narrow to read either — which is the point of the type, and what these are for.
const verdictOf = (item: JudgedItem | undefined) => (item?.outcome === "judged" ? item.verdict : undefined);
const errorOf = (item: JudgedItem | undefined) => (item?.outcome === "unjudged" ? item.error : undefined);

const stated = (id: string, item: Record<string, unknown>) => ({ id, state: itemState.build(item) });
const items = (n: number) => Array.from({ length: n }, (_, i) => stated(`i${i}`, { text: `draft ${i}` }));

const run = (answers: Record<string, number>, count = 1, adapter?: Adapter) =>
  judge(items(count), {
    setName: "content",
    set: SET,
    mode: POLICY.mode,
    adapter: adapter ?? new MockAdapter({ answers }),
    timeoutMs: 1000,
  });

describe("the batch judge", () => {
  it("judges every item and reports the verdict", async () => {
    const result = await run({ unsupported_claim: 0.9, overclaims: 0.02, overclaims_v2: 0.02 }, 3);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((i) => verdictOf(i) === "ask")).toBe(true);
    expect(result.judged).toBe(3);
  });

  it("carries the item's own id, so a manifest can be traced back to the batch", async () => {
    const result = await run({ unsupported_claim: 0.9 }, 2);
    expect(result.items.map((i) => i.id)).toEqual(["i0", "i1"]);
    expect(result.manifest.items.map((i) => i.item)).toEqual(["i0", "i1"]);
  });

  // The ratio is the whole claim of the substitution play, so the denominator has to be
  // the items actually judged and nothing else.
  it("reports escalated over judged, with the denominator", async () => {
    const result = await run({ unsupported_claim: 0.9 }, 4);
    expect(result.manifest.itemsJudged).toBe(4);
    expect(result.manifest.escalationRate).toBe(1);
  });

  it("does not escalate an item the judge settled", async () => {
    const result = await run({ unsupported_claim: 0.02, overclaims: 0.02, overclaims_v2: 0.02 }, 3);
    expect(result.items.every((i) => verdictOf(i) === "allow")).toBe(true);
    expect(result.manifest.items).toEqual([]);
    expect(result.manifest.escalationRate).toBe(0);
  });

  it("names every threshold the item crossed, not just the deciding one", async () => {
    const result = await run({ unsupported_claim: 0.9, overclaims: 0.8, overclaims_v2: 0.02 });
    const signals = result.manifest.items[0]?.signals ?? [];
    expect(signals.map((s) => s.question)).toEqual(["unsupported_claim", "overclaims"]);
    expect(signals.filter((s) => s.decided)).toHaveLength(1);
  });

  it("carries the question's own words, which is what makes the manifest a prompt", async () => {
    const result = await run({ unsupported_claim: 0.9, overclaims: 0.02, overclaims_v2: 0.02 });
    expect(result.manifest.items[0]?.signals[0]?.asks).toBe("The draft states a fact with no source.");
  });

  // The gate leaves `state` off its manifest item because the log line beside it has the
  // same string. A standalone manifest has no such line, so the item has to stand alone.
  it("sets the state on a manifest item, unlike the gate", async () => {
    const result = await run({ unsupported_claim: 0.9, overclaims: 0.02, overclaims_v2: 0.02 });
    expect(result.manifest.items[0]?.state).toContain("draft 0");
  });

  it("splits probe answers out, so no rule can have read one", async () => {
    const result = await run({ unsupported_claim: 0.02, overclaims: 0.02, overclaims_v2: 0.99 });
    expect(result.items[0]?.answers).toEqual({ unsupported_claim: 0.02, overclaims: 0.02 });
    expect(result.items[0]?.probes).toEqual({ overclaims_v2: 0.99 });
    // 0.99 on the probe would have fired the overclaims rule had a rule been able to read it.
    expect(verdictOf(result.items[0])).toBe("allow");
  });

  // Mode is the gate's business: it decides what may be said to Claude Code, and there is
  // no Claude Code here.
  it("produces verdicts in observe mode, where the hook emits nothing", async () => {
    expect(POLICY.mode).toBe("observe");
    const result = await run({ unsupported_claim: 0.9 });
    expect(verdictOf(result.items[0])).toBe("ask");
  });

  it("redacts the state, so a credential in the batch does not leave with it", async () => {
    const result = await judge([stated("x", { text: "token sk-abcdefghijklmnopqrstuvwxyz012345" })], {
      setName: "content",
      set: SET,
      mode: POLICY.mode,
      adapter: new MockAdapter({ answers: { unsupported_claim: 0.02, overclaims: 0.02, overclaims_v2: 0.02 } }),
      timeoutMs: 1000,
    });
    expect(result.items[0]?.state).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(result.items[0]?.redactedKinds.length).toBeGreaterThan(0);
  });
});

describe("when the classifier cannot answer", () => {
  const failing: Adapter = {
    name: "failing",
    async decide(): Promise<DecideResponse> {
      throw new AdapterError("rate_limited", "429 from the backend");
    },
  };

  it("reports the item rather than dropping it", async () => {
    const result = await run({}, 2, failing);
    expect(result.items).toHaveLength(2);
    expect(errorOf(result.items[0])?.kind).toBe("rate_limited");
    // The line that mattered: a failed item came back `verdict: "allow"` beside its error.
    expect(result.items[0]).not.toHaveProperty("verdict");
  });

  // An item nobody judged is not an item the judge settled. Counting it would flatter the
  // ratio the whole substitution claim rests on.
  it("keeps it out of the denominator", async () => {
    const result = await run({}, 2, failing);
    expect(result.judged).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.manifest.itemsJudged).toBe(0);
    expect(result.manifest.escalationRate).toBe(0);
  });

  it("finishes the rest of the batch when only some items fail", async () => {
    let calls = 0;
    const flaky: Adapter = {
      name: "flaky",
      async decide(request: DecideRequest): Promise<DecideResponse> {
        if (calls++ === 0) throw new AdapterError("timeout", "took too long");
        return new MockAdapter({ answers: { unsupported_claim: 0.9 } }).decide(request);
      },
    };
    const result = await judge(items(4), {
      setName: "content", set: SET, mode: POLICY.mode, adapter: flaky, timeoutMs: 1000, concurrency: 1,
    });
    expect(result.failed).toBe(1);
    expect(result.judged).toBe(3);
  });

  // The mock answers everything it is asked, so a partial response needs its own adapter.
  const partial = (p: number): Adapter => ({
    name: "partial",
    async decide(): Promise<DecideResponse> {
      return { answers: { unsupported_claim: { type: "noul", noul: p } }, latencyMs: 1 };
    },
  });

  // `overclaims` was never assessed, so this is not an item the judge settled. It used to
  // come back `allow` with no error: accepted, and absent from the escalation manifest.
  it("fails an item whose answers were partial and would otherwise have been accepted", async () => {
    const result = await run({}, 2, partial(0.02));
    expect(errorOf(result.items[0])).toEqual({ kind: "malformed_response", message: "no answer for: overclaims" });
    expect(result.judged).toBe(0);
    expect(result.failed).toBe(2);
    expect(tally(result).allow).toBe(0);
  });

  it("still escalates a partial item whose one answer crossed a threshold", async () => {
    const result = await run({}, 1, partial(0.9));
    expect(errorOf(result.items[0])).toBeUndefined();
    expect(result.manifest.items.map((i) => i.verdict)).toEqual(["ask"]);
  });
});

describe("an item too long to show the classifier whole", () => {
  // Over the 16 KB cap, so the state is cut to the head of each field. Whatever the draft
  // says after that, the classifier never read — and a violation there reads exactly like
  // a clean draft.
  const long = [stated("long", { text: `A clean opening. ${"Padding. ".repeat(4000)}Guaranteed to double your revenue.` })];
  const over = (answers: Record<string, number>) =>
    judge(long, { setName: "content", set: SET, mode: POLICY.mode, adapter: new MockAdapter({ answers }), timeoutMs: 1000 });

  it("is not accepted on the strength of its head", async () => {
    const result = await over({ unsupported_claim: 0.02, overclaims: 0.02, overclaims_v2: 0.02 });
    expect(result.items[0]?.truncated).toBe(true);
    expect(result.items[0]?.outcome).toBe("incomplete");
    expect(result.items[0]).not.toHaveProperty("verdict");
    expect(tally(result).allow).toBe(0);
  });

  // The answers are real — about what was read — so they are kept for calibration.
  it("keeps the answers it did get", async () => {
    const result = await over({ unsupported_claim: 0.02, overclaims: 0.02, overclaims_v2: 0.02 });
    expect(result.items[0]?.answers).toEqual({ unsupported_claim: 0.02, overclaims: 0.02 });
  });

  // Not settled, and not something the reasoning pass can settle either: it would be sent
  // the same truncated state. So it is in neither the numerator nor the denominator.
  it("stays out of the escalation ratio on both sides", async () => {
    const result = await over({ unsupported_claim: 0.02, overclaims: 0.02, overclaims_v2: 0.02 });
    expect(result.incomplete).toBe(1);
    expect(result.judged).toBe(0);
    expect(result.manifest.items).toEqual([]);
    expect(result.manifest.itemsJudged).toBe(0);
  });

  // An ask found its reason in the part that was read, so it is a verdict like any other.
  it("is judged, and escalates, when its head alone crosses a threshold", async () => {
    const result = await over({ unsupported_claim: 0.9, overclaims: 0.02, overclaims_v2: 0.02 });
    expect(verdictOf(result.items[0])).toBe("ask");
    expect(result.manifest.items).toHaveLength(1);
  });

  it("says so in the summary", async () => {
    const out = formatRun(await over({ unsupported_claim: 0.02, overclaims: 0.02, overclaims_v2: 0.02 }));
    expect(out).toMatch(/incomplete +1/);
  });
});

describe("concurrency", () => {
  it("judges every item whatever the pool width, and keeps them in order", async () => {
    for (const concurrency of [1, 3, 64]) {
      const result = await judge(items(7), {
        setName: "content",
        set: SET,
        mode: POLICY.mode,
        adapter: new MockAdapter({ answers: { unsupported_claim: 0.9 } }),
        timeoutMs: 1000,
        concurrency,
      });
      expect(result.items.map((i) => i.id)).toEqual(["i0", "i1", "i2", "i3", "i4", "i5", "i6"]);
    }
  });

  it("reports progress once per item", async () => {
    const seen: number[] = [];
    await judge(items(5), {
      setName: "content",
      set: SET,
      mode: POLICY.mode,
      adapter: new MockAdapter({ answers: { unsupported_claim: 0.9 } }),
      timeoutMs: 1000,
      onProgress: (done) => seen.push(done),
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does nothing at all on an empty batch", async () => {
    const result = await run({}, 0);
    expect(result.items).toEqual([]);
    expect(result.manifest.escalationRate).toBe(0);
  });
});

describe("the run summary", () => {
  it("counts verdicts, excluding items nothing judged", async () => {
    const result = await run({ unsupported_claim: 0.9 }, 3);
    expect(tally(result)).toEqual({ allow: 0, ask: 3, deny: 0 });
  });

  it("prints the ratio with its denominator rather than a bare percentage", async () => {
    const out = formatRun(await run({ unsupported_claim: 0.9 }, 4));
    expect(out).toContain("escalated  4 / 4  (100.0%)");
  });

  it("reports tokens per item when the backend counts them", async () => {
    expect(formatRun(await run({ unsupported_claim: 0.9 }, 2))).toMatch(/tokens in +\d+ total, \d+ per item/);
  });
});
