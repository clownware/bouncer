// Redaction of secret-shaped text before anything leaves the machine.
//
// The gate asks whether a command exposes a credential. That question is answerable from
// the *shape* of the command — `echo $OPENAI_API_KEY`, `cat .env` — and never needs the
// value. So values are replaced before the state is built, and the classifier is asked
// about `[REDACTED:openai-key]` rather than the key itself.
//
// This is shape matching, not secret detection. It cannot recognise a credential that
// looks like ordinary text, and it is not the reason the design is safe — not sending
// file contents or diffs at all is. Treat it as defence in depth over the command line,
// which is the one place a literal secret plausibly appears.

export interface RedactionResult {
  readonly text: string;
  /** Kinds redacted, in first-seen order. Safe to log; the values are not. */
  readonly kinds: readonly string[];
}

interface Pattern {
  readonly kind: string;
  readonly re: RegExp;
}

// Ordered most specific first: a GitHub token would also match the generic long-hex rule,
// and the specific label is more useful both to the classifier and in the log.
const PATTERNS: readonly Pattern[] = [
  { kind: "private-key", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  // Anthropic before OpenAI: `sk-ant-…` also satisfies the OpenAI shape, so whichever
  // runs first wins the label. Ordering it first is the whole fix — the alternative,
  // excluding `ant-` from the OpenAI pattern, does not work, because the trailing
  // character class matches `ant-…` anyway.
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "stripe-key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "onepassword-ref", re: /\bop:\/\/[^\s"']+/g },
  { kind: "bearer-token", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g },
  // A URL carrying credentials in the authority, e.g. postgres://user:pw@host/db.
  // Only the password is replaced; the scheme and host are what the `prod` and `egress`
  // questions actually need to see.
  { kind: "url-credentials", re: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/g },
  // An inline assignment to something named like a secret: FOO_TOKEN=..., --password=...
  //
  // Each part of this has been wrong once.
  //
  // The name. Anything in front of the keyword is optional: it used to be required, so
  // `PASSWORD=`, `TOKEN=`, `API_KEY=` and `--password=` — the example in the line above —
  // never matched, and their values went to the classifier and the log in clear. After the
  // keyword comes the end of the name, a plural, digits, or a separator and the rest, so
  // `SECRET_KEY_BASE` and `TOKEN2` are names and `TOKENIZER` is a word.
  //
  // The value is skipped when a pattern above already redacted it. This one runs last, and
  // used to redact the marker: `STRIPE_SECRET_KEY=sk_live_…` came out as `assigned-secret`,
  // so naming a variable like a secret erased what kind of secret it held — against the
  // ordering comment at the top of this table.
  //
  // It is also skipped when it is nothing but a reference: `$VAR`, `${VAR}`, either in
  // double quotes, or a `$(command)`. Nothing secret is on the line, and the hard rule that
  // reads this kind tells the user a credential "appears literally". Single quotes make a
  // `$` literal and a value with a literal part beside a reference still has one, so both
  // are still redacted.
  {
    kind: "assigned-secret",
    re: /\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?)S?(?:[_-][A-Za-z0-9_-]*|\d+)?)(\s*=\s*)(?!\s)(?!["']?\[REDACTED:)(?!"?\$\()(?!"?\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)"?(?=[\s;&|)]|$))(?:"[^"]{4,}"|'[^']{4,}'|[^\s;&|)"']{4,})/gi,
  },
];

export function redact(input: string): RedactionResult {
  if (input.length === 0) return { text: input, kinds: [] };

  const kinds: string[] = [];
  const note = (kind: string) => {
    if (!kinds.includes(kind)) kinds.push(kind);
  };

  let text = input;
  for (const { kind, re } of PATTERNS) {
    // Each pattern has the /g flag and is module-level, so lastIndex must be reset —
    // otherwise a second call resumes mid-string and silently misses matches.
    re.lastIndex = 0;
    text = text.replace(re, (...args: unknown[]) => {
      note(kind);
      const groups = args.slice(1, -2) as (string | undefined)[];
      switch (kind) {
        // Keep the part that carries meaning, replace only the credential.
        case "url-credentials":
          return `${groups[0] ?? ""}:[REDACTED:url-credentials]@`;
        case "assigned-secret":
          return `${groups[0] ?? ""}${groups[1] ?? "="}[REDACTED:assigned-secret]`;
        default:
          return `[REDACTED:${kind}]`;
      }
    });
  }

  return { text, kinds };
}

/**
 * True when the text still contains something secret-shaped after redaction.
 *
 * Used as a belt-and-braces check on the log writer: a state that fails this is dropped
 * rather than written, on the grounds that a missing log line is cheaper than a leaked
 * credential in a file the user will later paste into an issue.
 */
export function looksRedacted(text: string): boolean {
  return redact(text).kinds.length === 0;
}
