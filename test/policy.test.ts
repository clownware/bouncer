import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPolicy, parseComparison, satisfies } from "../src/engine/policy.js";

const MINIMAL = `
version: 1
gate:
  tools: [Bash]
  questions:
    destructive:
      instructions: "It destroys something."
  rules:
    - when: { destructive: { p: ">=0.8" } }
      then: ask
    - default: allow
`;

const errors = (source: string) => loadPolicy(source).diagnostics.filter((d) => d.severity === "error");
const warnings = (source: string) => loadPolicy(source).diagnostics.filter((d) => d.severity === "warning");

describe("parseComparison", () => {
  const valid: ReadonlyArray<readonly [string, object]> = [
    [">=0.8", { kind: "gte", value: 0.8 }],
    [">0.8", { kind: "gt", value: 0.8 }],
    ["<=0.2", { kind: "lte", value: 0.2 }],
    ["<0.2", { kind: "lt", value: 0.2 }],
    [">= 0.8", { kind: "gte", value: 0.8 }],
    ["  >=0.8  ", { kind: "gte", value: 0.8 }],
    [">=.8", { kind: "gte", value: 0.8 }],
    [">=1", { kind: "gte", value: 1 }],
    [">=0", { kind: "gte", value: 0 }],
    ["0.4..0.6", { kind: "range", low: 0.4, high: 0.6 }],
    ["0..1", { kind: "range", low: 0, high: 1 }],
    ["0.5..0.5", { kind: "range", low: 0.5, high: 0.5 }],
  ];

  it.each(valid)("reads %s", (input, expected) => {
    expect(parseComparison(input)).toEqual(expected);
  });

  const invalid = [
    ["an out-of-range probability", ">=1.5"],
    ["a negative probability", ">=-0.5"],
    ["an inverted range", "0.6..0.4"],
    ["a range out of bounds", "0.5..1.5"],
    ["a bare number", "0.8"],
    ["an equality operator we do not support", "==0.8"],
    ["a percentage", ">=80%"],
    ["nonsense", "very likely"],
    ["an empty string", ""],
    ["an operator with no number", ">="],
  ] as const;

  it.each(invalid)("rejects %s", (_label, input) => {
    expect(parseComparison(input)).toBeUndefined();
  });
});

describe("satisfies", () => {
  it("treats >= and > differently at the boundary", () => {
    expect(satisfies(0.8, { kind: "gte", value: 0.8 })).toBe(true);
    expect(satisfies(0.8, { kind: "gt", value: 0.8 })).toBe(false);
  });

  it("treats a range as inclusive on both ends", () => {
    const range = { kind: "range", low: 0.4, high: 0.6 } as const;
    expect(satisfies(0.4, range)).toBe(true);
    expect(satisfies(0.6, range)).toBe(true);
    expect(satisfies(0.39, range)).toBe(false);
    expect(satisfies(0.61, range)).toBe(false);
  });
});

