import { performance } from "node:perf_hooks";
const boot = performance.now();
import { readFileSync } from "node:fs";
import { loadPolicy } from "./src/engine/policy.js";

const mark = () => performance.now();
const out: Record<string, number> = { boot };
const [, , policyPath, cachePath, mode] = process.argv as string[];

let t = mark();
const source = readFileSync(policyPath!, "utf8");
out.readPolicy = mark() - t;

if (mode === "load") {
  t = mark();
  const r = loadPolicy(source);
  out.work = mark() - t;
  out.ok = r.policy ? 1 : 0;
} else if (mode === "compare") {
  // Cache holds {source, result}. Equality is the source text itself, so there is no
  // collision class to reason about and no hash to compute.
  t = mark();
  const raw = readFileSync(cachePath!, "utf8");
  const entry = JSON.parse(raw) as { source: string; result: { policy?: unknown } };
  const hit = entry.source === source;
  out.work = mark() - t;
  out.ok = hit && entry.result.policy ? 1 : 0;
} else if (mode === "hash") {
  t = mark();
  const { createHash } = require("node:crypto");
  out.cryptoRequire = mark() - t;
  let u = mark();
  const digest = createHash("sha256").update(source).digest("hex");
  out.digest = mark() - u;
  u = mark();
  const raw = readFileSync(cachePath!, "utf8");
  out.readCache = mark() - u;
  u = mark();
  const entry = JSON.parse(raw) as { hash: string; result: { policy?: unknown } };
  out.parseCache = mark() - u;
  const hit = entry.hash === digest;
  out.work = mark() - t;
  out.ok = hit && entry.result.policy ? 1 : 0;
}

out.total = mark();
process.stdout.write(JSON.stringify(out));
