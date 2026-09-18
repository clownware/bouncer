// Registry building: namespacing, precedence, dedupe, and the frontmatter parse.
//
// Table-driven, and the tables are written to punish the mistakes that would actually ship
// rather than the ones that are easy to assert. Three of them:
//
//   - a bare name instead of a namespaced one, which is a perfectly well-formed string
//     that refers to nothing the model knows;
//   - a regex frontmatter parse, which gets a real quoted multi-line description wrong
//     quietly and mis-routes the skill;
//   - a `synced` container directory offered as if it were a skill.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRegistry,
  criteriaFor,
  MAX_DESCRIPTION_CHARS,
  parseFrontmatter,
  parsePluginManifest,
  parseSkillsManifest,
  pluginIsActive,
  type RawSkill,
} from "../src/engine/registry.js";

const FIXTURES = join(__dirname, "fixtures", "skills");

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# body\n`;
}

describe("parseFrontmatter", () => {
  // The single-quoted case is recorded from a real skill. A regex keyed on `description:`
  // up to end-of-line truncates it at the first newline and keeps a fragment, which is
  // both wrong and silently plausible — exactly the shape of bug that survives review.
  const quotedMultiline = [
    "---",
    "name: docs",
    "description: 'docs (living docs people share, comment on and edit; use only when the user",
    "  asks for one: names a doc, memo or PRD), or says yes to your doc offer; a .docx asked",
    "  for by name → that format''s skill.'",
    "---",
    "",
    "body",
  ].join("\n");

  const cases: ReadonlyArray<readonly [string, string, { name?: string; description?: string }]> = [
    ["plain", frontmatter("alpha", "Does a thing."), { name: "alpha", description: "Does a thing." }],
    [
      "quoted multi-line with colons, arrows and an escaped quote",
      quotedMultiline,
      {
        name: "docs",
        description:
          "docs (living docs people share, comment on and edit; use only when the user asks for one: names a doc, memo or PRD), or says yes to your doc offer; a .docx asked for by name → that format's skill.",
      },
    ],
    ["crlf line endings", "---\r\nname: beta\r\ndescription: Beta.\r\n---\r\nbody", { name: "beta", description: "Beta." }],
    ["leading byte order mark", "﻿---\nname: gamma\ndescription: Gamma.\n---\n", { name: "gamma", description: "Gamma." }],
    ["no frontmatter at all", "# just a heading\n", {}],
    ["unterminated frontmatter", "---\nname: delta\n", {}],
    ["malformed yaml inside", "---\nname: [unclosed\n---\n", {}],
    ["frontmatter that is not a mapping", "---\n- a\n- b\n---\n", {}],
    ["non-string description", "---\nname: eps\ndescription: 42\n---\n", { name: "eps" }],
  ];

  for (const [label, text, expected] of cases) {
    it(label, () => {
      expect(parseFrontmatter(text)).toEqual(expected);
    });
  }
});

