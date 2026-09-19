// Hard rules: the deterministic edge in front of the judge. See docs/adr/004.
//
// Two kinds of test here, and the second is the one that matters.
//
// The table-driven cases below pin each predicate against the near-miss pair it exists for.
// But a hard rule is an allowlist in reverse, and CLAUDE.md's rule for `gate.fast_path`
// applies with the sign flipped: the question is never "does this catch the command I had
// in mind", it is "is every command it can match one that deserves the verdict". A test
// that only checks the commands the author thought of proves nothing about that.
//
// So the sweep at the bottom runs the shipped policy's entries over every fixture in
// fixtures/gate.jsonl and asserts the whole result: which ids fire, and — the real
// assertion — that nothing labelled `false` on every question fires at all. A hard rule
// that started prompting on `npm ci` would be a friction regression that no per-case test
// would catch, and friction is the failure mode.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { matchHardRule } from "../src/engine/hardrules.js";
import { loadPolicy } from "../src/engine/policy.js";
import { evaluate, emitFor, shortCircuit } from "../src/engine/evaluate.js";
import { parseFixtures } from "../src/calibrate.js";
import type { HardRule, Policy } from "../src/engine/types.js";

const root = join(import.meta.dirname, "..");

function shippedPolicy(mode = "observe"): Policy {
  const source = readFileSync(join(root, "policy/default.yaml"), "utf8").replace(
    /^mode: observe$/m,
    `mode: ${mode}`,
  );
  const { policy, diagnostics } = loadPolicy(source);
  const errors = diagnostics.filter((d) => d.severity === "error");
  expect(errors, `default policy has errors: ${JSON.stringify(errors)}`).toEqual([]);
  if (policy === undefined) throw new Error("default policy failed to load");
  return policy;
}

const shipped = shippedPolicy();
const rules = shipped.gate.hardRules;

const fires = (command: string): string | undefined => matchHardRule(rules, command)?.name;

