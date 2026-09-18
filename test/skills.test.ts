// Discovery against a real directory tree.
//
// The tree is built here rather than committed, because what is being tested is the shape
// of the walk — which directories are skills, which are containers, and which are read
// from a manifest instead of walked. The manifests themselves are recorded fixtures
// (`test/fixtures/skills/`), since their field names are the part that came from reality
// rather than from a guess.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedDiscovery, discoverSkills, signatureOf } from "../src/io/skills.js";

const FIXTURES = join(__dirname, "fixtures", "skills");
const BUCKET = "b85a003e_cb4b071a";

let home: string;
let cwd: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bouncer-home-"));
  cwd = mkdtempSync(join(tmpdir(), "bouncer-cwd-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
}

function names(at: string = cwd): string[] {
  return discoverSkills(at).registry.skills.map((s) => s.qualifiedName);
}

describe("discoverSkills", () => {
  it("finds nothing, and does not throw, when there is no skills directory anywhere", () => {
    const discovery = discoverSkills(cwd);
    expect(discovery.registry.skills).toEqual([]);
    expect(discovery.registry.fingerprint).toBeTypeOf("string");
  });

  it("reads user skills from the documented location", () => {
    writeSkill(join(home, ".claude", "skills"), "session-start-hook", "Startup hooks.");
    expect(names()).toEqual(["session-start-hook"]);
  });

  // The trap this test exists for: `synced` lives inside `~/.claude/skills` and is a
  // container of buckets, not a skill. A plain walk offers the model a skill called
  // `synced`, which is a well-formed name for nothing.
  it("does not offer the synced container as if it were a skill", () => {
    const skills = join(home, ".claude", "skills");
    writeSkill(skills, "real-skill", "A real one.");
    mkdirSync(join(skills, "synced", BUCKET), { recursive: true });
    copyFileSync(join(FIXTURES, "skills-manifest.json"), join(skills, "synced", BUCKET, "manifest.json"));

    const found = names();
    expect(found).not.toContain("synced");
    expect(found).toContain("real-skill");
    expect(found.some((n) => n.startsWith("anthropic-skills:"))).toBe(true);
  });

  it("namespaces synced skills and takes their descriptions from the manifest", () => {
    const bucket = join(home, ".claude", "skills", "synced", BUCKET);
    mkdirSync(bucket, { recursive: true });
    copyFileSync(join(FIXTURES, "skills-manifest.json"), join(bucket, "manifest.json"));

    const skills = discoverSkills(cwd).registry.skills;
    expect(skills.length).toBeGreaterThan(0);
    // No SKILL.md was written anywhere, so a description here can only have come from the
    // manifest — which is the whole reason that path is preferred.
    expect(skills.every((s) => s.qualifiedName.startsWith("anthropic-skills:") && s.description.length > 0)).toBe(true);
  });

  describe("plugin buckets", () => {
    beforeEach(() => {
      const bucket = join(home, ".claude", "plugins", "synced", BUCKET);
      mkdirSync(bucket, { recursive: true });
      copyFileSync(join(FIXTURES, "plugins-manifest.json"), join(bucket, "manifest.json"));
      writeSkill(join(bucket, "marketing", "skills"), "brand-review", "Brand voice.");
      writeSkill(join(bucket, "engineering", "skills"), "code-review", "Reviews code.");
    });

    it("names plugin skills the way the model sees them", () => {
      expect(names()).toEqual(["engineering:code-review", "marketing:brand-review"]);
    });

    it("ignores directories the manifest does not list, however skill-shaped they look", () => {
      const bucket = join(home, ".claude", "plugins", "synced", BUCKET);
      writeSkill(join(bucket, "stale-clone", "skills"), "ghost", "From a plugin nobody installed.");
      expect(names()).not.toContain("stale-clone:ghost");
    });

    it("skips a plugin the manifest marks disabled", () => {
      const bucket = join(home, ".claude", "plugins", "synced", BUCKET);
      writeFileSync(
        join(bucket, "manifest.json"),
        JSON.stringify({
          plugins: [
            { name: "marketing", installationPreference: "disabled" },
            { name: "engineering", installationPreference: "available" },
          ],
        }),
      );
      expect(names()).toEqual(["engineering:code-review"]);
    });
  });

  it("prefers a project copy of a skill over a user one", () => {
    mkdirSync(join(cwd, ".git"), { recursive: true });
    writeSkill(join(cwd, ".claude", "skills"), "deploy", "The project's own.");
    writeSkill(join(home, ".claude", "skills"), "deploy", "The user's.");

    const skills = discoverSkills(cwd).registry.skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("The project's own.");
    expect(skills[0]?.origin).toBe("project");
  });

  it("ignores a project skills directory when there is no repository root above the cwd", () => {
    // No `.git`, so `<cwd>/.claude/skills` is not a project — matching how config.ts
    // decides whether a repo policy exists.
    writeSkill(join(cwd, ".claude", "skills"), "deploy", "Would be the project's.");
    expect(names()).toEqual([]);
  });

  it("reports which root each skill came from", () => {
    writeSkill(join(home, ".claude", "skills"), "alpha", "A.");
    const discovery = discoverSkills(cwd);
    const root = discovery.roots.find((r) => r.path.endsWith(join(".claude", "skills")));
    expect(root?.found).toBe(1);
  });
});

describe("signatureOf", () => {
  it("changes when a source file changes, and survives one going missing", () => {
    const file = join(home, "manifest.json");
    writeFileSync(file, '{"skills":[]}');
    const before = signatureOf([file]);

    writeFileSync(file, '{"skills":[{"name":"x","description":"X."}]}');
    expect(signatureOf([file])).not.toBe(before);

    rmSync(file);
    expect(signatureOf([file])).toContain("absent");
  });
});

describe("cachedDiscovery", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "bouncer-data-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the same registry on a second call", () => {
    writeSkill(join(home, ".claude", "skills"), "alpha", "A.");
    const first = cachedDiscovery(cwd, dataDir);
    const second = cachedDiscovery(cwd, dataDir);
    expect(second.registry.fingerprint).toBe(first.registry.fingerprint);
    expect(second.registry.skills.map((s) => s.qualifiedName)).toEqual(["alpha"]);
  });

  // The staleness bug ADR-002 warned about, tested rather than argued: a registry that
  // gained a skill must not keep serving the old option set, or the router suggests from
  // a list that no longer matches what the model can load.
  it("re-discovers when a new skill appears", () => {
    const skills = join(home, ".claude", "skills");
    writeSkill(skills, "alpha", "A.");
    expect(cachedDiscovery(cwd, dataDir).registry.skills).toHaveLength(1);

    writeSkill(skills, "beta", "B.");
    expect(cachedDiscovery(cwd, dataDir).registry.skills).toHaveLength(2);
  });

  it("does not serve one repository's registry to another", () => {
    mkdirSync(join(cwd, ".git"), { recursive: true });
    writeSkill(join(cwd, ".claude", "skills"), "project-only", "Here.");
    expect(cachedDiscovery(cwd, dataDir).registry.skills.map((s) => s.qualifiedName)).toEqual(["project-only"]);

    const other = mkdtempSync(join(tmpdir(), "bouncer-other-"));
    try {
      expect(cachedDiscovery(other, dataDir).registry.skills).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh discovery when the cache file is corrupt", () => {
    writeSkill(join(home, ".claude", "skills"), "alpha", "A.");
    writeFileSync(join(dataDir, "skills-cache.json"), "{not json");
    expect(cachedDiscovery(cwd, dataDir).registry.skills.map((s) => s.qualifiedName)).toEqual(["alpha"]);
  });

  it("does not throw when the data directory cannot be written", () => {
    writeSkill(join(home, ".claude", "skills"), "alpha", "A.");
    const unwritable = join(dataDir, "nested", "deeper");
    expect(() => cachedDiscovery(cwd, unwritable)).not.toThrow();
  });
});
