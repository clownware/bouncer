// Tests spawn bin/bouncer.mjs, so build it first — otherwise a passing run can be
// testing a stale bundle.
import { spawnSync } from "node:child_process";

export default function setup() {
  const r = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("build failed before tests");
}
