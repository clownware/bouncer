import { describe, expect, it } from "vitest";
import { redact } from "../src/engine/redact.js";

describe("redact", () => {
  // Real credential shapes. The values here are synthetic but structurally valid, which
  // is the point — a pattern that only matches the literal string "SECRET" is useless.
  const secrets: ReadonlyArray<readonly [string, string, string]> = [
    ["openai key", "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345", "openai-key"],
    // `sk-ant-…` also satisfies the OpenAI shape, so pattern order decides the label.
    // Before this test, every Anthropic key was reported as "openai-key".
    ["anthropic key", "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "anthropic-key"],
    ["openai project key", "curl -H 'Authorization: sk-proj-abcdefghijklmnopqrstuvwx'", "openai-key"],
    ["github pat (classic)", "git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y", "github-token"],
    ["github pat (fine-grained)", "echo github_pat_11ABCDEFG0abcdefghijklmnop", "github-pat"],
    ["slack token", "curl -d token=xoxb-123456789012-abcdefghijkl", "slack-token"],
    ["aws access key", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE aws s3 ls", "aws-access-key"],
    ["aws session key", "echo ASIAIOSFODNN7EXAMPLE", "aws-access-key"],
    ["google api key", "curl 'https://maps.googleapis.com/x?key=AIzaSyA1234567890abcdefghijklmnopqrstuv'", "google-api-key"],
    ["stripe live key", "stripe listen --api-key sk_live_abcdefghijklmnopqrstuvwx", "stripe-key"],
    ["jwt", "curl -H 'Auth: eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4'", "jwt"],
    ["1password ref", "op read op://Private/OpenAI/credential", "onepassword-ref"],
    ["bearer token", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'", "bearer-token"],
  ];

  it.each(secrets)("redacts a %s", (_label, input, kind) => {
    const result = redact(input);
    expect(result.kinds).toContain(kind);
    expect(result.text).toContain("[REDACTED:");
  });

  it("redacts a private key block including its body", () => {
    const input = "echo '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'";
    const result = redact(input);
    expect(result.kinds).toContain("private-key");
    expect(result.text).not.toContain("MIIEpAIBAAKCAQEA");
  });

  // The command is what the classifier judges, so redaction has to leave enough behind to
  // judge. A connection string with the password removed still shows scheme, host and
  // database — which is exactly what the `prod` and `egress` questions need.
  it("keeps the host of a connection string and removes only the password", () => {
    const result = redact("psql postgres://admin:hunter2@prod-db.internal:5432/orders");
    expect(result.kinds).toContain("url-credentials");
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("prod-db.internal");
    expect(result.text).toContain("postgres://admin");
  });

  it("keeps the variable name of an inline assignment and removes the value", () => {
    const result = redact("DATABASE_PASSWORD=s3cr3tvalue ./deploy.sh");
    expect(result.kinds).toContain("assigned-secret");
    expect(result.text).not.toContain("s3cr3tvalue");
    expect(result.text).toContain("DATABASE_PASSWORD");
    expect(result.text).toContain("./deploy.sh");
  });

  // Near-misses. Over-redacting destroys the signal the gate runs on: if every mention of
  // a variable name gets replaced, `echo $KEY` and `echo "$KEY"` become indistinguishable
  // from harmless text and the `secrets` question stops working.
  const innocuous: ReadonlyArray<readonly [string, string]> = [
    ["an env var referenced but not printed", "docker run -e API_KEY ubuntu"],
    ["a variable expansion, which is a shape the classifier should see", "echo $OPENAI_API_KEY"],
    ["prose containing the word secret", "git commit -m 'move secret handling into config'"],
    ["a path that happens to contain 'token'", "cat src/auth/token-refresh.ts"],
    ["a short hex string", "git checkout a1b2c3d"],
    ["a plain URL", "curl https://api.example.com/v1/users"],
    ["a URL with a port but no credentials", "psql postgres://localhost:5432/dev"],
    ["sk- too short to be a key", "echo sk-abc"],
    ["a flag named like a secret with no value", "./deploy --password"],
    ["an empty string", ""],
  ];

  it.each(innocuous)("leaves %s alone", (_label, input) => {
    const result = redact(input);
    expect(result.kinds).toEqual([]);
    expect(result.text).toBe(input);
  });

  it("redacts several distinct secrets in one command", () => {
    const result = redact("AWS_SECRET_ACCESS_KEY=abcd1234wxyz curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'");
    expect(result.kinds.length).toBeGreaterThanOrEqual(2);
    expect(result.text).not.toContain("abcd1234wxyz");
  });

  // The patterns are module-level with the /g flag, so a missed lastIndex reset makes the
  // second call on the same input silently skip matches. This has bitten every codebase
  // that has ever done this.
  it("labels an anthropic key as anthropic, not openai", () => {
    const result = redact("echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(result.kinds).toEqual(["anthropic-key"]);
    expect(result.kinds).not.toContain("openai-key");
  });

  it("still labels a plain openai key as openai", () => {
    expect(redact("echo sk-abcdefghijklmnopqrstuvwxyz0123").kinds).toEqual(["openai-key"]);
  });

  it("is idempotent across repeated calls", () => {
    const input = "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345";
    const first = redact(input);
    const second = redact(input);
    expect(second.text).toBe(first.text);
    expect(second.kinds).toEqual(first.kinds);
  });

  it("does not re-redact its own output", () => {
    const once = redact("export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz012345");
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
  });
});
