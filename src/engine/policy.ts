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
  EMPTY_GATE,
  GATE_SET,
  type Comparison,
  type Condition,
  type Diagnostic,
  type HardRule,
  type HardRuleWhen,
  type Mode,
  type OnError,
  type GatePolicy,
  type Policy,
  type PolicySet,
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
/** Keys only `policies.gate` may carry. On another set they would load and never fire. */
const GATE_ONLY_KEYS = ["tools", "fast_path", "hard_rules"] as const;

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

  // A warning and not an error: an error unloads the policy, which turns bouncer off, and
  // that is a heavier consequence than a setting that simply has no effect yet.
  if (mode === "observe" && onError === "deny") {
    warn(
      "on_error",
      "`on_error: deny` does nothing while `mode` is `observe`, which never emits a decision. It takes effect in guard, full and seatbelt — see docs/adr/003",
    );
  }

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

  const located = locateSets(raw, error);
  if (located === undefined) return { diagnostics };

  const sets: Record<string, PolicySet> = {};
  let gate: GatePolicy | undefined;

  for (const { name, path, body } of located) {
    if (name === GATE_SET) {
      gate = readGate(body, path, error, warn);
      sets[name] = gate;
    } else {
      sets[name] = readPolicySet(body, path, error, warn);
    }
  }

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
    sets,
    gate: gate ?? EMPTY_GATE,
    calibration: { confidenceFloor, accuracyBar },
  };

  return { policy, diagnostics };
}

