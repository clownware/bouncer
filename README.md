# Bouncer

A decision layer for [Claude Code](https://claude.com/claude-code) hooks.

A `PreToolUse` hook classifies each proposed tool call against a policy you own and returns
allow / ask / deny — using a fast System One model ([TypeSafe Jev](https://typesafe.ai))
rather than a frontier LLM, so it can run on every call for about four cents a day.

The problem it exists for: Claude Code's permission prompt is binary. Either every `Bash`,
`Edit` and `Write` interrupts you, or you run `--dangerously-skip-permissions` and hope.
There is no cheap middle — let the obvious through, stop the dangerous, ask about the
ambiguous — because that middle needs judgment, and judgment used to mean either brittle
regex or an LLM in the hot path.

> **Status: v0.1 in progress. Not usable yet.**
> The scaffold, latency budget and decision records are in place; the engine and the Jev
> adapter are not. See [docs/PRD.md](docs/PRD.md) for the spec and
> [docs/adr/](docs/adr/) for what has been decided and why.

## Design commitments

These are the parts worth arguing with, stated up front.

**It ships observing only.** The default mode emits no decision at all, which means
behaviour identical to not having the plugin installed. You turn on enforcement after
looking at your own calibration numbers, not because a README told you the model is good.

**It cannot fail open, and it cannot fail loud.** Every error path — timeout, bad key,
rate limit, unparseable policy, internal crash — falls through to Claude Code's normal
permission flow. Bouncer being broken is never the reason something dangerous ran, and
never the reason your session is unusable.

**Adding friction is treated as a bug.** Even a correct verdict is a regression if it
prompts you on something that would not have prompted you before. This is why observe mode
emits nothing rather than `ask` — see [ADR-003](docs/adr/003-fail-to-prompt-and-observe-by-default.md).

**No thresholds in code.** The questions are plain English and the thresholds are numbers,
both living in a YAML file you own and can commit next to your `CLAUDE.md`. Re-tuning the
policy never means re-asking the model.

**It is a safety net, not a security boundary.** The command text being judged can come
from a repository you do not control, and the model's own documentation notes that state
content can be adversarially framed. Bouncer is built to catch Claude's mistakes. It is not
built to withstand someone deliberately trying to get past it.

## Performance

Hook overhead, measured on Node 22 (`npm run bench`):

| | mean | p95 |
|---|---|---|
| bare `node -e ''` | 28 ms | 33 ms |
| bouncer hook, mock adapter | 43 ms | 47 ms |

Budget is 80 ms p95 for hook overhead, 600 ms p95 end to end including the classifier call.
CI enforces the former. See [ADR-002](docs/adr/002-bundled-single-file-on-node.md).

## Development

```bash
npm install
npm run build      # bundles src/ -> bin/bouncer.mjs (committed; see ADR-002)
npm test
npm run typecheck
npm run bench      # asserts hook overhead against the budget
```

`bin/bouncer.mjs` is a build artifact that lives in git, because Claude Code installs
plugins by fetching the repo and never runs `npm install`. Rebuild and commit it whenever
`src/` changes; CI checks that it matches.

To capture real hook payloads to develop against, see [scripts/CAPTURE.md](scripts/CAPTURE.md).

## License

MIT
