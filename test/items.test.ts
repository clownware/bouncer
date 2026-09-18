import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, loadItems } from "../src/io/items.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bouncer-items-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string) => {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
};

describe("a JSONL batch", () => {
  it("reads one item per line, keyed on the item's own id", () => {
    const path = write("b.jsonl", '{"id":"a","text":"one"}\n{"id":"b","text":"two"}\n');
    const { items } = loadItems(path);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(items[0]?.item).toEqual({ id: "a", text: "one" });
  });

  it("falls back to file:line when a line has no id", () => {
    const path = write("b.jsonl", '{"text":"one"}\n');
    expect(loadItems(path).items[0]?.id).toBe(`${path}:1`);
  });

  it("skips blank lines and // comments", () => {
    const path = write("b.jsonl", '// a note\n\n{"id":"a","text":"one"}\n');
    expect(loadItems(path).items).toHaveLength(1);
  });

  // A batch that silently lost lines would produce a confident escalation rate over a
  // denominator nobody agreed to.
  it("reports an unparseable line rather than swallowing it", () => {
    const path = write("b.jsonl", '{"id":"a"}\n{not json}\n');
    const { items, skipped } = loadItems(path);
    expect(items).toHaveLength(1);
    expect(skipped[0]?.path).toBe(`${path}:2`);
    expect(skipped[0]?.why).toMatch(/not valid JSON/);
  });

  it("reports a line that is not an object", () => {
    const path = write("b.jsonl", '["a"]\n');
    expect(loadItems(path).skipped[0]?.why).toBe("not a JSON object");
  });

  // docs/adr/009: a fixture file is a valid batch, so a set under development can be run
  // over its own fixtures without keeping the documents in two files.
  it("unwraps a labelled fixture line and ignores the labels", () => {
    const path = write("f.jsonl", '{"id":"a","kind":"item","item":{"text":"draft"},"expect":{"q":true},"note":"n"}\n');
    const { items } = loadItems(path);
    expect(items[0]?.id).toBe("a");
    expect(items[0]?.item).toEqual({ text: "draft" });
  });

  it("leaves a real item that merely has an `item` field alone", () => {
    const path = write("b.jsonl", '{"id":"a","item":{"sku":"x"},"qty":2}\n');
    expect(loadItems(path).items[0]?.item).toEqual({ id: "a", item: { sku: "x" }, qty: 2 });
  });
});

describe("a JSON array batch", () => {
  it("reads each element as an item", () => {
    const path = write("b.json", '[{"id":"a","text":"one"},{"id":"b","text":"two"}]');
    expect(loadItems(path).items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("refuses a JSON file that is not an array", () => {
    const path = write("b.json", '{"id":"a"}');
    expect(() => loadItems(path)).toThrow(/not an array of items/);
  });
});

describe("a directory of documents", () => {
  it("reads each file as an item carrying its path, name and text", () => {
    write("one.md", "# One");
    write("two.md", "# Two");
    const { items } = loadItems(dir);
    expect(items.map((i) => i.id)).toEqual(["one.md", "two.md"]);
    expect(items[0]?.item).toEqual({ path: "one.md", name: "one.md", text: "# One" });
  });

  it("recurses, and keys an item on its path relative to the batch root", () => {
    write(join("posts", "2026", "launch.md"), "body");
    expect(loadItems(dir).items[0]?.id).toBe("posts/2026/launch.md");
  });

  it("skips dotfiles and node_modules, because nobody means them", () => {
    write(".hidden.md", "x");
    write(join("node_modules", "pkg", "readme.md"), "x");
    write("real.md", "x");
    expect(loadItems(dir).items.map((i) => i.id)).toEqual(["real.md"]);
  });

  it("skips a binary file rather than asking a classifier about it", () => {
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const { items, skipped } = loadItems(dir);
    expect(items).toEqual([]);
    expect(skipped[0]?.why).toBe("looks binary");
  });

  // Truncating would judge the first 16 KB and report it as the whole document.
  it("skips an oversized file and says how big it was", () => {
    write("huge.md", "x".repeat(MAX_FILE_BYTES + 1));
    const { items, skipped } = loadItems(dir);
    expect(items).toEqual([]);
    expect(skipped[0]?.why).toMatch(/over the \d+ KB limit/);
  });

  it("reads files in a stable order, so two runs are comparable", () => {
    for (const name of ["c.md", "a.md", "b.md"]) write(name, name);
    expect(loadItems(dir).items.map((i) => i.id)).toEqual(["a.md", "b.md", "c.md"]);
  });
});
