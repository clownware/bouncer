// Finding the skills the model can actually load.
//
// All the filesystem knowledge lives here so `src/engine/registry.ts` stays pure, the same
// split `config.ts` uses for the policy file. Everything is best-effort: an unreadable
// directory is a smaller registry, never an error, because discovery failing must not be
// why a prompt is slow or a hook misbehaves.
//
// There is no single documented place skills live. Three layouts have been observed:
//
//   1. The documented one — `~/.claude/skills/` and `<project>/.claude/skills/`.
//   2. Remote and web sessions — `~/.claude/{skills,plugins}/synced/<bucket>/`, each
//      bucket carrying a `manifest.json`. Verified by reading them on 2026-09-18.
//   3. The desktop app — `~/Library/Application Support/Claude/local-agent-mode-sessions/`,
//      with `rpm/manifest.json` and `skills-plugin/.../manifest.json`. Surveyed on a macOS
//      machine on 2026-09-18; see the note on that code path below.
//
// On the machine where this was written, layout 1 held 1 skill and layout 2 held 105. A
// discovery that reads only the documented locations misses most of the registry, and a
// missing option is a confidently wrong suggestion rather than a gap. See docs/adr/006.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildRegistry,
  parsePluginManifest,
  parseSkillsManifest,
  pluginIsActive,
  type RawSkill,
  type Registry,
} from "../engine/registry.js";

/**
 * The namespace the CLI gives skills synced from the Anthropic set.
 *
 * It is not written anywhere on disk — the bucket directory is named with opaque UUIDs and
 * the manifest carries bare skill ids — so this is the one name here that is asserted
 * rather than read. It is asserted because the alternative is worse: suggesting a bare
 * `docs` when the model knows `anthropic-skills:docs` names nothing at all.
 */
const SYNCED_SKILL_NAMESPACE = "anthropic-skills";

/** Directories inside `~/.claude/skills` that are containers, not skills. */
const NOT_A_SKILL = new Set(["synced"]);

/** Bounds the desktop-app walk, which is over a tree this repo does not own. */
const MAX_SESSION_DIRS = 64;

export interface Discovery {
  readonly registry: Registry;
  /** Manifests and directories the result depends on, for cache invalidation. */
  readonly sources: readonly string[];
  /** Roots that were looked at, with what each contributed. For `bouncer skills`. */
  readonly roots: readonly { readonly path: string; readonly found: number }[];
}

export function discoverSkills(cwd: string): Discovery {
  const raw: RawSkill[] = [];
  const sources: string[] = [];
  const roots: { path: string; found: number }[] = [];

  const collect = (path: string, gather: () => RawSkill[]): void => {
    if (!existsSync(path)) return;
    const before = raw.length;
    try {
      raw.push(...gather());
    } catch {
      // A permission error on one root is not a reason to have no registry at all.
    }
    roots.push({ path, found: raw.length - before });
    sources.push(path);
  };

  const home = homedir();
  const projectSkills = projectSkillsDir(cwd);

  if (projectSkills !== undefined) {
    collect(projectSkills, () => plainSkillDir(projectSkills, "project"));
  }

  const userSkills = join(home, ".claude", "skills");
  collect(userSkills, () => plainSkillDir(userSkills, "user"));

  for (const bucket of bucketsIn(join(home, ".claude", "skills", "synced"))) {
    const manifest = join(bucket, "manifest.json");
    collect(manifest, () => syncedSkills(manifest));
  }

  for (const bucket of bucketsIn(join(home, ".claude", "plugins", "synced"))) {
    const manifest = join(bucket, "manifest.json");
    collect(manifest, () => pluginSkills(manifest, bucket, (name) => join(bucket, name, "skills")));
  }

  const installed = join(home, ".claude", "plugins", "installed_plugins.json");
  collect(installed, () => installedPluginSkills(installed));

  for (const manifest of desktopManifests(home)) {
    collect(manifest.path, manifest.gather);
  }

  return { registry: buildRegistry(raw), sources, roots };
}

/**
 * `<name>/SKILL.md` under a directory, the documented layout.
 *
 * `synced` is skipped: it sits inside `~/.claude/skills` and is a container of buckets, so
 * a naive walk would offer the model a skill called `synced`.
 */
function plainSkillDir(dir: string, origin: "project" | "user"): RawSkill[] {
  const skills: RawSkill[] = [];

  for (const name of directoriesIn(dir)) {
    if (NOT_A_SKILL.has(name)) continue;
    const frontmatter = read(join(dir, name, "SKILL.md"));
    if (frontmatter === undefined) continue;
    skills.push({ dirName: name, origin, frontmatter });
  }

  return skills;
}