interface LocatedSet {
  readonly name: string;
  /** The path as the user spelled it, so a diagnostic points at their own line. */
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Finds the named policy sets, whichever way the file spells them.
 *
 * Two spellings, both supported for good: a `policies:` mapping of name to set, and a
 * top-level `gate:`, which is the same thing under the one name the hook looks up. The
 * alias is not deprecated — every policy file written before v0.3 uses it, and a warning
 * on a file with nothing to fix is friction with nothing behind it (docs/adr/009).
 *
 * Both at once is an error rather than a precedence rule. Which one wins is not guessable,
 * and guessing would mean judging tool calls against the block the user thought they had
 * replaced.
 */
function locateSets(
  raw: Readonly<Record<string, unknown>>,
  error: (path: string, message: string) => void,
): LocatedSet[] | undefined {
  const policiesRaw = raw["policies"];
  const gateRaw = raw["gate"];

  if (policiesRaw !== undefined && gateRaw !== undefined) {
    error(
      "policies",
      "the file has both a top-level `gate:` and a `policies:` block — move the gate under `policies:` and delete the top-level one",
    );
    return undefined;
  }

  if (policiesRaw === undefined) {
    if (!isRecord(gateRaw)) {
      error("gate", "missing or not a mapping — a policy file needs a `gate:` block or a `policies:` block");
      return undefined;
    }
    return [{ name: GATE_SET, path: "gate", body: gateRaw }];
  }

  if (!isRecord(policiesRaw)) {
    error("policies", "must be a mapping of set name to policy set");
    return undefined;
  }

  const located: LocatedSet[] = [];
  for (const [name, body] of Object.entries(policiesRaw)) {
    const path = `policies.${name}`;
    if (!isRecord(body)) {
      error(path, "must be a mapping with `questions` and `rules`");
      continue;
    }
    located.push({ name, path, body });
  }

  if (located.length === 0) {
    error("policies", "names no policy sets");
    return undefined;
  }

  return located;
}

/**
 * Reads the gate: a policy set plus the three things only a tool call has.
 *
 * `tools`, `fast_path` and `hard_rules` reason about a Claude Code tool name or a shell
 * command, so they belong to this consumer rather than to the engine (docs/adr/008).
 * `readPolicySet` rejects them anywhere else.
 */
function readGate(
  raw: Readonly<Record<string, unknown>>,
  path: string,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): GatePolicy {
  const tools = readStringList(raw["tools"], [], `${path}.tools`, error);
  if (tools.length === 0) {
    warn(`${path}.tools`, "no tools listed, so the gate will never run");
  }

  const fastPath = readStringList(raw["fast_path"], [], `${path}.fast_path`, error);
  const hardRules = readHardRules(raw["hard_rules"], path, error, warn);

  return { tools, fastPath, hardRules, ...readPolicySet(raw, path, error, warn, true) };
}

/**
 * Reads one named set: questions, probe questions, rules.
 *
 * This is the engine's unit of work and it knows nothing about tool calls, which is why
 * `tools`, `fast_path` and `hard_rules` on a non-gate set are an error rather than a
 * warning. The failure mode is silence: a `hard_rules` block on a content set would load,
 * read correctly, and never once fire.
 */
function readPolicySet(
  raw: Readonly<Record<string, unknown>>,
  path: string,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
  isGate = false,
): PolicySet {
  if (!isGate) {
    for (const key of GATE_ONLY_KEYS) {
      if (raw[key] !== undefined) {
        error(
          `${path}.${key}`,
          `only the \`gate\` set can use \`${key}\` — it reasons about a tool call, and here it would load correctly and never fire`,
        );
      }
    }
  }

  const questions = readQuestions(raw["questions"], `${path}.questions`, true, error);
  // Probes are optional and, unlike `questions`, an empty block is fine: most policies
  // will not have any, and a policy with none must behave exactly as it did before they
  // existed.
  const probeQuestions = readQuestions(raw["probe_questions"], `${path}.probe_questions`, false, error);

  for (const name of Object.keys(probeQuestions)) {
    if (name in questions) {
      error(
        `${path}.probe_questions.${name}`,
        `"${name}" is already a question in ${path}.questions — answers come back keyed by name, so the two would collide`,
      );
    }
  }

  const rules = readRules(raw["rules"], path, questions, probeQuestions, error, warn);

  return { questions, probeQuestions, rules };
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
  basePath: string,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): HardRule[] {
  const rules: HardRule[] = [];
  if (raw === undefined) return rules;

  if (!Array.isArray(raw)) {
    error(`${basePath}.hard_rules`, "must be a list");
    return rules;
  }

  const seen = new Set<string>();

  raw.forEach((entry, i) => {
    const path = `${basePath}.hard_rules[${i}]`;

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
      error(`${path}.then`, `must be \`ask\` or \`deny\`; \`${basePath}.fast_path\` is where allow-without-judging lives`);
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
  basePath: string,
  questions: Readonly<Record<string, Question>>,
  probeQuestions: Readonly<Record<string, Question>>,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): Rule[] {
  const rules: Rule[] = [];

  if (!Array.isArray(raw)) {
    error(`${basePath}.rules`, "missing or not a list");
    return rules;
  }

  let terminalAt: number | undefined;

  raw.forEach((entry, i) => {
    const index = i + 1;
    const path = `${basePath}.rules[${i}]`;

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
          ? `"${question}" is a probe question, and probes are never read by rules — move it to ${basePath}.questions to act on it`
          : `no question named "${question}" is defined in ${basePath}.questions`,
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
    warn(`${basePath}.rules`, "no `default` rule, so an item matching nothing gets no decision");
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

/**
 * The inverse of `parseComparison`: a threshold back in the spelling the user wrote.
 *
 * The escalation manifest is read by a person or by a reasoning model, and "secrets 0.63
 * failed >=0.70" says what "secrets 0.63, rule 2" does not. Rendering from the parsed
 * form rather than keeping the source string means the manifest cannot drift from what
 * the rule actually tests.
 */
export function describeComparison(comparison: Comparison): string {
  switch (comparison.kind) {
    case "gte": return `>=${comparison.value}`;
    case "gt": return `>${comparison.value}`;
    case "lte": return `<=${comparison.value}`;
    case "lt": return `<${comparison.value}`;
    case "range": return `${comparison.low}..${comparison.high}`;
  }
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
