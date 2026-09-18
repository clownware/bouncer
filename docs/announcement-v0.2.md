# Announcement draft — Bouncer v0.2

*Not yet postable as written: `package.json` still says 0.1.0, so tag the release before
this goes out, or retitle it.*

Written to be posted as-is. Every number in it comes from
[run 8](calibration/2026-09-18-jev-8.md) or from the hard-rules sweep in
`test/hardrules.test.ts`. If a number changes, change it here too or cut the sentence.

---

## Long form (blog, LinkedIn, HN text post)

**Bouncer v0.2: the edges are code, the judge decides the middle**

Every agent pipeline is paying reasoning prices for if-statements. *Is this command
destructive? Does it touch production?* Those are judgments, not reasoning — small,
repeated, decided against criteria somebody already wrote down — and sending them to a
frontier model buys a paragraph of deliberation for a question whose answer is a number.

Bouncer puts a judgment model in that spot instead. It is a Claude Code `PreToolUse` hook:
every proposed tool call gets classified against a YAML policy you own — seven questions in
one call, a couple of hundred milliseconds, roughly four cents a day. It ships in observe mode, which emits no decision at all and just
writes down what it would have said.

v0.2 is mostly one lesson, learned the hard way.

The classifier is good. It clears the calibration bar on all seven questions. And it scored
`cat .env` at 0.15 on the question whose own criteria name "displaying the contents of a
.env file." Also `export STRIPE_SECRET_KEY=sk_live_…` at 0.17, `cat ~/.ssh/id_ed25519` at
0.27, and `git stash clear` at 0.42. All four still prompted, which was the problem rather
than the reassurance: each was rescued by some *other* question firing, or by an uncertainty
band. The verdict was right and the reason was an accident.

So we wrote it down — that narrowing one of those questions to cut friction would remove the
rescue — and then did the friction work anyway, because it was the right work. One day
later, the calibration run came back with the project's first missed fixture: the Stripe key,
allowed. Exactly the predicted one, for exactly the predicted reason.

The fix is not a better prompt or a moved threshold. A command that prints a private key is
not a probability. v0.2 adds `gate.hard_rules`: fifteen deterministic entries evaluated
before the model is called, where a match is the verdict and no classifier call happens at
all. Eleven fixtures hit them, every one labelled dangerous by hand, and **not one fixture
labelled safe gained a prompt.**

What else landed:

- **Friction more than halved**, 25 of 99 fixtures down to 12, by rewriting the question
  that caused most of it. It had been asking *where* a command acts when the labels are
  about *whose files* are at stake. Accuracy went up on both reworded questions, and on the
  main one it went up over a larger labelled set: fourteen fixtures that had been left
  unlabelled now carry an explicit label, so the denominator grew from 20 to 34 while
  accuracy went 90% to 94%.
- **`seatbelt` mode**, for the population that runs `--dangerously-skip-permissions` — which
  is most people running agents seriously. For them `ask` is meaningless: it forces the
  prompt they turned off. `seatbelt` never prompts. Hard rules deny, judgments stay silent
  unless they clear a deny threshold you set yourself. Zero interruptions, and a floor. We
  verified with a live probe that a hook `deny` is actually honoured under that flag before
  building the mode on top of it.
- **A local adapter**, so the same fixtures can run against an open-weights model through
  constrained decoding — the next token forced to the label set, probability read off the
  logits. Not a chat completion asked to return JSON with a confidence field it made up. If
  the endpoint can't constrain the decode, the adapter refuses to start rather than
  returning a number that looks exactly like a real one.

One thing we are careful about: there is no confidence field anywhere in this. A `noul`
answer is a bare probability. What the tables call confidence is `max(p, 1 − p)`, arithmetic
on `p` that adds no information. The calibration claim is the Brier score, and it is
published per question, from a live run, on the policy in the repo.

MIT, zero runtime dependencies, observe by default:
https://github.com/clownware/bouncer

---

## Short form (X / Mastodon)

Bouncer v0.2 is up. It's a Claude Code hook that runs a judgment model on every tool call
instead of a frontier one — ~200 ms for the whole gate, ~4¢/day, YAML policy you own.

The lesson of this release: our classifier clears its calibration bar on all seven
questions, and scores `cat .env` at 0.15 on the question whose own criteria say "displaying
the contents of a .env file."

So the edges are code now. Fifteen deterministic rules run before the model, and a match
skips the call entirely. Friction went 25 fixtures → 12 in the same release.

Plus `seatbelt` mode: if you run --dangerously-skip-permissions, `ask` is meaningless to
you. Never prompts, only ever denies, and only on a rule.

https://github.com/clownware/bouncer

---

## Notes before posting

- The Jev-versus-local comparison table is not in the README yet: the local adapter has
  never been run against a real model. Don't claim the compare in a post until that table
  exists.
- "Friction 25 → 12" is measured over 99 hand-labelled fixtures, and 14 of the reduction
  comes from fixtures that gained an explicit label in the same change. Run 8 says so
  plainly; if anyone asks, that is the honest version.
