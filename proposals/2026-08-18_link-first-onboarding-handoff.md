---
title: Handoff — make sending a link a first-class path in onboarding
slug: link-first-onboarding-handoff
project: sendmo
status: draft
blocked_on: "#62 released to prod"
created: 2026-08-18
last_updated: 2026-08-18
reviewed: null
decided: null
author: Claude Opus 5 — written at John's request after he looked at /onboarding/full-label/shipping in prod and read it as "there is no flex link option." Every fact below was verified against the shipped prod bundle and the code at main, not inferred.
reviewer: null
outcome: null
---

> **You have decision authority on this one.** John is asleep. He asked for this
> flow to be rethought and said the session "will make its own decisions about
> the flow." Do not stall waiting for input — decide, justify, build. The only
> things reserved for him are listed under **Guardrails**.
>
> **One-line summary:** the homepage sells a shareable link as the product; the
> onboarding funnel delivers a prepaid-label form and hides the link behind one
> muted text button. Make the link a first-class path again without throwing
> away the reasoning that got us here.

## The ask

Sending someone a link must be a **first-class situation** in onboarding — not
a fallback discovered by users who fail at something else. How you achieve that
is yours to decide. Reverting to the old two-door path picker is *allowed* but is
not the assumed answer; the picker was removed for real reasons (below).

## Why this exists

John was looking at `/onboarding/full-label/shipping` in production and asked
whether the missing flex-link option was intentional or a regression. It is
intentional — and it is in his screenshot, as the "I don't have their address"
button. **He built this flow, was looking straight at it, and did not see it.**
That is the finding. Treat his reaction as user research with n=1 and unusually
high signal, not as a misunderstanding to be corrected.

## Verified current state

Checked against the live bundle at `https://sendmo.co/assets/index-BSUxbUjX.js`
on 2026-08-18 — all of this is in production now:

| Surface | State |
|---|---|
| Homepage hero | "Create a shipping label. **Share it with anyone.**" |
| Homepage sub | "**Set up a link once.** Share it with anyone who needs to send you something — they click, enter package details, and print a label." |
| Homepage bottom CTA | "Your **first link** takes about 60 seconds to set up." |
| Both homepage CTAs | → `/onboarding` |
| `/onboarding` step 0 | "Who's sending the package?" — one card ("Someone else") + one muted text link ("I'm mailing something out myself") |
| Both step-0 answers | enter `full_label` |
| Only route to `flexible` | the "I don't have their address" button at the origin step |
| Seller link | visible but **inert** ("Coming soon" ×3 in the bundle) |

### The core tension

The homepage promises a link. The funnel delivers a label form whose first ask is
the *sender's* address — the one thing a user who wants a link does not have.
The link appears only as `text-muted-foreground` with a `HelpCircle` icon, named
after the user's *problem* ("I don't have their address") and never after the
product. The words "shipping link" / "flex link" appear nowhere in the flow.

Compounding it: of three `LinkType` values (`full_label`, `flexible`,
`seller_link`), **`seller_link` is gated to coming-soon and `flexible` is demoted
to an escape hatch.** For a product whose homepage is about links, `full_label`
is currently the only first-class thing in the funnel.

Note the asymmetry that already exists and is *correct*: authenticated users get a
first-class link entry on the Dashboard — "You don't have a shareable link yet" →
**"Create my link"** → `/links/new`. The gap is specifically the **unauthenticated
onboarding funnel**, which is where the homepage sends everyone.

## History — read this before you redesign

Do not relitigate these blind. They were decided with reasoning you should engage
with on the merits and may still overturn.

- [`proposals/2026-08-17_onboarding-who-is-sending_reviewed-2026-08-17_decided-2026-08-17.md`](2026-08-17_onboarding-who-is-sending_reviewed-2026-08-17_decided-2026-08-17.md) — the decided proposal that produced today's flow. **OQ2** chose routing shape (c): keep both slugs, default optimistically to `full_label`, and let the escape *navigate* to `flexible/preferences`. This was chosen over a neutral third slug and over moving `path` out of the URL, specifically to keep URLs self-describing, keep Sentry's parameterized route names intact, and keep existing deep links valid. Those constraints are real — respect them or explicitly argue past them.
- **LOG 2026-08-16** — review finding B1 flagged that signed-in users could never reach the new seller door. The same class of "the entry point exists but nobody can get to it" bug is what you are fixing now.
- **LOG 2026-08-18** — the step-0 rebalance and the seller coming-soon gate. Explains why step 0 is deliberately lopsided.
- `src/App.tsx:40-47` — the routing intent, in prose, at the source.
- `src/contexts/RecipientFlowContext.tsx:279-300` — the escape's mechanics, including why `data.path` is derived from the URL and why the flushSync pattern is *not* needed here. If you change the fork, this comment is the thing you must keep true.

### The strongest argument for today's design

Steelman it before discarding it: a path picker forces every user to classify
themselves into product vocabulary ("full label" vs "flexible link") **before**
they have any context. Deferring the fork until the user hits the actual
decision point — "I don't have their address" — is genuinely better UX *if* the
user reaches that point knowing the option exists. The design's flaw may be
discoverability and naming rather than the routing shape. A fix that only renames
and re-weights the affordance is a legitimate outcome if you can defend it.

## What "first-class" has to mean

Your design is free, but it should satisfy these or explain why not:

