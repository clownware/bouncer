import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseFlags, positiveInteger } from "../src/commands/args.js";
import { parseArgs as calibrateArgs } from "../src/commands/calibrate.js";
import { parseArgs as judgeArgs } from "../src/commands/judge.js";
import { parseArgs as measureArgs } from "../src/commands/measure.js";

const SPEC = { values: ["backend", "out"], switches: ["json"], positionals: 1 } as const;

describe("parseFlags", () => {
  it("reads values, switches and the positional", () => {
    const parsed = parseFlags(["batch.jsonl", "--backend", "mock", "--json"], SPEC);
    expect(parsed.error).toBeUndefined();
    expect(parsed.values.get("backend")).toBe("mock");
    expect(parsed.switches.has("json")).toBe(true);
    expect(parsed.positionals).toEqual(["batch.jsonl"]);
  });

  it("reads --name=value the same as --name value", () => {
    const parsed = parseFlags(["--backend=mock", "--out=a=b.jsonl"], SPEC);
    expect(parsed.error).toBeUndefined();
    expect(parsed.values.get("backend")).toBe("mock");
    expect(parsed.values.get("out")).toBe("a=b.jsonl");
  });

  const refused: [string, string[], string][] = [
    ["a flag that does not exist", ["--bogus", "x"], 'Unknown flag "--bogus"'],
    ["a typo of one that does", ["--backned", "mock"], 'Unknown flag "--backned"'],
    ["a typo spelled with =", ["--backned=mock"], 'Unknown flag "--backned=mock"'],
    ["a short flag", ["-j"], 'Unknown flag "-j"'],
    ["a value flag at the end", ["--backend"], "--backend needs a value"],
    ["a value flag followed by a flag", ["--out", "--json"], "--out needs a value"],
    ["an empty value", ["--out="], "--out needs a value"],
    ["a switch given a value", ["--json=yes"], "--json does not take a value"],
    ["a second positional", ["a.jsonl", "b.jsonl"], 'Unexpected argument "b.jsonl"'],
  ];

  it.each(refused)("refuses %s", (_, argv, message) => {
    const { error } = parseFlags(argv, SPEC);
    expect(error).toContain(message);
    // The way out is on the same screen as the refusal.
    expect(error).toContain("--backend <value>");
    expect(error).toContain("--json");
  });

  it("refuses any positional when the command takes none", () => {
    expect(parseFlags(["stray"], { values: [], switches: [] }).error).toContain('Unexpected argument "stray"');
  });
});

describe("positiveInteger", () => {
  it.each([["4", 4], ["1", 1]])("accepts %s", (raw, value) => {
    expect(positiveInteger("concurrency", raw)).toEqual({ value });
  });

  it.each(["abc", "0", "-2", "1.5", ""])("refuses %j", (raw) => {
    expect(positiveInteger("concurrency", raw).error).toContain("--concurrency needs a whole number");
  });

  it("is silent about a flag that was not given", () => {
    expect(positiveInteger("concurrency", undefined)).toEqual({});
  });
});

describe("the commands' own parsers", () => {
  it("calibrate takes no positional and knows --policy", () => {
    expect(calibrateArgs(["--policy", "p.yaml", "--backend", "mock"])).toMatchObject({ policy: "p.yaml", backend: "mock" });
    expect(calibrateArgs(["--policy", "p.yaml"]).error).toBeUndefined();
    expect(calibrateArgs(["fixtures.jsonl"]).error).toContain("Unexpected argument");
    expect(calibrateArgs(["--backned", "mock"]).error).toContain("Unknown flag");
  });

  it("judge refuses a concurrency that is not a number", () => {
    expect(judgeArgs(["b.jsonl", "--concurrency", "4"])).toMatchObject({ path: "b.jsonl", concurrency: 4 });
    expect(judgeArgs(["b.jsonl", "--concurrency", "abc"]).error).toContain("whole number");
    expect(judgeArgs(["b.jsonl", "--fixtures", "x"]).error).toContain('Unknown flag "--fixtures"');
  });

  it("measure refuses fixtures named both ways", () => {
    expect(measureArgs(["f.jsonl"]).fixtures).toBe("f.jsonl");
    expect(measureArgs(["--fixtures", "f.jsonl"]).fixtures).toBe("f.jsonl");
    expect(measureArgs(["g.jsonl", "--fixtures", "f.jsonl"]).error).toContain("named twice");
  });
});

// Through the built bundle, because "the parser returns an error" and "the command did not
// run" are different claims, and the second is the one a billed backend cares about.
describe("bin/bouncer.cjs", () => {
  const BIN = resolve("bin/bouncer.cjs");
  const dir = mkdtempSync(join(tmpdir(), "bouncer-args-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: dir,
    CLAUDE_PLUGIN_ROOT: resolve("."),
    CLAUDE_PLUGIN_DATA: dir,
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });

  it.each([
    ["calibrate", ["calibrate", "--backned", "mock"]],
    ["judge", ["judge", "test/fixtures/batch.jsonl", "--backned", "mock"]],
    ["measure", ["measure", "fixtures/gate.jsonl", "--backned", "mock"]],
  ])("%s exits 1 on a mistyped flag, and says which", (_, args) => {
    const r = run(...args);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Unknown flag "--backned"');
    expect(r.stdout).toContain("--backend <value>");
  });

  it("calibrate --policy scores against the file it names", () => {
    const policy = join(dir, "named.yaml");
    writeFileSync(policy, readFileSync("policy/default.yaml", "utf8"), "utf8");

    const named = run("calibrate", "--backend", "mock", "--json", "--policy", policy);
    expect(named.status).toBe(0);
    expect(JSON.parse(named.stdout).policy).toBe(policy);

    // And without the flag the same command reports the bundled one, so the line above is
    // the flag's doing and not a constant.
    const bundled = run("calibrate", "--backend", "mock", "--json");
    expect(JSON.parse(bundled.stdout).policy).toBe(resolve("policy/default.yaml"));
  });

  it("--policy wins over $BOUNCER_POLICY", () => {
    const policy = join(dir, "flag.yaml");
    writeFileSync(policy, readFileSync("policy/default.yaml", "utf8"), "utf8");
    const r = spawnSync(process.execPath, [BIN, "calibrate", "--backend", "mock", "--json", "--policy", policy], {
      encoding: "utf8",
      env: { ...env, BOUNCER_POLICY: resolve("policy/default.yaml") },
    });
    expect(JSON.parse(r.stdout).policy).toBe(policy);
  });

  it("calibrate --policy refuses a file that is not there rather than falling back", () => {
    const missing = join(dir, "nope.yaml");
    const r = run("calibrate", "--backend", "mock", "--policy", missing);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(missing);
    expect(r.stdout).toContain("could not be read");
  });
});
