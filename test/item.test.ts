import { describe, expect, it } from "vitest";
import { MAX_ITEM_STATE_BYTES, buildItemState, itemState } from "../src/engine/item.js";

describe("the item state builder", () => {
  it("keeps the item's own field names, because the questions refer to them", () => {
    const { text } = buildItemState({ title: "Q3 launch", body: "ships in April" });
    expect(JSON.parse(text)).toEqual({ title: "Q3 launch", body: "ships in April" });
  });

  // The gate turns file contents into a byte count. This one sends them, which is the
  // whole feature — see docs/adr/009 decision 4.
  it("sends the content, unlike the tool-call builder", () => {
    const { text } = buildItemState({ draft: "the full text of the draft" });
    expect(text).toContain("the full text of the draft");
  });

  it("redacts a credential anywhere in the item, however deep", () => {
    const { text, redactedKinds } = buildItemState({
      meta: { notes: ["deploy with sk-abcdefghijklmnopqrstuvwxyz012345"] },
    });
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(text).toContain("[REDACTED:");
    expect(redactedKinds.length).toBeGreaterThan(0);
  });

  it("preserves non-string values rather than stringifying them", () => {
    const { text } = buildItemState({ score: 4, published: true, tags: ["a", "b"], missing: null });
    expect(JSON.parse(text)).toEqual({ score: 4, published: true, tags: ["a", "b"], missing: null });
  });

  it("caps an oversized item and says it was truncated", () => {
    const { text, truncated } = buildItemState({ body: "x".repeat(MAX_ITEM_STATE_BYTES * 2) });
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_ITEM_STATE_BYTES);
    expect(text).toContain("[truncated]");
  });

  it("does not claim truncation on an item that fits", () => {
    expect(buildItemState({ body: "short" }).truncated).toBe(false);
  });

  // A batch is user data and this is the only place in the engine that walks an arbitrary
  // object, so a pathological item must not take the process with it.
  it("survives a cyclic item", () => {
    const item: Record<string, unknown> = { name: "loop" };
    item["self"] = item;
    expect(() => buildItemState(item)).not.toThrow();
    expect(buildItemState(item).text).toContain("too deeply nested");
  });

  it("wraps a non-object item so the state is still a mapping", () => {
    expect(JSON.parse(buildItemState("just a string" as unknown as Record<string, unknown>).text)).toEqual({
      value: "just a string",
    });
  });

  it("declares its kind, which is what a fixture and a log line record", () => {
    expect(itemState.kind).toBe("item");
  });
});
