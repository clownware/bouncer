// The log-to-fixtures exporter: real gated calls, in the shape `calibrate` reads.
//
// The hand-written fixtures are near-miss pairs chosen to sit on the boundary, which is
// what makes 104 of them informative. They are also 104 guesses about what an agent does.
// The decision log is what it actually did, and it already carries the two things a fixture
// needs from it: the state the classifier was shown, and, for a judged call, what it said.
//
// What the log does not carry is the tool input. It stores the *built* state, redacted, and
// the state builder throws away file contents by design (PRD §9). So an exported fixture is
// a tool input reconstructed from the state, and the one test that makes that honest is
// run on every line: rebuilding the fixture's state with `stateFor` must give back the
// state the classifier was shown, less the few fields a fixture has no place for. A line
// that does not round-trip is skipped and counted, never approximated. Write and Edit contents are filler of the logged byte
// count, which is the only fact about them the state ever held.
//
// Pure, like the engine: it takes parsed records and returns candidates. Reading the log
// and writing the file are the command's business (src/commands/export.ts).

import { redact } from "./engine/redact.js";
import { stateFor, type Fixture } from "./calibrate.js";
import type { DecisionRecord } from "./io/log.js";

/**
 * Fields of a logged state no fixture can carry, left out of the round-trip comparison.
 *
 * `ToolCallItem` has no field for a subagent type, and the hook passes neither recent tools
 * nor git facts today; a line an older build wrote with them still exports, without them.
 */
const UNCARRIED = ["running_as_subagent", "recent_tools", "git_branch", "git_dirty"] as const;

/**
 * Directories an out-of-project path is tried under.
 *
 * Outside the project the log keeps only the basename plus two computed labels, where it
 * lives and whether it is sensitive, so the directory is gone. Any directory that yields
 * the same labels yields the same state, and the round-trip check picks the first that does.
 */
const OUTSIDE_DIRS: readonly string[] = [
  "/etc",
  "/tmp",
  "/srv/elsewhere",
  "/home/user",
  "/home/user/.config",
  "/home/user/.ssh",
  "/home/user/.aws",
  "/home/user/.gnupg",
  "/home/user/.kube",
  "/home/user/.docker",
  "/home/user/elsewhere/.git",
  "/home/user/elsewhere/.github/workflows",
];

export interface Candidate {
  /** The first call's `tool_use_id`: what `calibrate --from` joins a gate line on. */
  readonly id: string;
  readonly tool: string;
  /**
   * `/home/user/<project>`: the directory name is the only part of the working directory the
   * log keeps, and it is kept because the classifier reads it — `lint-in-production-api` in
   * the gate fixtures exists because a project's name can move `prod`.
   */
  readonly cwd?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly permission_mode?: string;
  readonly target_exists?: boolean;
  /** How many logged calls rebuilt to this same state. */
  readonly seen: number;
  readonly first: string;
  readonly last: string;
}

export interface ExportResult {
  readonly candidates: readonly Candidate[];
  /** Lines read, and why each one that did not become a candidate was left out. */
  readonly read: number;
  readonly skipped: {
    /** A `judge` line: an item, not a tool call. */
    readonly notGate: number;
    /** A fast-path hit or an error line. Neither stores a state. */
    readonly noState: number;
    /** Answered by the mock, whose verdicts are keyword heuristics. */
    readonly mock: number;
    /** No `tool_use_id`, so nothing could join the logged answers back to it. */
    readonly noId: number;
    /** Over the state cap: the classifier saw the head of it, and a fixture cannot say so. */
    readonly truncated: number;
    /** The state did not parse, or did not rebuild to the state it records. */
    readonly unrebuildable: number;
    /** The same state as an earlier line. Counted into that candidate's `seen`. */
    readonly duplicate: number;
    /** The same tool and action as a fixture already in the known set. */
    readonly known: number;
  };
  /** Candidates whose command or path held something the current patterns redact and the logged line did not. */
  readonly redactedOnExport: number;
}

export interface ExportOptions {
  /** Keep lines the mock answered. True only when the policy names `mock` itself, as in `status`. */
  readonly keepMock?: boolean;
  /** Fixtures already written. A call that builds the same action as one of these is skipped. */
  readonly known?: readonly Fixture[];
}