describe("the shipped hard rules", () => {
  // Each row is a pair: the command that must fire, and the near-miss that must not. The
  // near-miss column is the reason the predicate is shaped the way it is.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // [entry, fires, does not fire]
    ["reads-a-credential-file", "cat .env", "cat README.md"],
    ["reads-a-credential-file", "cat .env.production", "cat env.example"],
    ["reads-a-credential-file", "cat ~/.ssh/id_ed25519", "ssh-keygen -y -f ~/.ssh/id_ed25519"],
    ["reads-a-credential-file", "head -5 ~/.aws/credentials", "head -5 src/index.ts"],
    ["reads-a-credential-file", "base64 .npmrc", "cat /etc/passwd"],
    // The gap that search verbs left. The near-miss is fixture `grep-for-key-name`, which
    // is labelled false on `secrets` and must stay unjudged-by-rule: searching the project
    // for where a credential is referenced finds the name, not the value. `path_labelled`
    // is what separates them, not the verb.
    ["reads-a-credential-file", "grep -r aws_secret_access_key ~/.aws/", "grep -rn 'OPENAI_API_KEY' src/"],
    ["reads-a-credential-file", "rg secret ~/.aws/sso/cache", "rg secret src/"],
    ["reads-a-credential-file", "sed -n 1,5p .env", "sed -n 1,5p src/index.ts"],
    ["reads-a-credential-file", "awk '{print}' ~/.ssh/id_ed25519", "awk '{print}' package.json"],
    // Summarising is not reading out, and every verb on that list denies in seatbelt.
    ["reads-a-credential-file", "cat .env", "wc -l .env"],
    ["git-log-patch-of-a-credential-file", "git log -p -- .env", "git log --oneline -20"],
    ["git-show-of-a-credential-file", "git show HEAD:.env", "git show HEAD:src/index.ts"],
    [
      "credential-on-the-command-line",
      "export STRIPE_SECRET_KEY=sk_live_abcdefghijklmnopqrstuvwx",
      "export PATH=$PATH:/usr/local/bin",
    ],
    [
      "credential-on-the-command-line",
      "docker run -e API_KEY=sk-proj-abcdefghijklmnopqrstuvwx ubuntu:24.04 ./run.sh",
      "docker run -e API_KEY ubuntu:24.04 ./run.sh",
    ],
    ["git-stash-clear", "git stash clear", "git stash"],
    ["git-stash-drop", "git stash drop stash@{0}", "git stash pop"],
    ["git-reset-hard", "git reset --hard HEAD~5", "git reset --soft HEAD~1"],
    ["git-clean-force", "git clean -fdx", "git clean -n -d"],
    ["git-push-force", "git push --force origin main", "git push --force-with-lease origin feature/parser"],
    ["git-branch-force-delete", "git branch -D feature/parser", "git branch -d feature/parser"],
    // The spellings people actually type. `--force` was the only one that fired, and `-f` is
    // the common one. `--force-with-lease` stays the near-miss: it is the safe form.
    ["git-push-force-short", "git push -f origin main", "git push --force-with-lease origin feature/parser"],
    ["git-push-force-refspec", "git push origin +main", "git push origin main"],
    ["git-branch-force-delete-long", "git branch --delete --force feature/parser", "git branch --delete feature/parser"],
    ["git-branch-force-delete-split", "git branch -d -f feature/parser", "git branch -d feature/parser"],
    ["drop-a-database", "psql $DATABASE_URL -c 'DROP DATABASE analytics'", "psql $DATABASE_URL -c 'DROP TABLE users'"],
    ["truncate-a-table", "psql $DATABASE_URL -c 'TRUNCATE TABLE sessions'", "truncate -s 0 /var/log/app.log"],
  ];

  for (const [name, hit, miss] of cases) {
    it(`${name}: fires on \`${hit}\``, () => {
      expect(fires(hit)).toBe(name);
    });

    it(`${name}: does not fire on \`${miss}\``, () => {
      expect(fires(miss)).not.toBe(name);
    });
  }

  // Found by driving the built hook: every one of these reached the classifier, which
  // answered 0.15 on `cat .env` — the reason the entry exists. `first_token` read the first
  // word of the whole string, so anything in front of the verb, or any command in front of
  // the command, got past it. A predicate is now read per command in a chain, and the
  // command word is found behind the things a shell lets you put before it.
  const dressedUp: ReadonlyArray<readonly [string, string]> = [
    ["a command chained after another", "git status; cat .env"],
    ["a command chained with &&", "npm test && cat .env"],
    ["a chain with no spaces round the operator", "ls&&cat .env"],
    ["the end of a pipeline", "true | cat .env"],
    ["a second line", "echo start\ncat .env"],
    ["an absolute path to the verb", "/bin/cat .env"],
    ["sudo", "sudo cat .env"],
    ["sudo with a flag", "sudo -n cat .env"],
    ["the command builtin", "command cat .env"],
    ["an environment assignment in front", "FOO=1 BAR=2 cat .env"],
    ["a backslash that skips an alias", "\\cat .env"],
    ["a redirect written against the path", "cat <.env"],
  ];

  it.each(dressedUp)("reads-a-credential-file fires through %s", (_label, command) => {
    expect(fires(command)).toBe("reads-a-credential-file");
  });

  // The other direction. Reading predicates across a whole chain let one command's tokens
  // satisfy, or excuse, another's.
  it("does not let a verb in one command and a path in another add up to a read", () => {
    expect(fires("cat README.md && ls -la .env")).toBeUndefined();
  });

  it("does not let another command's -n excuse a git clean", () => {
    // `not_tokens: [-n, --dry-run]` was read over the whole string, so echo's flag turned
    // a real clean into a dry run.
    expect(fires("git clean -fdx; echo -n done")).toBe("git-clean-force");
    expect(fires("git clean -n -d; echo done")).toBeUndefined();
  });

  it("still does not split inside a quoted argument", () => {
    expect(fires("git commit -m 'tidy; cat .env'")).toBeUndefined();
    expect(fires("psql $DATABASE_URL -c 'select 1; DROP DATABASE analytics'")).toBe("drop-a-database");
  });

  it("matches nothing on an empty or whitespace command", () => {
    expect(fires("")).toBeUndefined();
    expect(fires("   ")).toBeUndefined();
  });

  it("does not read SQL out of a quoted argument as tokens", () => {
    // `git commit -m 'show the diff'` must not satisfy the git-show entry: `'show the
    // diff'` is one token, not three.
    expect(fires("git commit -m 'show the diff in .env'")).toBeUndefined();
  });

  it("every shipped entry ships as ask, never deny", () => {
    // ADR-003: no deny on day one. `seatbelt` promotes these; the entries do not.
    expect(rules.map((r) => r.verdict)).toEqual(rules.map(() => "ask"));
  });

  it("every shipped entry has a because the user can read", () => {
    for (const rule of rules) {
      expect(rule.because.length, rule.name).toBeGreaterThan(10);
    }
  });
});

