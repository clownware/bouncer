import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// What an installed bouncer actually carries.
//
// The question this file exists to answer permanently: if someone has already installed
// the TypeSafe skill themselves and then installs bouncer, does bouncer bring a second
// copy that competes with theirs? It must not. `skills/` is the plugin's payload and
// `.claude/skills/` is project-local — only sessions working in a clone of this repo see
// the latter — and nothing should quietly move a skill across that line.

describe("the plugin payload", () => {
  it("ships exactly one skill, bouncer's own", () => {
    const shipped = readdirSync("skills", { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(shipped).toEqual(["bouncer"]);
  });

  it("does not ship a typesafe skill, so it never competes with the user's own", () => {
    expect(existsSync("skills/typesafe-ai")).toBe(false);
    expect(existsSync("skills/typesafe")).toBe(false);
  });

  it("keeps the vendored typesafe skill project-local", () => {
    // Checked in so every thread can follow CLAUDE.md's rule, including remote and CI
    // sessions that cannot see an account-enabled skill. See its VENDORED.md.
    expect(existsSync(".claude/skills/typesafe-ai/SKILL.md")).toBe(true);
    expect(existsSync(".claude/skills/typesafe-ai/LICENSE")).toBe(true);
  });

  it("keeps bouncer's own skill description off the classifier's territory", () => {
    // Two skills whose descriptions overlap is how a user gets the wrong one. Bouncer's
    // answers questions about this user's log and policy file; anything about Jev itself
    // belongs to the vendor's skill.
    const description = frontmatterField("skills/bouncer/SKILL.md", "description");
    expect(description).toMatch(/policy file/i);
    expect(description).toMatch(/log/i);
    expect(description).toMatch(/typesafe/i);
  });
});

/** The value of a single-line frontmatter field, which is all these files use. */
function frontmatterField(path: string, field: string): string {
  const text = readFileSync(path, "utf8");
  const match = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(text.split("---")[1] ?? "");
  return match?.[1] ?? "";
}

// The version is written in four places and a stale one is not cosmetic.
//
// Claude Code pins an installed plugin to the version string in plugin.json, so a fix
// merged without bumping it reaches nobody who has already installed. That makes the
// string load-bearing, and `--version` lying about it is how someone spends an afternoon
// debugging a fix they do not have.
describe("the version", () => {
  const manifest = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8")) as { version: string };

  it("matches between the plugin manifest and the package", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });

  it("is what the built bundle reports", () => {
    const printed = spawnSync(process.execPath, ["bin/bouncer.cjs", "--version"], { encoding: "utf8" });
    expect(printed.stdout.trim()).toBe(manifest.version);
  });

  it("is not the one the marketplace entry carries, because it carries none", () => {
    // plugin.json wins over a marketplace entry's version, so a second copy of the string
    // there would be a fifth place to forget. Keep the entry versionless.
    const market = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8")) as {
      plugins: readonly Record<string, unknown>[];
    };
    for (const entry of market.plugins) expect(entry["version"]).toBeUndefined();
  });
});
