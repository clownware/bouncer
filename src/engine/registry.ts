// Building the skill registry: raw records in, the router's option list out.
//
// Pure and synchronous, like the rest of `src/engine/`. Everything that touches the disk
// lives in `src/io/skills.ts`, which finds candidate skills and reads their bytes, then
// hands them here. That split is what makes the interesting part — precedence, dedupe,
// namespacing — a table test rather than a fixture tree.
//
// Why this module exists at all, and why it is held to a correctness standard rather than
// a best-effort one: a `choice` question cannot abstain. When the right option is missing
// from the registry, the classifier's distribution renormalises over what it was offered
// and the best of a bad set comes back looking certain — measured at 0.65 against 0.16 for
// a skill that simply was not in the list. Every guard in the router's design passed on a
// wrong answer. A short registry does not make the router quieter; it makes it confidently
// wrong. See docs/adr/006.

import { parse as parseYaml } from "yaml";

/** One option the router may suggest. */
export interface Skill {
  /**
   * The name the model actually sees, and therefore the only name worth suggesting:
   * `marketing:brand-review`, `anthropic-skills:docs`, or a bare `init` for a user or
   * project skill. A suggestion naming `brand-review` names nothing Claude knows about.
   */
  readonly qualifiedName: string;
  readonly description: string;
  /** Where it came from, for `bouncer skills` and for diagnosing a short registry. */
  readonly origin: SkillOrigin;
}

export type SkillOrigin = "project" | "user" | "plugin" | "synced-skill";

/**
 * Precedence when the same qualified name appears twice. Nearest to the user wins, which
 * matches how `resolvePolicy` picks a policy file — a project's copy of a skill is the one
 * that will actually load.
 */
const PRECEDENCE: Readonly<Record<SkillOrigin, number>> = {
  project: 0,
  user: 1,
  plugin: 2,
  "synced-skill": 3,
};

/**
 * A candidate found on disk, before validation.
 *
 * `description` is set when a manifest already carried it, which is the common case and
 * the reason this module prefers manifests: the synced-skills manifest lists every name
 * and description inline, so nothing has to be parsed out of a hundred `SKILL.md` files.
 * `frontmatter` is the fallback for plugin skills, whose manifests describe the plugin
 * rather than its skills.
 */
export interface RawSkill {
  readonly namespace?: string;
  readonly dirName: string;
  readonly origin: SkillOrigin;
  readonly description?: string;
  /** Raw `SKILL.md` text, read only when a manifest did not supply the description. */
  readonly frontmatter?: string;
}

export interface Registry {
  readonly skills: readonly Skill[];
  /**
   * Stable identifier for exactly this option set.
   *
   * Every observe-mode record carries it. Without it, replaying a logged prompt after
   * discovery changed is a different experiment reported as the same one — and discovery
   * is expected to change, which is the whole point of this module existing.
   */
  readonly fingerprint: string;
  /** Names dropped as duplicates, for `bouncer skills`. Not an error; worth seeing. */
  readonly duplicates: readonly string[];
}

/** Longer than this and a description is padding out the question for no gain. */
export const MAX_DESCRIPTION_CHARS = 200;

/**
 * Applies precedence, drops unusable candidates, truncates descriptions, sorts.
 *
 * Sorting is not cosmetic. The fingerprint is computed from the ordered list, so two runs
 * that found the same skills in a different directory order have to agree.
 */
export function buildRegistry(raw: readonly RawSkill[]): Registry {
  const best = new Map<string, { skill: Skill; precedence: number }>();
  const duplicates: string[] = [];

  for (const candidate of raw) {
    const description = descriptionOf(candidate);
    // A skill with no readable description is not a usable option: its description *is*
    // the criteria text the classifier reasons over. Dropping it is right, and it shows
    // up in `bouncer skills` as a count rather than vanishing.
    if (description === undefined) continue;

    const qualifiedName = qualify(candidate);
    if (qualifiedName === undefined) continue;

    const precedence = PRECEDENCE[candidate.origin];
    const existing = best.get(qualifiedName);

    if (existing !== undefined) {
      duplicates.push(qualifiedName);
      if (existing.precedence <= precedence) continue;
    }

    best.set(qualifiedName, {
      precedence,
      skill: { qualifiedName, description: truncate(description), origin: candidate.origin },
    });
  }

  const skills = [...best.values()]
    .map((entry) => entry.skill)
    .sort((a, b) => (a.qualifiedName < b.qualifiedName ? -1 : a.qualifiedName > b.qualifiedName ? 1 : 0));

  return { skills, fingerprint: fingerprintOf(skills), duplicates: [...new Set(duplicates)].sort() };
}

/**
 * The criteria map for the router's `which_skill` choice question.
 *
 * Keys are what comes back as the answer, which is why they are the qualified names.
 */
export function criteriaFor(registry: Registry): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const skill of registry.skills) criteria[skill.qualifiedName] = skill.description;
  return criteria;
}