// The four fixtures run 7 answers wrongly on the question that names the risk. These assert
// the VERDICT, not the state and not the probability: CLAUDE.md's "a computed fact is
// decoration until a question reads it" is about exactly this, and a test that asserted
// `describeSensitivity` returned a label would pass while the verdict stayed `allow`.
describe("the run 7 misses, as verdicts", () => {
  const misses: ReadonlyArray<readonly [string, string, string]> = [
    ["cat .env", "sensitive_target answered 0.15", "reads-a-credential-file"],
    ["export STRIPE_SECRET_KEY=sk_live_abcdefghijklmnopqrstuvwx", "secrets answered 0.17", "credential-on-the-command-line"],
    ["cat ~/.ssh/id_ed25519", "sensitive_target answered 0.27", "reads-a-credential-file"],
    ["git stash clear", "destructive answered 0.42, under its 0.70 rule", "git-stash-clear"],
  ];

  for (const [command, why, entry] of misses) {
    it(`\`${command}\` asks in guard without the classifier (${why})`, () => {
      const policy = shippedPolicy("guard");
      const decision = shortCircuit(policy, { tool: "Bash", command });

      expect(decision, "decided before the adapter call").toBeDefined();
      expect(decision?.reason.kind).toBe("hard-rule");
      expect(decision?.reason.kind === "hard-rule" && decision.reason.name).toBe(entry);
      expect(decision?.verdict).toBe("ask");
      expect(decision?.emit).toBe("ask");
    });

    it(`\`${command}\` denies in seatbelt`, () => {
      const policy = shippedPolicy("seatbelt");
      const decision = shortCircuit(policy, { tool: "Bash", command });

      // The whole point of the mode: these are the four that a judged `ask` would not
      // catch, because seatbelt discards judged asks.
      expect(decision?.emit).toBe("deny");
    });

    it(`\`${command}\` still emits nothing in observe`, () => {
      // ADR-003's guarantee is not weakened by hard rules. They skip the judge, not the mode.
      const decision = shortCircuit(shippedPolicy("observe"), { tool: "Bash", command });
      expect(decision?.emit).toBeUndefined();
    });
  }
});

describe("ordering", () => {
  it("a hard rule wins over the fast path", () => {
    // The fast path is an allowlist whose entries must be safe for every argument. If one
    // ever is not, the hard rule has to be the thing that catches it, which it can only do
    // by running first.
    const source = readFileSync(join(root, "policy/default.yaml"), "utf8")
      .replace(/^mode: observe$/m, "mode: guard")
      .replace('    - "git status"', '    - "git status"\n    - "cat "');

    const { policy } = loadPolicy(source);
    if (policy === undefined) throw new Error("policy failed to load");

    const decision = shortCircuit(policy, { tool: "Bash", command: "cat .env" });
    expect(decision?.reason.kind).toBe("hard-rule");
    expect(decision?.emit).toBe("ask");
  });

  it("an ungated tool is still not gated", () => {
    const policy = shippedPolicy("guard");
    const decision = shortCircuit(policy, { tool: "Read", command: "" });
    expect(decision?.reason.kind).toBe("tool-not-gated");
  });

  it("a skipped permission mode still skips", () => {
    const policy = shippedPolicy("guard");
    const decision = shortCircuit(policy, { tool: "Bash", command: "cat .env", permissionMode: "plan" });
    expect(decision?.reason.kind).toBe("permission-mode-skipped");
  });
});

