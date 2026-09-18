// Policy loading and validation.
//
// A policy file is something a user wrote by hand and will keep editing, so the validator
// is written to be specific about where a problem is rather than merely rejecting the
// document. Errors prevent enforcement; warnings do not, but they catch the mistakes that
// would otherwise show up as "bouncer silently never fires" — an unreachable rule, a rule
// naming a question that does not exist.

import { parse as parseYaml } from "yaml";
import {
  ANY_QUESTION,
  type Comparison,
  type Condition,
  type Diagnostic,
  type HardRule,
  type HardRuleWhen,
  type Mode,
  type OnError,
  type Policy,
  type Question,
  type Rule,
  type Verdict,
} from "./types.js";

export interface LoadResult {
  /** Present when there are no errors. */
  readonly policy?: Policy;
  readonly diagnostics: readonly Diagnostic[];
}

const MODES: readonly Mode[] = ["observe", "guard", "full", "seatbelt"];

/** The `when` keys a hard rule may assert. Misspelling one is an error, not a no-op. */
const HARD_RULE_PREDICATES = [
  "first_token",
  "tokens",
  "not_tokens",
  "text",
  "path_labelled",
  "redacts_as",
] as const;
const VERDICTS: readonly Verdict[] = ["allow", "ask", "deny"];
const ON_ERROR: readonly OnError[] = ["passthrough", "deny"];

const DEFAULT_TIMEOUT_MS = 800;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;

// PRD §12's release gate, as the defaults for a policy that omits the section.
const DEFAULT_CONFIDENCE_FLOOR = 0.8;
const DEFAULT_ACCURACY_BAR = 0.85;

export function loadPolicy(source: string): LoadResult {
  const diagnostics: Diagnostic[] = [];
  const error = (path: string, message: string) => diagnostics.push({ severity: "error", path, message });
  const warn = (path: string, message: string) => diagnostics.push({ severity: "warning", path, message });

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    error("", `not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    return { diagnostics };
  }

  if (!isRecord(raw)) {
    error("", "policy must be a mapping at the top level");
    return { diagnostics };
  }

  if (raw["version"] !== 1) {
    error("version", `expected 1, got ${JSON.stringify(raw["version"])}`);
  }

  const backend = typeof raw["backend"] === "string" ? raw["backend"] : "jev";
  if (raw["backend"] !== undefined && typeof raw["backend"] !== "string") {
    error("backend", "must be a string");
  }

  const mode = readEnum(raw["mode"], MODES, "observe", "mode", error);
  const onError = readEnum(raw["on_error"], ON_ERROR, "passthrough", "on_error", error);

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = raw["timeout_ms"];
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout)) {
      error("timeout_ms", "must be a number");
    } else if (rawTimeout < MIN_TIMEOUT_MS || rawTimeout > MAX_TIMEOUT_MS) {
      error("timeout_ms", `must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
    } else {
      timeoutMs = rawTimeout;
    }
  }

  const skipPermissionModes = readStringList(raw["skip_permission_modes"], ["plan"], "skip_permission_modes", error);

  const calibrationRaw = raw["calibration"];
  if (calibrationRaw !== undefined && !isRecord(calibrationRaw)) {
    error("calibration", "must be a mapping");
  }
  const calibrationFields = isRecord(calibrationRaw) ? calibrationRaw : {};
  const confidenceFloor = readProbability(
    calibrationFields["confidence_floor"],
    DEFAULT_CONFIDENCE_FLOOR,
    "calibration.confidence_floor",
    error,
  );
  const accuracyBar = readProbability(
    calibrationFields["accuracy_bar"],
    DEFAULT_ACCURACY_BAR,
    "calibration.accuracy_bar",
    error,
  );
  // Confidence is max(p, 1 − p), so it cannot be below 0.5. A floor under that would
  // silently widen the gate to every answer, which is not what anyone lowering it means.
  if (confidenceFloor < 0.5) {
    error("calibration.confidence_floor", "must be at least 0.5, since confidence is max(p, 1 − p)");
  }

  const gateRaw = raw["gate"];
  if (!isRecord(gateRaw)) {
    error("gate", "missing or not a mapping");
    return { diagnostics };
  }

  const tools = readStringList(gateRaw["tools"], [], "gate.tools", error);
  if (tools.length === 0) {
    warn("gate.tools", "no tools listed, so the gate will never run");
  }

  const fastPath = readStringList(gateRaw["fast_path"], [], "gate.fast_path", error);
  const hardRules = readHardRules(gateRaw["hard_rules"], error, warn);

  const questions = readQuestions(gateRaw["questions"], error);
  const rules = readRules(gateRaw["rules"], questions, error, warn);

  if (diagnostics.some((d) => d.severity === "error")) {
    return { diagnostics };
  }

  const policy: Policy = {
    version: 1,
    backend,
    mode,
    timeoutMs,
    onError,
    skipPermissionModes,
    gate: { tools, fastPath, hardRules, questions, rules },
    calibration: { confidenceFloor, accuracyBar },
  };

  return { policy, diagnostics };
}