describe("loadPolicy", () => {
  it("accepts a minimal policy", () => {
    const result = loadPolicy(MINIMAL);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.policy?.gate.rules).toHaveLength(2);
  });

  it("applies documented defaults for anything omitted", () => {
    const policy = loadPolicy(MINIMAL).policy;
    expect(policy?.mode).toBe("observe");
    expect(policy?.onError).toBe("passthrough");
    expect(policy?.timeoutMs).toBe(800);
    expect(policy?.backend).toBe("jev");
    expect(policy?.skipPermissionModes).toEqual(["plan"]);
  });

  // Observe-by-default is a safety property, not a convenience. A policy file that omits
  // `mode` must never come back as anything that can emit a decision.
  it("defaults to observe mode even when the file says nothing about mode", () => {
    expect(loadPolicy(MINIMAL).policy?.mode).toBe("observe");
  });

  const rejected: ReadonlyArray<readonly [string, string, string]> = [
    ["a missing version", "gate:\n  tools: [Bash]\n", "version"],
    ["an unknown mode", `${MINIMAL}\nmode: paranoid`, "mode"],
    ["an unknown on_error", `${MINIMAL}\non_error: explode`, "on_error"],
    ["a non-numeric timeout", `${MINIMAL}\ntimeout_ms: soon`, "timeout_ms"],
    ["an absurd timeout", `${MINIMAL}\ntimeout_ms: 600000`, "timeout_ms"],
    ["a sub-millisecond timeout", `${MINIMAL}\ntimeout_ms: 1`, "timeout_ms"],
    ["a missing gate", "version: 1\n", "gate"],
    ["no questions", "version: 1\ngate:\n  tools: [Bash]\n  questions: {}\n  rules: []\n", "gate.questions"],
    [
      "a question with no instructions",
      "version: 1\ngate:\n  tools: [Bash]\n  questions:\n    x: {}\n  rules:\n    - default: allow\n",
      "instructions",
    ],
    [
      "a rule naming a question that does not exist",
      `${MINIMAL}`.replace("destructive: { p", "nonexistent: { p"),
      "nonexistent",
    ],
    [
      "an unreadable threshold",
      `${MINIMAL}`.replace('">=0.8"', '"probably"'),
      "p",
    ],
    [
      "a rule matching on two questions at once",
      "version: 1\ngate:\n  tools: [Bash]\n  questions:\n    a:\n      instructions: x\n    b:\n      instructions: y\n  rules:\n    - when: { a: { p: \">=0.5\" }, b: { p: \">=0.5\" } }\n      then: ask\n    - default: allow\n",
      "when",
    ],
    ["an unknown verdict", `${MINIMAL}`.replace("then: ask", "then: explode"), "then"],
    ["two default rules", `${MINIMAL}    - default: deny\n`, "rules"],
    ["a reserved question name", "version: 1\ngate:\n  tools: [Bash]\n  questions:\n    any:\n      instructions: x\n  rules:\n    - default: allow\n", "any"],
    ["a non-numeric accuracy bar", `${MINIMAL}\ncalibration:\n  accuracy_bar: high`, "calibration.accuracy_bar"],
    ["an accuracy bar above 1", `${MINIMAL}\ncalibration:\n  accuracy_bar: 85`, "calibration.accuracy_bar"],
    // Confidence is max(p, 1 − p), so a floor under 0.5 would quietly count every answer.
    ["a confidence floor below 0.5", `${MINIMAL}\ncalibration:\n  confidence_floor: 0.3`, "calibration.confidence_floor"],
    ["a calibration section that is not a mapping", `${MINIMAL}\ncalibration: strict`, "calibration"],
    ["a top-level list", "- version: 1\n", ""],
    ["not YAML at all", "{{{", ""],
  ];

  it.each(rejected)("rejects %s", (_label, source, expectedPath) => {
    const found = errors(source);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((d) => d.path.includes(expectedPath))).toBe(true);
  });

  it("returns no policy when there are errors, so a broken file cannot enforce", () => {
    expect(loadPolicy(`${MINIMAL}\nmode: paranoid`).policy).toBeUndefined();
  });

  // Warnings are for the failure mode where bouncer loads fine and then silently does
  // nothing, which is far harder to notice than a parse error.
  it("warns about a rule placed after the default", () => {
    const source = `${MINIMAL}    - when: { destructive: { p: ">=0.9" } }\n      then: deny\n`;
    expect(warnings(source).some((d) => d.message.includes("unreachable"))).toBe(true);
  });

  it("warns when no default rule exists", () => {
    const source = "version: 1\ngate:\n  tools: [Bash]\n  questions:\n    a:\n      instructions: x\n  rules:\n    - when: { a: { p: \">=0.5\" } }\n      then: ask\n";
    expect(warnings(source).some((d) => d.message.includes("default"))).toBe(true);
  });

  it("warns when no tools are gated", () => {
    const source = "version: 1\ngate:\n  tools: []\n  questions:\n    a:\n      instructions: x\n  rules:\n    - default: allow\n";
    expect(warnings(source).some((d) => d.path === "gate.tools")).toBe(true);
  });

  // Exactly that failure mode: observe never emits, so the setting loads and does nothing.
  // A warning rather than an error, because an error unloads the policy and turns bouncer off.
  it("warns that on_error: deny does nothing in observe, and still loads the policy", () => {
    const source = "version: 1\nmode: observe\non_error: deny\ngate:\n  tools: [Bash]\n  questions:\n    a:\n      instructions: x\n  rules:\n    - default: allow\n";
    expect(warnings(source).map((d) => d.path)).toContain("on_error");
    expect(loadPolicy(source).policy?.onError).toBe("deny");
  });

  it("does not warn about on_error: deny in a mode that can emit it", () => {
    const source = "version: 1\nmode: guard\non_error: deny\ngate:\n  tools: [Bash]\n  questions:\n    a:\n      instructions: x\n  rules:\n    - default: allow\n";
    expect(warnings(source).map((d) => d.path)).not.toContain("on_error");
  });

  it("reads criteria, including YAML's boolean-looking true and false keys", () => {
    const source = `
version: 1
gate:
  tools: [Bash]
  questions:
    destructive:
      instructions: "It destroys something."
      criteria:
        "true": "rm -rf"
        "false": "git commit"
  rules:
    - default: allow
`;
    const question = loadPolicy(source).policy?.gate.questions["destructive"];
    expect(question?.criteria?.true).toBe("rm -rf");
    expect(question?.criteria?.false).toBe("git commit");
  });
});

