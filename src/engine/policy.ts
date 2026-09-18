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

const MODES: readonly Mode[] = ["observe", "guard", "full"];
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

  const questions = readQuestions(gateRaw["questions"], "gate.questions", true, error);
  // Probes are optional and, unlike `questions`, an empty block is fine: most policies
  // will not have any, and a policy with none must behave exactly as it did before they
  // existed.
  const probeQuestions = readQuestions(gateRaw["probe_questions"], "gate.probe_questions", false, error);

  for (const name of Object.keys(probeQuestions)) {
    if (name in questions) {
      error(
        `gate.probe_questions.${name}`,
        `"${name}" is already a question in gate.questions — answers come back keyed by name, so the two would collide`,
      );
    }
  }

  const rules = readRules(gateRaw["rules"], questions, probeQuestions, error, warn);

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
    gate: { tools, fastPath, questions, probeQuestions, rules },
    calibration: { confidenceFloor, accuracyBar },
  };

  return { policy, diagnostics };
}

/**
 * Reads a block of questions. Shared by `gate.questions` and `gate.probe_questions`,
 * which are validated identically: a probe is asked over the same wire as a judgment, so
 * a probe the classifier would reject is worth catching at load time too.
 */
function readQuestions(
  raw: unknown,
  basePath: string,
  required: boolean,
  error: (path: string, message: string) => void,
): Record<string, Question> {
  const questions: Record<string, Question> = {};

  if (raw === undefined && !required) return questions;

  if (!isRecord(raw)) {
    error(basePath, "missing or not a mapping");
    return questions;
  }

  for (const [name, value] of Object.entries(raw)) {
    const path = `${basePath}.${name}`;

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

  if (required && Object.keys(questions).length === 0) {
    error(basePath, "at least one question is required");
  }

  return questions;
}

function readRules(
  raw: unknown,
  questions: Readonly<Record<string, Question>>,
  probeQuestions: Readonly<Record<string, Question>>,
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
      // Naming a probe is the mistake worth a message of its own: the rule looks correct,
      // the question exists, and it would simply never fire. Rejecting it here is what
      // makes "a probe never affects a verdict" a property of the policy rather than of
      // whoever wrote the rules.
      error(
        `${path}.when.${question}`,
        question in probeQuestions
          ? `"${question}" is a probe question, and probes are never read by rules — move it to gate.questions to act on it`
          : `no question named "${question}" is defined in gate.questions`,
      );
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