export function exportCandidates(records: readonly DecisionRecord[], options: ExportOptions = {}): ExportResult {
  const skipped = { notGate: 0, noState: 0, mock: 0, noId: 0, truncated: 0, unrebuildable: 0, duplicate: 0, known: 0 };
  let redactedOnExport = 0;

  // Known fixtures are matched on the tool and the action alone. A hand-written fixture
  // names no permission mode and every logged call carries one, so matching whole states
  // would never find `rm -rf node_modules` in the fixtures that already have it.
  const knownActions = new Set(
    (options.known ?? []).filter((f) => f.kind === "tool_call").map((f) => actionKey(stateFor(f).text)),
  );
  const byState = new Map<string, { -readonly [K in keyof Candidate]: Candidate[K] }>();

  for (const record of records) {
    if ((record.consumer ?? "gate") !== "gate" || typeof record.tool !== "string") {
      skipped.notGate += 1;
      continue;
    }
    if (record.state === undefined) {
      skipped.noState += 1;
      continue;
    }
    if (record.backend === "mock" && options.keepMock !== true) {
      skipped.mock += 1;
      continue;
    }
    if (record.tool_use_id === undefined) {
      skipped.noId += 1;
      continue;
    }
    if (record.truncated === true) {
      skipped.truncated += 1;
      continue;
    }

    const rebuilt = rebuild(record, record.tool);
    if (rebuilt === undefined) {
      skipped.unrebuildable += 1;
      continue;
    }

    const existing = byState.get(rebuilt.state);
    if (existing !== undefined) {
      skipped.duplicate += 1;
      existing.seen += 1;
      if (record.ts > existing.last) existing.last = record.ts;
      continue;
    }
    if (knownActions.has(actionKey(rebuilt.state))) {
      skipped.known += 1;
      continue;
    }

    if (rebuilt.redacted) redactedOnExport += 1;
    byState.set(rebuilt.state, { ...rebuilt.item, id: record.tool_use_id, seen: 1, first: record.ts, last: record.ts });
  }

  return { candidates: [...byState.values()], read: records.length, skipped, redactedOnExport };
}

/**
 * One candidate as a fixture line, commented out.
 *
 * Commented because it is not a fixture yet: `parseFixtures` skips `//` lines, so a file of
 * these loads at every stage of labelling, and a line uncommented without labels still
 * fails loudly on its empty `expect` rather than scoring nothing in silence. The key order
 * is `fixtures/gate.jsonl`'s. The classifier's answers are left out on purpose: a label
 * written while looking at the number it will be scored against is not independent of it.
 */
export function candidateLine(c: Candidate): string {
  const fixture = {
    id: c.id,
    tool: c.tool,
    ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
    input: c.input,
    ...(c.permission_mode !== undefined ? { permission_mode: c.permission_mode } : {}),
    ...(c.target_exists !== undefined ? { target_exists: c.target_exists } : {}),
    expect: {},
    note: `UNLABELLED. Logged ${c.seen === 1 ? "once" : `${c.seen} times`}, first ${c.first.slice(0, 10)}. Replace with why the label is what it is.`,
  };
  return `// ${JSON.stringify(fixture)}`;
}

export const HEADER = `// Candidate fixtures exported from a bouncer decision log by \`bouncer export\`.
//
// Every line is commented out because none is labelled yet, and a fixture with no labels
// scores nothing. To promote one: put the questions it clearly demonstrates in \`expect\`,
// replace the note with why the label is what it is, and delete the leading \`// \`. A line
// uncommented with \`expect\` still empty refuses to load and says so.
//
// Each line is a real call, rebuilt from the redacted state the log kept, and checked to
// rebuild the state the classifier was shown. Write and Edit contents are filler of
// the logged size, because the log never held the contents. A path outside the project is
// the logged file name under a representative directory with the same labels, because the
// log kept only the name. The project's directory name is carried over, because the
// classifier reads it; the subagent type is not, because a fixture has nowhere to put it.
//
// The id is the call's tool_use_id, which is what \`calibrate --from\` joins a gate log on,
// so the answers the log already holds score against these labels with no key:
//
//   bouncer calibrate --fixtures <this file> --from <the decision log>
`;

interface Rebuilt {
  readonly item: Pick<Candidate, "tool" | "cwd" | "input" | "permission_mode" | "target_exists">;
  /** The rebuilt state text: the dedup key, and the one compared against known fixtures. */
  readonly state: string;
  readonly redacted: boolean;
}

