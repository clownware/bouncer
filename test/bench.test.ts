// `npm run bench` must not write to the user's decision log.
//
// The bench spawns the hook a few hundred times over one hardcoded payload, answered by
// the mock adapter. Before this was pinned it set BOUNCER_BACKEND and CLAUDE_PLUGIN_ROOT
// but not CLAUDE_PLUGIN_DATA, so every spawn appended to ~/.bouncer/decisions.jsonl — the
// file `bouncer status` summarises, `calibrate --from` re-scores, and docs/adr/006's
// offline replay reads. Seventy of those lines were enough to make status report a 100%
// ask rate over traffic that never happened.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PREFIX = "bouncer-bench-";
const scratchDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith(PREFIX));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bouncer-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the bench script", () => {
  // Two runs of two cases is enough for the property; the numbers are not the point here.
  const bench = (home: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env["CLAUDE_PLUGIN_DATA"];
    delete env["BOUNCER_POLICY"];
    return spawnSync(process.execPath, ["scripts/bench.mjs", "--runs", "2", "--budget", "100000"], {
      encoding: "utf8",
      env,
    });
  };

  it("leaves no decision line in the home-directory log", () => {
    const before = scratchDirs();

    const r = bench(home);
    expect(r.status, r.stderr).toBe(0);

    // The whole defect, in one assertion: ~/.bouncer must not exist at all, since nothing
    // but bouncer itself creates it and the bench just ran a few dozen gated calls.
    expect(existsSync(join(home, ".bouncer"))).toBe(false);

    // And the scratch directory it used instead is not left behind.
    expect(scratchDirs().filter((name) => !before.includes(name))).toEqual([]);
  });

  // The second thing the bench got wrong, and the harder one to see.
  //
  // `--against` used to hand both arms one scratch CLAUDE_PLUGIN_DATA. The compiled policy
  // is cached there under a key that includes CACHE_VERSION (docs/adr/007), so two bundles
  // built either side of a bump overwrite each other's entry on every call: both arms run
  // uncached, both read about 32 ms slow, and the difference reported is the cold parse
  // rather than the path a user pays. Interleaving does not catch it — the pairing still
  // cancels machine drift, so the numbers look exactly as sound as any others.
  //
  // What is asserted here is the header, because that is what a person reads before
  // quoting a number: both versions, named, and a mismatch said out loud.
  it("names each bundle's cache version when arms are compared", () => {
    const other = join(home, "other.cjs");
    copyFileSync("bin/bouncer.cjs", other);
    const source = readFileSync(other, "utf8");
    expect(source).toMatch(/CACHE_VERSION = \d+/);
    writeFileSync(other, source.replace(/CACHE_VERSION = \d+/, "CACHE_VERSION = 9"), "utf8");

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env["CLAUDE_PLUGIN_DATA"];
    delete env["BOUNCER_POLICY"];
    const r = spawnSync(process.execPath, ["scripts/bench.mjs", "--against", other, "--runs", "2"], {
      encoding: "utf8",
      env,
    });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/policy cache version: before=9\s+after=\d+/);
    expect(r.stdout).toContain("one data directory per arm");
    expect(r.stdout).toContain("different cache entries");
    expect(r.stdout).toMatch(/paired median diff/);
  });

  // #73. An absolute budget measures the machine as much as the code: unchanged `main` read
  // p95 36 ms on a laptop, 102.0 ms on an agent container and 151.3 ms on a CI runner. So
  // the default run reports and does not judge, and the gate that fails a change is the
  // paired one, whose limit the caller supplies.
  describe("what fails it", () => {
    const run = (...args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      delete env["CLAUDE_PLUGIN_DATA"];
      delete env["BOUNCER_POLICY"];
      return spawnSync(process.execPath, ["scripts/bench.mjs", "--runs", "5", ...args], { encoding: "utf8", env });
    };

    // A stand-in arm. It is never asked to be a bouncer, only to be reliably quicker or
    // reliably slower than one, which is all the comparison reads.
    const arm = (name: string, body: string) => {
      const file = join(home, name);
      writeFileSync(file, body, "utf8");
      return file;
    };

    it("prints the 80 ms target without enforcing it", () => {
      const r = run();
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("target=80ms (not enforced)");
    });

    it("still fails on an absolute budget that was asked for", () => {
      const r = run("--budget", "0.001");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("exceeds budget 0.001ms");
    });

    it("fails when the bundle is slower than the other arm by more than the limit", () => {
      const r = run("--against", arm("quick.cjs", "process.exit(0);\n"), "--max-regression-pct", "0.001");
      expect(r.status, r.stdout).toBe(1);
      expect(r.stderr).toMatch(/FAIL: .* slower than .*quick\.cjs, over the 0\.001% limit/);
    });

    it("passes when the bundle is the quicker arm", () => {
      const slow = "const until = Date.now() + 60; while (Date.now() < until);\n";
      const r = run("--against", arm("slow.cjs", slow), "--max-regression-pct", "1");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("(limit +1%)");
    });

    // A gate that cannot be evaluated has to fail. NaN compares false against everything,
    // so a missing value used to be a budget nothing could exceed.
    it.each([
      [["--budget"], "--budget needs a positive number"],
      [["--max-regression-pct", "abc", "--against", "bin/bouncer.cjs"], "--max-regression-pct needs a positive number"],
      [["--max-regression-pct", "15"], "needs --against"],
    ])("refuses %j", (args, message) => {
      const r = run(...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
    });
  });
});
