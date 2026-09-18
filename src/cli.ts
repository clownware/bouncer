// Entry point for the bouncer hook binary.
//
// v0.1 skeleton: reads the hook payload, emits no decision, exits 0. That is also the
// shipped default behaviour (`mode: observe`), so this is the real code path rather than
// a placeholder — the engine and adapter land on top of it in threads 2 and 3.
//
// The one invariant that matters here: this process must never exit 2. Claude Code treats
// exit 2 from PreToolUse as "block the tool call, regardless of stdout", so a crash that
// exits 2 would silently break the user's session. An uncaught exception in Node exits 1,
// which is a non-blocking error and safe. Everything below is written to keep it that way.

import { readPayload } from "./io/stdin.js";

const OK = 0;
const NONBLOCKING_ERROR = 1;

async function main(argv: string[]): Promise<number> {
  const command = argv[2];

  if (command === "pretooluse") {
    // Reading the payload is the only work v0.1's skeleton does. Emitting nothing tells
    // Claude Code to fall through to its normal permission flow, which is exactly what
    // observe mode wants: no added prompts, no added friction.
    await readPayload();
    return OK;
  }

  if (command === "--version") {
    process.stdout.write("0.1.0\n");
    return OK;
  }

  process.stderr.write(`bouncer: unknown command ${command ?? "(none)"}\n`);
  return NONBLOCKING_ERROR;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Never rethrow: an unhandled rejection would still exit non-2, but being explicit
    // here keeps the guarantee local and testable.
    process.stderr.write(`bouncer: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = NONBLOCKING_ERROR;
  });
