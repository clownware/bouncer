import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadPolicy } from "./src/engine/policy.js";
const [, , policyPath, outPath] = process.argv as string[];
const source = readFileSync(policyPath!, "utf8");
const result = loadPolicy(source);
writeFileSync(`${outPath}.compare.json`, JSON.stringify({ source, result }));
writeFileSync(`${outPath}.hash.json`, JSON.stringify({ hash: createHash("sha256").update(source).digest("hex"), result }));
