// Builds the state string sent to the classifier.
//
// Two rules govern everything here.
//
// First, what leaves the machine is a description of the *action*, never its content.
// `Write.content`, `Edit.old_string` / `new_string` and `NotebookEdit.new_source` are file
// contents and diffs; none of them is ever included. A byte count carries what the gate
// actually needs ("this overwrites a 12 KB file") without the bytes. There is a test that
// asserts no fixture's file content survives into the state.
//
// Second, the state is JSON with one field per fact, not a prose blob. The command text is
// attacker-influenced — it can come from a script or Makefile in a repository the user did
// not write, and Jev's own documentation notes that state content can be adversarially
// framed. Structuring it means a command containing `prod: false` cannot impersonate a
// field. This narrows the surface; it does not close it. Bouncer is a safety net against
// Claude's mistakes, not a security boundary against a motivated attacker.
//
// Anything numeric or path-shaped is computed here rather than asked. jev-1.13 is
// documented to be unreliable at counting and to read scoping words literally, and
// "is this path inside the project" is a fact we already hold.

import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { redact } from "./redact.js";

/** Hard cap on the serialized state. Jev's limit is far higher; this is for latency. */
export const MAX_STATE_BYTES = 4096;

export interface StateInput {
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  readonly permissionMode?: string;
  readonly agentType?: string;
  /** Recent tool names in this session, most recent last. */
  readonly recentTools?: readonly string[];
  readonly git?: { readonly branch?: string; readonly dirty?: boolean };
}

export interface BuiltState {
  /** The JSON string handed to the classifier. */
  readonly text: string;
  /** Redaction kinds that fired, for the log. Safe to record; the values are not. */
  readonly redactedKinds: readonly string[];
  /** True when the state hit MAX_STATE_BYTES and lost detail. */
  readonly truncated: boolean;
}

/** The command a fast-path check should run against; empty for non-Bash tools. */
export function commandOf(toolName: string, toolInput: Readonly<Record<string, unknown>>): string {
  if (toolName !== "Bash") return "";
  const command = toolInput["command"];
  return typeof command === "string" ? command : "";
}

export function buildState(input: StateInput): BuiltState {
  const kinds = new Set<string>();

  const clean = (value: string): string => {
    const { text, kinds: found } = redact(value);
    for (const k of found) kinds.add(k);
    return text;
  };

  const state: Record<string, unknown> = {
    tool: input.toolName,
    action: describeAction(input, clean),
  };

  // Only the basename of the working directory leaves the machine. The question the gate
  // actually asks about paths — is this inside the project — is answered as a boolean,
  // computed here.
  if (input.cwd !== undefined && input.cwd.length > 0) {
    state["project"] = basename(input.cwd);
  }
  if (input.permissionMode !== undefined) {
    state["permission_mode"] = input.permissionMode;
  }
  if (input.agentType !== undefined) {
    state["running_as_subagent"] = input.agentType;
  }
  if (input.git?.branch !== undefined) {
    state["git_branch"] = clean(input.git.branch);
  }
  if (input.git?.dirty !== undefined) {
    state["git_dirty"] = input.git.dirty;
  }
  if (input.recentTools !== undefined && input.recentTools.length > 0) {
    state["recent_tools"] = input.recentTools.slice(-3);
  }

  let text = JSON.stringify(state, null, 1);
  let truncated = false;

  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
    truncated = true;
    const action = state["action"];
    if (isRecord(action)) {
      state["action"] = truncateStrings(action, 512);
    }
    text = JSON.stringify(state, null, 1);

    if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
      // Cut on a character boundary rather than mid-codepoint, and say so in the text so
      // the classifier is not reasoning about a command it cannot see the end of.
      text = `${text.slice(0, MAX_STATE_BYTES - 32)}\n… [truncated]`;
    }
  }

  return { text, redactedKinds: [...kinds], truncated };
}

/**
 * Per-tool extraction.
 *
 * MultiEdit is absent on purpose: it does not exist in Claude Code 2.1.201 — the Edit tool
 * absorbed it — which the captured payloads confirmed.
 */
