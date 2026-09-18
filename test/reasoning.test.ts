import { describe, expect, it } from "vitest";
import { CommandReasoning, parseResponse } from "../src/io/reasoning.js";

const QUESTIONS = { on_brand: { type: "noul" as const, instructions: "It sounds like us." } };
const request = { item: "a", state: '{"text":"draft"}', questions: QUESTIONS };

describe("reading a reasoning command's answer", () => {
  it("reads booleans as 1 and 0", () => {
    expect(parseResponse('{"answers":{"a":true,"b":false}}', "x").answers).toEqual({ a: 1, b: 0 });
  });

  it("reads a probability as itself", () => {
    expect(parseResponse('{"answers":{"a":0.73}}', "x").answers).toEqual({ a: 0.73 });
  });

  it("reads token counts when they are reported", () => {
    const r = parseResponse('{"answers":{"a":true},"input_tokens":1840,"output_tokens":210}', "x");
    expect(r.inputTokens).toBe(1840);
    expect(r.outputTokens).toBe(210);
  });

  // Reported as not reported, never as zero: a measurement that invents its denominator is
  // worse than no measurement.
  it("leaves token counts undefined when the command does not report them", () => {
    const r = parseResponse('{"answers":{"a":true}}', "x");
    expect(r.inputTokens).toBeUndefined();
    expect(r.outputTokens).toBeUndefined();
  });

  // Tolerant about the envelope: a real CLI prints something before its JSON.
  it("ignores a preamble and reads the last JSON object", () => {
    expect(parseResponse('thinking...\n{"answers":{"a":true}}', "x").answers).toEqual({ a: 1 });
  });

  it("reads a pretty-printed object", () => {
    expect(parseResponse('log line\n{\n  "answers": {\n    "a": true\n  }\n}\n', "x").answers).toEqual({ a: 1 });
  });

  // Strict about the content: a coerced answer is a measurement built on a guess.
  const rejected: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["a string answer", '{"answers":{"a":"maybe"}}', /expected true, false, or a number/],
    ["a probability out of range", '{"answers":{"a":1.4}}', /expected true, false, or a number/],
    ["a null answer", '{"answers":{"a":null}}', /expected true, false, or a number/],
    ["no answers mapping", '{"input_tokens":10}', /has no "answers" mapping/],
    ["answers as an array", '{"answers":["a"]}', /has no "answers" mapping/],
    ["no JSON at all", "the model refused to answer", /printed no JSON object/],
    ["empty output", "", /printed no JSON object/],
  ];

  it.each(rejected)("refuses %s", (_label, stdout, message) => {
    expect(() => parseResponse(stdout, "item-1")).toThrow(message);
  });

  it("names the item it could not read, so a failure points at a line", () => {
    expect(() => parseResponse("", "draft-42")).toThrow(/draft-42/);
  });
});

describe("running a reasoning command", () => {
  it("answers through the real protocol, against the stand-in model", async () => {
    const backend = new CommandReasoning("node test/fixtures/reasoning/oracle.mjs");
    const r = await backend.answer(request);
    expect(r.answers).toEqual({ on_brand: 0 });
    expect(r.inputTokens).toBe(1800);
  });

  it("passes the item, the state and the questions on stdin", async () => {
    const backend = new CommandReasoning("cat > /dev/null; echo '{\"answers\":{\"on_brand\":true}}'");
    expect((await backend.answer(request)).answers).toEqual({ on_brand: 1 });
  });

  it("hands the escalation signals through when there are any", async () => {
    // The command echoes back whether it saw signals, which is the only way to observe it.
    const backend = new CommandReasoning(
      `node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));` +
        `process.stdout.write(JSON.stringify({answers:{on_brand:r.signals!==undefined}}))'`,
    );
    const withSignals = await backend.answer({
      ...request,
      signals: [{ question: "on_brand", p: 0.52, criterion: "0.40..0.60", asks: "It sounds like us.", ruleIndex: 1, verdict: "ask", decided: true }],
    });
    expect(withSignals.answers["on_brand"]).toBe(1);
    expect((await backend.answer(request)).answers["on_brand"]).toBe(0);
  });

  // The command's own stderr is where a missing key or a rate limit will have said so.
  it("reports a non-zero exit with the command's stderr", async () => {
    const backend = new CommandReasoning(">&2 echo 'no API key configured'; exit 3");
    await expect(backend.answer(request)).rejects.toThrow(/exited 3: no API key configured/);
  });

  it("reports a command that does not exist", async () => {
    const backend = new CommandReasoning("definitely-not-a-real-command-xyz");
    await expect(backend.answer(request)).rejects.toThrow();
  });

  it("gives up on a command that hangs, rather than stalling the run", async () => {
    const backend = new CommandReasoning("sleep 30", 150);
    await expect(backend.answer(request)).rejects.toThrow(/did not answer within/);
  });

  it("does not report EPIPE when the command exits before reading stdin", async () => {
    const backend = new CommandReasoning("exit 1");
    await expect(backend.answer(request)).rejects.toThrow(/exited 1/);
  });

  it("names itself after the command, so a report says which model produced a row", () => {
    expect(new CommandReasoning("claude -p --model opus").name).toBe("claude -p --model opus");
  });
});
