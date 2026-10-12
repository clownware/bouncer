// What a push would carry: the commits ahead of the base, and what they change.
//
// `bouncer ready` judges a change before it is pushed (#93). Everything it knows about
// the change comes through here, read with `git` and nothing else, so the part that decides
// (`src/push.ts`) stays a pure function of this file's return value and is tested without a
// repository.
//
// Only committed work is read. A dirty working tree is not what a push sends.

import { execFileSync } from "node:child_process";

export type FileStatus = "added" | "modified" | "deleted";

export interface ChangedFile {
  readonly path: string;
  readonly status: FileStatus;
  /** Lines added and removed. Zero for a binary file, which has no lines. */
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
  /** The unified diff for this file. Empty for a binary file. */
  readonly diff: string;
}

export interface Commit {
  readonly subject: string;
  readonly body: string;
}

export interface GitChange {
  /** The repository's top-level directory. */
  readonly root: string;
  readonly branch: string;
  /** The ref the change is measured against, as resolved: `origin/main`, or what `--base` named. */
  readonly baseRef: string;
  /** The merge base with `baseRef`: the commit the diff starts from. */
  readonly base: string;
  readonly head: string;
  /** Oldest first. */
  readonly commits: readonly Commit[];
  readonly files: readonly ChangedFile[];
}

/** A diff past this is not read into memory whole. `src/push.ts` reports the file as not checked. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_DIFF_BYTES * 4, stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    return git(cwd, args).trim();
  } catch {
    return undefined;
  }
}

/** The remote's default branch, as a ref this repository has: `origin/main` on most. */
function defaultBase(cwd: string): string | undefined {
  const head = tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head !== undefined && head.length > 0) return head;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]) !== undefined) return candidate;
  }
  return undefined;
}

/**
 * The change `HEAD` would push, measured from its merge base with `baseRef`.
 *
 * Returns the sentence to print instead when there is nothing to read: not a repository, no
 * base to measure from. Neither is an error in the caller's sense. A readiness check that
 * cannot run has no opinion, and having no opinion never blocks a push.
 */
export function readChange(cwd: string, baseRef?: string): GitChange | string {
  const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) return "not inside a git repository";

  const ref = baseRef ?? defaultBase(root);
  if (ref === undefined) return "no base to compare against: there is no origin/HEAD, origin/main or main. Name one with --base.";

  const base = tryGit(root, ["merge-base", "HEAD", ref]);
  if (base === undefined) return `no merge base between HEAD and ${ref}`;
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const branch = tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";

  // Unit and record separators, so a body with any ordinary character in it parses.
  const commits = git(root, ["log", "--reverse", "--format=%s%x1f%b%x1e", `${base}..${head}`])
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    });

  // --no-renames: a rename reads as a delete and an add. The add is what gets judged, and
  // its diff is then the whole file, which is the honest reading of "this file is new here".
  const range = [base, head];
  const statusOf = new Map<string, FileStatus>();
  for (const line of git(root, ["diff", "--no-renames", "--name-status", ...range]).split("\n")) {
    const [code, path] = line.split("\t");
    if (code === undefined || path === undefined) continue;
    statusOf.set(path, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified");
  }

  const files: ChangedFile[] = [];
  for (const line of git(root, ["diff", "--no-renames", "--numstat", ...range]).split("\n")) {
    const [added, removed, path] = line.split("\t");
    if (added === undefined || removed === undefined || path === undefined) continue;
    const binary = added === "-";
    const status = statusOf.get(path) ?? "modified";
    let diff = "";
    if (!binary && status !== "deleted") {
      try {
        diff = git(root, ["diff", "--no-renames", "--no-color", "--unified=3", ...range, "--", path]);
      } catch {
        // Over the buffer. Left empty with its line counts intact, which `src/push.ts` reads
        // as a file too long to check, and says so.
        diff = "";
      }
    }
    files.push({ path, status, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary, diff });
  }

  return { root, branch, baseRef: ref, base, head, commits, files };
}