function readQuestions(
  raw: unknown,
  error: (path: string, message: string) => void,
): Record<string, Question> {
  const questions: Record<string, Question> = {};

  if (!isRecord(raw)) {
    error("gate.questions", "missing or not a mapping");
    return questions;
  }

  for (const [name, value] of Object.entries(raw)) {
    const path = `gate.questions.${name}`;

    if (name === ANY_QUESTION) {
      error(path, `"${ANY_QUESTION}" is reserved for rules that match any question`);
      continue;
    }

    if (!isRecord(value)) {
      error(path, "must be a mapping with `instructions`");
      continue;
    }

    const instructions = value["instructions"];
    if (typeof instructions !== "string" || instructions.trim().length === 0) {
      error(`${path}.instructions`, "must be a non-empty string");
      continue;
    }

    const question: { instructions: string; criteria?: { true?: string; false?: string } } = { instructions };

    const criteriaRaw = value["criteria"];
    if (criteriaRaw !== undefined) {
      if (!isRecord(criteriaRaw)) {
        error(`${path}.criteria`, "must be a mapping with `true` and/or `false` keys");
      } else {
        const criteria: { true?: string; false?: string } = {};
        // YAML parses bare `true:` / `false:` as boolean keys, which arrive here stringified.
        for (const key of ["true", "false"] as const) {
          const described = criteriaRaw[key];
          if (described === undefined) continue;
          if (typeof described !== "string") {
            error(`${path}.criteria.${key}`, "must be a string");
          } else {
            criteria[key] = described;
          }
        }
        if (Object.keys(criteria).length > 0) question.criteria = criteria;
      }
    }

    questions[name] = question;
  }

  if (Object.keys(questions).length === 0) {
    error("gate.questions", "at least one question is required");
  }

  return questions;
}

/**
 * Reads `gate.hard_rules`.
 *
 * Stricter than the rest of the loader on purpose. A hard rule is the one thing in the
 * policy that produces a verdict without any evidence behind it, so a malformed entry is
 * an error rather than a warning: the two ways it could fail quietly are an entry that
 * matches everything and an entry that matches nothing, and both are worse than refusing
 * to enforce. The `no thresholds in code` rule applies here too — the paths, verbs and
 * credential shapes are all data in this file.
 */
