#!/usr/bin/env node

// src/io/stdin.ts
async function readPayload() {
  const raw = await readAll();
  if (raw.trim().length === 0) return void 0;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function readAll() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// src/cli.ts
var OK = 0;
var NONBLOCKING_ERROR = 1;
async function main(argv) {
  const command = argv[2];
  if (command === "pretooluse") {
    await readPayload();
    return OK;
  }
  if (command === "--version") {
    process.stdout.write("0.1.0\n");
    return OK;
  }
  process.stderr.write(`bouncer: unknown command ${command ?? "(none)"}
`);
  return NONBLOCKING_ERROR;
}
main(process.argv).then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`bouncer: ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = NONBLOCKING_ERROR;
});
