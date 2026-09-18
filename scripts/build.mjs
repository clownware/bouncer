// Bundles src/cli.ts into a single committed file at bin/bouncer.cjs.
//
// The bundle is committed on purpose: Claude Code installs plugins by fetching
// the repo and does not run `npm install`, so anything the hook needs at runtime
// has to already be on disk. See docs/adr/002-bundled-single-file.md.
//
// Bundling is also the single biggest thing we do for hook latency. Measured on
// Node 22 (scripts/bench.mjs): bundled ~45 ms, the same code resolving modules
// from node_modules ~87 ms. Nearly all of the gap is module resolution, not parsing.

import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";

mkdirSync("bin", { recursive: true });

const result = await build({
  entryPoints: ["src/cli.ts"],
  outfile: "bin/bouncer.cjs",
  bundle: true,
  platform: "node",
  // CommonJS output, not ESM. `yaml` — and most of npm — resolves its `node` export
  // condition to a CommonJS build whose internal `require()` calls cannot be satisfied
  // inside an ESM bundle; esbuild emits a shim that throws "Dynamic require of process is
  // not supported" at startup. Targeting CJS sidesteps that for every dependency rather
  // than for this one, and a CommonJS bundle initialises marginally faster too. The file
  // is named .cjs because package.json sets "type": "module".
  format: "cjs",
  target: "node20",
  minify: false, // keep it readable: users are being asked to trust this in their tool path
  banner: { js: "#!/usr/bin/env node" },
  // Prefer a dependency's ESM entry. Without this esbuild resolves `yaml` to its CommonJS
  // build, whose internal `require("process")` cannot be satisfied in an ESM bundle and
  // throws at startup — a crash that only appears once something actually imports yaml,
  // which is why a bundle-only smoke test is part of the test suite.
  legalComments: "none",
  metafile: true,
});

const bytes = statSync("bin/bouncer.cjs").size;
console.log(`bin/bouncer.cjs  ${(bytes / 1024).toFixed(1)} KB`);

if (result.warnings.length > 0) {
  for (const w of result.warnings) console.warn(w.text);
}
