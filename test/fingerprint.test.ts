// The policy fingerprint's exact output, pinned.
//
// `fingerprint` names a configuration in the decision log, so its value is not an
// implementation detail: a line written before a change and a line written after must agree
// about the same policy, or `bouncer status`, `calibrate --from` and ADR-006's replay all
// read one policy as two. Nothing else in the suite asserts a value — the other tests ask
// only whether two fingerprints are equal to each other, which every wrong implementation
// also satisfies.
//
// The table exists because the loop was rewritten for speed. It walked the text with
// `for (const char of text)`, which costs about 5 ms cold on the shipped 27.5 KB policy —
// most of the hook's cold-start regression between 8384ad0 and b213fe7. The index loop that
// replaced it hashes code points, not code units, so the surrogate pairs below are the cases
// where a plain `charCodeAt` walk would silently produce a different answer.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fingerprint } from "../src/engine/fingerprint.js";

describe("fingerprint", () => {
  // Every value here was produced by the original code-point implementation.
  const cases: readonly [label: string, text: string, expected: string][] = [
    ["the empty string", "", "0-811c9dc5"],
    ["one ASCII character", "a", "1-e40c292c"],
    ["a line of policy", "mode: observe\n", "14-31613bfa"],
    ["a character outside the BMP", "\u{1F600}", "2-0650a71f"],
    ["a composed accent", "café", "4-3308be7c"],
    ["a surrogate pair between ASCII", "a\u{1F600}b", "4-4e6351d2"],
    ["two surrogate pairs in a row", "\u{1F600}\u{1F600}", "4-1102b3cd"],
    ["a lone high surrogate", "\ud800", "1-0481d51f"],
    ["a lone high surrogate before ASCII", "\ud800a", "2-9663155a"],
    ["a lone low surrogate after ASCII", "a\udc00", "2-2c65f444"],
  ];

  for (const [label, text, expected] of cases) {
    it(`is unchanged for ${label}`, () => {
      expect(fingerprint(text)).toBe(expected);
    });
  }

  it("distinguishes the shipped policy from an edit of it", () => {
    const source = readFileSync("policy/default.yaml", "utf8");
    expect(fingerprint(source)).toMatch(/^\d+-[0-9a-f]{8}$/);
    expect(fingerprint(`${source}\n# one more comment\n`)).not.toBe(fingerprint(source));
  });
});
