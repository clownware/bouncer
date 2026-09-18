# PRD — Bouncer: a decision layer for Claude Code hooks

**Status:** Draft v0.1 · **Owner:** Chris / Clownware · **Date:** 2026-09-18
**Working name:** `bouncer` (alternatives: `verdict`, `gatekeep`). Name the layer, not the backend.

---

## 1. Problem

Claude Code users live with two failure modes that hand-written rules can't fix:

1. **Permission prompts are binary.** Either every `Bash`/`Edit`/`Write` interrupts you, or you run `--dangerously-skip-permissions` and hope. There's no cheap middle: "let the obvious through, stop the dangerous, ask about the ambiguous."
2. **Skill triggering is a coin flip.** Skills fire on description matching that the user can't observe or tune. Users with many custom skills (this author has 10+) get the wrong skill, or none, and don't find out until the output is wrong.

Both are *judgment* problems — fuzzy classification over small, bounded state — that need ~100 ms answers, not a frontier model call. Until this week, that meant either brittle regex or an LLM in the hot path. System One models (TypeSafe Jev) and single-token-logprob tricks on local LLMs now make a calibrated, sub-second decision cheap enough to run on every tool call and every prompt.

## 2. Goals

- **G1.** A `PreToolUse` gate that classifies a proposed tool call against a user-owned policy and returns `allow` / `ask` / `deny` in < 600 ms p95, with the judgment and confidence logged.
- **G2.** A `UserPromptSubmit` skill router that picks the best-fit skill (or none) from the user's installed skills and injects a one-line hint, with confidence gating so low-confidence picks are silent.
- **G3.** Decisions are backend-pluggable. v0.1 ships Jev; the interface is designed so a local logprob adapter (v0.3) is a config change, not a rewrite.
- **G4.** Policy lives in code (a YAML file the user owns); raw judgments are logged unchanged so policy can be re-tuned without re-asking.
- **G5.** Ship a calibration harness so users can verify the backend's confidence numbers against their own history before trusting enforcement.
- **G6.** Installable as a standard Claude Code plugin via a marketplace; zero runtime dependencies beyond Node (already required by Claude Code).

## 3. Non-goals

- Not a model router for subagents. Claude already picks subagent models with full context; re-deciding from prompt text adds nothing. (Routing belongs in pipelines with no frontier model in the loop — out of scope here.)
- Not a replacement for Claude Code's permission system. Bouncer sits in front of it and can only make it *quieter* or *stricter*; it never bypasses a deny the user configured.
- Not an MCP server. Exposing Jev as tools the LLM calls is the wrong layer — the hook asks Jev, the model never knows.
- No text generation anywhere in the hot path.
- No image/screenshot input (Jev is text-only today).
- v0.1 does not attempt to gate MCP tool calls beyond logging them.

## 4. Users

- **Primary:** solo/indie developers directing Claude Code heavily, many custom skills, running with broad permissions and uneasy about it.
- **Secondary:** small teams wanting a shared, reviewable policy for agent actions in a repo (policy file committed alongside `CLAUDE.md`).
- **Not targeted in v0.1:** enterprise policy management, org-wide audit.

## 5. Architecture

```
Claude Code ──(hook JSON on stdin)──▶ bouncer CLI ──▶ Decision Engine ──▶ Adapter (jev | local | mock)
                                          │                │
                                          │                └─▶ decisions.jsonl (append-only log)
                                          ◀──(hook JSON on stdout)── Policy (bouncer.yaml)
```

### 5.1 Components

