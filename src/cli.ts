// Entry point for the bouncer hook binary.
//
// The one invariant that matters here: this process must never exit 2. Claude Code treats
// exit 2 from PreToolUse as "block the tool call, regardless of stdout", so a crash that
// exits 2 would silently break the user's session. An uncaught exception in Node exits 1,
// which is a non-blocking error and safe. Everything below is written to keep it that way,
// and test/cli.test.ts feeds it deliberately hostile input to prove it.

import { runPreToolUse } from "./hooks/pretooluse.js";
import { status } from "./commands/status.js";
import { explain } from "./commands/explain.js";
import { calibrate, parseArgs } from "./commands/calibrate.js";
import { judge, parseArgs as parseJudgeArgs } from "./commands/judge.js";
import { measure, parseArgs as parseMeasureArgs } from "./commands/measure.js";
import { skills, parseArgs as parseSkillsArgs } from "./commands/skills.js";
import { readPayload } from "./io/stdin.js";

const OK = 0;
const NONBLOCKING_ERROR = 1;

async function main(argv: string[]): Promise<number> {
  const command = argv[2];

  switch (command) {
    case "pretooluse": {
      const payload = await readPayload();
      // An unreadable payload is not something to guess about. Emitting nothing lets the
      // normal permission flow run, which is the correct response to "I don't understand".
      if (payload === undefined) return OK;

      const output = await runPreToolUse(payload);
      if (output !== undefined) process.stdout.write(JSON.stringify(output));
      return OK;
    }

    case "status":
      process.stdout.write(status());
      return OK;

    case "explain":
      process.stdout.write(explain(argv[3]));
      return OK;

    case "calibrate":
      return calibrate(parseArgs(argv.slice(3)), (text) => process.stdout.write(text));

    case "judge":
      return judge(parseJudgeArgs(argv.slice(3)), (text) => process.stdout.write(text));

    case "measure":
      return measure(parseMeasureArgs(argv.slice(3)), (text) => process.stdout.write(text));

    case "skills":
      process.stdout.write(skills(parseSkillsArgs(argv.slice(3))));
      return OK;

    case "--version":
      process.stdout.write("0.2.2\n");
      return OK;

    default:
      process.stderr.write(`bouncer: unknown command ${command ?? "(none)"}\n`);
      return NONBLOCKING_ERROR;
  }
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`bouncer: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = NONBLOCKING_ERROR;
  });
