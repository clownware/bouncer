// Bundles src/cli.ts into a single committed file at bin/bouncer.mjs.
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
  outfile: "bin/bouncer.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false, // keep it readable: users are being asked to trust this in their tool path
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  metafile: true,
});

const bytes = statSync("bin/bouncer.mjs").size;
console.log(`bin/bouncer.mjs  ${(bytes / 1024).toFixed(1)} KB`);

if (result.warnings.length > 0) {
  for (const w of result.warnings) console.warn(w.text);
}