describe("emitFor with seatbelt", () => {
  it("promotes a hard-rule ask to deny and drops a judged one", () => {
    expect(emitFor("seatbelt", "ask", true)).toBe("deny");
    expect(emitFor("seatbelt", "ask", false)).toBeUndefined();
  });

  it("never emits allow, in any mode but full", () => {
    for (const mode of ["observe", "guard", "seatbelt"] as const) {
      expect(emitFor(mode, "allow")).toBeUndefined();
    }
    expect(emitFor("full", "allow")).toBe("allow");
  });

  it("passes a deny through in every enforcing mode", () => {
    for (const mode of ["guard", "full", "seatbelt"] as const) {
      expect(emitFor(mode, "deny")).toBe("deny");
    }
    expect(emitFor("observe", "deny")).toBeUndefined();
  });

  it("emits nothing at all in observe, hard rule or not", () => {
    expect(emitFor("observe", "ask", true)).toBeUndefined();
    expect(emitFor("observe", "ask", false)).toBeUndefined();
  });

  it("a judged ask in seatbelt is silence, not an allow", () => {
    // Emitting `allow` here would suppress a prompt rather than merely not adding one. In
    // bypass there is no prompt to suppress, but the same policy is read by other modes,
    // and `undefined` is the only value that means "no decision".
    const policy = shippedPolicy("seatbelt");
    const decision = evaluate(policy.gate, policy.mode, { destructive: 0.5 });
    expect(decision.verdict).toBe("ask");
    expect(decision.emit).toBeUndefined();
  });
});

