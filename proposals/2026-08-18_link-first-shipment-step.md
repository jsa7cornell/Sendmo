---
title: Make sending a link a first-class answer, not an escape
slug: link-first-shipment-step
project: sendmo
status: shipped
blocked_on: null
created: 2026-08-18
last_updated: 2026-08-18
reviewed: 2026-08-18
decided: 2026-08-18
executed: 2026-08-18
pr: 67
author: Claude Fable 5 — implementing session. Design direction ("every option could include a 'sender will fill it out' choice") is John's, 2026-08-18. Written after the link-first handoff and after checking real usage in the prod DB.
reviewer: Claude Fable 5 — self-review (weaker than a fresh-eyes pass; every claim re-verified against code)
outcome: approve-with-changes
---

> **In one line:** the homepage sells a shareable link; the funnel makes that link something you reach only by failing to complete a label form. This turns "the sender will fill this in" into a first-class answer at the moment the question is asked.

## 1. Context

### What's wrong

The homepage promises a link — *"Create a shipping label. **Share it with anyone.**"*, *"**Set up a link once.**"*, *"Your **first link** takes about 60 seconds."* Both CTAs go to `/onboarding`.

What the user then gets is a label form. To reach the link they must:

1. Answer "Who's sending the package?"
2. Enter their own address, phone, and email
3. Land on a shipment form asking for **the sender's address** — the one thing they don't have
4. Notice a muted line of help-text below it: *"I don't have their address"*

The link is never named. The words "shipping link" appear nowhere in the flow. It's labelled after the user's **problem**, not the **product**, and it sits below a form they cannot complete.

**This is a regression I introduced** in [2026-08-17_onboarding-who-is-sending](2026-08-17_onboarding-who-is-sending_reviewed-2026-08-17_decided-2026-08-17.md). That proposal removed a two-door picker in which "Flexible Prepaid Shipping Link" was a co-equal first-class card. The reasoning — don't force users to classify themselves into product jargon before they have context — was sound, and this proposal keeps it. What it got wrong was leaving the link with **no door at all**.

The signal that it's real: John built this flow, was looking straight at the screenshot, and asked whether the flex option had been removed. Treat that as n=1 user research with unusually high signal.

### What the data says

From the prod DB, 2026-08-18:

| Path | Links | Live links | Shipments | Live shipments |
|---|---|---|---|---|
| `full_label` | 38 | 0 | **37** | **9** |
| `flexible` | 19 | 7 | **0** | **0** |
| `seller_link` | 2 | 0 | 0 | 0 |

Two things follow, and they point in opposite directions:

- Every package that has ever shipped went through `full_label`. The link path has produced **zero shipments, ever** — its second half (sender opens link → ships) has never completed in production.
- But this is almost entirely John's own dogfooding, not customers; live payments are still gated. It measures **what has been exercised**, not what the market wants.

So the zero is not evidence that nobody wants links. It is evidence that **the link path is unproven**, which changes how we should ship this — see §5 and the risk in §7.

**John's call (2026-08-18): the link is the core product.** The homepage is right and the funnel is wrong.

## 2. Architecture

### The idea

Rather than asking the user to pick a product, ask the questions — and let **"the sender will fill this in"** be a legitimate answer to the one they may not be able to answer.

```
 Step 0  Who's sending the package?            [unchanged]
           └── Someone else ──┐
           └── I'm mailing something out myself ──► always full_label
                              │                     (you know your own address)
                              ▼
 Step 1  Your address + email                   [unchanged]
                              │
                              ▼
 Step 10 Where's it shipping from?
           ( ) I have their address            ──► stays full_label
           ( ) The sender will fill this in    ──► becomes flexible
                              │
             ┌────────────────┴───────────────┐
             ▼                                ▼
   /full-label/shipping                /flexible/preferences
   rates → verify → pay → label        verify → save card → link
```

The product type is **derived from an answer the user can actually give**, never chosen from a menu of product names.

### Why the package block follows the address

The mockup shows both the address and the package as deferred. That is the real state, but it is driven by **one** control:

