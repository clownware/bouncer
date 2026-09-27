// Bearer keys for the servers #105 names, and the rule that a key must be protecting
// something.
//
// Clownbot's local seats refuse every request without their key, which they read from a
// 0600 file. Bouncer had no way to send one to `local`, and `jev@<url>` sent none on
// purpose, so neither seat could be calibrated against. The keys come from the environment
// or a key file only, never the policy, and a keyed server that also answers without the
// key is refused before the first fixture.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JevAdapter } from "../src/adapters/jev.js";
import { LocalAdapter } from "../src/adapters/local.js";
import { AdapterError } from "../src/adapters/types.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { adapterFor, labelled } from "../src/commands/calibrate.js";
import { jevCompatible, keyFromEnv, localBackend } from "../src/io/config.js";

const NAMES = [
  "BOUNCER_LOCAL_API_KEY",
  "BOUNCER_LOCAL_API_KEY_FILE",
  "BOUNCER_JEV_COMPAT_API_KEY",
  "BOUNCER_JEV_COMPAT_API_KEY_FILE",
  "BOUNCER_LOCAL_URL",
];

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bouncer-keys-"));
  for (const name of NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const SEAT = "seat-key-abcdefghijklmnopqrstuvwxyz";

describe("keyFromEnv", () => {
  it("reads the variable", () => {
    process.env["BOUNCER_LOCAL_API_KEY"] = ` ${SEAT} `;
    expect(keyFromEnv("BOUNCER_LOCAL_API_KEY")).toEqual({ key: SEAT });
  });

  it("reads the file the _FILE variable names, trimmed", () => {
    const file = join(dir, "seat.key");
    writeFileSync(file, `${SEAT}\n`, { mode: 0o600 });
    process.env["BOUNCER_LOCAL_API_KEY_FILE"] = file;
    expect(keyFromEnv("BOUNCER_LOCAL_API_KEY")).toEqual({ key: SEAT });
  });

  it("prefers the variable to the file", () => {
    process.env["BOUNCER_LOCAL_API_KEY"] = SEAT;
    process.env["BOUNCER_LOCAL_API_KEY_FILE"] = join(dir, "absent.key");
    expect(keyFromEnv("BOUNCER_LOCAL_API_KEY")).toEqual({ key: SEAT });
  });

  it("is no key when neither is set", () => {
    expect(keyFromEnv("BOUNCER_LOCAL_API_KEY")).toEqual({});
  });

  // A typo in a path must not become a run against an endpoint that refuses every call.
  it.each([
    ["a file that does not exist", () => join(dir, "absent.key"), /cannot be read/],
    ["an empty file", () => {
      const file = join(dir, "empty.key");
      writeFileSync(file, "\n");
      return file;
    }, /is empty/],
  ])("is an error for %s", (_label, path, message) => {
    process.env["BOUNCER_LOCAL_API_KEY_FILE"] = path();
    const result = keyFromEnv("BOUNCER_LOCAL_API_KEY");
    expect(result.key).toBeUndefined();
    expect(result.error).toMatch(message);
    expect(result.error).toContain("BOUNCER_LOCAL_API_KEY_FILE");
  });
});

describe("which key goes where", () => {
  it("gives local its own key", () => {
    process.env["BOUNCER_LOCAL_API_KEY"] = SEAT;
    expect(localBackend().apiKey).toBe(SEAT);
  });

  it("gives a jev@ URL the compat key and nothing else", () => {
    process.env["BOUNCER_JEV_COMPAT_API_KEY"] = SEAT;
    process.env["BOUNCER_TYPESAFE_API_KEY"] = "typesafe-abcdefghijklmnop";
    try {
      expect(jevCompatible("jev@http://127.0.0.1:8093")).toEqual({
        baseUrl: "http://127.0.0.1:8093/v1/systemone",
        apiKey: SEAT,
      });
    } finally {
      delete process.env["BOUNCER_TYPESAFE_API_KEY"];
    }
  });

  it("sends no key to a jev@ URL when no compat key is set, whatever else is", () => {
    process.env["BOUNCER_LOCAL_API_KEY"] = SEAT;
    expect(jevCompatible("jev@http://127.0.0.1:8093")).toEqual({ baseUrl: "http://127.0.0.1:8093/v1/systemone" });
  });

  it("reports an unreadable compat key file instead of an endpoint", () => {
    process.env["BOUNCER_JEV_COMPAT_API_KEY_FILE"] = join(dir, "absent.key");
    expect(jevCompatible("jev@http://127.0.0.1:8093")).toEqual({ error: expect.stringMatching(/cannot be read/) });
  });
});

describe("labelled", () => {
  it.each([
    ["local-decision=jev@http://127.0.0.1:8093", { label: "local-decision", backend: "jev@http://127.0.0.1:8093" }],
    ["local-plumbing=local", { label: "local-plumbing", backend: "local" }],
    ["jev", { backend: "jev" }],
    // The `=` inside a query string is not a label: what precedes it holds `@` and `:`.
    ["jev@https://host/v1/systemone?a=b", { backend: "jev@https://host/v1/systemone?a=b" }],
  ])("%s", (spec, expected) => {
    expect(labelled(spec)).toEqual(expected);
  });
});

/** A fetch that answers keyed requests, and keyless ones only when `open` is true. */
function keyedServer(options: { open: boolean; keylessStatus?: number }) {
  const seen: Array<{ url: string; keyed: boolean }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const keyed = headers["authorization"] === `Bearer ${SEAT}`;
    seen.push({ url: href, keyed });
    if (!keyed && !options.open) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: options.keylessStatus ?? 401 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    if (href.endsWith("/v1/systemone")) {
      const questions = Object.keys((body["questions"] ?? {}) as Record<string, unknown>);
      return Response.json({ model: "laya", answers: Object.fromEntries(questions.map((q) => [q, { type: "noul", noul: 0.5 }])) });
    }
    if (href.endsWith("/tokenize")) {
      const text = String(body["content"] ?? body["prompt"] ?? "");
      const ids: Record<string, number> = { yes: 9891, " yes": 9891, Yes: 5297, " Yes": 5297, no: 1738, " no": 1738, No: 2360, " No": 2360 };
      return ids[text] === undefined ? Response.json({ error: "unknown" }, { status: 400 }) : Response.json({ tokens: [ids[text]] });
    }
    // Completions: answer whatever was asked with a yes-leaning distribution in the
    // llama.cpp 0.4.1 content shape, which is what the seat this exists for returns.
    const row = (token: string, logprob: number) => ({ token, logprob });
    return Response.json({
      choices: [{ text: " yes", logprobs: { content: [{ ...row(" yes", Math.log(0.9)), top_logprobs: [row(" yes", Math.log(0.9)), row(" no", Math.log(0.1))] }] } }],
    });
  });
  return { fetchImpl, seen };
}

