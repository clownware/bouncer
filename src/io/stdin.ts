// Reads the hook payload from stdin.
//
// Claude Code writes a single JSON object and closes the pipe. We take the raw text and
// parse leniently: an unparseable payload is not an error worth failing on, because the
// only safe response to "I don't understand this" is to emit no decision and let the
// normal permission flow run.

export interface HookPayload {
  readonly hook_event_name?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly permission_mode?: string;
  readonly tool_name?: string;
  readonly tool_use_id?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export async function readPayload(): Promise<HookPayload | undefined> {
  const raw = await readAll();
  if (raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HookPayload) : undefined;
  } catch {
    return undefined;
  }
}

function readAll(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}
