// Reading a batch of items off disk, for `bouncer judge`.
//
// Three shapes, because these are the three a batch actually arrives in: a JSONL file with
// one object per line (an export from somewhere), a JSON file holding an array (the same
// thing from a tool that would not write JSONL), and a directory of documents (drafts,
// transcripts, posts). Anything else is a conversion the user can do in one line of `jq`,
// and guessing at more formats here would mean guessing wrong in ways that are hard to see.
//
// All the filesystem knowledge is here so the engine stays pure, same as `config.ts`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { Item } from "../engine/item.js";

/** One item and the key it is reported under. */
export interface LoadedItem {
  /** Stable across runs: the item's own `id`, or its path, or `file:line`. */
  readonly id: string;
  readonly item: Item;
}

export interface LoadedBatch {
  readonly items: readonly LoadedItem[];
  /**
   * Files skipped, with the reason.
   *
   * Reported rather than swallowed: a run that silently judged 40 of 60 documents and
   * printed a confident escalation rate over the 40 is exactly the kind of number this
   * project exists to not produce.
   */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly why: string }>;
}

/**
 * Files above this are skipped rather than truncated.
 *
 * The state builder caps what it sends, so a large file would be judged on its first 16 KB
 * without that being obvious from the output. Skipping and saying so is the honest version;
 * splitting the document is the user's call, not this function's.
 */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Directory recursion depth. A batch nested deeper than this is a mistake worth surfacing. */
const MAX_DEPTH = 8;

export function loadItems(path: string): LoadedBatch {
  const stats = statSync(path);
  if (stats.isDirectory()) return loadDirectory(path);

  const source = readFileSync(path, "utf8");
  return extname(path).toLowerCase() === ".json" ? loadJsonArray(source, path) : loadJsonl(source, path);
}

/** A JSONL export: one object per line. Blank lines and `//` comments are skipped. */
function loadJsonl(source: string, path: string): LoadedBatch {
  const items: LoadedItem[] = [];
  const skipped: Array<{ path: string; why: string }> = [];

  source.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("//")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      skipped.push({ path: `${path}:${i + 1}`, why: `not valid JSON: ${message(err)}` });
      return;
    }

    if (!isRecord(parsed)) {
      skipped.push({ path: `${path}:${i + 1}`, why: "not a JSON object" });
      return;
    }

    items.push({ id: idOf(parsed, `${path}:${i + 1}`), item: unwrapFixture(parsed) });
  });

  return { items, skipped };
}

/**
 * A labelled calibration fixture is also a valid batch line.
 *
 * `{ kind, item, expect }` all together is the fixture shape and nothing else's, so a line
 * carrying all three is read as one and its labels ignored. That makes a fixture file
 * runnable through `bouncer judge` — which is how you look at the escalation manifest for
 * a set you are still writing, without maintaining the same documents in two files.
 *
 * Deliberately requires all three keys. `item` alone is a field name a real batch might
 * plausibly use; the three together are not.
 */
function unwrapFixture(line: Record<string, unknown>): Item {
  const item = line["item"];
  const kind = line["kind"];
  if ((kind !== "item" && kind !== "tool_call") || !isRecord(item) || !isRecord(line["expect"])) return line;
  return item;
}

function loadJsonArray(source: string, path: string): LoadedBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${message(err)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${path} holds a ${typeof parsed}, not an array of items`);
  }

  const items: LoadedItem[] = [];
  const skipped: Array<{ path: string; why: string }> = [];

  parsed.forEach((entry, i) => {
    if (!isRecord(entry)) {
      skipped.push({ path: `${path}[${i}]`, why: "not a JSON object" });
      return;
    }
    items.push({ id: idOf(entry, `${path}[${i}]`), item: entry });
  });

  return { items, skipped };
}

/**
 * A directory of documents. Each readable text file is one item.
 *
 * The item carries the path, the name and the text under those names, so a policy set's
 * questions can refer to them: a question about a draft says `text` and one about where it
 * came from says `path`. Dotfiles and `node_modules` are skipped because nobody means them.
 */
function loadDirectory(root: string): LoadedBatch {
  const items: LoadedItem[] = [];
  const skipped: Array<{ path: string; why: string }> = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      skipped.push({ path: relative(root, dir) || ".", why: `nested more than ${MAX_DEPTH} deep` });
      return;
    }

    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const id = relative(root, full).split(sep).join("/");

      let size: number;
      try {
        size = statSync(full).size;
      } catch (err) {
        skipped.push({ path: id, why: message(err) });
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        // Truncating would judge the first 16 KB and report it as the document.
        skipped.push({ path: id, why: `${(size / 1024).toFixed(0)} KB, over the ${MAX_FILE_BYTES / 1024} KB limit` });
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = readFileSync(full);
      } catch (err) {
        skipped.push({ path: id, why: message(err) });
        continue;
      }

      // A NUL byte in the first block is the usual test for a binary file, and a classifier
      // asked to judge one would answer something rather than refuse.
      if (buffer.subarray(0, 4096).includes(0)) {
        skipped.push({ path: id, why: "looks binary" });
        continue;
      }

      items.push({ id, item: { path: id, name: entry.name, text: buffer.toString("utf8") } });
    }
  };

  walk(root, 0);
  return { items, skipped };
}

/** The item's own `id` if it has a usable one, otherwise where it came from. */
function idOf(item: Record<string, unknown>, fallback: string): string {
  const id = item["id"];
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
