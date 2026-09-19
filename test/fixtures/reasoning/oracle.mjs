// A stand-in reasoning model, for tests and for the README's dry run.
//
// It implements the same stdin/stdout protocol a real reasoning command does (see
// src/io/reasoning.ts) and answers from a lookup table keyed on the item id, so a
// measurement run is deterministic and needs no API key. $ORACLE_ANSWERS holds the table:
//
//   {"<item id>": {"<question>": true|false|0.0-1.0}, "__tokens__": {"in": 1800, "out": 200}}
//
// Anything not in the table is answered false, which is what an over-cautious reasoning
// model looks like and keeps the cascade row from being trivially perfect.

import { readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(0, "utf8"));
const table = JSON.parse(process.env.ORACLE_ANSWERS ?? "{}");
const tokens = table["__tokens__"] ?? { in: 1800, out: 200 };
const forItem = table[request.item] ?? {};

const answers = {};
for (const name of Object.keys(request.questions)) {
  answers[name] = forItem[name] ?? false;
}

// A real CLI prints things before its JSON. Doing the same here keeps the parser honest.
process.stderr.write(`oracle: answering ${request.item}\n`);
process.stdout.write(`thinking about ${request.item}...\n`);
process.stdout.write(JSON.stringify({ answers, input_tokens: tokens.in, output_tokens: tokens.out }));
