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

  // `assigned-secret` asked for at least one character in front of its keyword, so a name
  // that simply IS the keyword never matched — though `--password=...` is the example in the
  // pattern's own comment. Every value in the left column went to the classifier and into
  // the log in clear. The right column is the twin that was always caught.
  //
  // The values are plain words on purpose. This pattern keys on the NAME, so a value's shape
  // proves nothing here, and a realistic-looking one trips the secret scanner in the commit
  // hook for no gain. The shape-keyed patterns above are where a structurally valid value
  // earns its place.
  const bareNames: ReadonlyArray<readonly [string, string, string]> = [
    ["PASSWORD=hunter22 ./deploy.sh", "hunter22", "DB_PASSWORD=hunter22 ./deploy.sh"],
    ["TOKEN=swordfish ./run.sh", "swordfish", "MY_TOKEN=swordfish ./run.sh"],
    ["API_KEY=opensesame ./run.sh", "opensesame", "X_API_KEY=opensesame ./run.sh"],
    ["SECRET=opensesame ./run.sh", "opensesame", "APP_SECRET=opensesame ./run.sh"],
    ["mysql -u root --password=hunter22 prod", "hunter22", "mysql -u root --db-password=hunter22 prod"],
    ["export SECRET_KEY_BASE=swordfish", "swordfish", "export RAILS_SECRET_KEY_BASE=swordfish"],
    ["curl -d 'token=swordfish' https://example.com", "swordfish", "curl -d 'api_token=swordfish' https://example.com"],
  ];

  it.each(bareNames)("redacts the value in `%s`", (input, value, twin) => {
    for (const command of [input, twin]) {
      const result = redact(command);
      expect(result.kinds, command).toContain("assigned-secret");
      expect(result.text, command).not.toContain(value);
    }
  });

  // The table is ordered most specific first because the specific label is the useful one,
  // and then `assigned-secret` ran last and redacted the marker the specific pattern had
  // just written. A variable named like a secret erased what kind of secret it held.
  it("keeps the specific label when the variable is also named like a secret", () => {
    // Synthetic, and it has to be key-shaped: the point is that the shape-keyed pattern wins.
    // Built on the alphabet run, which is what .gitleaks.toml recognises as fake.
    const stripe = "export STRIPE_SECRET_KEY=sk_live_abcdefghijklmnopqrstuvwx";
    expect(redact(stripe).text).toBe("export STRIPE_SECRET_KEY=[REDACTED:stripe-key]");
    expect(redact("docker run -e API_KEY=sk-proj-abcdefghijklmnopqrstuvwx ubuntu:24.04").text).toBe(
      "docker run -e API_KEY=[REDACTED:openai-key] ubuntu:24.04",
    );
  });

  it("keeps the bare name, as it keeps a prefixed one", () => {
    expect(redact("PASSWORD=hunter22 ./deploy.sh").text).toBe("PASSWORD=[REDACTED:assigned-secret] ./deploy.sh");
  });

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
    // One near-miss per pattern that had none. The first is the one that mattered: run over
    // serialised JSON, the 1Password pattern took the backslash out of `\"op://\"` and broke
    // a logged state. On the raw command it is right to match nothing, and this pins that.
    ["the 1Password scheme with no reference after it", 'git grep -n "op://" | cut -c1-170'],
    ["another scheme that ends in op", "open shop://catalog/items"],
    ["a bearer header whose token is a variable", "curl -H 'Authorization: Bearer $TOKEN' https://api.example.com"],
    ["the word bearer in prose", "git commit -m 'the bearer of bad news about auth'"],
    ["an AWS key prefix that is too short", "echo AKIAIOSFODNN7"],
    ["a GitHub token prefix that is too short", "git checkout ghp_short"],
    ["a GitHub PAT prefix that is too short", "echo github_pat_short"],
    ["a Slack token prefix that is too short", "echo xoxb-short"],
    ["a Stripe publishable key, which is public", "echo pk_live_abcdefghijklmnopqrstuvwx"],
    ["a Stripe key prefix that is too short", "stripe listen --api-key sk_test_short"],
    ["a JWT header with no payload or signature", "echo eyJhbGciOiJIUzI1"],
    ["a Google key prefix that is too short", "echo AIzaShort"],
    ["an Anthropic key prefix that is too short", "echo sk-ant-short"],
    ["a public key block", "echo '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----'"],
    ["a full commit hash", "git show 3bb898e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6"],
    ["sk- in the middle of a word", "git checkout task-refactor-the-state-builder-module"],
    ["reading a config key named like a token", "npm config get //registry.npmjs.org/:_authToken"],
    // A reference is not a value. Nothing secret is on the line, the classifier should see
    // that one variable is being fed from another, and the hard rule that reads this kind
    // says "a credential value appears literally on the command line" — which would be
    // false, and a prompt. Matters more now that a bare name matches: `export
    // TOKEN=$GITHUB_TOKEN` is how most CI scripts start.
    ["a secret set from another variable", "export API_KEY=$OTHER_KEY"],
    ["the same with braces", "export TOKEN=${GITHUB_TOKEN}"],
    ["the same in double quotes", 'export DB_PASSWORD="$PGPASSWORD"'],
    ["a secret set from a command", "export TOKEN=$(op read item/credential)"],
    ["a word that only contains a keyword", "export TOKENIZER=sentencepiece"],
  ];

  // The other side of that line. Single quotes make `$` literal, and a value that merely
  // contains a reference still has a literal part.
  const stillSecret: ReadonlyArray<readonly [string, string]> = [
    ["a single-quoted value that starts with a dollar", "PASSWORD='$ecret-hunter2' ./deploy.sh"],
    ["a literal with a reference after it", 'API_KEY="abcd1234$SUFFIX" ./run.sh'],
  ];

  it.each(stillSecret)("still redacts %s", (_label, input) => {
    expect(redact(input).kinds).toContain("assigned-secret");
  });

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