function readHardRules(
  raw: unknown,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): HardRule[] {
  const rules: HardRule[] = [];
  if (raw === undefined) return rules;

  if (!Array.isArray(raw)) {
    error("gate.hard_rules", "must be a list");
    return rules;
  }

  const seen = new Set<string>();

  raw.forEach((entry, i) => {
    const path = `gate.hard_rules[${i}]`;

    if (!isRecord(entry)) {
      error(path, "must be a mapping");
      return;
    }

    const name = entry["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      error(`${path}.name`, "must be a non-empty string");
      return;
    }
    if (seen.has(name)) {
      // Names end up in the log and in `/bouncer:explain`, so a duplicate makes a decision
      // record ambiguous about which entry produced it.
      error(`${path}.name`, `duplicate hard rule name "${name}"`);
      return;
    }
    seen.add(name);

    const because = entry["because"];
    if (typeof because !== "string" || because.trim().length === 0) {
      // Required, for the same reason a fixture's `note` is: an unexplained verdict cannot
      // be argued with, and this one is shown to the user at the moment they are stopped.
      error(`${path}.because`, "must be a non-empty string — it is the reason the user reads");
      return;
    }

    const then = entry["then"] ?? "ask";
    if (!isVerdict(then)) {
      error(`${path}.then`, `must be one of ${VERDICTS.join(", ")}`);
      return;
    }
    if (then === "allow") {
      error(`${path}.then`, "must be `ask` or `deny`; `gate.fast_path` is where allow-without-judging lives");
      return;
    }
    if (then === "deny") {
      warn(
        path,
        "`then: deny` blocks the tool call in guard and full. `ask` is the shipped default and `seatbelt` already denies on it — see docs/adr/003",
      );
    }

    const whenRaw = entry["when"];
    if (!isRecord(whenRaw)) {
      error(`${path}.when`, `must be a mapping of at least one of ${HARD_RULE_PREDICATES.join(", ")}`);
      return;
    }

    for (const key of Object.keys(whenRaw)) {
      if (!(HARD_RULE_PREDICATES as readonly string[]).includes(key)) {
        error(`${path}.when.${key}`, `unknown predicate — expected one of ${HARD_RULE_PREDICATES.join(", ")}`);
        return;
      }
    }

    const when: {
      firstToken?: readonly string[];
      tokens?: readonly string[];
      notTokens?: readonly string[];
      text?: readonly string[];
      pathLabelled?: readonly string[];
      redactsAs?: readonly string[];
    } = {};

    let failed = false;
    const list = (key: string): readonly string[] | undefined => {
      if (whenRaw[key] === undefined) return undefined;
      const value = readStringList(whenRaw[key], [], `${path}.when.${key}`, error);
      if (value.length === 0) {
        error(`${path}.when.${key}`, "must be a non-empty list");
        failed = true;
      }
      return value;
    };

    const firstToken = list("first_token");
    const tokens = list("tokens");
    const notTokens = list("not_tokens");
    const text = list("text");
    const pathLabelled = list("path_labelled");
    const redactsAs = list("redacts_as");
    if (failed) return;

    if (firstToken !== undefined) when.firstToken = firstToken;
    if (tokens !== undefined) when.tokens = tokens;
    if (notTokens !== undefined) when.notTokens = notTokens;
    if (text !== undefined) when.text = text;
    if (pathLabelled !== undefined) when.pathLabelled = pathLabelled;
    if (redactsAs !== undefined) when.redactsAs = redactsAs;

    // `not_tokens` narrows; it cannot be the whole of a rule. On its own it would match
    // every command that merely lacks those tokens, which is most of them.
    const narrowingOnly = Object.keys(when).length === 1 && when.notTokens !== undefined;
    if (Object.keys(when).length === 0 || narrowingOnly) {
      error(
        `${path}.when`,
        "needs at least one predicate that matches something — `not_tokens` only excludes",
      );
      return;
    }

    rules.push({ name, verdict: then, because, when: when as HardRuleWhen, index: i + 1 });
  });

  return rules;
}

