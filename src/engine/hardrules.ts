// Deterministic rules, evaluated before the classifier. See docs/adr/004.
//
// The judge decides the ambiguous middle; the edges are code. `gate.fast_path` is the
// other edge — a command obviously safe enough not to be judged — and this is its
// symmetric twin: a command obviously not safe enough to be judged.
//
// Pure and synchronous, like the rest of the engine. Every predicate is a string operation
// over one command line, so a hard-rule hit is strictly cheaper than the classifier call it
// replaces, not an addition to it.
//
// The rule for what belongs in `gate.hard_rules` is the rule for `gate.fast_path`, with
// the sign flipped: an entry is judged on whether *every* command it can match deserves
// its verdict, never on whether the command the author had in mind does. Each predicate
// here exists because some near-miss pair in fixtures/gate.jsonl needs it — see the table
// in ADR-004, and the tests, which sweep the whole fixture file.

import { describeSensitivity } from "./state.js";
import { redact } from "./redact.js";
import type { HardRule } from "./types.js";

/**
 * The first entry whose `when` holds, or undefined.
 *
 * Order is the policy file's order, and the first match wins, exactly as `gate.rules`
 * works. Entries are not scored against each other.
 */
export function matchHardRule(rules: readonly HardRule[], command: string): HardRule | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0 || rules.length === 0) return undefined;

  // Computed once and shared: a policy with a dozen entries would otherwise tokenize and
  // redact the same command a dozen times, in the hook's latency path.
  const facts = factsFor(trimmed);

  for (const rule of rules) {
    if (holds(rule, facts)) return rule;
  }

  return undefined;
}

interface CommandFacts {
  readonly tokens: readonly string[];
  readonly lower: string;
  /** Sensitivity labels carried by any token that reads as a path. */
  readonly pathLabels: ReadonlySet<string>;
  /** Redaction kinds the command's text matches. */
  readonly redactionKinds: ReadonlySet<string>;
}

function factsFor(command: string): CommandFacts {
  const tokens = tokenize(command);

  const pathLabels = new Set<string>();
  for (const token of tokens) {
    for (const candidate of pathsIn(token)) {
      const label = describeSensitivity(candidate);
      if (label !== undefined) pathLabels.add(label);
    }
  }

  return {
    tokens,
    lower: command.toLowerCase(),
    pathLabels,
    // The redactor is the project's one tested table of credential shapes. Reusing it
    // means `redacts_as` cannot drift from what redaction actually recognises, and a shape
    // added there is a shape the hard rule catches on the same day.
    redactionKinds: new Set(redact(command).kinds),
  };
}

/**
 * Every predicate present must hold, and at least one must be present.
 *
 * An entry whose `when` is empty matches nothing rather than everything. A policy file
 * with a typo'd predicate name would otherwise turn into "ask on every command", which is
 * the failure mode CLAUDE.md names; the loader rejects it as an error too, and this is the
 * second line of that defence.
 */
function holds(rule: HardRule, facts: CommandFacts): boolean {
  const { when } = rule;
  let asserted = false;

  if (when.firstToken !== undefined) {
    asserted = true;
    if (!when.firstToken.includes(facts.tokens[0] ?? "")) return false;
  }

  if (when.tokens !== undefined) {
    asserted = true;
    if (!when.tokens.every((t) => facts.tokens.includes(t))) return false;
  }

  if (when.text !== undefined) {
    asserted = true;
    if (!when.text.some((t) => facts.lower.includes(t.toLowerCase()))) return false;
  }

  if (when.pathLabelled !== undefined) {
    asserted = true;
    if (!when.pathLabelled.some((label) => facts.pathLabels.has(label))) return false;
  }

  if (when.redactsAs !== undefined) {
    asserted = true;
    if (!when.redactsAs.some((kind) => facts.redactionKinds.has(kind))) return false;
  }

  // Checked last and never on its own: an entry that only says what it excludes would
  // match every command that merely lacks those tokens.
  if (when.notTokens !== undefined && when.notTokens.some((t) => facts.tokens.includes(t))) {
    return false;
  }

  return asserted;
}

/**
 * Whitespace split, except that a quoted run is one token.
 *
 * Quoting matters in both directions. `psql -c 'DROP TABLE users'` must not turn `DROP`
 * into a token that some other entry matches on, and `git commit -m 'show the diff'` must
 * not produce a `show` token that the git-show entry would accept. SQL inside such a token
 * is reached by the `text` predicate instead, which is exactly why that predicate exists.
 *
 * This is not a shell parser and does not try to be. It does not expand variables, resolve
 * redirections or split on operators, and a command that defeats it reaches the classifier
 * as it would have anyway — which is the safe direction for a miss.
 */
function tokenize(command: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (token.length > 0) out.push(token);
  }

  return out;
}

/**
 * The path-shaped readings of one token.
 *
 * A token is not always a bare path. `~/.ssh/id_ed25519` needs its tilde stripped, because
 * expansion is the shell's job and the label table takes a path. And git spells a path
 * inside a revision as `HEAD:.env`, so `git show HEAD:.env` would otherwise carry no
 * labelled token at all — which is how this function came to exist: the near-miss table in
 * test/hardrules.test.ts caught it, having been written before the code.
 *
 * Returning several candidates rather than picking one keeps this from having to decide
 * what a token "really is". A reading that labels nothing costs a failed regex.
 */
function pathsIn(token: string): string[] {
  const candidates = [token.startsWith("~/") ? token.slice(2) : token];

  const colon = token.lastIndexOf(":");
  if (colon > 0 && colon < token.length - 1) {
    candidates.push(token.slice(colon + 1));
  }

  return candidates;
}