function describeAction(
  input: StateInput,
  clean: (value: string) => string,
): Record<string, unknown> {
  const { toolName, toolInput, cwd } = input;

  switch (toolName) {
    case "Bash": {
      const action: Record<string, unknown> = { kind: "run_shell_command" };
      const command = toolInput["command"];
      if (typeof command === "string") action["command"] = clean(command);
      // Claude writes a short human description alongside the command. It is a useful
      // hint about intent, so it is included — and redacted like anything else.
      const description = toolInput["description"];
      if (typeof description === "string" && description.length > 0) {
        action["stated_intent"] = clean(description);
      }
      return action;
    }

    case "Write": {
      const path = pathFacts(toolInput["file_path"], cwd, clean);
      const content = toolInput["content"];
      return {
        kind: "write_file",
        ...path,
        // The content itself never leaves. Its size does, because "overwrites a large
        // existing file" and "creates a 40-byte file" are different risks.
        bytes: typeof content === "string" ? Buffer.byteLength(content, "utf8") : undefined,
      };
    }

    case "Edit": {
      const path = pathFacts(toolInput["file_path"], cwd, clean);
      const oldString = toolInput["old_string"];
      const newString = toolInput["new_string"];
      return {
        kind: "edit_file",
        ...path,
        replaces_every_occurrence: toolInput["replace_all"] === true,
        // A diff is file content. Only its magnitude and direction travel.
        bytes_removed: typeof oldString === "string" ? Buffer.byteLength(oldString, "utf8") : undefined,
        bytes_added: typeof newString === "string" ? Buffer.byteLength(newString, "utf8") : undefined,
      };
    }

    case "NotebookEdit": {
      const path = pathFacts(toolInput["notebook_path"], cwd, clean);
      const cellId = toolInput["cell_id"];
      return {
        kind: "edit_notebook_cell",
        ...path,
        cell: typeof cellId === "string" ? cellId : undefined,
        edit_mode: typeof toolInput["edit_mode"] === "string" ? toolInput["edit_mode"] : undefined,
      };
    }

    default: {
      // An unrecognised tool still gets gated if policy lists it. Send scalars and short
      // strings only: an unknown tool's input could be anything, including file contents,
      // so the conservative reading is to send almost nothing.
      const summary: Record<string, unknown> = { kind: "other_tool", tool: toolName };
      for (const [key, value] of Object.entries(toolInput)) {
        if (typeof value === "number" || typeof value === "boolean") {
          summary[key] = value;
        } else if (typeof value === "string" && value.length <= 200) {
          summary[key] = clean(value);
        } else if (typeof value === "string") {
          summary[`${key}_bytes`] = Buffer.byteLength(value, "utf8");
        }
      }
      return summary;
    }
  }
}

/**
 * Facts about a target path.
 *
 * `inside_project` is computed, not asked. The classifier reads scoping words literally
 * and this is something we can simply know.
 *
 * Being inside the project is not the same as being ordinary. A write to `.git/hooks/` or
 * to `.env` sits inside the working directory and is still exactly the kind of thing the
 * gate exists to notice, so a sensitivity label is computed independently of location.
 */
function pathFacts(
  raw: unknown,
  cwd: string | undefined,
  clean: (value: string) => string,
): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) {
    return { path: undefined, inside_project: undefined };
  }

  if (cwd === undefined || cwd.length === 0) {
    return { path: clean(basename(raw)), inside_project: undefined };
  }

  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  const rel = relative(resolve(cwd), absolute);
  const inside = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);

  const facts: Record<string, unknown> = {
    // Inside the project, the relative path is meaningful and safe to send. Outside it,
    // only the basename goes — the rest of the user's filesystem layout is not the
    // classifier's business.
    path: clean(inside ? rel : basename(absolute)),
    inside_project: inside,
  };

  if (!inside) {
    facts["outside_location"] = describeOutside(absolute);
  }

  const sensitive = describeSensitivity(inside ? rel : absolute);
  if (sensitive !== undefined) {
    facts["sensitive"] = sensitive;
  }

  return facts;
}

/**
 * A label for paths that warrant attention regardless of whether they are in the project.
 *
 * Deterministic on purpose: these are exact, well-known locations, and asking a classifier
 * "is this a git internal" would be slower and less reliable than checking.
 */
function describeSensitivity(path: string): string | undefined {
  const parts = path.split(sep).filter((p) => p.length > 0);
  const name = parts.at(-1) ?? "";

  if (parts.includes(".git")) return "git_internals";
  if (parts.includes(".ssh")) return "ssh_configuration";
  if (parts.includes(".github") && parts.includes("workflows")) return "ci_workflow";
  if (/^\.env(\..+)?$/.test(name)) return "environment_file";
  if (/^(\.npmrc|\.pypirc|\.netrc|\.gitconfig|\.dockercfg)$/.test(name)) return "credentials_file";
  if (/^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(name)) return "ssh_key";
  if (/^(\.bashrc|\.zshrc|\.profile|\.bash_profile)$/.test(name)) return "shell_startup_file";

  return undefined;
}

/** A coarse label for where an out-of-project path lives, without sending the path. */
function describeOutside(absolute: string): string {
  const parts = absolute.split(sep);
  if (parts.includes(".git")) return "git_internals";
  if (/^\/(etc|usr|bin|sbin|var|opt|sys|proc|boot)(\/|$)/.test(absolute)) return "system_directory";
  if (/^\/(tmp|private\/tmp)(\/|$)/.test(absolute)) return "temp_directory";
  if (/^\/(home|Users)\/[^/]+\/?$/.test(absolute)) return "home_directory_root";
  if (/^\/(home|Users)\/[^/]+\/\./.test(absolute)) return "user_dotfiles";
  if (/^\/(home|Users)\//.test(absolute)) return "elsewhere_in_home";
  return "elsewhere_on_machine";
}

function truncateStrings(record: Record<string, unknown>, limit: number): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) =>
      typeof value === "string" && value.length > limit
        ? [key, `${value.slice(0, limit)}… [truncated]`]
        : [key, value],
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
