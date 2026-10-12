// Turns a change about to be pushed into items the engine can judge (#93).
//
// This is a consumer of the engine, not a part of it (ADR-008): it produces plain items for
// the `item` state builder and names two policy sets, and nothing below `src/commands/`
// learns what a push is. Being plain items is also what makes the rest free: the same
// shapes are the fixtures in `fixtures/push*.jsonl`, so `calibrate` scores the questions and
// `measure` compares them with a reasoning model, with no code of their own.
//
// Two kinds of item, because two kinds of question:
//
//   the push      one item. Its commit messages, its file list with line counts, the facts
//                 below, and a short excerpt of what was added. Asked whether the message
//                 describes the change and whether behaviour changed with no test.
//   each file     one item per file worth reading. That file's diff. Asked what is true of
//                 one file: a debugging statement left in, work marked unfinished.
//
// The split is what the classifier's documented limits ask for. Its accuracy falls as the
// state fills with content unrelated to the question, so a question about one file is shown
// one file. It does not count or compare reliably, so everything countable is counted here
// and handed over as a field: `tests_changed` is a fact, and the judgment left over is only
// whether behaviour changed.
//
// Pure: no git, no files. `src/io/git.ts` reads the change.

import type { Item } from "./engine/item.js";
import { MAX_ITEM_STATE_BYTES } from "./engine/item.js";
import type { ChangedFile, GitChange } from "./io/git.js";

/** The two policy sets `bouncer ready` asks, and the item each is asked of. */
export const PUSH_SET = "push";
export const PUSH_FILE_SET = "push_file";

/** How much of the added text the whole-push item carries, across every file. */
const EXCERPT_BYTES = 6000;
/** No file's share of the excerpt shrinks below this, however many files there are. */
const EXCERPT_FLOOR = 240;
/** Room left under the item cap for the fields around a file's diff. */
const FILE_ITEM_OVERHEAD = 1024;

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(swift|cs|java|kt)$/;
const DOC_PATH = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS)(\.[a-z]+)?$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock)$/;
const GENERATED = /(^|\/)(dist|build|out|vendor|node_modules|\.next|coverage)\/|\.min\.(js|css)$|\.(map|snap)$|\.generated\.|_pb2?\.py$|\.pb\.go$/;

export type FileKind = "test" | "docs" | "lockfile" | "generated" | "source";

export function kindOf(path: string): FileKind {
  if (LOCKFILE.test(path)) return "lockfile";
  if (GENERATED.test(path)) return "generated";
  if (TEST_PATH.test(path)) return "test";
  if (DOC_PATH.test(path)) return "docs";
  return "source";
}

export interface FileItem {
  readonly path: string;
  readonly item: Item;
}

export interface Unchecked {
  readonly path: string;
  /** Why no question was asked of this file. Printed, so it is a sentence fragment. */
  readonly why: string;
}

export interface PushItems {
  readonly summary: Item;
  readonly files: readonly FileItem[];
  /**
   * Files no file-level question was asked of. Named rather than dropped: a check that read
   * four of nine files and says "ready" has to say which four.
   */
  readonly unchecked: readonly Unchecked[];
}

/** The lines a diff adds, without their `+` and without the `+++` header. */
function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function whyUnchecked(file: ChangedFile, kind: FileKind): string | undefined {
  if (file.status === "deleted") return "deleted, so it adds nothing to read";
  if (file.binary) return "binary";
  if (kind === "lockfile") return "a lockfile";
  if (kind === "generated") return "generated or vendored";
  if (kind === "docs") return "documentation";
  if (file.diff.length === 0) return "its diff could not be read";
  // A diff the state builder would cut is not judged on its head: an allow from the first
  // sixteen kilobytes of a file says nothing about the rest. Reading long files in pieces
  // is #53, and until then they are named here instead.
  if (Buffer.byteLength(file.diff, "utf8") > MAX_ITEM_STATE_BYTES - FILE_ITEM_OVERHEAD) {
    return "its diff is longer than one item can carry (#53)";
  }
  return undefined;
}

export function pushItems(change: GitChange): PushItems {
  const kinds = new Map(change.files.map((f) => [f.path, kindOf(f.path)]));
  const kind = (f: ChangedFile) => kinds.get(f.path) as FileKind;
  const live = change.files.filter((f) => f.status !== "deleted");

  const subjects = change.commits.map((c) => c.subject);
  const files: FileItem[] = [];
  const unchecked: Unchecked[] = [];
  for (const file of change.files) {
    const why = whyUnchecked(file, kind(file));
    if (why !== undefined) {
      unchecked.push({ path: file.path, why });
      continue;
    }
    files.push({
      path: file.path,
      item: {
        kind: "push_file",
        path: file.path,
        status: file.status,
        is_test: kind(file) === "test",
        commit_subjects: subjects,
        diff: file.diff,
      },
    });
  }

  // The excerpt is for one question, whether the messages describe the change, so it is
  // spread over the files that carry behaviour and tests rather than spent on the first.
  const excerptable = live.filter((f) => !f.binary && (kind(f) === "source" || kind(f) === "test") && f.diff.length > 0);
  const share = excerptable.length === 0 ? 0 : Math.max(EXCERPT_FLOOR, Math.floor(EXCERPT_BYTES / excerptable.length));
  let budget = EXCERPT_BYTES;
  const excerpt: string[] = [];
  for (const file of excerptable) {
    if (budget <= 0) break;
    const text = addedLines(file.diff).join("\n").slice(0, Math.min(share, budget));
    if (text.length === 0) continue;
    excerpt.push(`--- ${file.path}\n${text}`);
    budget -= text.length;
  }

  const count = (k: FileKind) => live.filter((f) => kind(f) === k).length;
  const summary: Item = {
    kind: "push",
    branch: change.branch,
    commits: change.commits.map((c) => (c.body.length > 0 ? { subject: c.subject, body: c.body } : { subject: c.subject })),
    files: change.files.map((f) => ({ path: f.path, status: f.status, lines_added: f.added, lines_removed: f.removed })),
    files_changed: change.files.length,
    lines_added: change.files.reduce((sum, f) => sum + f.added, 0),
    lines_removed: change.files.reduce((sum, f) => sum + f.removed, 0),
    // Computed, never asked: "is there a test for this" needs a count across files, and
    // counting is on the classifier's own list of things it does badly.
    source_files_changed: count("source"),
    test_files_changed: count("test"),
    tests_changed: count("test") > 0,
    docs_only: live.length > 0 && live.every((f) => kind(f) === "docs"),
    added_excerpt: excerpt.join("\n"),
  };

  return { summary, files, unchecked };
}