const WARMUP = { deadlineMs: 2_000, intervalMs: 1 };

describe("a keyed jev@ server", () => {
  it("starts when it refuses the keyless probe", async () => {
    const { fetchImpl, seen } = keyedServer({ open: false });
    await new JevAdapter({ baseUrl: "http://127.0.0.1:8093/v1/systemone", apiKey: SEAT, fetch: fetchImpl, warmup: WARMUP }).start();
    expect(seen.map((s) => s.keyed)).toEqual([true, false]);
  });

  it("is refused when it answers without the key", async () => {
    const { fetchImpl } = keyedServer({ open: true });
    const error = await new JevAdapter({ baseUrl: "http://127.0.0.1:8093/v1/systemone", apiKey: SEAT, fetch: fetchImpl, warmup: WARMUP })
      .start()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).message).toMatch(/answered a request sent without the key/);
  });

  it("is not probed when no key is configured, so an open endpoint stays usable", async () => {
    const { fetchImpl, seen } = keyedServer({ open: true });
    await new JevAdapter({ baseUrl: "http://127.0.0.1:8093/v1/systemone", fetch: fetchImpl, warmup: WARMUP }).start();
    expect(seen).toHaveLength(1);
  });
});

describe("a keyed local server", () => {
  const options = { baseUrl: "http://127.0.0.1:8092/v1", apiKey: SEAT };

  it("sends the key on every call and starts when the keyless probe is refused", async () => {
    const { fetchImpl, seen } = keyedServer({ open: false });
    await new LocalAdapter({ ...options, fetch: fetchImpl }).start();
    const keyless = seen.filter((s) => !s.keyed);
    expect(keyless).toHaveLength(1);
    expect(keyless[0]?.url).toBe("http://127.0.0.1:8092/v1/completions");
  });

  it("is refused when it answers without the key", async () => {
    const { fetchImpl } = keyedServer({ open: true });
    const error = await new LocalAdapter({ ...options, fetch: fetchImpl }).start().catch((e: unknown) => e);
    expect((error as AdapterError).message).toMatch(/answered a request sent without the key/);
  });

  it("cannot be told keyed or not when the keyless probe fails some other way, and says so", async () => {
    const { fetchImpl } = keyedServer({ open: false, keylessStatus: 500 });
    const error = await new LocalAdapter({ ...options, fetch: fetchImpl }).start().catch((e: unknown) => e);
    expect((error as AdapterError).message).toMatch(/whether it is keyed cannot be told/);
  });
});

// `chat@` options were built as `{ ...localBackend(), ...chat }`, so once `local` had a key
// it would have been spread into every chat arm and sent to whatever URL was typed. A real
// loopback server, because the adapter built by the command takes no injected fetch.
describe("the local key and a chat@ URL", () => {
  it("never meet", async () => {
    const headers: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      headers.push(req.headers["authorization"]);
      res.writeHead(500).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;

    process.env["BOUNCER_LOCAL_API_KEY"] = SEAT;
    process.env["BOUNCER_CHAT_MODEL"] = "m";
    try {
      const adapter = adapterFor(`chat@http://127.0.0.1:${port}`);
      expect(typeof adapter).not.toBe("string");
      await (adapter as LocalAdapter).start().catch(() => undefined);
    } finally {
      delete process.env["BOUNCER_CHAT_MODEL"];
      await new Promise<void>((done) => server.close(() => done()));
    }

    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h === undefined)).toBe(true);
  });
});