describe("buildRegistry", () => {
  it("namespaces plugin and synced skills, and leaves user and project skills bare", () => {
    const registry = buildRegistry([
      { namespace: "marketing", dirName: "brand-review", origin: "plugin", frontmatter: frontmatter("brand-review", "Brand voice.") },
      { namespace: "anthropic-skills", dirName: "docs", origin: "synced-skill", description: "Living docs." },
      { dirName: "session-start-hook", origin: "user", frontmatter: frontmatter("session-start-hook", "Startup hooks.") },
      { dirName: "deploy", origin: "project", frontmatter: frontmatter("deploy", "Ship it.") },
    ]);

    expect(registry.skills.map((s) => s.qualifiedName)).toEqual([
      "anthropic-skills:docs",
      "deploy",
      "marketing:brand-review",
      "session-start-hook",
    ]);
  });

  it("prefers the nearest copy when the same qualified name is found twice", () => {
    const registry = buildRegistry([
      { namespace: "team", dirName: "review", origin: "plugin", frontmatter: frontmatter("review", "From the plugin.") },
      { namespace: "team", dirName: "review", origin: "project", frontmatter: frontmatter("review", "From the project.") },
    ]);

    expect(registry.skills).toHaveLength(1);
    expect(registry.skills[0]?.description).toBe("From the project.");
    expect(registry.skills[0]?.origin).toBe("project");
    expect(registry.duplicates).toEqual(["team:review"]);
  });

  it("keeps the first copy when precedence ties, and reports the duplicate either way", () => {
    const registry = buildRegistry([
      { namespace: "team", dirName: "review", origin: "plugin", description: "Version one." },
      { namespace: "team", dirName: "review", origin: "plugin", description: "Version two." },
    ]);

    expect(registry.skills).toHaveLength(1);
    expect(registry.skills[0]?.description).toBe("Version one.");
    expect(registry.duplicates).toEqual(["team:review"]);
  });

  // A description is not decoration here: it *is* the criteria text the classifier reasons
  // over, so an option without one is an option that cannot be chosen for a good reason.
  it("drops candidates with no readable description", () => {
    const registry = buildRegistry([
      { dirName: "no-frontmatter", origin: "user", frontmatter: "# nothing here\n" },
      { dirName: "empty-description", origin: "user", frontmatter: "---\nname: x\ndescription: '   '\n---\n" },
      { dirName: "nothing-at-all", origin: "user" },
      { dirName: "fine", origin: "user", description: "Usable." },
    ]);

    expect(registry.skills.map((s) => s.qualifiedName)).toEqual(["fine"]);
  });

  it("drops a candidate with an empty directory name rather than emitting a bare namespace", () => {
    const registry = buildRegistry([
      { namespace: "team", dirName: "   ", origin: "plugin", description: "Nameless." },
    ]);
    expect(registry.skills).toEqual([]);
  });

  it("prefers a manifest description over frontmatter, since the manifest is the live record", () => {
    const registry = buildRegistry([
      { dirName: "x", origin: "user", description: "From the manifest.", frontmatter: frontmatter("x", "From the file.") },
    ]);
    expect(registry.skills[0]?.description).toBe("From the manifest.");
  });

  describe("description truncation", () => {
    it("collapses whitespace and leaves short descriptions alone", () => {
      const registry = buildRegistry([{ dirName: "x", origin: "user", description: "One.  Two.\n  Three." }]);
      expect(registry.skills[0]?.description).toBe("One. Two. Three.");
    });

    it("cuts at a late sentence boundary", () => {
      const description = `${"a".repeat(120)}. ${"b".repeat(200)}`;
      const got = registry1(description);
      expect(got.endsWith(".")).toBe(true);
      expect(got.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
      expect(got).not.toContain("b");
    });

    // The `docs` description opens with "docs (living docs people share, comment on and
    // edit; use only when..." — its first period is far too early, and honouring it would
    // leave a few words. A hard cut keeps more signal than a faithful sentence boundary.
    it("falls back to a hard cut when the only sentence boundary is early", () => {
      const got = registry1(`Short. ${"c".repeat(400)}`);
      expect(got.endsWith("…")).toBe(true);
      expect(got.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS + 1);
      expect(got).toContain("c");
    });

    function registry1(description: string): string {
      return buildRegistry([{ dirName: "x", origin: "user", description }]).skills[0]?.description ?? "";
    }
  });

  describe("fingerprint", () => {
    const a: RawSkill = { dirName: "a", origin: "user", description: "A." };
    const b: RawSkill = { dirName: "b", origin: "user", description: "B." };

    it("is stable across discovery order, because the registry is sorted", () => {
      expect(buildRegistry([a, b]).fingerprint).toBe(buildRegistry([b, a]).fingerprint);
    });

    // This is the property the observe-mode record depends on: if the registry changed,
    // replaying a logged prompt against it is a different experiment, and the fingerprint
    // is what makes that visible instead of silent.
    it("changes when a skill appears or disappears", () => {
      expect(buildRegistry([a, b]).fingerprint).not.toBe(buildRegistry([a]).fingerprint);
    });

    it("does not change when only a description is edited", () => {
      const edited: RawSkill = { dirName: "a", origin: "user", description: "A, reworded." };
      expect(buildRegistry([a]).fingerprint).toBe(buildRegistry([edited]).fingerprint);
    });
  });

  it("criteriaFor keys the map by the name the answer comes back under", () => {
    const registry = buildRegistry([
      { namespace: "marketing", dirName: "brand-review", origin: "plugin", description: "Brand voice." },
    ]);
    expect(criteriaFor(registry)).toEqual({ "marketing:brand-review": "Brand voice." });
  });
});

describe("manifest parsing", () => {
  it("reads the recorded plugin manifest", () => {
    const json = readFileSync(join(FIXTURES, "plugins-manifest.json"), "utf8");
    const plugins = parsePluginManifest(json);

    expect(plugins.map((p) => p.name)).toContain("marketing");
    expect(plugins.every((p) => p.installationPreference === "available")).toBe(true);
  });

  it("reads the recorded skills manifest, which carries descriptions inline", () => {
    const json = readFileSync(join(FIXTURES, "skills-manifest.json"), "utf8");
    const skills = parseSkillsManifest(json);

    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.name.length > 0 && s.description.length > 0)).toBe(true);
  });

  const garbage: ReadonlyArray<readonly [string, string]> = [
    ["not json", "{nope"],
    ["not an object", "[]"],
    ["missing the key", '{"other": []}'],
    ["key is not an array", '{"plugins": {}}'],
    ["entries are not objects", '{"plugins": ["marketing"]}'],
    ["entries missing names", '{"plugins": [{"pluginId": "x"}]}'],
  ];

  for (const [label, json] of garbage) {
    it(`returns nothing for ${label}`, () => {
      expect(parsePluginManifest(json)).toEqual([]);
      expect(parseSkillsManifest(json)).toEqual([]);
    });
  }

  it("skips manifest skills that have no description", () => {
    expect(parseSkillsManifest('{"skills":[{"name":"x"},{"name":"y","description":"Y."}]}')).toEqual([
      { name: "y", description: "Y." },
    ]);
  });
});

describe("pluginIsActive", () => {
  // Asymmetric on purpose. Wrongly excluding a plugin removes options and produces the
  // confident wrong pick this whole module exists to prevent; wrongly including one costs
  // a few tokens and a suggestion the user ignores. So unknown values are included.
  const cases: ReadonlyArray<readonly [string | undefined, boolean]> = [
    ["available", true],
    ["enabled", true],
    ["Available", true],
    [undefined, true],
    ["something-new", true],
    ["disabled", false],
    ["uninstalled", false],
    ["none", false],
  ];

  for (const [preference, expected] of cases) {
    it(`${preference ?? "(absent)"} → ${expected ? "active" : "inactive"}`, () => {
      expect(pluginIsActive({ name: "p", ...(preference === undefined ? {} : { installationPreference: preference }) })).toBe(expected);
    });
  }
});