/**
 * Reads `name` and `description` out of a `SKILL.md`.
 *
 * Parsed as YAML rather than matched with a regex, deliberately. Real descriptions in the
 * wild are single-quoted, span lines, and contain escaped quotes and colons; a regex gets
 * those wrong quietly, and a wrong description is a mis-routed skill. The `yaml` parser is
 * already in the bundle for the policy file and costs about 2 ms (ADR-002), so this is
 * free.
 */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return {};

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    // Malformed frontmatter means this skill is skipped, never that discovery fails.
    return {};
  }

  if (!isRecord(parsed)) return {};
  return {
    ...(typeof parsed["name"] === "string" ? { name: parsed["name"] } : {}),
    ...(typeof parsed["description"] === "string" ? { description: parsed["description"] } : {}),
  };
}

export interface PluginEntry {
  readonly name: string;
  readonly installationPreference?: string;
}

/**
 * Plugin records from a synced or installed plugin manifest.
 *
 * The manifest is read instead of walking directories because a walk finds every cached
 * version and every marketplace clone of the same plugin — 108 `SKILL.md` files for 42
 * distinct skills on one machine surveyed. Duplicate options split probability mass
 * between identical entries and depress the margin, which reads as uncertainty rather than
 * as the bug it is. The manifest names one live entry per plugin, which removes the
 * problem at its source rather than patching it afterwards.
 */
export function parsePluginManifest(json: string): readonly PluginEntry[] {
  const plugins = arrayUnder(json, "plugins");
  const entries: PluginEntry[] = [];

  for (const value of plugins) {
    if (!isRecord(value)) continue;
    const name = value["name"];
    if (typeof name !== "string" || name.length === 0) continue;
    const preference = value["installationPreference"];
    entries.push({
      name,
      ...(typeof preference === "string" ? { installationPreference: preference } : {}),
    });
  }

  return entries;
}

export interface ManifestSkill {
  readonly name: string;
  readonly description: string;
}

/**
 * Skills from a synced-skills manifest, which carries names and descriptions inline.
 *
 * This is the cheap path: one file read covers the whole bucket, and no `SKILL.md` is
 * opened at all.
 */
export function parseSkillsManifest(json: string): readonly ManifestSkill[] {
  const skills = arrayUnder(json, "skills");
  const entries: ManifestSkill[] = [];

  for (const value of skills) {
    if (!isRecord(value)) continue;
    const name = value["name"] ?? value["skillId"];
    const description = value["description"];
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof description !== "string" || description.length === 0) continue;
    entries.push({ name, description });
  }

  return entries;
}

/**
 * Whether a plugin the manifest lists should contribute its skills.
 *
 * On every machine surveyed so far each listed plugin carried `installationPreference:
 * "available"` and every one of them was live in the session, so `available` is read as
 * enabled. Anything explicitly disabled is excluded; an unrecognised value is included,
 * because the failure modes are not symmetric — wrongly excluding a plugin produces the
 * confidently-wrong suggestion this module exists to prevent, while wrongly including one
 * costs a few option tokens and a suggestion the user can ignore.
 */
export function pluginIsActive(entry: PluginEntry): boolean {
  const preference = entry.installationPreference?.toLowerCase();
  return preference !== "disabled" && preference !== "uninstalled" && preference !== "none";
}

function descriptionOf(candidate: RawSkill): string | undefined {
  if (candidate.description !== undefined && candidate.description.trim().length > 0) {
    return candidate.description.trim();
  }
  if (candidate.frontmatter === undefined) return undefined;

  const parsed = parseFrontmatter(candidate.frontmatter);
  const description = parsed.description?.trim();
  return description !== undefined && description.length > 0 ? description : undefined;
}

/**
 * The name the model sees.
 *
 * Plugin and synced skills are namespaced; user and project skills are not. Getting this
 * wrong is silent: `brand-review` is a perfectly well-formed string that refers to nothing.
 */
function qualify(candidate: RawSkill): string | undefined {
  const bare = candidate.dirName.trim();
  if (bare.length === 0) return undefined;
  if (candidate.namespace === undefined || candidate.namespace.length === 0) return bare;
  return `${candidate.namespace}:${bare}`;
}

function truncate(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_DESCRIPTION_CHARS) return collapsed;

  // Prefer a sentence boundary, but only a late one: cutting "docs (living docs people
  // share, comment on and edit; use only when..." at its first period would keep three
  // words. Falling back to a hard cut is better than keeping almost nothing.
  const head = collapsed.slice(0, MAX_DESCRIPTION_CHARS);
  const stop = head.lastIndexOf(". ");
  if (stop >= MAX_DESCRIPTION_CHARS / 2) return head.slice(0, stop + 1);
  return `${head.trimEnd()}…`;
}

/**
 * A short, stable digest of the ordered option set.
 *
 * FNV-1a, not a crypto hash: this identifies a configuration, it does not protect one, and
 * `node:crypto` is an import the hot path does not otherwise need (ADR-002).
 */
function fingerprintOf(skills: readonly Skill[]): string {
  let hash = 0x811c9dc5;
  for (const skill of skills) {
    for (const char of `${skill.qualifiedName}\u0000`) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${skills.length}-${hash.toString(16).padStart(8, "0")}`;
}

function arrayUnder(json: string, key: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const value = parsed[key];
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
