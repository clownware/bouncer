import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicy } from "../src/engine/policy.js";
import { CACHE_VERSION, loadPolicyCached } from "../src/io/policycache.js";

const SHIPPED = readFileSync("policy/default.yaml", "utf8");
const PATH = "/somewhere/policy/default.yaml";

/** The cache's own files, whatever it chose to call them. */
const entries = (dir: string): string[] => {
  try {
    return readdirSync(join(dir, "policy-cache")).sort();
  } catch {
    return [];
  }
};

const entryIn = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, "policy-cache", entries(dir)[0]!), "utf8"));

describe("the compiled-policy cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bouncer-cache-"));
    delete process.env["BOUNCER_NO_CACHE"];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["BOUNCER_NO_CACHE"];
  });

  // The only thing a cache is allowed to change is how long the answer takes.
  it("returns exactly what a full parse returns, cold and warm", () => {
    const direct = loadPolicy(SHIPPED);

    const miss = loadPolicyCached(dir, PATH, SHIPPED);
    expect(miss).toEqual(direct);

    const hit = loadPolicyCached(dir, PATH, SHIPPED);
    expect(hit).toEqual(direct);
    expect(entries(dir)).toHaveLength(1);
  });

  it("keeps the diagnostics of a policy that does not load", () => {
    const broken = "version: 2\ngate: []\n";
    const direct = loadPolicy(broken);
    expect(direct.policy).toBeUndefined();

    expect(loadPolicyCached(dir, PATH, broken)).toEqual(direct);
    expect(loadPolicyCached(dir, PATH, broken)).toEqual(direct);
  });

  // The source text is the key, so this is the case the mtime key in ADR-002's rejected
  // draft would have got wrong: an edit within the same second, or an edit that restores
  // the file's original size.
  it("misses on an edit that changes neither the file's size nor its shape", () => {
    loadPolicyCached(dir, PATH, SHIPPED);

    const edited = SHIPPED.replace('destructive: { p: ">=0.70" }', 'destructive: { p: ">=0.20" }');
    expect(edited).not.toBe(SHIPPED);
    expect(edited.length).toBe(SHIPPED.length);

    const thresholdOf = (result: ReturnType<typeof loadPolicy>) =>
      result.policy?.gate.rules[0]?.condition?.comparison;

    expect(thresholdOf(loadPolicyCached(dir, PATH, edited))).toMatchObject({ value: 0.2 });
    expect(thresholdOf(loadPolicyCached(dir, PATH, SHIPPED))).toMatchObject({ value: 0.7 });
  });

  it("gives each policy path its own entry, so alternating between two does not thrash", () => {
    const other = SHIPPED.replace("mode: observe", "mode: guard");

    loadPolicyCached(dir, "/a/.bouncer.yaml", SHIPPED);
    loadPolicyCached(dir, "/b/.bouncer.yaml", other);

    expect(entries(dir)).toHaveLength(2);
    expect(loadPolicyCached(dir, "/a/.bouncer.yaml", SHIPPED).policy?.mode).toBe("observe");
    expect(loadPolicyCached(dir, "/b/.bouncer.yaml", other).policy?.mode).toBe("guard");
  });

  it("ignores an entry written by a different compiler version", () => {
    loadPolicyCached(dir, PATH, SHIPPED);
    const file = join(dir, "policy-cache", entries(dir)[0]!);

    const stale = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // A policy compiled before `gate.hard_rules` existed: shaped right, missing a field the
    // engine now reads. Trusting it would silently switch every hard rule off.
    stale["version"] = CACHE_VERSION - 1;
    const gate = (stale["result"] as { policy: { gate: Record<string, unknown> } }).policy.gate;
    delete gate["hardRules"];
    writeFileSync(file, JSON.stringify(stale));

    const result = loadPolicyCached(dir, PATH, SHIPPED);
    expect(result.policy?.gate.hardRules.length).toBeGreaterThan(0);
    expect(entryIn(dir)["version"]).toBe(CACHE_VERSION);
  });

  const corrupt: ReadonlyArray<readonly [string, string]> = [
    ["empty", ""],
    ["not JSON at all", "{{{"],
    ["truncated mid-write", '{"version":1,"source":"version: 1","resu'],
    ["JSON but not an object", '"a string"'],
    ["an entry with no result", '{"version":1,"source":"x"}'],
    ["a result with no diagnostics", '{"version":1,"source":"x","result":{}}'],
    ["a policy that is not a mapping", '{"version":1,"source":"x","result":{"diagnostics":[],"policy":7}}'],
    ["a policy with no gate", '{"version":1,"source":"x","result":{"diagnostics":[],"policy":{}}}'],
  ];

  it.each(corrupt)("parses normally when the cache file is %s", (_label, contents) => {
    loadPolicyCached(dir, PATH, SHIPPED);
    writeFileSync(join(dir, "policy-cache", entries(dir)[0]!), contents);

    expect(loadPolicyCached(dir, PATH, SHIPPED)).toEqual(loadPolicy(SHIPPED));
  });

  it("still answers when the cache directory cannot be created", () => {
    // A plain file where the cache directory needs to be. Every write fails, on every call,
    // and the hook must not notice: this is the read-only or full disk case, reproducible
    // as root, which a chmod is not.
    writeFileSync(join(dir, "policy-cache"), "not a directory");

    expect(loadPolicyCached(dir, PATH, SHIPPED)).toEqual(loadPolicy(SHIPPED));
    expect(loadPolicyCached(dir, PATH, SHIPPED)).toEqual(loadPolicy(SHIPPED));
    expect(readdirSync(dir)).toEqual(["policy-cache"]);
  });

  it("leaves no temporary files behind", () => {
    loadPolicyCached(dir, PATH, SHIPPED);
    loadPolicyCached(dir, PATH, SHIPPED.replace("mode: observe", "mode: guard"));
    expect(entries(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("parses every time when BOUNCER_NO_CACHE is set", () => {
    process.env["BOUNCER_NO_CACHE"] = "1";
    expect(loadPolicyCached(dir, PATH, SHIPPED)).toEqual(loadPolicy(SHIPPED));
    expect(entries(dir)).toHaveLength(0);
  });

  // The source text catches a stale policy. Nothing but CACHE_VERSION catches a stale
  // compiler, so this pins the shape that number stands for: a field added to `Policy`,
  // `GatePolicy`, `HardRule`, `HardRuleWhen`, `Rule` or `CalibrationPolicy` fails here until
  // the version moves, and entries written by the build before it are then ignored rather
  // than deserialised into a policy missing the field.
  //
  // Pinned against a fixture rather than the shipped policy on purpose: the shipped file's
  // question names are part of its shape, and a thread editing the questions must not have
  // to bump a cache version to do it. The fixture asserts every predicate so the pin covers
  // all of `HardRuleWhen`, not only the keys that happen to be used.
  it("fails when the compiled shape changes without CACHE_VERSION moving", () => {
    const fixture = [
      "version: 1",
      "backend: mock",
      "mode: observe",
      "gate:",
      "  tools: [Bash]",
      '  fast_path: ["pwd"]',
      "  hard_rules:",
      "    - name: only-rule",
      "      because: it is the one entry this shape is pinned against",
      "      when:",
      "        first_token: [git]",
      "        tokens: [stash, clear]",
      "        not_tokens: [--help]",
      '        text: ["drop table"]',
      "        path_labelled: [credential]",
      "        redacts_as: [api_key]",
      "  questions:",
      "    only_question:",
      "      instructions: whether the command is the one this shape is pinned against",
      "      criteria:",
      "        true: it is",
      "        false: it is not",
      "  rules:",
      '    - when: { only_question: { p: ">=0.70" } }',
      "      then: ask",
      "    - default: allow",
      "",
    ].join("\n");

    const shapeOf = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.length > 0 ? shapeOf(value[0]) : ""}]`;
      if (typeof value === "object" && value !== null) {
        return `{${Object.keys(value as object)
          .sort()
          .map((k) => `${k}:${shapeOf((value as Record<string, unknown>)[k])}`)
          .join(",")}}`;
      }
      return typeof value;
    };

    const loaded = loadPolicy(fixture);
    expect(loaded.diagnostics).toEqual([]);
    expect(shapeOf(loaded.policy)).toBe(
      "{backend:string,calibration:{accuracyBar:number,confidenceFloor:number}," +
        "gate:{fastPath:[string],hardRules:[{because:string,index:number,name:string," +
        "verdict:string,when:{firstToken:[string],notTokens:[string],pathLabelled:[string]," +
        "redactsAs:[string],text:[string],tokens:[string]}}],probeQuestions:{}," +
        "questions:{only_question:{criteria:{false:string,true:string},instructions:string}}," +
        "rules:[{condition:{comparison:{kind:string,value:number},question:string}," +
        "index:number,verdict:string}],tools:[string]}," +
        "mode:string,onError:string,skipPermissionModes:[string],timeoutMs:number,version:number}",
    );
    expect(CACHE_VERSION).toBe(2);
  });
});
