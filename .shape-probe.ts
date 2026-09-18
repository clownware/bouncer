import { readFileSync } from "node:fs";
import { loadPolicy } from "./src/engine/policy.js";
const shapeOf = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.length > 0 ? shapeOf(value[0]) : ""}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as object).sort().map((k) => `${k}:${shapeOf((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return typeof value;
};
const r = loadPolicy(readFileSync(process.argv[2]!, "utf8"));
console.log(JSON.stringify(r.diagnostics));
console.log(shapeOf(r.policy));