| Component | Responsibility |
|---|---|
| **Hook entrypoints** | Two thin scripts registered in the plugin's `hooks/hooks.json`: `pretooluse` and `userpromptsubmit`. Read stdin JSON, call the engine, write stdout JSON. Hard timeout well under Claude Code's hook timeout. |
| **State builder** | Turns the hook payload into the *state* string sent to the adapter. Applies redaction (see §9) and size caps. |
| **Decision engine** | Loads policy, builds the question set (fan-out), calls the adapter once, evaluates policy rules against returned probabilities/confidence, emits a verdict. |
| **Adapter interface** | `decide(state, questions[]) → answers[]` with three question types: `choice`, `score`, `noul`. Adapters: `jev` (v0.1), `mock` (v0.1, for tests/CI), `local` (v0.3). |
| **Policy** | `bouncer.yaml` — questions, thresholds, actions. Repo-level overrides user-level. |
| **Log** | `~/.bouncer/decisions.jsonl` — every judgment with raw probabilities, confidence, verdict, latency, backend. Never contains redacted content. |
| **Calibration harness** | `bouncer calibrate` — replays logged decisions (or a labeled fixture set) and prints a reliability table (bucketed confidence vs. observed agreement with the user's later action). |
| **Commands / skill** | `/bouncer:status`, `/bouncer:dry-run on|off`, `/bouncer:explain <id>` (shows the last verdict's raw judgments), plus a SKILL.md that teaches Claude to consult the log when a user asks "why did that get blocked." |

### 5.2 Adapter contract

```ts
type Question =
  | { id: string; type: "choice"; prompt: string; options: string[] }
  | { id: string; type: "score";  prompt: string; levels: string[] }   // ordered
  | { id: string; type: "noul";   prompt: string };                     // "is this true"

type Answer =
  | { id: string; type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { id: string; type: "score";  score: number; probabilities: number[]; confidence: number }
  | { id: string; type: "noul";   p: number };

interface Adapter {
  name: string;
  decide(state: string, questions: Question[], opts: { timeoutMs: number }): Promise<Answer[]>;
}
```

All questions in one call. Adapter must be side-effect free and must throw a typed `AdapterError` (`timeout` | `auth` | `rate_limited` | `unavailable`) so the engine can apply the failure policy (§8).

### 5.3 Hook I/O

- **PreToolUse:** read `tool_name`, `tool_input`, `cwd`, session/transcript path from stdin. Output a decision using Claude Code's documented hook response schema (`permissionDecision: allow|deny|ask` + reason). `ask` means "fall through to the normal prompt"; `allow` suppresses it only when the user has enabled auto-allow in policy.
- **UserPromptSubmit:** read `prompt`, `cwd`. Output additional context (one line: `Consider loading skill: <name> — <reason>`) or nothing.

> **Open item (verify first thing):** confirm the exact current field names for hook input/output and the per-hook timeout against the live Claude Code hooks docs. Do not build against memory. Pin the docs version in an ADR.

## 6. Policy schema (v0.1)

```yaml
version: 1
backend: jev            # jev | local | mock
mode: dry-run           # dry-run | enforce   (dry-run: log verdicts, always return "ask"→passthrough)
timeout_ms: 800
on_error: passthrough   # passthrough (fall to normal prompt) | deny

gate:
  # Questions are asked in one fan-out. Each is a Noul unless typed.
  questions:
    destructive:   "The command deletes, overwrites, resets, or force-pushes something not trivially recoverable."
    secrets:       "The action reads, writes, prints, or transmits a credential, token, key, or password."
    outside_repo:  "The action touches paths outside the current working directory or its subtree."
    egress:        "The action sends data to a network destination other than a package registry or git remote."
    prod:          "The action targets a production system, deployment, or live data."
  rules:
    # Evaluated top-down; first match wins. `p` is the Noul probability, `conf` the answer confidence.
    - when: { destructive: { p: ">=0.85" } }           then: deny
    - when: { secrets:     { p: ">=0.70" } }           then: deny
    - when: { prod:        { p: ">=0.60" } }           then: ask
    - when: { outside_repo:{ p: ">=0.60" } }           then: ask
    - when: { egress:      { p: ">=0.60" } }           then: ask
    - when: { any:         { conf: "<0.55" } }         then: ask     # low confidence → human
    - default: allow
  auto_allow: false      # if false, "allow" still shows the normal prompt (log-only). Flip after calibration.
  tools: [Bash, Edit, Write, MultiEdit, NotebookEdit]

router:
  enabled: true
  min_confidence: 0.70
  include_none: true      # always offer "none of these"
  skills: auto            # auto = read installed skills' name + description at runtime; or an explicit list
```

Design rules: policy is data, questions are plain English, thresholds are numbers the user can move after reading their own calibration table. No question or threshold is baked into code.

## 7. State construction

Gate state (≤ 4 KB, truncated with a marker):

```
tool: Bash
cwd: /Users/x/Dev/ops
git: branch=type/judge-signals, dirty=true
command: <redacted-per-§9 command text>
recent: <last 3 tool names in this session>
```

Router state (≤ 2 KB): the user prompt + a one-line list of skill names with descriptions.

Keep state small on purpose: latency scales with input tokens, and Jev is cheapest and fastest on dense state.

## 8. Failure modes & latency budget

| Condition | Behavior |
|---|---|
| Adapter timeout / unavailable / 429 | `on_error` policy. Default `passthrough` → Claude Code's normal prompt appears. Never silently allow. |
| Auth error | Same, plus a one-time stderr warning. |
| Policy file invalid | Refuse to start enforcing; log-only with a clear error. |
| Hook itself crashes | Must exit 0 with no output so Claude Code proceeds normally; log the crash. |

Budget: hook overhead (Node start + JSON) ≤ 80 ms; adapter call ≤ 500 ms p95 (Jev advertises 70–500 ms); total ≤ 600 ms p95. Measure and log per call. If p95 exceeds budget for 20 consecutive calls, auto-drop to dry-run and warn.

## 9. Security & privacy

- **What leaves the machine (Jev backend):** the constructed state only — tool name, cwd basename, git branch, the command/prompt text, skill names. Never file contents, never diffs, never env vars.
- **Redaction before send:** strip anything matching common secret shapes (bearer tokens, `sk-`, `ghp_`, AWS keys, private-key blocks, `op://` refs) and replace with `[REDACTED:<type>]`. The `secrets` question is answered from the *shape* of the command, not the value.
- **API key handling:** read from `BOUNCER_TYPESAFE_API_KEY` or `TYPESAFE_API_KEY` env only. Never stored by the plugin. Never logged. Resolving an `op://` reference at hook time was dropped: `op read` spawns a subprocess and can raise a biometric prompt, so it would put Touch ID in the middle of an agent run. If 1Password support returns it belongs in a `SessionStart` hook that resolves once per session.
- **Log hygiene:** `decisions.jsonl` stores the redacted state itself, not only a hash. Decided 2026-09-18, reversing this document's original position. A hash cannot answer "why was this prompted", cannot seed fixtures from real history, and cannot be re-scored after a policy change, which are the three reasons the log exists. The state is redacted before it reaches the writer and redacted again on write as a backstop, and file contents never enter the state at all, so what is retained is a redacted command line. The log is capped at 8 MB and rotates to one `.1` generation.
- **Local adapter (v0.3)** is the answer for users who won't send command text off-machine; document this trade-off in the README up front.
- **Trust boundary:** hook output is the only thing Bouncer controls. It cannot execute anything. It cannot widen permissions beyond what Claude Code's own settings allow.

## 10. Calibration harness

`bouncer calibrate [--from decisions.jsonl | --fixtures fixtures/*.jsonl] [--backend jev|local]`

- Fixture format: `{ state, questions, expected: {...} }`. Ship ~150 hand-labeled fixtures across the seven gate questions (destructive/safe git, rm variants, curl to registries vs. arbitrary hosts, secret echo vs. secret-shaped strings, prod vs. staging, writes to sensitive paths, piped or auto-approved execution). v0.1 ships 96, which is short of the target and is why the per-bucket accuracies in the README rest on three or four samples each.
- Output: per-question reliability table — confidence buckets (0.5–0.6 … 0.9–1.0) vs. observed accuracy, plus Brier score — followed by the release-gate table below, which reports correct/n and pass/fail per question against the `calibration` block in the policy (defaulting to this section's 0.85 at confidence 0.8). The gate is compared on the exact ratio and printed to one decimal, because 11 of 13 is 84.6% and rounds to a passing-looking 85%. Optional `--compare` runs two backends on the same fixtures side by side.
- From live log: pair each logged verdict with what the user actually did next (approved/denied at the prompt, or the tool ran) and treat that as the label.
- This is a release gate: v0.1 README must publish the fixture table for Jev so users see the numbers before enabling `enforce`.

## 11. Plugin layout

```
bouncer/
├── .claude-plugin/plugin.json
├── hooks/hooks.json                # registers PreToolUse + UserPromptSubmit
├── bin/bouncer                     # single bundled JS, no deps, node shebang
├── skills/bouncer/SKILL.md         # how Claude explains verdicts / edits policy
├── commands/status.md, dry-run.md, explain.md, calibrate.md
├── policy/default.yaml
├── fixtures/*.jsonl
├── src/ (TypeScript)
│   ├── hooks/{pretooluse,userpromptsubmit}.ts
│   ├── engine/{policy,state,redact,evaluate}.ts
│   ├── adapters/{types,jev,mock,local}.ts
│   └── calibrate.ts
├── test/                           # vitest; adapters mocked; fixtures replayed
├── docs/adr/
└── README.md
```

Language: TypeScript, bundled to one file (esbuild), runs on the Node Claude Code already requires. (Go would start faster; rejected for v0.1 because per-platform binaries complicate plugin distribution. Revisit if hook overhead measures > 80 ms.)

## 12. Phasing

**v0.1 — Gate, dry-run first (target: this weekend)**
- Jev + mock adapters, policy loader, redaction, PreToolUse hook, JSONL log, `/bouncer:status`, `/bouncer:explain`, `bouncer calibrate --fixtures` with ~150 fixtures and the published Jev table.
- Ships with `mode: dry-run` and `auto_allow: false`. Enforcement is opt-in after the user has looked at their own table.
- Definition of done: installs from a Clownware marketplace on a clean machine; 100 tool calls in dry-run with p95 ≤ 600 ms; fixture table published; tests green; ADRs 001–003 written.

**v0.2 — Router** *(designed in [ADR-006](adr/006-the-skill-router.md), which supersedes this entry and the `router:` block in §6)*
- `UserPromptSubmit` hook, `skills: auto` discovery, a `needs_skill` noul plus a `which_skill` choice over the discovered registry, gated on probability *and* margin. Its own `off | observe | suggest` mode, observing by default, and in `observe` it makes no classifier call at all — it records state and the harness replays it offline.
- `bouncer calibrate --router` over hand-labelled `fixtures/router.jsonl`, plus `--review`, which pairs observe-mode records with the skill Claude actually loaded and prints the disagreements as the hand-labelling queue.
- ~~DoD: on the author's skill set, top-1 agreement ≥ 80% at confidence ≥ 0.7 over one week of prompts.~~ Withdrawn: agreement with the skill the model already picked measures imitation of the incumbent, and 100% agreement would be worth nothing. See ADR-006 § Calibration.
- DoD: ≥ 60 hand-labelled near-miss fixtures over a committed registry of real public skill names, at least a third labelled `none`; top-1 accuracy ≥ 0.85 among the prompts the router answers on; false-suggestion rate ≤ 0.05; **coverage ≥ 0.25** among fixtures labelled as needing a skill, so a router that passes by abstaining is visibly doing that; table published in the README before `suggest` is recommended.

**v0.3 — Local adapter**
- Single-token-logprob adapter over an OpenAI-compatible local endpoint (Ollama / vLLM). Same fixtures, `--compare` table in README.
- DoD: local adapter within 5 pts of Jev on the fixture Brier score, or the README says exactly how far off it is.

**Later / maybe:** MCP tool gating, team policy inheritance, Ops integration (post decisions to `vendor_api:typesafe` spend rows), event-gating adapter for long-running agents.

## 13. ADRs to write during v0.1

- **ADR-001** Hook-layer decision, not MCP tools — why the model never sees the judge.
- **ADR-002** Backend-pluggable adapter interface; Jev first, local second; System One primitive set as the contract.
- **ADR-003** Fail-to-prompt, never fail-open; dry-run default; auto-allow off until calibrated.
- **ADR-004** Policy as YAML in the repo; questions in plain English; no thresholds in code.
- **ADR-005** What leaves the machine, and redaction rules.

ADR-004 and ADR-005 are still unwritten; their content lives in `policy/default.yaml`'s
comments and §9 respectively. Numbering is not reused, so the router's design is
**ADR-006** rather than filling one of those gaps.

## 14. Test plan

- Unit: policy parsing, rule evaluation order, redaction (table-driven, includes near-misses), state truncation.
- Adapter: `mock` deterministic; `jev` tested with stubbed fetch for 200/401/429/timeout.
- Integration: replay fixtures through the real hook entrypoint via stdin; assert stdout schema.
- Latency: bench script; CI asserts hook overhead ≤ 80 ms with mock adapter.
- Calibration: fixtures run in CI against mock; Jev table produced manually and committed.

## 15. Success metrics

- Author dogfood: prompt interruptions down ≥ 50% at zero unsafe allows over two weeks in enforce mode.
- Calibration: Jev gate questions ≥ 0.85 accuracy in the 0.8+ confidence bucket on fixtures.
- Adoption signal: 25 installs / 3 external policy PRs in the first month — enough to know whether the policy format is the thing people fork.

## 16. Open questions

1. ~~Exact current Claude Code hook schema and timeout.~~ **Answered.** Captured from a live session on 2026-09-18; the payloads are in `test/fixtures/payloads/` and the pinned facts are in `docs/adr/001`. Read a fixture rather than the docs.
2. ~~Jev state-size limit and rate limits.~~ **Answered.** 64k tokens for state plus all questions, 32k for state plus the longest question. Rate limits are documented as dynamically adjusting, so nothing hardcodes them.
3. ~~Does Jev's confidence on Noul questions carry information beyond `|p − 0.5|`?~~ **Answered, and the question was wrong.** `noul` answers have no confidence field at all; only `choice` and `score` return one. Uncertainty rules are written as ranges on `p`.
4. Should the router inject context or actually invoke the skill? v0.2 injects only; invoking is a bigger permission question. **Still open, and now has a prior question in front of it:** whether the injected line goes to the model (`additionalContext` — the only form that can save tokens, and the only form that can cost them) or to the human (`systemMessage` — no routing risk, no token saving). ADR-006 recommends the former, behind a `suggest` mode that is not the default.
5. Marketplace: publish under `clownware/plugins` or a dedicated repo? Recommend dedicated repo, listed in the existing marketplace.

## 17. Project brief (paste into the Claude Code project)

**Goal:** Ship Bouncer v0.1 — a Claude Code plugin whose PreToolUse hook classifies tool calls via a pluggable System One adapter (Jev first) against a user-owned YAML policy, in dry-run by default, with a calibration harness and published fixture results.

**Threads, in order:**
1. Verify Claude Code hooks schema/timeouts against live docs; write ADR-001..003; scaffold plugin layout and CI. *Blocks all others.*
2. Engine: policy loader + validator, redaction, state builder, rule evaluator. Table-driven tests.
3. Adapters: interface, `mock`, `jev` (raw fetch, no SDK), typed errors, stubbed-fetch tests. *Depends on 2's types.*
4. Hook entrypoint + bundling + latency bench; `/bouncer:status`, `/bouncer:explain`. *Depends on 2, 3.*
5. Fixtures (~150) + `bouncer calibrate` + README with the table. *Depends on 3.*

**Rules:** read `CLAUDE.md` first; conventional commits; branch per thread; PRs only; no `--no-verify`; no real API key in any thread — Jev calls are stubbed in tests and the calibration run against live Jev is done by me locally. Report out-of-scope findings as Found Work.

**Definition of done:** as §12 v0.1.
