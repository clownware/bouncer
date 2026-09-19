// `npm run bench` must not write to the user's decision log.
//
// The bench spawns the hook a few hundred times over one hardcoded payload, answered by
// the mock adapter. Before this was pinned it set BOUNCER_BACKEND and CLAUDE_PLUGIN_ROOT
// but not CLAUDE_PLUGIN_DATA, so every spawn appended to ~/.bouncer/decisions.jsonl — the
// file `bouncer status` summarises, `calibrate --from` re-scores, and docs/adr/006's
// offline replay reads. Seventy of those lines were enough to make status report a 100%
// ask rate over traffic that never happened.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
});