/** A synced-skills bucket: one manifest carries every name and description inline. */
function syncedSkills(manifest: string): RawSkill[] {
  const json = read(manifest);
  if (json === undefined) return [];

  return parseSkillsManifest(json).map((skill) => ({
    namespace: SYNCED_SKILL_NAMESPACE,
    dirName: skill.name,
    origin: "synced-skill" as const,
    description: skill.description,
  }));
}

/**
 * Plugin skills, named by a manifest and read from the one live path per plugin.
 *
 * The manifest describes the plugin, not its skills, so each skill's description still
 * comes from its own `SKILL.md`. What the manifest buys is knowing *which* directories to
 * open — a walk of the tree instead finds every cached version and marketplace clone.
 */
function pluginSkills(
  manifest: string,
  _bucket: string,
  skillsDirFor: (pluginName: string) => string,
): RawSkill[] {
  const json = read(manifest);
  if (json === undefined) return [];

  const skills: RawSkill[] = [];

  for (const plugin of parsePluginManifest(json)) {
    if (!pluginIsActive(plugin)) continue;

    const dir = skillsDirFor(plugin.name);
    for (const name of directoriesIn(dir)) {
      const frontmatter = read(join(dir, name, "SKILL.md"));
      if (frontmatter === undefined) continue;
      skills.push({ namespace: plugin.name, dirName: name, origin: "plugin", frontmatter });
    }
  }

  return skills;
}

/**
 * CLI-installed plugins, which record an `installPath` per version.
 *
 * Unverified: no machine available to this repo has this file, so its shape comes from a
 * survey rather than from a file read. It is handled defensively and contributes nothing
 * when absent or shaped differently than expected — which is the right failure, since the
 * layouts above already cover the machines that have been looked at. Replace this with a
 * recorded fixture the first time one turns up.
 */
function installedPluginSkills(file: string): RawSkill[] {
  const json = read(file);
  if (json === undefined) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const skills: RawSkill[] = [];
  const entries = Array.isArray((parsed as Record<string, unknown>)["plugins"])
    ? ((parsed as Record<string, unknown>)["plugins"] as unknown[])
    : Object.values(parsed as Record<string, unknown>);

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    const installPath = record["installPath"];
    if (typeof name !== "string" || typeof installPath !== "string") continue;
    if (!pluginIsActive({ name, ...preferenceOf(record) })) continue;

    const dir = join(installPath, "skills");
    for (const skillName of directoriesIn(dir)) {
      const frontmatter = read(join(dir, skillName, "SKILL.md"));
      if (frontmatter === undefined) continue;
      skills.push({ namespace: name, dirName: skillName, origin: "plugin", frontmatter });
    }
  }

  return skills;
}

/**
 * The desktop app's own tree.
 *
 * Undocumented, macOS-specific, and not passed on argv or in the environment, so this is a
 * private layout read over the application's shoulder. It is included because leaving it
 * out costs about sixty percent of the registry on a desktop machine, and a short registry
 * is a wrong answer rather than a quiet one. It is bounded, wrapped, and contributes
 * nothing anywhere else — a CLI-only or non-macOS user simply gets a smaller registry, so
 * the degradation is the router being quieter rather than confidently wrong.
 *
 * Unverified from this repo: no macOS machine is available here, so the paths come from a
 * survey and the fixture under `test/fixtures/skills/desktop/` is reconstructed from that
 * description rather than recorded. `bouncer skills` exists so the shape can be confirmed
 * on a real machine in one command.
 */
function desktopManifests(home: string): { path: string; gather: () => RawSkill[] }[] {
  const root = join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions");
  if (!existsSync(root)) return [];

  const found: { path: string; gather: () => RawSkill[] }[] = [];
  let visited = 0;

  for (const outer of directoriesIn(root)) {
    for (const inner of directoriesIn(join(root, outer))) {
      if (++visited > MAX_SESSION_DIRS) return found;
      const session = join(root, outer, inner);

      const rpm = join(session, "rpm", "manifest.json");
      if (existsSync(rpm)) {
        found.push({
          path: rpm,
          gather: () =>
            pluginSkills(rpm, session, (name) => join(session, "rpm", `plugin_${name}`, "skills")),
        });
      }

      for (const bucket of nestedBuckets(join(session, "skills-plugin"))) {
        const manifest = join(bucket, "manifest.json");
        if (existsSync(manifest)) found.push({ path: manifest, gather: () => syncedSkills(manifest) });
      }
    }
  }

  return found;
}