function readRules(
  raw: unknown,
  questions: Readonly<Record<string, Question>>,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): Rule[] {
  const rules: Rule[] = [];

  if (!Array.isArray(raw)) {
    error("gate.rules", "missing or not a list");
    return rules;
  }

  let terminalAt: number | undefined;

  raw.forEach((entry, i) => {
    const index = i + 1;
    const path = `gate.rules[${i}]`;

    if (!isRecord(entry)) {
      error(path, "must be a mapping");
      return;
    }

    if ("default" in entry) {
      const verdict = entry["default"];
      if (!isVerdict(verdict)) {
        error(`${path}.default`, `must be one of ${VERDICTS.join(", ")}`);
        return;
      }
      if (terminalAt !== undefined) {
        error(path, "a second `default` rule — only one is allowed");
        return;
      }
      terminalAt = i;
      rules.push({ verdict, index });
      return;
    }

    if (terminalAt !== undefined) {
      warn(path, `unreachable: rule ${terminalAt + 1} is the default rule and always matches`);
    }

    const when = entry["when"];
    const then = entry["then"];

    if (!isRecord(when)) {
      error(`${path}.when`, "must be a mapping of a question name to a condition");
      return;
    }
    if (!isVerdict(then)) {
      error(`${path}.then`, `must be one of ${VERDICTS.join(", ")}`);
      return;
    }

    const entries = Object.entries(when);
    if (entries.length !== 1) {
      error(`${path}.when`, `must name exactly one question, got ${entries.length}`);
      return;
    }

    const [question, conditionRaw] = entries[0] as [string, unknown];
    if (question !== ANY_QUESTION && !(question in questions)) {
      error(`${path}.when.${question}`, `no question named "${question}" is defined in gate.questions`);
      return;
    }

    if (!isRecord(conditionRaw) || typeof conditionRaw["p"] !== "string") {
      error(`${path}.when.${question}`, 'must be a mapping with a `p` string, for example { p: ">=0.7" }');
      return;
    }

    const comparison = parseComparison(conditionRaw["p"]);
    if (comparison === undefined) {
      error(
        `${path}.when.${question}.p`,
        `cannot read "${conditionRaw["p"]}" — expected >=, >, <=, < followed by a number between 0 and 1, or a range like "0.4..0.6"`,
      );
      return;
    }

    const condition: Condition = { question, comparison };
    rules.push({ condition, verdict: then, index });
  });

  if (terminalAt === undefined && rules.length > 0) {
    warn("gate.rules", "no `default` rule, so a tool call matching nothing gets no decision");
  }

  return rules;
}

/**
 * Reads a threshold like ">=0.7", "<0.3" or the inclusive range "0.4..0.6".
 *
 * Returns undefined rather than throwing: the caller has the file path and can produce a
 * better message than this function could.
 */
export function parseComparison(input: string): Comparison | undefined {
  const text = input.trim();

  const range = /^(\d*\.?\d+)\.\.(\d*\.?\d+)$/.exec(text);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (!inUnitInterval(low) || !inUnitInterval(high) || low > high) return undefined;
    return { kind: "range", low, high };
  }

  const compared = /^(>=|<=|>|<)\s*(\d*\.?\d+)$/.exec(text);
  if (compared) {
    const value = Number(compared[2]);
    if (!inUnitInterval(value)) return undefined;
    switch (compared[1]) {
      case ">=": return { kind: "gte", value };
      case ">": return { kind: "gt", value };
      case "<=": return { kind: "lte", value };
      case "<": return { kind: "lt", value };
    }
  }

  return undefined;
}

export function satisfies(p: number, comparison: Comparison): boolean {
  switch (comparison.kind) {
    case "gte": return p >= comparison.value;
    case "gt": return p > comparison.value;
    case "lte": return p <= comparison.value;
    case "lt": return p < comparison.value;
    case "range": return p >= comparison.low && p <= comparison.high;
  }
}

function inUnitInterval(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  error: (path: string, message: string) => void,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  error(path, `must be one of ${allowed.join(", ")}`);
  return fallback;
}

function readProbability(
  value: unknown,
  fallback: number,
  path: string,
  error: (path: string, message: string) => void,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    error(path, "must be a number");
    return fallback;
  }
  if (value < 0 || value > 1) {
    error(path, "must be between 0 and 1");
    return fallback;
  }
  return value;
}

function readStringList(
  value: unknown,
  fallback: readonly string[],
  path: string,
  error: (path: string, message: string) => void,
): readonly string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    error(path, "must be a list");
    return fallback;
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== "string") error(`${path}[${i}]`, "must be a string");
    else out.push(item);
  });
  return out;
}
