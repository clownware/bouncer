// Finding the policy, the data directory, and the API key.
//
// All the filesystem knowledge lives here so the engine can stay pure. Everything is
// best-effort: a missing or unreadable file is a reason to fall back, never a reason to
// fail, because a config problem must not be why a tool call gets blocked.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadPolicy, type LoadResult } from "../engine/policy.js";
import type { Diagnostic } from "../engine/types.js";

export interface ResolvedPolicy extends LoadResult {
  /** Where the policy came from, for `/bouncer:status`. */
  readonly source: string;
}

/**
 * Policy precedence, nearest first:
 *
 *   1. $BOUNCER_POLICY            — explicit override, mostly for tests
 *   2. <repo>/.bouncer.yaml       — committed next to CLAUDE.md, shared with the team
 *   3. ~/.bouncer/bouncer.yaml    — the user's own
 *   4. the bundled default        — observe mode, no deny rules
 *
 * A repo policy overriding a user policy is the documented behaviour, and is worth being
 * aware of: cloning a repository means adopting its policy. Since the strictest thing any
 * policy can do is add prompts, and since it can never widen what Claude Code's own
 * settings allow, the worst a hostile policy achieves is noise.
 */
export function resolvePolicy(cwd: string, pluginRoot?: string): ResolvedPolicy {
  for (const candidate of policyCandidates(cwd, pluginRoot)) {
    const source = tryRead(candidate);
    if (source === undefined) continue;
    return { ...loadPolicy(source), source: candidate };
  }

  return {
    diagnostics: [{ severity: "error", path: "", message: "no policy file found" }],
    source: "(none)",
  };
}

function policyCandidates(cwd: string, pluginRoot?: string): string[] {
  const candidates: string[] = [];

  const override = process.env["BOUNCER_POLICY"];
  if (override !== undefined && override.length > 0) candidates.push(resolve(override));

  const repoRoot = findRepoRoot(cwd);
  if (repoRoot !== undefined) {
    candidates.push(join(repoRoot, ".bouncer.yaml"), join(repoRoot, ".bouncer.yml"));
  }

  candidates.push(join(homedir(), ".bouncer", "bouncer.yaml"));

  if (pluginRoot !== undefined) candidates.push(join(pluginRoot, "policy", "default.yaml"));

  return candidates;
}

/** Walks up looking for a `.git` entry. Returns undefined outside a repository. */
function findRepoRoot(from: string): string | undefined {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Where decisions.jsonl and the breaker state live.
 *
 * ${CLAUDE_PLUGIN_DATA} is the directory Claude Code gives a plugin for persistent data.
 * Falling back to ~/.bouncer keeps the CLI usable when run outside a hook.
 */
export function dataDir(): string {
  const fromPlugin = process.env["CLAUDE_PLUGIN_DATA"];
  if (fromPlugin !== undefined && fromPlugin.length > 0) return fromPlugin;
  return join(homedir(), ".bouncer");
}

/**
 * The plugin's own directory: where the bundled policy and the fixtures live.
 *
 * Inside a hook, Claude Code sets CLAUDE_PLUGIN_ROOT. Outside one — `node bin/bouncer.cjs
 * calibrate` from a checkout, or from wherever the plugin was installed — nothing does,
 * so fall back to the binary's own location: it lives at <root>/bin/bouncer.cjs, and the
 * candidate is checked for the bundled policy rather than assumed.
 */
export function pluginRoot(): string | undefined {
  const fromEnv = process.env["CLAUDE_PLUGIN_ROOT"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  const script = process.argv[1];
  if (script === undefined || script.length === 0) return undefined;
  const candidate = resolve(dirname(script), "..");
  return existsSync(join(candidate, "policy", "default.yaml")) ? candidate : undefined;
}

/**
 * The API key, from the environment only.
 *
 * Deliberately not resolving `op://` references here, though the PRD allowed it: `op read`
 * spawns a subprocess and can raise a biometric prompt, and doing that inside a
 * PreToolUse hook means Touch ID appearing in the middle of an agent run. If 1Password
 * support returns, it belongs in a SessionStart hook that resolves once per session.
 */
export function apiKey(): string | undefined {
  for (const name of ["BOUNCER_TYPESAFE_API_KEY", "TYPESAFE_API_KEY"]) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function errorsIn(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