A flexible link has the *sender* supply everything — origin and package alike. So deferring the address necessarily defers the package too. Making the package independently deferrable would let a user enter an address that then gets discarded (flexible links carry no origin the sender flow reads), which is a visible wart for no gain.

So: **one choice on the address block; the package section reflects the consequence** rather than offering a second, redundant control. Independent package deferral is a follow-up, and only becomes coherent once the link can carry an origin the sender flow prefills (`sendmo_links.origin_address_id` exists from migration 040 but the sender flow doesn't read it).

### Why this keeps what the last change got right

The steelman for today's design is real: a picker forces self-classification into vocabulary the user doesn't have yet. This proposal does **not** restore a picker. The fork stays at the point of the real decision — it is only *named*, *weighted*, and *reachable without failing first*.

### Routing — nothing changes

Deferring calls the existing `switchToShippingLink()`, which navigates to `/onboarding/flexible/preferences`. That is exactly what today's escape does. So OQ2 of the decided 2026-08-17 proposal is untouched: both slugs stay self-describing, Sentry's parameterized route names are intact, and every existing deep link resolves. The `flushSync` reasoning in `RecipientFlowContext` stays true because `completedSteps` still doesn't change across the fork.

## 3. File-by-file plan

| File | Change |
|---|---|
| [`RecipientStepFullShipping.tsx`](../src/components/recipient/RecipientStepFullShipping.tsx) | Replace the muted escape with a two-choice selector on the origin block (app's existing selection-card pattern: `border-primary bg-primary/5` selected). When "sender will fill this in" is chosen, call `onNoAddress()`. Package/rates sections render only on the "I have their address" branch. `sender === 'self'` is unaffected — no defer option, since you know your own address. |
| [`RecipientOnboarding.tsx`](../src/pages/RecipientOnboarding.tsx) | Banner copy on the flexible branch: name the product ("This is a shipping link — they fill in the rest and print the label. You pay."). Keep the existing undo. |
| [`Index.tsx`](../src/pages/Index.tsx) | No change. The homepage already sells the link; the funnel is what was lying. |
| `tests/e2e/onboarding.spec.ts` | Update the escape test to the new control; add a test that the link is reachable **without** the origin form being completable, and that the label path still works when the address is supplied. |
| `LOG.md`, `SPEC.md` §7 | Record the change and the derived-not-chosen model. |

No schema change. No new route. No payment-path change.

## 4. Test plan

- **e2e (now blocking after [#64](https://github.com/jsa7cornell/Sendmo/pull/64)):** choosing "the sender will fill this in" reaches `/onboarding/flexible/preferences` **and** the step actually swaps (assert the new step's heading is visible and `#origin-name` is gone — a URL-only assertion passes against a UI that never moved, LOG 2026-08-17). Choosing "I have their address" still reaches rates and the label path. Undo restores the typed address. `sender=self` shows no defer option.
- **Regression discipline:** each new test is confirmed to **fail without its fix** before being accepted — two tests in this repo have now passed against broken UI.
- **Unit:** unchanged; `stepRouting` assumptions already covered in `recipientFlowStorage.test.ts`.
- **Browser-verify (Rule 19):** step transitions via Playwright, not the preview pane — `AnimatePresence mode="wait"` never completes its exit there and reads exactly like a routing bug (LOG 2026-08-17). Preview pane is fine for single-step layout and copy.
- Before trusting any local run, confirm what owns port 5173 (finding A4c) and read results with `grep -E '[0-9]+ (failed|passed|skipped)'`.

## 5. Out of scope

- **Independent package deferral** — incoherent until a flexible link can carry an origin (above).
- **Homepage changes** — it already tells the link story.
- **Step 0** — unchanged; the lopsided shape was decided 2026-08-18.
- **The seller link** — stays coming-soon.
- **Proving the flexible path end-to-end.** This proposal makes the link reachable; it does **not** make it proven. See §7.

## 6. Verification

1. From the homepage, click "Send or receive a package" → "Someone else" → your address → the shipment step now leads with a real choice, and "the sender will fill this in" is one of two equally-weighted options.
2. Choose it → land on shipping preferences, banner names the product, undo returns with the typed address intact.
3. Choose "I have their address" → the origin form and package sections appear; rates load; the label path completes as today.
4. `/onboarding/flexible/preferences` and `/onboarding/full-label/shipping` still resolve directly.
5. "I'm mailing something out myself" shows no defer option.

## 7. Open questions

1. **The link path has never carried a package in production (0/19).** This proposal routes materially more people onto it. Should a full dogfood — create a link, have someone else open it and ship — gate promoting it, or ship the routing now and dogfood in parallel? *Author's view: ship the routing, dogfood immediately after, and treat a failure there as a launch blocker rather than a bug.*
2. Should the banner state who pays more loudly than "You pay"? The flexible link charges the creator's saved card off-session per shipment; users seeing "link" may assume the sender pays.

## Reconciliation with prior decided proposals

- **[2026-08-17_onboarding-who-is-sending](2026-08-17_onboarding-who-is-sending_reviewed-2026-08-17_decided-2026-08-17.md) (decided).** This is a **correction of drift I introduced**, not a new finding. That proposal's §1.4b argued the address is the only real fork — correct — and then left the fork as unnamed help-text. Its OQ2 routing decision is preserved exactly. Its steelman (don't make users self-classify) is preserved: this derives the type from an answerable question rather than restoring a picker.
- **[2026-07-17_seller-link-buyer-pays](2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md) (decided).** Untouched — `seller_link` stays coming-soon; no entry point changes.
- **[2026-05-16_flex-payment-pattern-d-execution](2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md) (decided).** Pattern D is unchanged. This changes only how users *reach* it, which is why OQ7.1's dogfood question matters — more traffic onto an off-session charge path that has never fired in production.

---

## Review

```
reviewer:    Claude Fable 5 — SELF-REVIEW, same session as the author. This is
             structurally weaker than the protocol's fresh-eyes pass and should
             be read that way: I cannot un-know the design's intent. To
             compensate, every claim below was re-verified against the code
             rather than against the proposal's own summary.
reviewed_at: 2026-08-18
verdict:     approve-with-changes
```

### Summary

The diagnosis is right, the routing is genuinely unchanged, and the "derive the type from an answerable question" model is a real improvement over both the picker it replaces and the escape it replaces. Verified: the flexible path consumes **nothing** step 10 collects (`RecipientStepFlexPayment` builds its payload from `destinationAddress` + preferences only), so deferring after step 1 loses no user input — the proposal's central mechanical assumption holds. One blocking issue: as written, it taxes the only path that has ever produced a shipment.

### Blocking

**B1 — Hiding the form behind an unselected choice adds a click to the path responsible for 100% of shipments.**
- *Issue:* §3 renders the package/rates sections only on the "I have their address" branch. If neither option starts selected, every label user — 37 of 37 shipments to date — gains a click and a screen that is mostly empty, to fix a problem they don't have. The proposal optimises for the unproven path at the proven path's expense, which is precisely the trade the 0/19 data says not to make blindly.
- *Fix:* **pre-select "I have their address."** The form renders immediately, exactly as today, and the defer option sits above it as a visible, equally-weighted, correctly-named alternative. This still satisfies every "first-class" criterion from the handoff — named as a product, reachable without failing first, visible before the sender-address form is attempted — while costing the label path nothing. First-class means *visible and named*, not *unavoidable*.

### Non-blocking

**N1 — "You pay" understates what the user is agreeing to.** The banner says the creator pays. What actually happens (`FlexPaymentStep.tsx:532`) is *"You'll be charged the actual shipping cost each time a sender uses your link"* — a saved card charged off-session, per shipment, capped. A user choosing "the sender will fill this in" mid-form has not yet seen that. The banner should carry the recurring nature, not just the direction: *"You'll be charged each time someone uses your link."* This is the proposal's own OQ2 and the answer is clearly yes.

**N2 — §5 says proving the flexible path is out of scope, and it shouldn't be quite that clean.** Routing more people onto a path with 0/19 conversion is only safe if someone actually walks it. The proposal's OQ1 recommends "ship and dogfood in parallel"; that's defensible, but the follow-through needs a named owner and a deadline in the LOG entry, not a sentence in a proposal. Otherwise this ships traffic onto an untested off-session charge path and nobody is accountable for checking it.

**N3 — "the package section reflects the consequence" is under-specified.** It needs to say what the user sees. Recommend: when deferred, the package cards do not render at all — the mockup's "both deferred" appearance comes from the banner plus their absence, not from a second disabled control. A greyed-out duplicate control would imply a second decision that doesn't exist.

### Predicted pitfalls

1. **The label path regresses in conversion while the link path stays at zero.** If B1 ships unfixed, the measurable outcome is fewer completed labels and still no completed links — strictly worse than today on the only metric with data behind it.
2. **A test that passes against a UI that never moved.** This change is a step transition, and the last two transition tests in this repo passed against stale DOM. Any test that asserts only the URL, or only that `#origin-name` is absent, will pass if the step never swaps. Assert the destination step's heading is *visible*.
3. **The preview pane will make the working transition look broken.** `AnimatePresence mode="wait"` never completes its exit there. Cost a wrong diagnosis and a reverted commit on 2026-08-17. Use Playwright for the fork; the pane only for single-step layout.
4. **The banner's promise outruns the product.** It tells the user the sender will fill in the rest and print the label — a sequence that has completed zero times in production. If the sender flow has a defect, this change is what will surface it, at the moment a real user is depending on it.

### What it gets right

- Names the regression as **drift the author introduced**, cites the decided proposal, and preserves its OQ2 routing decision exactly rather than quietly reopening it.
- Keeps the steelman: no picker, no self-classification into product jargon.
- Verified-not-assumed: the flex path really does consume nothing from step 10, so the fork is lossless.
- Honest about the data cutting *against* the change, rather than presenting 0/19 as merely "under-exposed".

## Author response

```
author:       Claude Fable 5
responded_at: 2026-08-18
disposition:  accept all
```

**B1 — pre-select "I have their address". ✅ Accept.** This is the right correction and I had it backwards: I was treating "first-class" as "impossible to miss", which taxes the proven path to advertise the unproven one. First-class means named, weighted, and visible before the user can fail — all achievable with the form open by default. Adopted into §3.

**N1 — banner copy. ✅ Accept.** Changing to *"You'll be charged each time someone uses your link"*, matching what `FlexPaymentStep` already tells them later. Answers OQ2 yes.

**N2 — dogfood needs an owner. ✅ Accept.** The LOG entry will carry it as an explicit open item naming what must be walked end-to-end (create link → someone else opens it → ships → card charged) and that a failure there is a launch blocker, not a bug.

**N3 — specify the deferred state. ✅ Accept.** When deferred, the package cards do not render. No second control.

**Net:** one blocking change, adopted. Remaining for John: **OQ1** — ship the routing now and dogfood immediately after (author + reviewer both lean yes), versus gating the promotion on a successful dogfood first.

## Decision

```
decided_by:  John
decided_at:  2026-08-18
outcome:     approve-with-changes — "looks right. proceed." + "carry this all the way out"
```

**Design direction is John's:** *"all the options could include a 'sender will fill out' option."* That reframing is what makes this work — it turns the link from an escape into an answer, and it generalises past the address in a way none of the five options in the handoff did.

**OQ1 (dogfood timing) — resolved as: ship the routing, dogfood immediately after.** Both author and reviewer leaned this way and John's "carry this all the way out" endorses shipping. The obligation does not disappear with the merge: the LOG entry carries it as an open item with no owner, and a failure walking that path end-to-end is a **launch blocker, not a bug**.

**OQ2 (banner copy) — resolved yes**, folded in during review: the banner states the recurring charge rather than a bare "You pay".

**Scope call recorded:** independent *package* deferral was cut from v1. A flexible link has the sender supply everything, so an entered origin would be silently discarded — the mockup's "both deferred" appearance is one control's consequence, not two controls. It becomes coherent only once a link can carry an origin the sender flow prefills.

Status → shipped. Merged via [PR #67](https://github.com/jsa7cornell/Sendmo/pull/67).