// The shipped default is what every new user runs, so it is tested like code.
describe("the shipped default policy", () => {
  const source = readFileSync("policy/default.yaml", "utf8");
  const result = loadPolicy(source);

  it("loads without errors", () => {
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("loads without warnings", () => {
    expect(result.diagnostics).toEqual([]);
  });

  it("ships in observe mode", () => {
    expect(result.policy?.mode).toBe("observe");
  });

  // docs/adr/003: a false-positive deny sends Claude down a workaround path the user
  // never sees. Nothing ships enabled until there is a calibration table to justify it.
  it("ships with no deny rules enabled", () => {
    expect(result.policy?.gate.rules.some((r) => r.verdict === "deny")).toBe(false);
  });

  it("falls through to allow rather than leaving calls undecided", () => {
    const rules = result.policy?.gate.rules ?? [];
    expect(rules.at(-1)?.condition).toBeUndefined();
    expect(rules.at(-1)?.verdict).toBe("allow");
  });

  it("never fails closed on error", () => {
    expect(result.policy?.onError).toBe("passthrough");
  });

  it("skips work in plan mode, where no tool runs anyway", () => {
    expect(result.policy?.skipPermissionModes).toContain("plan");
  });

  // PRD §12's release gate. In the policy rather than in src/ so a user can raise the bar
  // before trusting a question, and so `bouncer calibrate` prints a verdict rather than
  // leaving it to be worked out by hand off the bucket columns.
  it("carries the release gate the calibration harness measures against", () => {
    expect(result.policy?.calibration.confidenceFloor).toBe(0.8);
    expect(result.policy?.calibration.accuracyBar).toBe(0.85);
  });
});

// A policy written before the section existed still has to load, and has to get the
// PRD's numbers rather than no gate at all.
describe("a policy with no calibration section", () => {
  const source = "version: 1\ngate:\n  tools: [Bash]\n  questions:\n    a:\n      instructions: x\n  rules:\n    - default: allow\n";
  const result = loadPolicy(source);

  it("loads without complaint", () => {
    expect(result.diagnostics).toEqual([]);
  });

  it("falls back to the PRD's gate", () => {
    expect(result.policy?.calibration).toEqual({ confidenceFloor: 0.8, accuracyBar: 0.85 });
  });
});

describe("probe questions", () => {
  const WITH_PROBES = `${MINIMAL}
  probe_questions:
    destructive_v2:
      instructions: "It throws away work."
      criteria:
        "true": "rm -rf"
        "false": "git commit"
`;

  it("loads them into their own block, leaving the gate questions alone", () => {
    const gate = loadPolicy(WITH_PROBES).policy?.gate;
    expect(Object.keys(gate?.questions ?? {})).toEqual(["destructive"]);
    expect(gate?.probeQuestions["destructive_v2"]?.instructions).toBe("It throws away work.");
    expect(gate?.probeQuestions["destructive_v2"]?.criteria).toEqual({ true: "rm -rf", false: "git commit" });
  });

  // The zero-probe case is the one that has to stay exactly as it was, so it is asserted
  // rather than assumed: every policy written before probes existed is this case.
  it("is an empty block when the policy does not mention it", () => {
    const gate = loadPolicy(MINIMAL).policy?.gate;
    expect(gate?.probeQuestions).toEqual({});
  });

  it("validates a probe the same way as a question", () => {
    const source = `${MINIMAL}
  probe_questions:
    broken: {}
`;
    expect(errors(source).map((d) => d.path)).toContain("gate.probe_questions.broken.instructions");
  });

  it("rejects a probe reusing a gate question's name, since the answers would collide", () => {
    const source = `${MINIMAL}
  probe_questions:
    destructive:
      instructions: "The same name."
`;
    const [error] = errors(source);
    expect(error?.path).toBe("gate.probe_questions.destructive");
    expect(error?.message).toMatch(/already a question/);
  });

  it("rejects the reserved name", () => {
    const source = `${MINIMAL}
  probe_questions:
    any:
      instructions: "Reserved."
`;
    expect(errors(source).map((d) => d.path)).toContain("gate.probe_questions.any");
  });

  // A rule naming a probe would load, read nothing and never fire. Refusing it is what
  // makes "a probe never affects a verdict" a property of the policy rather than a habit.
  it("rejects a rule that names a probe, and says why", () => {
    const source = `
version: 1
gate:
  tools: [Bash]
  questions:
    destructive:
      instructions: "It destroys something."
  probe_questions:
    destructive_v2:
      instructions: "It throws away work."
  rules:
    - when: { destructive_v2: { p: ">=0.8" } }
      then: ask
    - default: allow
`;
    const [error] = errors(source);
    expect(error?.path).toBe("gate.rules[0].when.destructive_v2");
    expect(error?.message).toMatch(/probe question/);
  });

  it("still says a rule names nothing at all when the question simply does not exist", () => {
    const source = MINIMAL.replace("destructive: { p:", "nonexistent: { p:");
    expect(errors(source)[0]?.message).toMatch(/no question named/);
  });

  it("carries the shipped probes", () => {
    const { policy } = loadPolicy(readFileSync("policy/default.yaml", "utf8"));
    expect(Object.keys(policy?.gate.probeQuestions ?? {})).toEqual(["outside_repo_v2", "home_dir_tool_cache"]);
  });
});

// docs/adr/009 decision 1: the file names several sets, and `gate:` at the top level is a
// permanent alias rather than a deprecated spelling.
describe("named policy sets", () => {
  const CONTENT_SET = `
version: 1
policies:
  content:
    questions:
      on_brand:
        instructions: "The draft sounds like the brand's own voice."
    rules:
      - when: { on_brand: { p: "<0.40" } }
        then: ask
      - default: allow
`;

  it("reads a set under policies: that is not the gate", () => {
    const { policy } = loadPolicy(CONTENT_SET);
    expect(Object.keys(policy?.sets ?? {})).toEqual(["content"]);
    expect(policy?.sets["content"]?.rules).toHaveLength(2);
  });

  it("gives a file with no gate set an empty gate rather than refusing to load", () => {
    // The hook reads policy.gate on the hot path of every tool call. An empty `tools` list
    // already means "not gated", so a judge-only policy is silent rather than undefined.
    const { policy } = loadPolicy(CONTENT_SET);
    expect(policy?.gate.tools).toEqual([]);
    expect(policy?.gate.rules).toEqual([]);
  });

  it("does not warn about tools on a file that never claimed to have a gate", () => {
    expect(warnings(CONTENT_SET).map((d) => d.path)).not.toContain("gate.tools");
    expect(warnings(CONTENT_SET).map((d) => d.path)).not.toContain("policies.gate.tools");
  });

  it("reads a top-level gate: as policies.gate, with no deprecation warning", () => {
    const { policy, diagnostics } = loadPolicy(MINIMAL);
    // Equality, not identity: a policy read back from the on-disk cache (docs/adr/007) is
    // two structurally equal objects rather than one, and nothing may depend on which.
    expect(policy?.sets["gate"]).toEqual(policy?.gate);
    expect(diagnostics).toEqual([]);
  });

  it("reads the same gate whichever way the file spells it", () => {
    const nested = `
version: 1
policies:
  gate:
    tools: [Bash]
    questions:
      destructive:
        instructions: "It destroys something."
    rules:
      - when: { destructive: { p: ">=0.8" } }
        then: ask
      - default: allow
`;
    expect(loadPolicy(nested).policy?.gate).toEqual(loadPolicy(MINIMAL).policy?.gate);
  });

  it("refuses a file that spells the gate both ways", () => {
    const both = `${MINIMAL}
policies:
  content:
    questions:
      on_brand:
        instructions: "It sounds like us."
    rules:
      - default: allow
`;
    expect(errors(both)[0]?.message).toMatch(/both a top-level/);
  });

  it("refuses gate-only keys on another set, because there they would never fire", () => {
    const source = CONTENT_SET.replace("  content:\n", "  content:\n    hard_rules: []\n");
    const [error] = errors(source);
    expect(error?.path).toBe("policies.content.hard_rules");
    expect(error?.message).toMatch(/only the `gate` set/);
  });

  it.each(["tools", "fast_path"])("refuses gate-only key %s on another set", (key) => {
    const source = CONTENT_SET.replace("  content:\n", `  content:\n    ${key}: [x]\n`);
    expect(errors(source)[0]?.path).toBe(`policies.content.${key}`);
  });

  it("points a diagnostic at the path the user actually wrote", () => {
    const source = CONTENT_SET.replace('{ on_brand: { p: "<0.40" } }', '{ nonexistent: { p: "<0.40" } }');
    const [error] = errors(source);
    expect(error?.path).toBe("policies.content.rules[0].when.nonexistent");
    expect(error?.message).toMatch(/policies\.content\.questions/);
  });

  it("refuses an empty policies block", () => {
    expect(errors("version: 1\npolicies: {}\n")[0]?.path).toBe("policies");
  });

  it("still names gate: in the message when the file has neither block", () => {
    expect(errors("version: 1\n")[0]?.message).toMatch(/`gate:` block or a `policies:` block/);
  });
});
