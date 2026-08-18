---
title: Unified onboarding — one flow, every question skippable, the product is the result
slug: unified-onboarding-every-question-skippable
project: sendmo
status: decided (B, C) / draft (A, D)
blocked_on: null — B and C decided by John 2026-08-18; A and D follow the recommendations unless he objects
created: 2026-08-18
last_updated: 2026-08-18
author: Claude Fable 5 — written from John's direction of 2026-08-18 ("progress bars don't represent the flow; who's-sending is now unnecessary; every step should be skippable, including recipient address"). This continues the two ideas PR #68's handoff explicitly deferred.
reviewer: null
outcome: null
---

> **What John asked for, verbatim intent:** (1) the progress bar should represent the actual questions — destination address, origin address, package details, shipping options; (2) the who's-sending step should disappear — the flow itself resolves it; (3) every question should be skippable, including the recipient address, and skipping should make it visibly clear you're now creating a link, not a label.

## 1. The end state

One flow. Four questions, in John's order, each independently skippable. No product fork the user walks; `link_type` is computed from what they skipped, at the end.

| # | Question | Skip answer | Skip means |
|---|---|---|---|
| 1 | **Where's it going?** (destination) | "The sender ships it wherever I want" → see §5-D naming | 🆕 new shape: link user supplies the destination. Creator still pays. |
| 2 | **Where's it shipping from?** (origin) | "The sender will fill this in" | exists today (PR #68) |
| 3 | **What's in the package?** | "The sender will fill this in" | exists today (PR #68) |
| 4 | **Shipping options** | — not skippable in the same sense | nothing skipped → carrier + exact price + pay now. Anything skipped → preferences + price cap + save card. |

**The moment any skip is chosen, a persistent banner appears and stays for the rest of the flow:** "This is now a **shipping link** — {the other party} fills in the rest and prints the label. **You pay.**" Undo restores label mode if the skip is reversed. This is John's point 3's second half and it generalizes PR #68's step-20 banner from "shown at the end" to "shown at the moment of the decision."

**Who-pays never changes: the creator pays on every branch of this flow.** That sentence must survive every copy edit — the skippable-recipient shape is the seller link's *geometry* with the *opposite payer*, and who-pays confusion is what the seller-link review spent most of its time on. Nothing in this flow may ever be labeled or styled as the seller flow.

## 2. Item 1 — the progress bar (independent, ship first)

Today's four segments are Destination / Shipment Details / Payment / Label & Link, and steps 10 (origin) + 14 (package) both map to segment 1 — so completing the origin step advances the bar by nothing, which is exactly John's complaint. Fix: segments become the four questions plus completion:

**Destination → Origin → Package → Shipping → Done** (5 segments; verify+payment fold into the segment they conclude — "Shipping" for the label path, matching today's collapse rule).

Mechanics are contained: `STEPS` in `ProgressBar.tsx`, `STEP_TO_PROGRESS` / `progressIndexToStep` in `stepRouting.ts`, and their tests. No routing or state changes. **This does not need the rest of the proposal decided** and can merge as its own small PR immediately.

## 3. Item 2 — deleting the who's-sending step

Step 0 exists to answer one thing: which address slot the account holder's saved address prefills (`prefillSlotFor`), plus copy tense. With both address questions now first-class steps, the classification is derivable at the address steps themselves:

- Each address step shows a one-tap **"Use my address" chip** (saved address, pre-verified) beside the input. Tapping it on *destination* = today's `sender: 'other'`; tapping it on *origin* = today's `sender: 'self'`. Not tapping it anywhere = no assumption.
- `sender` stays in flow state as a *derived* value (`'self'` / `'other'` / `null`) for everything that branches on it today (copy, Rule-7 guards, creation-email recipient). Nothing downstream changes shape.
- `/onboarding` then starts directly at the destination step. The `who-sending` route 301s there; the resume banner moves with it.

Risk to check in review: the 2026-06-27 decision (only the payer gets a creation email) keys off who the account holder is, not off `sender` — confirm no email logic reads `sender` before it's derivable.

## 4. Item 3 — skippable destination (the new shape)

Skipping the destination produces a link whose *user* enters where it ships. Real product ("I'll ship this wherever you want it" — gifts, prizes, "send it to your new place"). Consequences, none optional:

1. **Migration 042.** The 040/041 constraint requires `recipient_address_id IS NOT NULL` on non-seller links. New rule for `flexible`: **at least one of** recipient/origin address present (a link carrying *neither* address and *no* package is an empty product — refuse it at creation with copy, and in the constraint). `seller_link` and `full_label` invariants unchanged. Strictly relaxing again; same apply-before-merge protocol as 041, which is now well-rehearsed.
2. **Sender flow asks for the destination** when the link lacks one — a new step in `SenderFlow`, validated + verified like the origin. OG unfurl copy needs a no-destination variant ("You've been sent a prepaid shipping label — tell us where it's going").
3. **Rule 7 flips direction here:** on this shape the *creator's* saved address must NOT leak to the link user beyond what the flow needs. The GET payload for a no-destination link must omit `recipient_*` fields entirely (today they'd be null anyway — assert it in tests, not assume it).
4. **Labels/tracking:** `labels` edge function resolves destination from the shipment, not the link — verify it has no `link.recipient_address_id` assumption (the seller flow already ships without one, which is encouraging but must be checked, not inferred).

## 5. Decision points (John)

- **A. Payment when anything is skipped** — proposal: unchanged from today's flex path (save card + price cap). No new payment surface. *Recommended; anything else touches PAYMENTS.md scope.*
- **B. Can the destination AND origin both be skipped?** **DECIDED (John, 2026-08-18): any combination** — including all three questions skipped. The link user can be left to enter everything; the price cap is the only bound. Migration 042 therefore drops the address requirement for `flexible` entirely (constraint keeps `seller_link` and `full_label` invariants only). The abuse surface is accepted and bounded by the cap; revisit if real links show misuse.
- **C. Progress bar ships first, alone?** **DECIDED (John, 2026-08-18): yes** — shipping immediately as its own PR.
- **D. Naming the new shape.** It must never read as the seller flow. Working copy: same "shipping link" name everywhere, with the banner clarifying who fills what. A distinct name ("open link"?) only if testing shows confusion. *Recommendation: one name, vary the sentence.*

## 6. Staging

| Phase | Scope | Gate |
|---|---|---|
| **1 (now)** | Progress bar = the four questions (§2). | None — independent. |
| **2** | Delete step 0; derive `sender`; unify `/onboarding/*` routes into one step map with `link_type` computed at the end. Skip-banner generalized to fire at the moment of any skip. | This proposal decided. Touches routing, guards, both step maps, every onboarding test — the reason PR #68 refused to do it inline. |
| **3** | Skippable destination: migration 042, SenderFlow destination step, OG variant, GET-payload omission tests. | Phase 2 merged; decision B made. |

Each phase is its own PR with its own review, per the PR #68 pattern (it caught 5 real findings; the pattern earns its cost).

## 7. What this does NOT change

Seller flow (`/sell`, buyer-pays) — untouched, including its entry-point gating. Payment architecture — untouched (decision A). The append-only ledger, webhooks, tracking — untouched. And the still-open launch blocker stands: **the flex path has 19 links and 0 shipments ever in production**; Phases 2–3 route even more people onto it, so the end-to-end proof (different person ships, creator's card charged) should ideally land before Phase 2, not after.
