import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The docs that enumerate things the code enumerates.
//
// `seatbelt` shipped with ADR-004 and `commands/mode.md` went on listing three modes for
// eleven days, steering a bypass-mode user to `guard`, which does nothing there. Nothing
// pinned the list. These tests read the enumerations out of the source and check that each
// document that claims to list them does. They are string checks over committed files and
// cost the hook nothing.

const read = (path: string): string => readFileSync(path, "utf8");

/** Every member of the `Mode` union in `src/engine/types.ts`. */
function modesInSource(): readonly string[] {
  const match = /export type Mode = ([^;]+);/.exec(read("src/engine/types.ts"));
  if (match?.[1] === undefined) throw new Error("Mode union not found in src/engine/types.ts");
  return [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1] as string);
}

/** Every subcommand `src/cli.ts` dispatches on, excluding `--version`. */
function subcommandsInSource(): readonly string[] {
  return [...read("src/cli.ts").matchAll(/^\s+case "([a-z]+)":/gm)].map((m) => m[1] as string);
}

describe("the modes", () => {
  const modes = modesInSource();

  it("are the four the tests expect, so a fifth updates this file too", () => {
    expect(modes).toEqual(["observe", "guard", "full", "seatbelt"]);
  });

  it("are all in /bouncer:mode's argument hint and body", () => {
    const text = read("commands/mode.md");
    const hint = /argument-hint:\s*"\[([^\]]+)\]"/.exec(text)?.[1] ?? "";
    expect(hint.split("|").sort()).toEqual([...modes].sort());
    for (const mode of modes) expect(text).toMatch(new RegExp(`\\*\\*${mode}\\*\\*`));
  });

  it("are all named in the bouncer skill", () => {
    const text = read("skills/bouncer/SKILL.md");
    for (const mode of modes) expect(text).toContain(`\`${mode}\``);
  });

  it("each have a row in the README's modes table", () => {
    const text = read("README.md");
    for (const mode of modes) expect(text).toMatch(new RegExp(`^\\| \`${mode}\`[^|]*\\|`, "m"));
  });

  it("are all described in the shipped policy's comments", () => {
    const text = read("policy/default.yaml");
    for (const mode of modes) expect(text).toMatch(new RegExp(`^# ${mode}:`, "m"));
  });
});

describe("the subcommands", () => {
  const subcommands = subcommandsInSource();

  it("are the ones the tests expect, so a new one updates this file too", () => {
    expect(subcommands).toEqual(["pretooluse", "status", "explain", "calibrate", "judge", "measure", "export", "skills"]);
  });

  it("are each named in the README, except the hook entry, which hooks.json names", () => {
    const readme = read("README.md");
    for (const command of subcommands) {
      if (command === "pretooluse") {
        expect(read("hooks/hooks.json")).toContain("bouncer.cjs\\\" pretooluse");
        continue;
      }
      // Any spelling a user meets: `bouncer x`, `bouncer.cjs x` or `/bouncer:x`.
      expect(readme).toMatch(new RegExp(`bouncer(:| |\\.cjs )${command}\\b`));
    }
  });
});
