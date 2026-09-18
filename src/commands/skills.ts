// `bouncer skills` — what the router would offer the classifier, and where it came from.
//
// This exists because discovery cannot be verified from inside this repository. Skills
// live in at least three different layouts and the desktop app's is undocumented, so the
// only way to know a registry is complete on a given machine is to build it there and
// look. The acceptance test for discovery is a sentence a person can check in one command:
// on a machine with the desktop app running, this listing contains
// `marketing:brand-review`.
//
// It also prints the fingerprint, because that is what observe-mode records carry, and a
// registry that changed between two runs is the difference between a replay and a
// different experiment.

import { criteriaFor } from "../engine/registry.js";
import { discoverSkills, signatureOf } from "../io/skills.js";

export interface SkillsOptions {
  /** Print the choice-question criteria map as JSON instead of the human listing. */
  readonly json: boolean;
  /** Print every skill rather than a count per origin. */
  readonly verbose: boolean;
}

export function parseArgs(argv: readonly string[]): SkillsOptions {
  return { json: argv.includes("--json"), verbose: argv.includes("--verbose") || argv.includes("-v") };
}

export function skills(options: SkillsOptions, cwd = process.cwd()): string {
  const discovery = discoverSkills(cwd);
  const { registry } = discovery;

  if (options.json) {
    return `${JSON.stringify({ fingerprint: registry.fingerprint, criteria: criteriaFor(registry) }, null, 2)}\n`;
  }

  const lines: string[] = [];
  lines.push(`${registry.skills.length} skill${registry.skills.length === 1 ? "" : "s"} · fingerprint ${registry.fingerprint}`);
  lines.push("");

  const byOrigin = new Map<string, number>();
  for (const skill of registry.skills) {
    byOrigin.set(skill.origin, (byOrigin.get(skill.origin) ?? 0) + 1);
  }

  lines.push("Where they came from:");
  for (const root of discovery.roots) {
    lines.push(`  ${String(root.found).padStart(4)}  ${root.path}`);
  }
  if (discovery.roots.length === 0) {
    lines.push("  none — no skills directory or manifest was found anywhere.");
  }

  lines.push("");
  lines.push(`By origin: ${[...byOrigin.entries()].map(([o, n]) => `${o} ${n}`).join(", ") || "none"}`);

  if (registry.duplicates.length > 0) {
    // Not an error. A name found twice is normally the same skill reached by two routes,
    // and precedence already picked one. It is printed because a long list here means
    // discovery is reading a tree it should be reading a manifest for.
    lines.push(
      `Resolved ${registry.duplicates.length} duplicate name${registry.duplicates.length === 1 ? "" : "s"} by precedence: ${registry.duplicates.slice(0, 5).join(", ")}${registry.duplicates.length > 5 ? " …" : ""}`,
    );
  }

  if (options.verbose) {
    lines.push("");
    for (const skill of registry.skills) {
      lines.push(`  ${skill.qualifiedName}`);
      lines.push(`      ${skill.description}`);
    }
  } else if (registry.skills.length > 0) {
    lines.push("");
    lines.push("Names the router could suggest:");
    lines.push(...wrap(registry.skills.map((s) => s.qualifiedName)));
    lines.push("");
    lines.push("Run with --verbose for descriptions, or --json for the criteria map.");
  }

  lines.push("");
  lines.push(
    registry.skills.length === 0
      ? "An empty registry means the router would never suggest anything. That is safe, and it is also useless — see docs/adr/006."
      : "A missing skill here is worse than a short list: the classifier renormalises over what it is offered, so an absent option becomes a confident wrong pick.",
  );

  // Cheap to compute and the thing a cache would key on, so it is worth being able to see.
  lines.push("");
  lines.push(`Sources signature: ${shorten(signatureOf(discovery.sources))}`);

  return `${lines.join("\n")}\n`;
}

function wrap(names: readonly string[], width = 92): string[] {
  const lines: string[] = [];
  let current = " ";

  for (const name of names) {
    if (current.length + name.length + 2 > width) {
      lines.push(current);
      current = " ";
    }
    current += ` ${name}`;
  }
  if (current.trim().length > 0) lines.push(current);

  return lines;
}

function shorten(signature: string): string {
  return signature.length <= 120 ? signature : `${signature.slice(0, 117)}…`;
}
