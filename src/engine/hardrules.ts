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

  // Entries in order, and for each entry every command in the chain: the first entry that
  // any one command satisfies wins, which keeps the policy file's order meaning what it did.
  for (const rule of rules) {
    if (facts.some((f) => holds(rule, f))) return rule;
  }

  return undefined;
}

/**
 * What is known about ONE command in a chain.
 *
 * A predicate used to be read over the whole string, which got two things wrong in opposite
 * directions. `first_token` saw only the first word typed, so `git status; cat .env` and
 * `sudo cat .env` both got past an entry written for `cat`. And `tokens`, `not_tokens` and
 * `path_labelled` saw every command at once, so `cat README.md && ls .env` added up to a
 * credential read, and echo's `-n` excused a `git clean -fdx` sitting next to it.
 *
 * `lower` and `redactionKinds` stay whole-string on purpose: `text` exists to see inside a
 * quoted argument, and a credential is a credential wherever in the chain it sits.
 */
interface CommandFacts {
  /** The verb, found behind anything a shell lets you put in front of it. */
  readonly commandWord: string;
  readonly tokens: readonly string[];
  readonly lower: string;
  /** Sensitivity labels carried by any token that reads as a path. */
  readonly pathLabels: () => ReadonlySet<string>;
  /** Redaction kinds the command's text matches. */
  readonly redactionKinds: () => ReadonlySet<string>;
}

/** Computed on the first ask and kept. A `??=` would recompute a falsy answer. */
function once<T>(compute: () => T): () => T {
  let value: T;
  let done = false;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}

/**
 * The two expensive facts are deferred, and the rest are not.
 *
 * `holds` checks the cheap predicates first and returns on the first that fails, so on a
 * typical call no entry reaches `path_labelled` or `redacts_as` at all. Building both
 * eagerly meant every gated Bash call ran the fourteen-pattern redactor over the command
 * line and resolved every token that looks like a path, whatever the policy asked about.
 * Measured against the 8384ad0 bundle, 50 interleaved cold spawns of instrumented builds:
 * the short-circuit phase cost +0.55 ms more than it used to, and +0.19 ms once these two
 * were deferred.
 *
 * Both are pure functions of the command, so deferring them cannot change a verdict —
 * `test/hardrules.test.ts` sweeps the whole fixture file, which is what says so rather than
 * the argument.
 */
function factsFor(command: string): CommandFacts[] {
  const lower = command.toLowerCase();
  // The redactor is the project's one tested table of credential shapes. Reusing it
  // means `redacts_as` cannot drift from what redaction actually recognises, and a shape
  // added there is a shape the hard rule catches on the same day.
  //
  // Whole-string, so it is memoised across the chain rather than per command.
  const redactionKinds = once(() => new Set(redact(command).kinds) as ReadonlySet<string>);

  return commandsIn(command).map((tokens) => ({
    commandWord: commandWordOf(tokens),
    tokens,
    lower,
    pathLabels: once(() => {
      const labels = new Set<string>();
      for (const token of tokens) {
        for (const candidate of pathsIn(token)) {
          const label = describeSensitivity(candidate);
          if (label !== undefined) labels.add(label);
        }
      }
      return labels as ReadonlySet<string>;
    }),
    redactionKinds,
  }));
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
    if (!when.firstToken.includes(facts.commandWord)) return false;
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
    const labels = facts.pathLabels();
    if (!when.pathLabelled.some((label) => labels.has(label))) return false;
  }

  if (when.redactsAs !== undefined) {
    asserted = true;
    const kinds = facts.redactionKinds();
    if (!when.redactsAs.some((kind) => kinds.has(kind))) return false;
  }

  // Checked last and never on its own: an entry that only says what it excludes would
  // match every command that merely lacks those tokens.
  if (when.notTokens !== undefined && when.notTokens.some((t) => facts.tokens.includes(t))) {
    return false;
  }

  return asserted;
}

/** What separates one command from the next. Never looked for inside a quoted token. */
const OPERATOR = /(&&|\|\||;|\|)/;

/**
 * The token lists of each command in a chain: a whitespace split in which a quoted run is
 * one token, cut into commands at `&&`, `||`, `;`, `|`, a lone `&` and newlines.
 *
 * Quoting matters in both directions. `psql -c 'DROP TABLE users'` must not turn `DROP`
 * into a token that some other entry matches on, and `git commit -m 'show the diff'` must
 * not produce a `show` token that the git-show entry would accept. SQL inside such a token
 * is reached by the `text` predicate instead, which is exactly why that predicate exists.
 * For the same reason only an unquoted token is searched for an operator, so
 * `-m 'tidy; cat .env'` stays one token of one command. `2>&1` is left alone: it holds a
 * single `&`, which is only an operator when it stands as a token by itself.
 *
 * This is not a shell parser and does not try to be. It does not expand variables, resolve
 * redirections or follow a heredoc, and a command that defeats it reaches the classifier as
 * it would have anyway — which is the safe direction for a miss.
 */
function commandsIn(command: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  const end = (): void => {
    if (current.length > 0) commands.push(current);
    current = [];
  };

  for (const line of command.split("\n")) {
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const quoted = match[1] ?? match[2];
      if (quoted !== undefined) {
        if (quoted.length > 0) current.push(quoted);
        continue;
      }

      for (const piece of (match[3] ?? "").split(OPERATOR)) {
        if (piece.length === 0) continue;
        if (OPERATOR.test(piece) || piece === "&") {
          end();
          continue;
        }
        current.push(piece);
        // `-df` is `-d -f`, so it counts as both as well as itself. Otherwise an entry has
        // to list every order of every bundle, and `git clean -fdn` — a dry run — prompts.
        // A long option written with one dash (`find -delete`) gets letters it does not
        // mean; an entry also names its command, which is what keeps that harmless.
        if (/^-[A-Za-z]{2,}$/.test(piece)) {
          for (const letter of piece.slice(1)) current.push(`-${letter}`);
        }
      }
    }
    end();
  }

  return commands;
}

/** Words that run the command after them, and so are not the command. */
const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "env", "time", "nohup", "nice"]);

/**
 * The verb of one command: past any `NAME=value` in front of it, past a wrapper and the
 * wrapper's own flags, with the directory and an alias-skipping backslash taken off.
 *
 * `sudo -u root cat .env` still gets past this — `root` reads as the verb, because knowing
 * it is not would mean knowing every wrapper's flags. That falls to the classifier, like
 * anything else this file does not understand.
 */
function commandWordOf(tokens: readonly string[]): string {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i += 1;
    } else if (WRAPPERS.has(token)) {
      i += 1;
      while (i < tokens.length && (tokens[i] as string).startsWith("-")) i += 1;
    } else {
      break;
    }
  }

  const word = (tokens[i] ?? "").replace(/^\\/, "");
  return word.slice(word.lastIndexOf("/") + 1);
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
  // `cat <.env` writes the redirect against the path, and it is still the path.
  const bare = token.replace(/^[<>]+/, "");
  const candidates = [bare.startsWith("~/") ? bare.slice(2) : bare];

  const colon = token.lastIndexOf(":");
  if (colon > 0 && colon < token.length - 1) {
    candidates.push(token.slice(colon + 1));
  }

  return candidates;
}
