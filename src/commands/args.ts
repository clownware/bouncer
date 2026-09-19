// One argv reader for the commands that take flags.
//
// Each command used to read its own, and each dropped what it did not recognise. A flag that
// does not exist (`--policy`, before it did) and a typo (`--backned mock`) both ran as if
// they had not been typed — and with a key in the environment the second one is a live,
// billed run against a classifier the user did not mean to call. So nothing here is
// skipped: a token is a flag this command declares, a positional it declares, or an error
// naming the token and listing what would have been accepted.

export interface FlagSpec {
  /** Flags followed by a value: `--backend mock` or `--backend=mock`. */
  readonly values: readonly string[];
  /** Flags that are present or absent: `--json`. */
  readonly switches: readonly string[];
  /** How many bare words the command takes. Zero unless stated. */
  readonly positionals?: number;
}

export interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
  readonly positionals: readonly string[];
  /** The first thing wrong with the argv, as a line to print. Nothing else is trustworthy when set. */
  readonly error?: string;
}

export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  const fail = (message: string): ParsedFlags => ({ values, switches, positionals, error: `${message}\n${accepted(spec)}\n` });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (!token.startsWith("-") || token === "-") {
      if (positionals.length >= (spec.positionals ?? 0)) return fail(`Unexpected argument "${token}".`);
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const long = token.startsWith("--");

    if (long && spec.switches.includes(name)) {
      if (eq !== -1) return fail(`--${name} does not take a value.`);
      switches.add(name);
      continue;
    }

    if (long && spec.values.includes(name)) {
      // A following flag is not a value: `--out --json` is a forgotten path, and reading
      // `--json` as the path would write a file of that name and leave JSON output off.
      const value = eq !== -1 ? token.slice(eq + 1) : argv[i + 1];
      if (value === undefined || value.length === 0 || (eq === -1 && value.startsWith("--"))) {
        return fail(`--${name} needs a value.`);
      }
      values.set(name, value);
      if (eq === -1) i += 1;
      continue;
    }

    return fail(`Unknown flag "${token}".`);
  }

  return { values, switches, positionals };
}

/** A whole number of at least one, or an error line. `--concurrency abc` used to be dropped. */
export function positiveInteger(name: string, raw: string | undefined): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return { error: `--${name} needs a whole number of at least 1, not "${raw}".\n` };
  return { value };
}

function accepted(spec: FlagSpec): string {
  const flags = [...spec.values.map((v) => `--${v} <value>`), ...spec.switches.map((s) => `--${s}`)];
  return `Flags: ${flags.join(", ")}.`;
}
