import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The docs that enumerate things the code enumerates.
//
// `seatbelt` shipped with ADR-004 and `commands/mode.md` went on listing three modes for
// eleven days, steering a bypass-mode user to `guard`, which does nothing there. Nothing
// pinned the list. These tests read the enumerations out of the source and check that each
// document that claims to list them does. They are string checks over committed files and
// cost the hook nothing.

const read = (path: string): string => readFileSync(path, "utf8");

// What a failure prints. A title is read by whoever runs the suite; a message is read by
// whoever is about to edit past the assertion, which may be an agent that never opened the
// document the test is guarding. So each message names the list, the file it lives in and
// the edit that makes it true again (docs/adr/012, decision 2).
const listed = (what: string, where: string): string =>
  `${where} does not list every ${what} the source defines. Add the missing one to ${where}; ` +
  `do not shorten the list in this test. Why this is pinned: the header of test/docs.test.ts.`;

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
    expect(
      modes,
      "The Mode union in src/engine/types.ts changed. A mode is a user-facing promise " +
        "(docs/adr/003, docs/adr/004): update this list in the same change as commands/mode.md, " +
        "skills/bouncer/SKILL.md, the README's modes table and policy/default.yaml's comments.",
    ).toEqual(["observe", "guard", "full", "seatbelt"]);
  });

  it("are all in /bouncer:mode's argument hint and body", () => {
    const text = read("commands/mode.md");
    const hint = /argument-hint:\s*"\[([^\]]+)\]"/.exec(text)?.[1] ?? "";
    expect(hint.split("|").sort(), listed("mode", "commands/mode.md's argument-hint")).toEqual([...modes].sort());
    for (const mode of modes) {
      expect(text, listed("mode", "commands/mode.md")).toMatch(new RegExp(`\\*\\*${mode}\\*\\*`));
    }
  });

  it("are all named in the bouncer skill", () => {
    const text = read("skills/bouncer/SKILL.md");
    for (const mode of modes) expect(text, listed("mode", "skills/bouncer/SKILL.md")).toContain(`\`${mode}\``);
  });

  it("each have a row in the README's modes table", () => {
    const text = read("README.md");
    for (const mode of modes) {
      expect(text, listed("mode", "README.md's modes table")).toMatch(new RegExp(`^\\| \`${mode}\`[^|]*\\|`, "m"));
    }
  });

  it("are all described in the shipped policy's comments", () => {
    const text = read("policy/default.yaml");
    for (const mode of modes) {
      expect(text, listed("mode", "policy/default.yaml's header comments")).toMatch(new RegExp(`^# ${mode}:`, "m"));
    }
  });
});

describe("the subcommands", () => {
  const subcommands = subcommandsInSource();

  it("are the ones the tests expect, so a new one updates this file too", () => {
    expect(
      subcommands,
      "The subcommands src/cli.ts dispatches on changed. Update this list and name the new one " +
        "in README.md in the same change. A new hook entrypoint is also a decision with its own " +
        "record: `userpromptsubmit` is docs/adr/006, accepted and not built.",
    ).toEqual(["pretooluse", "status", "explain", "calibrate", "judge", "measure", "export", "skills"]);
  });

  it("are each named in the README, except the hook entry, which hooks.json names", () => {
    const readme = read("README.md");
    for (const command of subcommands) {
      if (command === "pretooluse") {
        expect(read("hooks/hooks.json"), "hooks/hooks.json no longer runs `bouncer.cjs pretooluse`").toContain(
          "bouncer.cjs\\\" pretooluse",
        );
        continue;
      }
      // Any spelling a user meets: `bouncer x`, `bouncer.cjs x` or `/bouncer:x`.
      expect(readme, listed("subcommand", "README.md")).toMatch(new RegExp(`bouncer(:| |\\.cjs )${command}\\b`));
    }
  });
});

// The records, and the index that routes to them.
//
// docs/adr/README.md is what CLAUDE.md points a reader at, and a reader takes its `status`
// column as the answer to "is this decided, and is it built". Nothing pinned it to the files:
// a record added without a row is a decision nobody is routed to, and a row whose status
// lags its file says "accepted" about something the file has since marked otherwise. Same
// class as the mode list above, which went stale for eleven days.
//
// These are checks on shape, not on substance, and docs/adr/012 says why nothing stronger
// exists: correcting a record in place is the normal edit here, so the files are not frozen.
// What is pinned is that the index and the files tell one story.
describe("the decision records", () => {
  const DIR = "docs/adr";
  const files = readdirSync(DIR)
    .filter((name) => /^\d{3}-.+\.md$/.test(name))
    .sort();
  const index = read(`${DIR}/README.md`);

  /** `| [NNN](file.md) | decides | status | changed by |`, one per record. */
  const rows = [...index.matchAll(/^\| \[(\d{3})\]\(([^)]+)\) \|[^|]*\| ([^|]*) \|/gm)].map((m) => ({
    number: m[1] as string,
    file: m[2] as string,
    status: (m[3] as string).trim(),
  }));

  /** The first word of a status, which is the part the index and the file must agree on. */
  const head = (status: string): string => /^[a-z]+/.exec(status.toLowerCase())?.[0] ?? "";

  const statusIn = (file: string): string =>
    /^- \*\*Status:\*\* (.+)$/m.exec(read(`${DIR}/${file}`))?.[1] ?? "";

  it("are numbered from 001 with no gap and no number used twice", () => {
    expect(
      files.map((name) => name.slice(0, 3)),
      `${DIR} must hold one record per number, in order. A used number is never reused and a ` +
        `record is never deleted (${DIR}/README.md); a decision that changed is corrected in place.`,
    ).toEqual(files.map((_, i) => String(i + 1).padStart(3, "0")));
  });

  it("each have exactly one row in the index, and the index has no row without a file", () => {
    expect(
      rows.map((row) => row.file),
      `${DIR}/README.md's table and the files in ${DIR} disagree. Add a row for a new record, ` +
        `or fix the link; the index is how a reader finds a decision.`,
    ).toEqual(files);
    for (const row of rows) expect(row.file.startsWith(`${row.number}-`), `row ${row.number} links ${row.file}`).toBe(true);
  });

  it.each(files)("%s opens with its own number and a status line", (file) => {
    const text = read(`${DIR}/${file}`);
    expect(text, `${file} must open with \`# ADR-${file.slice(0, 3)}: …\``).toMatch(
      new RegExp(`^# ADR-${file.slice(0, 3)}: `),
    );
    expect(
      head(statusIn(file)),
      `${file} needs a \`- **Status:** …\` line that starts with proposed, accepted, superseded or rejected`,
    ).toMatch(/^(proposed|accepted|superseded|rejected)$/);
  });

  it.each(rows)("the index says what $file says about its own status", ({ file, status }) => {
    expect(
      head(status),
      `${DIR}/README.md's status for ${file} must start with the same word as the file's own ` +
        `Status line ("${statusIn(file)}"). Change the index when the record changes.`,
    ).toBe(head(statusIn(file)));
  });
});