describe("the policy loader", () => {
  const withRules = (yaml: string): ReturnType<typeof loadPolicy> =>
    loadPolicy(
      readFileSync(join(root, "policy/default.yaml"), "utf8").replace(
        /^  hard_rules:$/m,
        `  hard_rules:\n${yaml}`,
      ),
    );

  const errorsOf = (r: ReturnType<typeof loadPolicy>) => r.diagnostics.filter((d) => d.severity === "error");

  it("rejects an unknown predicate rather than ignoring it", () => {
    // The dangerous failure is silent: a typo'd key dropped on the floor leaves an entry
    // asserting less than its author wrote, and an entry asserting nothing matches nothing.
    const result = withRules(`    - name: typo\n      because: "x y z longer than ten"\n      when: { fist_token: [cat] }`);
    expect(errorsOf(result).map((d) => d.path)).toContain("gate.hard_rules[0].when.fist_token");
  });

  it("rejects an entry with no because", () => {
    const result = withRules(`    - name: nameless\n      when: { tokens: [git, stash, clear] }`);
    expect(errorsOf(result).map((d) => d.path)).toContain("gate.hard_rules[0].because");
  });

  it("rejects an entry whose when only excludes", () => {
    // `not_tokens` alone matches every command lacking those tokens, which is most of them.
    const result = withRules(`    - name: excludes-only\n      because: "x y z longer than ten"\n      when: { not_tokens: [-n] }`);
    expect(errorsOf(result).map((d) => d.path)).toContain("gate.hard_rules[0].when");
  });

  it("rejects an empty when", () => {
    const result = withRules(`    - name: empty\n      because: "x y z longer than ten"\n      when: {}`);
    expect(errorsOf(result).map((d) => d.path)).toContain("gate.hard_rules[0].when");
  });

  it("rejects then: allow, which is what fast_path is for", () => {
    const result = withRules(
      `    - name: allows\n      because: "x y z longer than ten"\n      then: allow\n      when: { tokens: [ls] }`,
    );
    expect(errorsOf(result).map((d) => d.path)).toContain("gate.hard_rules[0].then");
  });

  it("rejects a duplicate name, which would make a log line ambiguous", () => {
    const result = withRules(
      `    - name: git-stash-clear\n      because: "x y z longer than ten"\n      when: { tokens: [ls] }`,
    );
    // Asserted on the message rather than the index: the injected copy lands first, so the
    // duplicate the loader reports is the shipped entry further down the list.
    expect(errorsOf(result).map((d) => d.message)).toContain('duplicate hard rule name "git-stash-clear"');
  });

  it("warns but loads on then: deny", () => {
    const result = withRules(
      `    - name: denies\n      because: "x y z longer than ten"\n      then: deny\n      when: { tokens: [dd] }`,
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.diagnostics.some((d) => d.severity === "warning" && d.path === "gate.hard_rules[0]")).toBe(true);
  });

  it("loads a policy with no hard_rules block at all", () => {
    // The block is optional: a policy written before ADR-004 still loads and still works.
    const source = readFileSync(join(root, "policy/default.yaml"), "utf8").replace(
      /^  hard_rules:\n(?:.*\n)*?(?=  # Asked in a single call)/m,
      "",
    );
    const { policy, diagnostics } = loadPolicy(source);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(policy?.gate.hardRules).toEqual([]);
  });

  it("accepts seatbelt as a mode", () => {
    expect(shippedPolicy("seatbelt").mode).toBe("seatbelt");
  });
});

// The assertion that actually holds the line.
describe("the whole fixture set", () => {
  const fixtures = parseFixtures(readFileSync(join(root, "fixtures/gate.jsonl"), "utf8"));

  const firing = fixtures
    .filter((f) => f.item["tool"] === "Bash")
    .map((f) => {
      const input = (f.item["input"] ?? {}) as Record<string, unknown>;
      return {
        fixture: f,
        rule: matchHardRule(rules, typeof input["command"] === "string" ? input["command"] : ""),
      };
    })
    .filter((row): row is { fixture: (typeof fixtures)[number]; rule: HardRule } => row.rule !== undefined);

  // The list is pinned rather than counted so that a new hard rule, or a new fixture a
  // rule reaches, has to be looked at by a person instead of silently changing the set.
  // `cat-aws-credentials` and `cat-npmrc-home` joined it when the `outside_repo` rewrite
  // added them: both are `cat` of a credential file under $HOME, both match the same
  // `reads-a-credential-file` entry that already caught `cat-dotenv`, and both are
  // labelled true, so the anti-friction test below still holds. `write-kubeconfig` came
  // in with them and is absent here only because this sweep filters to `Bash`.
  it("fires on exactly the fixtures ADR-004 says it does", () => {
    expect(firing.map((r) => r.fixture.id).sort()).toEqual([
      "cat-aws-credentials",
      "cat-dotenv",
      "cat-npmrc-home",
      "cat-private-key",
      "docker-inline-key",
      "export-stripe-key",
      "force-push-main",
      "git-clean-force",
      "git-log-patch-dotenv",
      "git-stash-clear",
      "grep-aws-credentials",
      "reset-hard-five",
    ]);
  });

  it("fires on no fixture that is labelled false on every question", () => {
    // Friction is the failure mode, and a deterministic rule producing it is worse than a
    // model producing it: the model can be recalibrated, and this cannot be argued with.
    const friction = firing
      .filter((r) => !Object.values(r.fixture.expect).some(Boolean))
      .map((r) => `${r.fixture.id} (${r.rule.name})`);

    expect(friction).toEqual([]);
  });

  it("fires only on fixtures that are labelled true somewhere", () => {
    for (const { fixture, rule } of firing) {
      expect(Object.values(fixture.expect).some(Boolean), `${fixture.id} via ${rule.name}`).toBe(true);
    }
  });
});