/** `<dir>/<bucket>/` — one level of opaque ids. */
function bucketsIn(dir: string): string[] {
  return directoriesIn(dir).map((name) => join(dir, name));
}

/** `<dir>/<id>/<id>/` — the doubled-id shape the desktop tree uses. */
function nestedBuckets(dir: string): string[] {
  const buckets: string[] = [];
  for (const outer of directoriesIn(dir)) {
    for (const inner of directoriesIn(join(dir, outer))) {
      buckets.push(join(dir, outer, inner));
    }
  }
  return buckets;
}

function directoriesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function preferenceOf(record: Record<string, unknown>): { installationPreference?: string } {
  const preference = record["installationPreference"] ?? record["installation_preference"];
  return typeof preference === "string" ? { installationPreference: preference } : {};
}

/**
 * A signature over the manifests a registry was built from.
 *
 * The cache is keyed on this rather than on the skills directories' mtimes: three manifest
 * files stand in for roughly 170 skill files, so watching them is both cheaper and more
 * precise than watching a tree. This is what makes ADR-002's "cache nothing" finding not
 * transfer — that was one file parsed in 2 ms, and this is a hundred file reads.
 */
export function signatureOf(sources: readonly string[]): string {
  const parts: string[] = [];
  for (const source of sources) {
    try {
      const stat = statSync(source);
      parts.push(`${source}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${source}:absent`);
    }
  }
  return parts.join("|");
}

function projectSkillsDir(cwd: string): string | undefined {
  const root = findRepoRoot(cwd);
  return root === undefined ? undefined : join(root, ".claude", "skills");
}

/** Walks up for a `.git`, the same way `config.ts` finds a repo policy. */
function findRepoRoot(from: string): string | undefined {
  let current = from;
  for (let depth = 0; depth < 32; depth++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Where a cached registry lives, under the same data directory as the log. */
const CACHE_FILE = "skills-cache.json";

/**
 * Discovery, reusing a cached result while the manifests it was built from are unchanged.
 *
 * Measured on this repository's development machine, 69 skills across 3 manifests and
 * about 50 `SKILL.md` reads: a cold discovery costs ~27 ms on top of ~43 ms of process
 * startup. Against the 80 ms hook budget (ADR-002) that is not an optimisation, it is the
 * difference between fitting and not — which is why the cache ships with discovery rather
 * than after it.
 *
 * ADR-002 found that caching the parsed policy bought nothing and cost a staleness bug.
 * That finding does not transfer: it was one file parsed in 2 ms, and this is a hundred
 * file reads. The staleness risk is handled by keying on the manifests rather than on a
 * timestamp — a bucket that gains a plugin changes its manifest, and a skills directory
 * that gains a skill changes its mtime, so both invalidate.
 *
 * Every failure here falls through to a fresh discovery. A cache that cannot be read or
 * written costs latency, never correctness.
 */
export function cachedDiscovery(cwd: string, dir: string): Discovery {
  const file = join(dir, CACHE_FILE);
  const fresh = (): Discovery => {
    const discovery = discoverSkills(cwd);
    writeCache(file, cwd, discovery);
    return discovery;
  };

  let cached: unknown;
  try {
    cached = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fresh();
  }

  if (typeof cached !== "object" || cached === null) return fresh();
  const record = cached as Record<string, unknown>;

  // The cwd is part of the key because project skills take precedence over user ones, so
  // the same machine legitimately has a different registry in a different repository.
  if (record["cwd"] !== cwd) return fresh();

  const sources = Array.isArray(record["sources"]) ? (record["sources"] as string[]) : undefined;
  if (sources === undefined || record["signature"] !== signatureOf(sources)) return fresh();

  const discovery = record["discovery"];
  if (!isDiscovery(discovery)) return fresh();
  return discovery;
}

function writeCache(file: string, cwd: string, discovery: Discovery): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ cwd, sources: discovery.sources, signature: signatureOf(discovery.sources), discovery }),
      "utf8",
    );
  } catch {
    // A read-only or full disk means discovery is simply uncached.
  }
}

function isDiscovery(value: unknown): value is Discovery {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const registry = record["registry"];
  if (typeof registry !== "object" || registry === null) return false;
  const skills = (registry as Record<string, unknown>)["skills"];
  return Array.isArray(skills) && Array.isArray(record["sources"]) && Array.isArray(record["roots"]);
}
