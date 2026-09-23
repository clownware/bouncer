// Finding the policy, the data directory, and the API key.
//
// All the filesystem knowledge lives here so the engine can stay pure. Everything is
// best-effort: a missing or unreadable file is a reason to fall back, never a reason to
// fail, because a config problem must not be why a tool call gets blocked.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type LoadResult } from "../engine/policy.js";
import { loadPolicyCached } from "./policycache.js";
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
 *
 * `explicit` is a command's `--policy`, and is not a fifth rung. A candidate that cannot be
 * read is skipped in favour of the next one, which is right for places a policy might be
 * and wrong for a file somebody named: a mistyped path would run the command against a
 * different policy and say nothing. So a named file is the only candidate, and failing to
 * read it is the error.
 */
export function resolvePolicy(cwd: string, pluginRoot?: string, explicit?: string): ResolvedPolicy {
  if (explicit !== undefined) {
    const path = resolve(explicit);
    const source = tryRead(path);
    if (source === undefined) {
      return { diagnostics: [{ severity: "error", path: "", message: "the file could not be read" }], source: path };
    }
    return { ...loadPolicyCached(dataDir(), path, source), source: path };
  }

  for (const candidate of policyCandidates(cwd, pluginRoot)) {
    const source = tryRead(candidate);
    if (source === undefined) continue;
    // Compiled results are memoised on disk, keyed on this text. The hook is a fresh
    // process on every tool call, so a parse saved is saved on every call. See docs/adr/007.
    return { ...loadPolicyCached(dataDir(), candidate, source), source: candidate };
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
 * Claude Code exports it to hook processes but *not* to commands it runs through the Bash
 * tool — which is what a slash command is. So `/bouncer:status` and `/bouncer:explain`
 * resolved ~/.bouncer while the hook beside them wrote to the plugin's data directory, and
 * status reported "No decisions logged yet" over a log with a thousand decisions in it.
 * Deriving the directory closes that split; the environment still wins when it is set.
 *
 * Falling back to ~/.bouncer keeps the CLI usable from a checkout, where there is no
 * plugin directory to derive anything from.
 */
export function dataDir(): string {
  const fromPlugin = process.env["CLAUDE_PLUGIN_DATA"];
  if (fromPlugin !== undefined && fromPlugin.length > 0) return fromPlugin;
  return derivedPluginData(pluginRoot()) ?? join(homedir(), ".bouncer");
}

/**
 * ${CLAUDE_PLUGIN_DATA} reconstructed from an installed plugin's own location.
 *
 * Claude Code caches a plugin at `<plugins>/cache/<marketplace>/<plugin>/<version>` and
 * gives it `<plugins>/data/<plugin>-<marketplace>`, the plugin identifier `<plugin>@<marketplace>`
 * with every character outside `a-zA-Z0-9_-` replaced by `-`. Both names are documented.
 *
 * The directory has to already exist for this to return it. That is the guard on a
 * derivation: if the layout ever changes, the check fails and the caller falls back to
 * ~/.bouncer, which is where it was reading before. Nothing is created here, and nothing
 * is written to a path that was guessed rather than found.
 */
function derivedPluginData(root: string | undefined): string | undefined {
  if (root === undefined) return undefined;

  const version = resolve(root);
  const plugin = dirname(version);
  const marketplace = dirname(plugin);
  const cache = dirname(marketplace);
  if (basename(cache) !== "cache") return undefined;

  const candidate = join(dirname(cache), "data", `${basename(plugin)}-${basename(marketplace)}`);
  return existsSync(candidate) ? candidate : undefined;
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
 * PreToolUse hook means Touch ID appearing in the middle of an agent run.
 *
 * This note used to say that if 1Password support returned it belonged in a SessionStart
 * hook resolving once per session. That is not available, checked 2026-09-19.
 * `CLAUDE_ENV_FILE` is the only documented way a hook exports anything to the session, and
 * it is scoped to the Bash tool: the docs define it as a script Claude Code runs "before
 * each Bash command in the same shell process". A PreToolUse hook is not a Bash command and
 * never sources it (anthropics/claude-code#60697 asks for it to reach beyond bash). A
 * plugin's SessionStart hook is handed the variable empty in any case (#11649). So the key
 * reaches this function from the environment Claude Code itself was started with, and
 * nowhere else; `docs/dogfooding.md` lists the three places that environment can come from.
 */
export function apiKey(): string | undefined {
  for (const name of ["BOUNCER_TYPESAFE_API_KEY", "TYPESAFE_API_KEY"]) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * A Jev-shaped server named as `jev@<url>`: its endpoint, the sentence to print instead, or
 * undefined when the name is not of that form.
 *
 * The TypeSafe key is never sent to it. The key belongs to one vendor and the URL is
 * whatever was typed, so forwarding it would hand the key to any host someone pastes;
 * openjev-sglang's public deploy needs no key, which is also what lets a thread with no key
 * run this arm. TypeSafe's own host is refused under this spelling for the same reason in
 * reverse: `jev` is the name that sends the key, and a keyless call there only fails.
 *
 * A bare origin gets `/v1/systemone`, the path both TypeSafe and openjev-sglang serve;
 * anything with a path is taken as the full endpoint.
 */
export function jevCompatible(backend: string): { readonly baseUrl: string } | { readonly error: string } | undefined {
  if (!backend.startsWith("jev@")) return undefined;

  const raw = backend.slice("jev@".length).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `"${backend}" names no URL: write jev@https://host, for a server that speaks Jev's /v1/systemone.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: `"${backend}" is not an http or https URL.` };
  }
  if (url.hostname === "api.typesafe.ai") {
    return { error: `"${backend}" is TypeSafe itself: name it jev, which is the backend that sends your key.` };
  }
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1/systemone";
  return { baseUrl: url.toString() };
}

/**
 * An OpenAI-compatible chat endpoint named as `chat@<url>`, the LLM one-token-logprob arm:
 * the local adapter's options for it, the sentence to print instead, or undefined when the
 * name is not of that form.
 *
 * It is an OpenAI model or an open-weights model on vLLM, because those are what serve chat
 * with `logprobs`; Anthropic's API returns none. The model is `BOUNCER_CHAT_MODEL` and is
 * required, since it is the thing the arm's column claims to be.
 *
 * Keys follow `jevCompatible`'s rule. `OPENAI_API_KEY` goes to OpenAI's own host and
 * nowhere else, because the URL is whatever was typed. `BOUNCER_CHAT_API_KEY` goes to any
 * `chat@` URL, which is what setting it for this means (vLLM's `--api-key`).
 * `BOUNCER_CHAT_EXTRA_BODY` is a JSON object merged into every request, for switches a
 * server needs and OpenAI would reject, such as turning a Qwen model's thinking off.
 *
 * A bare origin gets `/v1`; anything with a path is taken as the API root.
 */
export function chatBackend(
  backend: string,
): { readonly baseUrl: string; readonly model: string; readonly apiKey?: string; readonly extraBody?: Record<string, unknown> } | { readonly error: string } | undefined {
  if (!backend.startsWith("chat@")) return undefined;

  const raw = backend.slice("chat@".length).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `"${backend}" names no URL: write chat@https://api.openai.com, or chat@http://127.0.0.1:8000 for vLLM.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: `"${backend}" is not an http or https URL.` };
  }
  if (url.hostname === "api.anthropic.com") {
    return { error: `"${backend}" cannot be an arm: Anthropic's API returns no logprobs, so there is no probability to read.` };
  }

  const text = (name: string): string | undefined => {
    const value = process.env[name];
    return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
  };

  const model = text("BOUNCER_CHAT_MODEL");
  if (model === undefined) {
    return { error: `"${backend}" needs BOUNCER_CHAT_MODEL: the model the endpoint serves, such as gpt-4.1-mini or the name vLLM was started with.` };
  }

  const openai = url.hostname === "api.openai.com";
  const apiKey = text("BOUNCER_CHAT_API_KEY") ?? (openai ? text("OPENAI_API_KEY") : undefined);
  if (openai && apiKey === undefined) {
    return { error: `"${backend}" is OpenAI: set OPENAI_API_KEY.` };
  }

  let extraBody: Record<string, unknown> | undefined;
  const extra = text("BOUNCER_CHAT_EXTRA_BODY");
  if (extra !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extra);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "BOUNCER_CHAT_EXTRA_BODY is not a JSON object." };
    }
    extraBody = parsed as Record<string, unknown>;
  }

  if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(extraBody !== undefined ? { extraBody } : {}),
  };
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

/**
 * Where the local backend lives.
 *
 * Environment only, for now. An endpoint URL is not a threshold, so the no-thresholds-in-
 * code rule does not send it to the policy — but a `local:` block in the YAML is the right
 * home once the adapter is a supported hook backend rather than a calibration one, and
 * ADR-005 records that as the follow-up. Keeping it out of the schema today means the
 * adapter can land without touching the policy loader.
 */
export function localBackend(): { baseUrl?: string; model?: string; concurrency?: number } {
  const text = (name: string): string | undefined => {
    const value = process.env[name];
    return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
  };

  const concurrency = Number(text("BOUNCER_LOCAL_CONCURRENCY"));

  return {
    ...(text("BOUNCER_LOCAL_URL") !== undefined ? { baseUrl: text("BOUNCER_LOCAL_URL") as string } : {}),
    ...(text("BOUNCER_LOCAL_MODEL") !== undefined ? { model: text("BOUNCER_LOCAL_MODEL") as string } : {}),
    ...(Number.isFinite(concurrency) && concurrency > 0 ? { concurrency } : {}),
  };
}