1. A user arriving from the homepage's "set up a link once" copy reaches a link **without first being asked for the sender's address**.
2. The link path is **named as a product** somewhere the user sees it — the words matter, "I don't have their address" is a symptom, not a name.
3. It is reachable **without failing at something else first**.
4. The homepage promise and the funnel's first screen tell the same story.
5. Existing `/onboarding/flexible/*` and `/onboarding/full-label/*` deep links still resolve.

## Options — evaluate, don't assume

Non-exhaustive. Judge on merits; invent a better one if you have it.

- **(A) Restore a two-door picker at step 0**, renamed in job language rather than product jargon. Costs: the "classify yourself first" problem the current design was built to solve.
- **(B) Keep step 0 as-is, promote the escape** — move it up, name it ("Send them a link instead"), give it card weight rather than help-text weight. Cheapest; may not be enough for #1 above, since the user still lands on an address form first.
- **(C) Fork on the homepage instead of in onboarding** — two doors on `/` that deep-link to `/onboarding/flexible/...` vs `/onboarding/full-label/...`. The homepage already has a two-door pattern for the seller product; this reuses it. Note the seller door is currently coming-soon, so a third door needs thought.
- **(D) Make the destination step path-agnostic** and fork after it, so the shared step comes first and the fork is a real choice rather than a rescue.
- **(E) Reframe entirely around the job** ("Someone's sending me something" / "I'm sending something") and derive `link_type` from answers the user can actually give.

## Evidence worth gathering first

- Read `src/pages/Index.tsx` end to end. The whole marketing narrative is link-first; the funnel is label-first. Quantify the mismatch before designing.
- `src/pages/LinksNew.tsx` — the authenticated link-creation flow already exists and works. Reusing it may be cheaper than new onboarding surface.
- Check whether any analytics/event_logs distinguish `flexible` vs `full_label` onboarding completions. If the data exists, **use it** — it beats all of the above reasoning. If it does not exist, say so rather than guessing at volumes.
- `SPEC.md` for the intended product model of the three link types.

## Guardrails

- **Open a PR. Do not merge to `main`.** John reviews in the morning. Prod deploys on merge and he is asleep.
- **No force-push.** No destructive DB operations (global Rule 0.5). No secrets in chat (Rule 0).
- Payments, auth, and schema paths are **out of scope** — this is an onboarding-routing change.
- Follow **PLAYBOOK Rule 19**: any change to a rendered surface needs a `Browser-verified:` block in LOG.md with a spec or an mcp-session, and `variants-covered:`. Assert on the rendered element, not on the URL — a transition test that only checks the URL and prior-step state passes against a UI that never moved (LOG 2026-08-17).
- **`AnimatePresence mode="wait"` never completes its exit in the browser preview pane** — the outgoing step stays mounted under the new URL and reads exactly like a routing bug. Use Playwright for step transitions (LOG 2026-08-17).
- Before trusting any local e2e run, confirm what owns port 5173 — a stale `vite` from another checkout silently tests a different app (finding A4c):
  ```bash
  for pid in $(lsof -ti:5173); do lsof -a -p $pid -d cwd -Fn | grep '^n'; done
  ```
- Read Playwright results with `grep -E '[0-9]+ (failed|passed|skipped)'` — a stricter anchor has now fooled two sessions into reading a red run as clean.
- **Write a proposal first** per `PROPOSAL-REVIEW-PROTOCOL.md`, then — since John is unavailable to break ties — **adversarially review your own design** in a separate pass before implementing, and record both the proposal and the self-review in the file. State your decision and its reasoning explicitly so John can audit the call rather than reconstruct it.
- End the session per Rule 5: update `LOG.md` and `SPEC.md`.

## Starting state

- Branch from `main` **after #62 has merged and deployed** (it was awaiting CI when this was written — verify with `gh pr view 62 --json state,mergedAt`).
- **Check whether [#64](https://github.com/jsa7cornell/Sendmo/pull/64) has merged.** It was open when this was written. It makes the e2e suite blocking and fixes a host mismatch that made ~28 CI failures meaningless; if it has landed, a green CI run is trustworthy and you should keep it green. If it has not, e2e results on your branch are noise — say so rather than reporting them as signal.

## Files you will touch

| File | Why |
|---|---|
| [`src/components/recipient/RecipientStepWhoSending.tsx`](../src/components/recipient/RecipientStepWhoSending.tsx) | Step 0 — the fork, currently lopsided by design |
| [`src/components/recipient/RecipientStepFullShipping.tsx:278-288`](../src/components/recipient/RecipientStepFullShipping.tsx) | The "I don't have their address" escape, gated on `!isSelfSender` |
| [`src/contexts/RecipientFlowContext.tsx:279-300`](../src/contexts/RecipientFlowContext.tsx) | `switchToShippingLink` — the only mid-session product change |
| [`src/lib/stepRouting.ts`](../src/lib/stepRouting.ts) | URL/step model and `canAccessStep` guards |
| [`src/App.tsx:40-47`](../src/App.tsx) | Routing intent prose — keep it true or rewrite it |
| [`src/pages/Index.tsx`](../src/pages/Index.tsx) | The homepage promise the funnel has to keep |

## Open questions for John (do not block on these)

1. Is `flexible` actually the strategic core product, or has `full_label` quietly become it? The homepage says the former; the funnel now says the latter. Decide for the design, flag the assumption loudly, and let him correct it.
2. Should the seller link's coming-soon state change how many doors the homepage shows? Three doors may be one too many while one is inert.