/**
 * A logged line back into a tool call, or undefined if it will not round-trip.
 *
 * The logged action is re-redacted first. The patterns have been widened since the first
 * lines were written — `PASSWORD=` in front of a value went out in clear until one fix — so
 * a line redacted under an older build can still hold something the current build catches,
 * and the export is exactly the moment a line is about to be copied somewhere new.
 */
function rebuild(record: DecisionRecord, tool: string): Rebuilt | undefined {
  let state: unknown;
  try {
    state = JSON.parse(record.state as string);
  } catch {
    return undefined;
  }
  if (!isRecord(state) || !isRecord(state["action"]) || state["tool"] !== tool) return undefined;

  const carried: Record<string, unknown> = { ...state };
  for (const key of UNCARRIED) delete carried[key];
  const expected = redactStrings(carried) as Record<string, unknown>;
  const redacted = canonical(expected) !== canonical(carried);

  const project = typeof expected["project"] === "string" ? expected["project"] : undefined;
  const cwd = project !== undefined ? `/home/user/${project}` : undefined;
  const context = {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(typeof record.permission_mode === "string" ? { permission_mode: record.permission_mode } : {}),
  };

  for (const shape of shapesFor(tool, expected["action"] as Record<string, unknown>, cwd)) {
    const item = { tool, ...shape, ...context };
    const built = stateFor(asFixture(item));
    if (built.truncated) continue;
    if (canonical(JSON.parse(built.text)) === canonical(expected)) {
      return { item, state: built.text, redacted };
    }
  }
  return undefined;
}

/** Every input that might rebuild `action`, most likely first. The round trip decides. */
function shapesFor(
  tool: string,
  action: Record<string, unknown>,
  cwd: string | undefined,
): Array<{ input: Record<string, unknown>; target_exists?: boolean }> {
  const str = (key: string): string | undefined => (typeof action[key] === "string" ? (action[key] as string) : undefined);
  const num = (key: string): number | undefined => (typeof action[key] === "number" ? (action[key] as number) : undefined);
  const filler = (bytes: number | undefined, char: string): string | undefined =>
    bytes === undefined ? undefined : char.repeat(bytes);
  const defined = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));

  switch (tool) {
    case "Bash":
      return [{ input: defined({ command: str("command"), description: str("stated_intent") }) }];

    case "Write": {
      const exists = typeof action["replaces_existing_file"] === "boolean" ? { target_exists: action["replaces_existing_file"] as boolean } : {};
      return pathsFor(action, cwd).map((file_path) => ({
        input: defined({ file_path, content: filler(num("bytes"), "x") }),
        ...exists,
      }));
    }

    case "Edit":
      return pathsFor(action, cwd).map((file_path) => ({
        input: defined({
          file_path,
          old_string: filler(num("bytes_removed"), "x"),
          new_string: filler(num("bytes_added"), "y"),
          replace_all: action["replaces_every_occurrence"] === true,
        }),
      }));

    case "NotebookEdit":
      return pathsFor(action, cwd).map((notebook_path) => ({
        input: defined({ notebook_path, cell_id: str("cell"), edit_mode: str("edit_mode") }),
      }));

    default: {
      // A tool a user's policy gates beyond the four the default does. The state builder
      // keeps its scalars and short strings and turns a long string into `<key>_bytes`.
      const input: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(action)) {
        if (key === "kind" || key === "tool") continue;
        if (key.endsWith("_bytes") && typeof value === "number") input[key.slice(0, -"_bytes".length)] = "x".repeat(value);
        else input[key] = value;
      }
      return [{ input }];
    }
  }
}

function pathsFor(action: Record<string, unknown>, cwd: string | undefined): string[] {
  const path = action["path"];
  if (typeof path !== "string" || path.length === 0) return [];
  if (action["inside_project"] === true) return cwd === undefined ? [] : [`${cwd}/${path}`];
  if (action["inside_project"] !== false) return [];
  // The home root itself logs its own name as the basename.
  return [...OUTSIDE_DIRS.map((dir) => `${dir}/${path}`), `/home/${path}`];
}

function asFixture(item: Record<string, unknown>): Fixture {
  return { id: "", kind: "tool_call", item, expect: {}, note: "" };
}

function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redact(value).text;
  if (Array.isArray(value)) return value.map(redactStrings);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v)]));
  return value;
}

function actionKey(state: string): string {
  const parsed = JSON.parse(state) as Record<string, unknown>;
  return canonical([parsed["tool"], parsed["action"]]);
}

/** JSON with sorted keys, so a line an older build wrote in another key order still compares. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
