---
title: Onboarding UX refresh — implementing the shipping-flow design handoff
slug: shipping-flow-redesign
project: sendmo
status: revised
blocked_on: null
created: 2026-08-19
last_updated: 2026-08-19 (T1 decided: option B — handoff order kept)
reviewed: 2026-08-19
decided: null
author: Claude Opus 5 — implementation plan for the design handoff in `Handoffs/design_handoff_shipping_flow/`, which was commissioned by the design brief merged at `c0c5177`. Verified against `origin/main` at `c0c5177`. An earlier draft of this file was written against a 44-commit-stale working tree and is fully superseded; §1.2 records what that cost, because the correction is load-bearing for anyone reading the git history.
reviewer: Claude Fable 5 — fresh-eyes review; every load-bearing claim re-verified against origin/main c0c5177 in a clean worktree, the design handoff read in full (README + both prototypes + screenshots), and the four cited prior proposals read in full
outcome: approve-with-changes
---

> **What this is in one line:** the flow's mechanics are done and correct — this implements the visual and interaction refresh the design brief asked for, and the one structural change without which the brief's hardest ask cannot be built.

---

## 1. Context

### 1.1 Where the flow actually stands

Between 2026-08-17 and 2026-08-19, five PRs rebuilt the shipment-creation flow:

| PR | What landed |
|---|---|
| #67 | The shipping link became an answer, not an escape |
| #68 | Step 10 split into Origin (10) and Package (14), both skippable; drafts survive a closed tab |
| #70 | Progress bar: one segment per question |
| #71 | Step 0 deleted; `sender` derived in-flow; Phase 2 of the unified-onboarding proposal |
| #72 | Skippable destination (Phase 3), migrations 041 + 042 |

All three questions are skippable today. [`useRecipientFlow.ts:31-33`](../src/hooks/useRecipientFlow.ts) carries `deferredDestination`, `deferredOrigin`, `deferredPackage`. Migration [`042`](../supabase/migrations/042_flexible_link_may_defer_destination.sql) relaxed the address constraint for `flexible` entirely, so any combination of skips stores cleanly. A creator can already skip everything.

**The mechanics work. This proposal does not touch them.**

### 1.2 What the earlier draft of this file got wrong, and why it is recorded here

The first version of this proposal was written against branch `fix/e2e-infra-audit`, 44 commits behind `origin/main`. It proposed a deferral-mask migration to fix two CHECK-constraint blockers (already fixed by migrations 041 and 042), recommended deleting step 0 (already deleted in `e05d840`), and raised as an open question whether links with no address at all should ship — which **John had already decided** on 2026-08-18 as decision B of the [unified-onboarding proposal](2026-08-18_unified-onboarding-every-question-skippable.md): *"any combination… the abuse surface is accepted and bounded by the cap."*

Recorded because the protocol treats re-deciding a decided question as the most common way a proposal wastes reviewer time, and because a future reader finding both versions in the history deserves to know which one describes reality. The root cause of the stale baseline is being investigated separately in [`2026-08-19_shipping-process-and-stale-branch-rca.md`](2026-08-19_shipping-process-and-stale-branch-rca.md).

### 1.3 What the handoff is

The design brief merged at `c0c5177` ([`2026-08-19_onboarding-ux-refresh-design-brief.md`](2026-08-19_onboarding-ux-refresh-design-brief.md)) commissioned a redesign and states its own scope plainly: *"The flow's mechanics were just rebuilt and work correctly — this is a UX and visual design refresh, not a logic change."*

The handoff in [`Handoffs/design_handoff_shipping_flow/`](../Handoffs/design_handoff_shipping_flow/) is the answer to that brief: a README spec, two clickable prototypes, and 12 screenshots. John's read is that it's 95% solid on design and may be missing product considerations. That assessment holds — §1.5 lists what it misses, and none of it is large.

### 1.4 The four things the brief asked for, and their status

| # | Brief's ask | Built? |
|---|---|---|
| 1 | The skip option must sit **on top** of each question, not below the form | ❌ [`RecipientStepAddress.tsx:270-281`](../src/components/recipient/RecipientStepAddress.tsx) still renders it under the address block |
| 2 | **One** progress mechanism that stays stable and morphs — *"the hardest and most valuable problem in the brief"* | ❌ [`ProgressBar.tsx:11-25`](../src/components/recipient/ProgressBar.tsx) still holds two segment sets and swaps between them |
| 3 | Identity, sign-in, and saved-address given a deliberate home | ❌ still scattered across steps 1 and 10 |
| 4 | Make the label↔link transformation feel legible, not like a warning banner | ❌ still a muted banner |

Zero of four. That is the work.

### 1.5 What the handoff does not say, and needs to

**(a) The handoff contradicts itself twice.** README §1 puts a "Continue with Google" button and email field under the destination fields; the prototype has no sign-in before step 5 and the `01-creator-flow.png` annotation states the opposite as a deliberate improvement. Separately, README describes progress "done" and "skipped" states as a checkmark and an amber arrow, while that same annotation says *"no checkmarks or arrows to parse."* **Resolution: the prototype wins on sign-in placement** (it is also what brief point 3 asks for), **the README wins on the progress bar**, because a four-state bar is the only thing that makes a skipped step legible — which is brief point 2's whole purpose.

**(b) Price ranges on the link-path Shipping screen have no source.** The design shows a range per speed tier ("$9–$14"). Today's [`RecipientStepFlexPreferences.tsx`](../src/components/recipient/RecipientStepFlexPreferences.tsx) shows no prices at all, and `fetchRates` needs a concrete parcel and two concrete addresses — which by definition are missing whenever something was skipped. The prototype's ranges are hardcoded. See **OQ1**.

**(c) The sender's delivery estimate is a day count today.** The design shows *"Arrives Aug 21–23"*. `ShippingRate.estimated_days` is a number; turning it into a date range needs business-day arithmetic and a cutoff assumption. See **OQ2**.

**(d) The brief's point 9 is unresolved and the handoff quietly answers it.** The brief flags a real tension: *"today 'I have their address' is pre-selected so the label path (all revenue to date) doesn't lose a click, while the founder wants the skip option on top. Prominence and default are separable — resolve this tension deliberately and say how."* The handoff's segmented toggle has **neither option pre-selected**, which changes the default rather than only the prominence. That costs the label path a click on every shipment. See **OQ3**.

### 1.6 One risk flag, narrow and verified

Decision B accepted the abuse surface of a fully-skipped link on the reasoning that *"the price cap is the only bound."* On current `main` the cap bounds each **use**, not the total. The flexible insert at [`links/index.ts:885-901`](../supabase/functions/links/index.ts:885) sets neither `expires_at` nor `max_shipments`, and [`:382`](../supabase/functions/links/index.ts:382) records the Pattern D decision that flex links stay `active` indefinitely. A leaked link with no destination is therefore worth `cap × unlimited uses, forever`, not `cap`.

Both controls that would bound it already work in that same file — auto-expiry at [`:386`](../supabase/functions/links/index.ts:386), single-use closure at [`:699`](../supabase/functions/links/index.ts:699) — and are simply never set for flexible rows. John's own words on decision B were *"revisit if real links show misuse,"* so this is offered as a correction to that decision's stated reasoning, not a reopening of the decision. **It is out of scope for this proposal** and is called out so it lands somewhere rather than nowhere.

Related and worth pairing with it, from the unified proposal's §7: **the flex path has 19 links and 0 shipments ever in production.** This refresh routes more people onto a path no real shipment has ever completed.

---

## 2. Architecture

### 2.1 The finding: the morph bar cannot be built inside the progress bar

Brief point 2 asks for one stable progress mechanism. The bar swaps sets today because **the flow genuinely branches into different steps** ([`stepRouting.ts:114-115`](../src/lib/stepRouting.ts)):

```
FULL_LABEL_STEPS = [1, 10, 14, 11, 12, 13]   Destination · Origin · Package · Verify · Payment · Label
FLEX_LINK_STEPS  = [1, 20, 21, 22, 23]       Destination · Preferences · Verify · Authorize · Share
```

The moment a skip flips the path, steps 10 and 14 leave the sequence entirely. Origin and Package stop existing as steps. The bar isn't choosing to swap — it is honestly reporting that the user was moved into a different sequence. That is exactly the *"teleported into a different product"* feeling the brief describes, and no amount of component work fixes it while two maps exist.

**So the refresh needs one structural change: collapse the two step maps into one.** This is the back half of what Phase 2 of the unified-onboarding proposal set out to do — its scope line reads *"unify `/onboarding/*` routes into one step map with `link_type` computed at the end."* PR #71 delivered the first half (deleted step 0, derived `sender`) and stopped before the map unification. This proposal finishes it, and frames it as completing a decided Phase 2 rather than as a new idea.

### 2.2 The unified flow

```
ONE sequence. Every step keeps its identity whatever the user skips.

  1 Destination ─┐
  2 Origin      ─┼── each carries the same control, skip option FIRST:
  3 Package     ─┘   [ The other person fills this in ] [ I have it ]
        │
  4 Shipping ────── one step, two modes:
        │            nothing skipped → carrier rate cards, exact price
        │            anything skipped → speed + carrier preference + cap
  5 Contact ─────── email + OTP, or Google        (auto-skipped when signed in)
  6 Payment ─────── charge now  │  save card
        │
  7 Done ────────── label to print  │  link to share

link_type is computed at step 6 from the three skip flags. It is never a step.
```

The progress bar then has six fixed segments and four states per segment — upcoming, current, done, **skipped** — and the "morph" is a segment turning amber in place while the flow's destination label updates. Nothing is added or removed. That is a state change the user can watch, which is what brief point 4 asks for.

**Routing.** The 2026-08-17 proposal's OQ2 decision keeps `path` in the URL, and this design keeps that: both paths walk the same six slugs, and the `full-label` ⇄ `flexible` segment rewrites when the first skip lands or the last skip is undone. Old deep links (`/onboarding/flexible/preferences`, `/onboarding/full-label/shipping`) must continue to resolve — six-plus e2e call sites hard-code them and PR #68 explicitly preserved them. They map onto the new slugs with a redirect table.

**No `flushSync` on the path flip.** The page guard reads `completedSteps`, and a skip changes none — steps 1–3 are shared and already complete when the flip happens. `flushSync` stays required where a step *completes* and navigates in the same tick, which is `tryAdvance` (see the 2026-05-19 LOG entry and [`stepRouting.ts`](../src/lib/stepRouting.ts)'s guard comment).

### 2.3 Skip-first, and the default question

Brief point 1 wants the skip option on top; brief point 9 warns that prominence and default are separable. The handoff's control puts the skip first **and** pre-selects neither.

This proposal implements **skip-first prominence with the answer-it-yourself path still the default**: the control renders with "The other person fills this in" as the first option, and the address fields below are live and focusable on arrival. A creator who types an address has answered without touching the control. A creator who taps skip dims the fields in place. Nothing is pre-selected visually, but the *keyboard and pointer default* — an empty form ready to receive input — is unchanged, so the label path loses no click. OQ3 puts this to the reviewer, because it is the one place this proposal knowingly softens the handoff.

### 2.4 Identity

Brief point 3. Account entry gets its own step (5, Contact), as the prototype has it. Two affordances remain on the question steps because they are only useful there:

- **Step 1** — a single line under the fields: *"Returning? Sign in to use your saved address."*
- **Steps 1 and 2** — the saved-address chips (*"Deliver to me"*, *"I'm the sender"*), rendered only when signed in.

Signing in mid-flow must return the user to the exact step with typed input intact. [`recipientFlowStorage.ts`](../src/lib/recipientFlowStorage.ts) already persists the draft across a redirect, and PR #68 added explicit resume — so the missing piece is only a `returnTo` on the auth handoff, which today lands every sign-in on `/dashboard?welcome=1`. Prefill stays **chip-driven**: nothing auto-fills on return, so a sign-in can never overwrite something already typed.

---

## 3. File-by-file plan

Three PRs, each independently deployable, each leaving the blocking e2e suite green.

### PR 1 — One step map, one progress bar

The structural spine. No screen is visually redesigned yet, so the diff is reviewable on its own terms.

| File | Change |
|---|---|
| `src/lib/stepRouting.ts` | One `STEPS` array of six. One slug map. `stepsForPath` collapses. Redirect table for the retired slugs (`preferences`, `authorize`, `share`, `shipping`, `package`, `label`) so every existing deep link resolves. |
| `src/components/recipient/MorphProgressBar.tsx` | **New.** Six segments, four states (upcoming / current / done / skipped), connector lines, amber skipped state. Ported from `MorphProgressBar.dc.html` onto design tokens. Generic enough for the sender flow to reuse in PR 3. |
| `src/components/recipient/ProgressBar.tsx` | **Delete** once nothing imports it. |
| `src/contexts/RecipientFlowContext.tsx` | `deferToSender` gains `"destination"`, so all three skips flow through one function instead of destination having its own pair of handlers. Path derives from the three flags; the URL segment rewrites on first-skip and last-undo. |
| `src/pages/RecipientOnboarding.tsx` | Renders the six-step sequence. Steps 20/22/23 fold into the shared Shipping / Payment / Done steps. |
| `src/index.css` | Add the amber/tan "skipped" token. Nothing else — per the 2026-08-17 OQ4 decision, no new accent families (emerald already means "Economy" in SPEC §6). |

### PR 2 — The four question screens, plus identity

| File | Change |
|---|---|
| `src/components/recipient/SkipToggle.tsx` | **New.** The shared skip-first control, as a `radiogroup` with two radios so it is keyboard- and screen-reader-correct. Used by all three question steps. |
| `src/components/recipient/RecipientStepAddress.tsx` | Skip control moves above the fields; skipped state dims in place (opacity, `pointer-events: none`) instead of replacing the block, so nothing shifts. Sign-in line added; the inline Google button and email field move out to step 5. |
| `src/components/recipient/RecipientStepFullShipping.tsx` | **Split.** It currently serves both step 10 and step 14 ([`RecipientOnboarding.tsx:225,243`](../src/pages/RecipientOnboarding.tsx)) and carries the rate fetch and cap enforcement. Becomes `RecipientStepOrigin.tsx`, `RecipientStepPackage.tsx`, and `RecipientStepShipping.tsx`. **This is the largest and least predictable piece of the plan** — the file is 24 KB of working money-path logic and the split must preserve it exactly. |
| `src/components/recipient/RecipientStepPackage.tsx` | Guestimator card plus the green result panel with **editable** L/W/H and lb/oz inputs, per the handoff. |
| `src/components/recipient/RecipientStepShipping.tsx` | Two modes in one step: rate cards + "Estimated cost" callout, or speed tier + carrier preference + cap. Wraps the existing `FlexPreferencesForm` rather than replacing it. |
| `src/components/recipient/RecipientStepContact.tsx` | **New.** Consolidates `RecipientStepEmailVerifySupabase` and `RecipientStepEmailVerifyFlex`, which differ only in copy and next-step. Auto-skip when signed in stays as-is — including the auto-advance timer fix from `338160e`, which must not regress. |
| `src/components/recipient/RecipientStepPaymentSummary.tsx` | **New.** The unified summary card above the existing payment forms: type pill, To/From rows, carrier row, the dynamic "what's left for the other person" sentence with the cap folded in, Total row. |
| `src/pages/Login.tsx`, `src/contexts/AuthContext.tsx`, `AppHeader.tsx` | `returnTo` round trip so mid-flow sign-in lands back on the step (§2.4). |

**Untouched on purpose:** `RecipientStepFlexPayment`, `RecipientStepPayment`, `StripePaymentForm`, and the whole Pattern D mechanism. Payment gets a new summary above it and no new behavior.

### PR 3 — Sender flow refresh (secondary scope per the brief)

| File | Change |
|---|---|
| `src/components/sender/SenderProgressBar.tsx` | Replace with the shared `MorphProgressBar`, labels computed from the link's skip flags — "Package" / "Your info" / "Destination & info". |
| `src/components/sender/SenderStepIntro.tsx` | Headline and subhead vary by what was skipped; "How it works" three-line card. |
| `src/components/sender/SenderStepPackage.tsx` | Header shows "Shipping to {recipient}" and, when the origin is known, "From {name}" beneath it. A known origin renders as a one-line note, never an editable field (Rule 7). |
| `src/components/sender/SenderStepRates.tsx` | Keep the `$`–`$$$$` tiers and "Preferred by" badge — both already correct. Restyle; add "{Name} will pay for shipping." |
| `src/components/sender/SenderStepReview.tsx` | Service block as its own labelled line; delivery estimate beneath it (**OQ2**); new email helper copy; single "Share my contact info" checkbox, with "save my info on this device" removed per the handoff. |
| `src/lib/senderDelivery.ts` | **New**, only if OQ2 lands on showing dates. Pure function, unit-tested. |

---

## 4. Test plan

Per PLAYBOOK rules 10, 11, 12 and [`TESTING.md`](../TESTING.md).

**Unit.** The six-segment bar's state derivation for all eight skip combinations, especially `skipped`. `stepRouting`'s one map: `nextStep`, `prevStep`, `canAccessStep`, and every retired-slug redirect. The payment-summary sentence builder for all seven skip combinations.

**E2E — the part that needs care.** The mocked suite has been **blocking since 2026-08-18**, so a red window stops merges rather than just looking bad. `url-step-routing.spec.ts` and `auth-section-and-flex-otp.spec.ts` hard-code the old URLs; they are updated in PR 1, in the same commit as the redirect table, so the suite never goes red between commits. New specs cover skip-then-undo restoring typed input, and the bar showing amber rather than re-rendering a different set.

Three traps this project has already paid for, all live here:
- Derive the mock target from `supabaseEnvUrl()` in [`tests/e2e/supabase-env.ts`](../tests/e2e/supabase-env.ts), never a hardcoded project URL — the 2026-08-18 host mismatch made 28 failures invisible.
- Confirm the dev server under test is *this* checkout (`lsof -ti:5173` → cwd) before believing a local run, per the 2026-08-18 worktree finding.
- Between two clicks that span a step transition, wait for the **new step to mount**, never on the URL — PR #68 recorded a spec whose second click hit the outgoing step's button.

**Browser-verify (Rule 19).** Variant axis: `{nothing skipped, destination, origin, package, all three} × {signed-in, signed-out}`, and `× {test, live-comp, live-charge}` for anything touching payment.

---

## 5. Out of scope

- **The flow's mechanics.** All three skips work; migrations 041/042 are done. Nothing here changes what can be stored or created.
- **The §1.6 link-bounding gap.** Flagged, not fixed here.
- **Seller flow, dashboard, tracking page, admin** — the brief excludes all four.
- **Pattern D and the payment architecture.**
- **The homepage**, except the single button entering this flow.

---

## 6. Verification

1. **Label path.** Answer all three → rate cards → pay → PDF. Six segments, all blue, none amber.
2. **Skip one.** Skip Origin → the Origin segment turns amber **in place**; the other five keep their labels and positions. Nothing is added or removed. This is the brief's point 2, and it either reads as a morph or it doesn't.
3. **Undo.** Skip, type nothing, undo → previously-typed input returns, segment returns to blue, URL segment rewrites back.
4. **Skip everything.** All three amber → Shipping shows preferences + cap → card saved → link. Open the link: the sender is asked for all three.
5. **Mid-flow sign-in.** Signed out on step 1, partial address typed, sign in from the header → back on step 1, input intact, saved-address chip now offered and **not** auto-applied.
6. **Old deep links.** `/onboarding/flexible/preferences` and `/onboarding/full-label/shipping` both resolve.
7. **Privacy.** As the sender: no street address for anything the creator filled, no exact prices, and only "{Name} will pay for shipping" as money language.
8. **Resume.** Close the tab mid-flow, reopen → the resume offer appears and does not auto-apply.

---

## 7. Open questions

**OQ1 — where do the link-path price ranges come from?** The design shows a range per speed tier; nothing produces one, and by definition something is missing whenever this screen renders. Options: **(a)** call `fetchRates` with the Guestimator's default parcel and whatever addresses exist, showing a real range when a route exists; **(b)** show ranges only when enough is known, falling back to today's price-free selector; **(c)** drop the ranges. The author leans **(b)**. Reviewer: does a range computed from a parcel the user never described create a quote SendMo then has to honor?

**OQ2 — how precise should the sender's delivery estimate be?** *"Arrives Aug 21–23"* is commitment-shaped, built from an EasyPost estimate with no cutoff guarantee, on the screen a sender acts on. Options: show it as designed; hedge it (*"Usually arrives…"*); keep today's day count. Support load is the real cost and there is no support team.

**OQ3 — does the skip control change the default, or only its prominence?** The brief's point 9 names this tension explicitly and asks for a deliberate resolution. The handoff pre-selects neither option; §2.3 proposes skip-first prominence with an unchanged input default, so the label path — which is all revenue to date — loses no click. Reviewer: is that a fair reading of the brief, or is it under-delivering point 1?

**OQ4 — is the step-map collapse in scope?** The brief says "not a logic change," and §2.1 argues the brief's own point 2 cannot be delivered without it. If the reviewer disagrees, the fallback is a bar that fakes stability by rendering six segments while the router still runs two sequences — which would drift the bar from the actual flow and is the kind of thing this project's LOG has caught before. The author believes the collapse is correct and finishes a decided Phase 2, but wants it confirmed rather than assumed.

---

## Reconciliation with prior decided proposals

**[`2026-08-18_unified-onboarding-every-question-skippable`](2026-08-18_unified-onboarding-every-question-skippable.md) — decided, all three phases shipped.** This proposal **completes** its Phase 2, whose scope line reads *"unify `/onboarding/*` routes into one step map with `link_type` computed at the end."* PR #71 landed the first half. §2.1 argues the second half is required by the design brief; it is finishing a decided item, not proposing a new one. Its decision B (any combination of skips) is **accepted, not reopened**; §1.6 corrects one factual premise in that decision's reasoning without changing the decision.

**[`2026-08-19_onboarding-ux-refresh-design-brief`](2026-08-19_onboarding-ux-refresh-design-brief.md) — the commissioning document.** This proposal implements its four founder points and honors all nine hard constraints. It departs from the brief in exactly one place — the brief says "not a logic change" while §2.1 proposes a routing change — and OQ4 escalates that rather than assuming it.

**[`2026-08-17_onboarding-who-is-sending`](2026-08-17_onboarding-who-is-sending_reviewed-2026-08-17_decided-2026-08-17.md) — decided and superseded in part.** Its step 0 was already deleted by PR #71. Three of its decisions are **kept**: OQ2's routing shape (path stays in the URL, segment rewrites on the fork), OQ4's palette rule (`primary` plus tokens, no new accent families), and the strings-only naming — "Prepaid label" / "Shipping link" — which the handoff's pill badges match exactly.

**[`2026-05-16_flex-payment-pattern-d-execution`](2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md) — decided, untouched.** Save-card-and-charge-on-use is the mechanism behind every skip combination. This proposal adds a summary card above it and changes nothing about it. §1.6 observes a consequence of its "flex links stay active indefinitely" decision but proposes no change here.

---

## Appendix — handoff fidelity

Adopted as specified: all colors, radii, shadows, typography; every screen's copy; skip-first placement; dim-in-place rather than screen-swap; the one-time explainer bubble then a small Undo link; the four-state progress bar; editable Guestimator outputs; every sender-side privacy rule.

Changed, with reason:
- **Sign-in on the Destination step** — README §1 has a full sign-in block, the prototype does not. Prototype wins; a one-line sign-in prompt replaces it (§2.4).
- **Progress-bar checkmarks and arrows** — README has them, one screenshot annotation says otherwise. README wins; the four states are what make a skipped step legible.
- **Neither toggle option pre-selected** — softened to skip-first prominence with an unchanged input default, so the label path loses no click. OQ3.
- **Price ranges and delivery dates** — shown in the design, not currently producible. OQ1 and OQ2.

---

## Review

```
reviewer:    Claude Fable 5 — fresh-eyes session. Read the handoff (README, both .dc.html prototypes, screenshots), all four cited prior proposals in full, PLAYBOOK / SPEC / TESTING / PRE-LAUNCH / PAYMENTS, and the last ~12 LOG entries; re-verified every load-bearing claim against origin/main c0c5177 in a clean worktree.
reviewed_at: 2026-08-19
verdict:     approve-with-changes
```

### Summary

The direction is right and most of the hard verification held: the zero-of-four audit is accurate, both handoff self-contradictions are real (annotation quotes verified against `01-creator-flow.png` and `MorphProgressBar.dc.html`), the Phase 2 scope quote is verbatim, and collapsing the step maps is the correct call. But the two side-claims the proposal presents as "verified" don't survive contact with `main` — §1.6 misses the decided Account Budget control that already bounds the exposure it warns about, and §1.5(b)'s "shows no prices at all" is false (the flex step's most prominent element is a hardcoded price range) — and PR 1 as staged can't deliver a six-step map while the step-14 split waits in PR 2. All of it is fixable without touching the architecture, which is why this is approve-with-changes and not needs-info.

### Blocking issues

**B1 — §1.6's headline number is wrong: a decided control already bounds the exposure, and the section never mentions it.**
- **Location:** §1.6 (and the README blurb repeating it).
- **Issue:** `checkAccountBudget()` (`supabase/functions/_shared/budget.ts`, called in `labels/index.ts` on the flex path against `link.user_id`, ordered *before* the off-session PI) caps cumulative charges at **$200/day and $500/week per account** — `profiles.daily_budget_cents`/`weekly_budget_cents` defaults, breach → 402 + `velocity.limit_hit` + email to the account holder. That is PAYMENTS.md §10.2, decided in the 2026-05-21 payments-risk-intelligence proposal. On top of it: the Pattern D rate limit — 5/min per `(IP + short_code)` (`labels/index.ts:42,118`, in the decided Pattern D file plan and SPEC §14's rate-limit table) — Radar screening of the anonymous sender, per-use decline, link rotation (`POST /:id/rotate`) and cancel, and `is_funded` gating. "Worth `cap × unlimited uses, forever`" is therefore wrong by roughly an order of magnitude per week, and the risk did not need "somewhere to land" — it landed in May. What survives, and is still worth stating: there is **no per-link lifetime bound** — the flexible insert sets neither `expires_at` nor `max_shipments` (`links/index.ts:885-901`, verified), and note that `max_shipments` *enforcement* is `seller_link`-gated (`labels/index.ts:1491-1500`), so bounding flex links needs a code change, not just a value; `:699` is the seller insert's setter, not the closure.
- **Suggested fix:** rewrite §1.6 as "no per-link lifetime bound exists; the account-budget layer bounds totals at $200/day / $500/week (PAYMENTS.md §10.2)," drop the cap×unlimited framing, and keep the correction-to-decision-B framing at these smaller stakes. Update the README blurb when responding.

**B2 — §1.5(b)/OQ1 rests on a false premise: today's flex step already shows price ranges.**
- **Location:** §1.5(b), OQ1, Appendix ("Price ranges … not currently producible").
- **Issue:** `FlexPreferencesForm.tsx` (which `RecipientStepFlexPreferences` wraps) carries a hardcoded `exampleRange` per speed tier — "$13–$18" / "$21–$28" / "$50–$70" (lines 22/34/46) — and renders the selected tier's range as the screen's single most prominent element (`text-4xl font-bold`, line 259, the "Cost spotlight" panel), captioned "typical range for a medium package within California" and "Actual price depends on weight, size, and distance," plus a size×distance estimate grid ("Example estimates. Actual costs can vary."). "Shows no prices at all" is wrong against the very baseline (c0c5177) the proposal claims verification on — the same error class §1.2 apologizes for. The prototype's hardcoded ranges match what already ships; the "quote SendMo has to honor" worry is already answered in production by the disclaimers plus the cap governing the actual charge.
- **Suggested fix:** correct the premise. OQ1 collapses to "keep the shipped hardcoded-example pattern (which the handoff matches), reconcile the two sets of range values, optionally compute a real range when a route + parcel exists." See the OQ1 answer below.

**B3 — PR 1 is underspecified exactly where it is most load-bearing, and its staging contradicts itself.**
- **Location:** §3 PR 1 table; §2.2.
- **Issue,** three parts:
  - **(a) The six-step map needs a component PR 2 owns.** "One `STEPS` array of six" requires a Shipping step distinct from Package, but the component that provides both today (`RecipientStepFullShipping`, parcel + rates together in `mode="package"`) doesn't split until PR 2. As staged, PR 1 either pulls the split forward (contradicting "no screen is visually redesigned yet") or ships a bar whose Shipping segment maps to no full-label step. The plan never states the new step array's contents, the new slug strings, or what renders at Package vs Shipping on the label path in PR 1 — for "the structural spine," that is the one sketch that had to be concrete.
  - **(b) The redirect table omits `verify`.** Three e2e call sites deep-link `/onboarding/flexible/verify`, and three src call sites *build* verify URLs as OAuth/magic-link `redirectTo` targets (`RecipientStepAddress.tsx:88-89`, `RecipientStepEmailVerifySupabase.tsx:176`, `RecipientStepEmailVerifyFlex.tsx:163`) — in-flight magic-link emails will carry them across the deploy. Either the Contact step keeps the `verify` slug or `verify` joins the table. And `package` appears in the retired list while presumably also being a new slug — say which it is.
  - **(c) The call-site census is short.** 24 slug-bearing deep-link literals across **three** spec files, not two: `url-step-routing.spec.ts`, `auth-section-and-flex-otp.spec.ts`, *and* `onboarding.spec.ts:363`. Breakdown: destination ×9 (survives), preferences ×5 — two of which are `/full-label/preferences` invalid-combination assertions that the one-map world inverts — verify ×3, shipping ×3, label ×2, payment ×2 (survives). `authorize`/`share` have no e2e call sites but exist in circulated URLs and persisted drafts, so they still need entries.
- **Suggested fix:** add a concrete `stepRouting.ts` sketch — the array, the slug strings, the full redirect table including `verify` — and name the PR 1/PR 2 seam honestly: either the `RecipientStepFullShipping` split moves into PR 1, or PRs 1+2 ship as one deploy. "Each independently deployable" is currently asserted, not demonstrated.

**B4 — the amber "skipped" token contradicts the decided OQ4 principle the proposal itself cites: amber already means Express in SPEC §6.**
- **Location:** §3 PR 1 `src/index.css` row; PR 3 sender bar.
- **Issue:** SPEC §6 blesses amber as the **Express** speed-tier accent (`bg-amber-50 / border-amber-300 / text-amber-700`; §8's sender rate cards use it; admin Live Comp is also amber). The 2026-08-17 OQ4 decision rejected reusing emerald for seller surfaces precisely because "emerald already means Economy" — the same logic bars an unexamined amber=skipped. The worst adjacency is on this proposal's own screens: the flex-mode Shipping step renders speed tiers directly beneath a bar with amber segments, and PR 3 puts the amber-skip bar above SPEC §8's amber Express cards. The index.css row cites the OQ4 decision as its authority ("no new accent families") while adding a new semantic accent family.
- **Suggested fix:** make the overload a named decision instead of a silent one: either adopt the handoff's tan-amber *with* a SPEC §6 note recording the family's second meaning (John's call — the handoff does pull toward tan `oklch(72% 0.15 70)`, which is distinguishable from `bg-amber-50` chips but not from across the room), or pick a hue clearly outside the Express family. Either way keep a non-color state discriminator on the segment — which the README's arrow glyph already is (see NB2; the two findings solve each other).

### Non-blocking concerns

- **NB1 — §2.1's impossibility claim is overstated; the conclusion is still right.** Full analysis under the OQ4 answer below. Amend §2.1 so the decided record carries the true rationale, not "cannot be built."
- **NB2 — "README wins on the progress bar" is the right call for the wrong reason.** Both versions have all four states: `MorphProgressBar.dc.html` paints upcoming/current/done/skipped as four distinct color treatments with a number in every state (`symbol = String(i + 1)`; no checkmark or arrow anywhere in the component). The delta is only the glyphs. The real reason to keep README's checkmark/arrow is accessibility — state must not be conveyed by color alone — and it mitigates B4's amber collision.
- **NB3 — §1.5(a)'s evidence needs one correction.** The prototype is not uniformly sign-in-free before Contact: its desktop key-screens section renders the destination screen *with* an Identity panel (Continue with Google + email), siding with README §1 against the interactive demo and the `01-creator-flow.png` annotation ("Email and Google sign-in live on their own step, right before payment" — verified verbatim). The handoff contradicts itself three ways, not two. The resolution (Contact step + one-line prompt on step 1) still stands.
- **NB4 — "No `flushSync` on the path flip" is safe only under the toggle model where a skip stops navigating.** Today's `deferToSender` marks the skipped step complete *and* navigates, and wraps that write in `flushSync` for exactly the 2026-05-19 reason. If the unified `deferToSender` (which gains `"destination"`) keeps any navigate, the `flushSync` must survive; §2.2's sentence as written invites deleting it. Also do the `full-label ⇄ flexible` segment rewrite with `replace`, not push — otherwise Back replays the flip (the class PR #71's review re-tightened an assertion for).
- **NB5 — draft compatibility across the renumbering is unaddressed.** 7-day-TTL localStorage drafts carry old step numbers (`completedSteps` with 20–23 on flex, 1/10/14/11/12/13 on full-label) and an old `path`; after the collapse, `firstIncompleteUrl` over the new array resumes them somewhere else or bounces them. PR #68 built `readStored()` compat for exactly this class (LOG 2026-08-18). State the mapping — or the deliberate reset — and pin it with a test.
- **NB6 — the file plan omits `useRecipientFlow.ts`, and the test plan omits `phone-gate.spec.ts`.** `getValidationErrors` and the `canFetchRates` phone-gate pins live in that module; the toggle model changes validation semantics (a deferred step must now *pass* validation via `tryAdvance` instead of bypassing it via defer-marks-complete), and the split moves rate-fetch preconditions into a new step. `phone-gate.spec.ts` is the one named cross-cutting regression spec (4 regressions across 4 surfaces) and was already restructured once when PR #68 split step 10 — it restructures again here and deserves a named line in §4.
- **NB7 — email capture silently moves from step 1 to step 5.** Today step-1 validation requires the email ("email is not deferrable"), so every abandoned flow leaves a contact; under the handoff the first four steps collect none, and the resume draft has no identity. Dogfood-era stakes, but it's a product regression the brief didn't ask for — name it for John rather than inheriting it from the design.
- **NB8 — "Steps 20/22/23 fold into the shared Shipping / Payment / Done steps" oversells PR 1.** `RecipientStepPayment` internally owns steps 12 *and* 13 (payment and label-ready in one component, `RecipientOnboarding.tsx`), and the plan rightly leaves it untouched — so "Done" remains two components behind one slug. Fine; say so, or PR 1's reviewer will hunt for a Done component that doesn't exist.
- **NB9 — §2.4's "nothing auto-fills on return" is not what `main` does.** The context's prefill effect (`RecipientFlowContext.tsx`, prefill block) auto-fills the *empty* slot the moment `sender` resolves — it can't overwrite typed input (bails on `street`), but it is not chip-driven. Either keep the effect and soften the sentence, or gate it; don't let the proposal describe behavior the code doesn't have.
- **NB10 — deploy-quota sequencing.** Three preview-generating PRs plus their merges land on a Vercel Hobby account with a shared daily deploy pool (the 2026-08-16 #62 hold was exactly this). Sequence the PRs; don't open all three at once.

### Nits

- §1.6's ":699 single-use closure" cite is the seller insert's *setter* in `links/`; the closure lives at `labels/index.ts:1491-1500` and is seller-gated.
- The Appendix says "skip-first placement — adopted as specified," but the handoff's toggle order is "**I have it**" first (README §1 and every screenshot); §2.2/§2.3's skip-first inversion is a departure and belongs under "Changed, with reason" (see OQ3).
- Reconciliation calls the unified proposal "decided, all three phases shipped." Precisely: B and C are decided (John, 2026-08-18), A and D are "follow the recommendation unless he objects," and its filename never took a reviewed/decided suffix. "B/C decided; Phases 1–3 deployed" is the accurate cite.
- TESTING.md at `main` still says both e2e steps are non-blocking — stale since #64's A1 flip (`test.yml`'s `continue-on-error` now covers only ESLint and the authed step). The proposal's "blocking since 2026-08-18" is correct; fix the stale doc line in PR 1 while touching the suite.
- `progressIndexToStep` (`stepRouting.ts:167-173`) is the click-handler's per-path map and also collapses in PR 1 — it isn't named in the table.
- The README blurb repeats §1.6's and §2.1's overclaims; update it alongside the author response.

### Predicted pitfalls

1. **The guard-bounce class returns through the unified skip handler.** Someone reads §2.2's "no flushSync on the path flip," deletes the `flushSync` in `deferToSender` during the refactor, and skip-advance races the page guard — user reports "stuck on a step," server says everything succeeded. This is LOG 2026-05-19 (navigate-vs-setData race) and PLAYBOOK Rule 20's reference incident, re-armed by a sentence in this proposal. The fix is in NB4; the pitfall is that the sentence outlives the fix.
2. **Old drafts resume into the wrong place after renumbering.** A creator mid-flow at `/flexible/authorize` on Tuesday gets the deploy on Wednesday; their draft's `completedSteps` [1, 20, 21] means nothing to the new map, and `firstIncompleteUrl` walks them back to Origin with their card half-saved. Same class as PR #68's mid-deploy draft recovery (LOG 2026-08-18), which had to be fixed *after* the fact last time.
3. **`phone-gate.spec.ts` restructures again and a new spec passes vacuously.** The 4×-regressed invariant ("no rate fetch without a phone") moves surfaces when rates leave step 14; meanwhile Playwright's most-recent-first route matching (the PR #68 trap — register the specific mock last) plus redirect-following assertions make it easy to write a deep-link spec that passes against an empty page. The suite is merge-blocking now, so a vacuous pass is worse than a red one — it's invisible. See also 2026-08-17's "a passing e2e that proved nothing."
4. **Amber reads as Express, not skipped, exactly where both render.** Flex-mode Shipping step: amber segment above, warm-accented Express tier below; sender flow (PR 3): amber-skip bar above SPEC §8's amber Express rate cards. A sender concludes the skipped thing is express-related, or vice versa. B4/NB2's glyph keeps the state legible even if the hue stays.
5. **Step-transition verification in the preview pane misleads again.** PR 1–2 change every transition, and the pane cannot complete `AnimatePresence mode="wait"` exits — it reads exactly like a routing bug and already cost one wrong diagnosis and a reverted edit (LOG 2026-08-17). Rule 19 verification for this work is Playwright-first; the pane is for single-step layout only.
6. **A conflicting stacked PR shows no CI at all.** Three sequential PRs rewriting the same files (`stepRouting.ts`, `RecipientOnboarding.tsx`, the same three specs) is the exact shape that leaves PR 2/3 CONFLICTING after PR 1 merges — and a conflicting PR gets *no* Actions run, silently (Rule 21 / A6; LOG 2026-08-18, PR #64's three uncovered commits). Verify `mergeable` + check-suite presence before trusting any of the three PRs' green.

### What the proposal got right

- **The zero-of-four audit is accurate.** All four verified against `main`: skip below the form (`RecipientStepAddress.tsx` ~272), two segment sets (`ProgressBar.tsx:11-24`), identity scattered into step 1's card, muted `bg-muted` banner in `RecipientOnboarding.tsx`.
- **Both handoff self-contradictions are real**, and the annotation quotes check out word-for-word against `01-creator-flow.png`. Catching a design handoff contradicting itself is exactly what this review step exists for, and the author did it first.
- **§1.5(d)/OQ3 is the best product catch in the document:** the handoff *did* silently change the default (neither option pre-selected) against the brief's point 9, which explicitly ordered the tension resolved deliberately. §2.3's prominence-without-default-change is the deliberate resolution the brief asked for and the handoff failed to supply.
- **The Phase 2 framing is honest and verified.** The scope line is quoted verbatim from the unified proposal's §6; PR #71 verifiably stopped short (both step arrays live at `stepRouting.ts:115-116` on c0c5177). This is drift-restoration correctly framed as drift-restoration.
- **Deep links and the red-window discipline.** Redirect table + same-commit spec updates is the right shape for a merge-blocking suite (census gaps aside), and PR #68's slug-preservation precedent is correctly carried forward.
- **The payment architecture is left alone**, the who-pays copy rule is carried into every new surface, and PR 3 keeps Rule 7's sender-side privacy ("a known origin renders as a one-line note, never an editable field").
- **The three e2e traps in §4 are all real, documented incidents** (supabaseEnvUrl derivation, lsof-cwd server check, wait-for-mount), and the browser-verify variant axis matches Rule 19's required shape.
- **The `returnTo` diagnosis is correct** — `AuthContext.tsx:168,178` and `Login.tsx:72` hardcode `/dashboard?welcome=1`; the in-flow Google CTA already round-trips (`RecipientStepAddress.tsx:88-89`), so the header/Login path is indeed the only missing piece.
- **§1.2's provenance record.** Writing down what the stale draft got wrong, and why, is load-bearing honesty — it made this review faster and it will keep the git history legible.

### Open-question answers

**OQ1 — where do the link-path price ranges come from?** The premise is wrong (B2): they come from where they already come from — hardcoded example ranges with disclaimers, shipped today as the flex step's most prominent element. Recommendation: keep that pattern, reconcile the handoff's per-tier numbers with `FlexPreferencesForm`'s existing `exampleRange` values (one source, not two), and keep the "Example estimates / actual price depends on…" caption. The author's (b) — compute a real range when a route + parcel exists — is a fine later enhancement, not a requirement, and there is no honored-quote risk: the actual charge is governed by cap + real rate, and the disclaimer already ships. This also shrinks PR 2: flex-mode Shipping is closer to a restyle than the proposal fears.

**OQ2 — how precise should the sender's delivery estimate be?** Show dates, hedged: "Estimated Aug 21–23" (or "Usually arrives…"), never bare "Arrives." Dates genuinely help a sender choose a speed — a day count forces mental math at the decision moment — but `estimated_days` carries no cutoff or guarantee semantics, and an unhedged promise on the confirm screen is support load with no support team (the proposal's own framing, which is right). Build `senderDelivery.ts` pure as planned; keep the arithmetic dumb (calendar-day window + the hedge word rather than an invented business-day/holiday calendar), document the cutoff assumption in one comment, and unit-test the no-`estimated_days` fallback (today's day count) explicitly.

**OQ3 — does the skip control change the default, or only its prominence?** §2.3 is the right resolution and it is precisely what brief point 9 demanded — prominence moves, the operative default (an empty, live, focusable form) stays, the label path (100% of revenue) loses no click. Endorsed. Two amendments: (1) the *within-toggle order* is a second, unacknowledged departure — the handoff renders "I have it" first everywhere; §2.2's diagram puts the skip segment first. Keep the handoff's order unless John explicitly wants the literal "on top" reading: with equal-weight segments, order is the only remaining prominence lever, and the answer-it-yourself path has earned first position while the flex path stands at 19 links / 0 shipments. One-token swap either way — put it to John in one line. (2) Move "neither pre-selected, softened" from the Appendix into the decision record so point 9's resolution is findable later.

**OQ4 — is the step-map collapse in scope?** **Yes — but fix the argument, because the impossibility claim is false and this file becomes the decided record.** A stable six-segment bar *can* be built over two maps: fixed segments + a per-path step→segment lookup, with the flex path deriving Origin/Package segment states from `completedSteps` ∩ {10, 14} and the defer flags — the exact derivation `RecipientOnboarding.tsx`'s `completedProgressIndexes` already performs. Labels never change; a skip turns amber in place; the fork advance is an ordinary advance. That is not the "fakes stability" strawman OQ4 offers — it is honest, *provided* step 14 splits so the Shipping segment has a step, and PR 2 splits it regardless. What actually justifies the collapse: (1) it is decided Phase 2 scope, verifiably undelivered; (2) the handoff's screens 4–6 — one Shipping step with two modes, one Contact, one Payment — *are* the collapse expressed as UI, so two maps means either duplicated steps sharing components across different numbers (today's verify pair, tripled) or two maps that converge on identical sequences, which is pure liability; (3) the cross-path mapping layer is the bug class Phase 1 already paid for (the `completedProgressIndexes` leak that lit Preferences/Save Card from steps 10+14), and the amber-segment-click undo would need cross-map path gymnastics that one map makes trivial. Same conclusion, honest premises — amend §2.1 accordingly. On the brief's "not a logic change": the escalation posture is right, and PR 1's guardrail should be stated as "behavior-preserving modulo slugs — every old URL resolves, the blocking suite green in every commit."

**Scope and sequencing (asked directly):** three PRs is right-sized and matches the phase-per-PR pattern that has been earning its cost (#68/#70/#71/#72 each caught real findings in review). PR 1 leaves the app shippable on its own *only after* B3's seam is answered; run the three sequentially with a rebase after each merge (pitfall 6), and mind NB10's deploy quota. Nothing here needs to wait on T1-1, but the end-to-end flex proof (different person ships, creator's card charged) remains the open launch blocker this redesign routes more people toward — PR 3's sender-flow work is the natural moment to finally run it.

---

## Author response

```
author:       Claude Opus 5 — same session that drafted the proposal
responded_at: 2026-08-19
posture:      all four blockers accepted; every factual correction independently re-verified
              against the c0c5177 worktree before acceptance
```

Four blockers, zero rejections. Two of them (B1, B2) correct claims this proposal asserted as verified fact, which is the more serious category — they are handled first and their corrections are traced to *why* the error happened, not just *that* it did.

### B1 — §1.6 overstates the risk. ✅ Accept, and the correction is substantial.

Re-verified: [`_shared/budget.ts:28-29`](../supabase/functions/_shared/budget.ts) sets `DEFAULT_DAILY_CENTS = 20000` and `DEFAULT_WEEKLY_CENTS = 50000`, and `checkAccountBudget` is called on the label-buy path at [`labels/index.ts:816`](../supabase/functions/labels/index.ts:816) against `link.user_id` — so it binds every link a creator owns, not just one. **"Cap × unlimited uses, forever" is wrong.** Real exposure is bounded at $200/day and $500/week per account, before Radar, the Pattern D per-(IP+link) rate limit, rotation, and `is_funded`.

**How the error happened, since that matters more than the correction:** §1.6 reasoned from the *link* row outward — no `expires_at`, no `max_shipments`, therefore unbounded — and never asked whether a bound existed at the account layer. PAYMENTS.md documents `checkAccountBudget` in §10.2. It was not read. The proposal cited PLAYBOOK, SPEC, TESTING, and LOG in its test plan and skipped the one doc that governs the exact question it was raising.

**What survives, narrowed to what is actually true:** there is no per-link *lifetime* bound, so a single leaked no-destination link can be drawn against repeatedly within the account's daily and weekly budget. The reviewer's added fact sharpens this — `max_shipments` enforcement at [`labels/index.ts:1500`](../supabase/functions/labels/index.ts:1500) and [`:1617`](../supabase/functions/labels/index.ts:1617) is gated on `link_type === "seller_link"`, so extending it to flexible links is a code change, not a column value. §1.6 is rewritten to say that and nothing more. It remains out of scope here.

### B2 — §1.5(b) and OQ1 rest on a false premise. ✅ Accept; OQ1 dissolves.

Re-verified: [`FlexPreferencesForm.tsx:22,34,46`](../src/components/forms/FlexPreferencesForm.tsx) define `exampleRange` per speed tier, and [`:259`](../src/components/forms/FlexPreferencesForm.tsx) renders the selected one at `text-4xl font-bold` — the largest element on the screen. The claim "shows no prices at all" is flatly wrong.

**How the error happened:** the proposal read [`RecipientStepFlexPreferences.tsx`](../src/components/recipient/RecipientStepFlexPreferences.tsx), saw a thin wrapper delegating to `FlexPreferencesForm`, and asserted the screen's behavior without opening the component that renders it. Unlike the stale-baseline errors this file already records, **this one is not staleness** — the file was current and simply unread. Reading a wrapper is not reading a screen.

**Consequence:** the handoff's ranges are not a new capability at all; they match a pattern already shipped. OQ1's "does a computed range create a quote we must honor" is moot, because nothing computed is proposed. The real work is smaller and different: two sets of hardcoded ranges would now exist (the shipped one and the handoff's), and they must reconcile to one source. Computed ranges become a later enhancement with its own justification, not a blocker here.

### B3 — PR 1 is underspecified and internally inconsistent. ✅ Accept.

Three distinct defects, all real:

1. **The six-step map depends on work sequenced into PR 2.** Steps 10 and 14 both render `RecipientStepFullShipping` today; a six-step sequence needs Origin, Package, and Shipping as separate components. PR 1 cannot land the map without at least the structural half of that split. **Resolution:** the split moves into PR 1, which becomes "one step map, one progress bar, and the `RecipientStepFullShipping` split that both require." PR 2 keeps the visual redesign. This makes PR 1 larger and honest rather than small and wrong.
2. **The new step array and slugs are never written down.** A file-by-file plan that says "one `STEPS` array of six" without naming the six numbers and slugs is not implementable from the document. To be stated explicitly before this is decided.
3. **The redirect table omits `verify`, and the census undercounts.** Measured directly against the worktree: **26 `/onboarding/` literals across 4 spec files** — `url-step-routing`, `auth-section-and-flex-otp`, `onboarding`, and `home` — not "six-plus call sites" across two. `verify` is the load-bearing omission: it appears in `redirectTo` builders, which means **magic-link emails already in users' inboxes point at it.** A redirect for `verify` is not test hygiene; dropping it breaks sign-in for anyone mid-flow when the deploy lands.

### B4 — amber for "skipped" collides with a live semantic. ✅ Accept, with a resolution that is better than a different hue.

Re-verified: [`SPEC.md:152`](../SPEC.md), [`:323`](../SPEC.md), [`:400`](../SPEC.md) all assign amber to the Express speed tier. The 2026-08-17 OQ4 decision rejected emerald for selling surfaces on exactly this reasoning — emerald already meant Economy. Amber for "skipped" repeats the mistake with the other end of the same scale, and the collision lands on this proposal's own screens: the Shipping step renders speed tiers, and PR 3's sender rates do too.

**Resolution — distinguish skipped by shape, not hue.** Done is a `primary` fill with a check; skipped is a `muted` fill with an arrow. No new accent family, no collision, and it satisfies the OQ4 decision more cleanly than amber ever did. The handoff's amber was doing two jobs — *this one is different* and *this is a link now*. Shape carries the first. The flow-destination label beneath the bar carries the second, which is where it belongs, because the flow's destination is a property of the whole flow rather than of one segment. Accessibility improves as a side effect: the four states stop depending on hue discrimination.

### §2.1's central argument — ✅ accept the correction; the conclusion stands, the reasoning does not.

The reviewer is right that a stable six-segment bar **can** be rendered over two step maps: fixed segments plus a per-path step→segment lookup, which [`stepRouting.ts`](../src/lib/stepRouting.ts)'s `STEP_TO_PROGRESS` and `progressIndexToStep` already do. §2.1's claim that the morph "cannot be built" inside the component is too strong, and OQ4's fallback framing ("a bar that fakes stability") was a strawman.

The honest justification, which replaces it:

- **It completes a decided Phase 2.** That proposal's scope line commits to one step map; PR #71 landed half.
- **The handoff's screens *are* the collapse, expressed as UI.** Two maps mean Origin and Package exist on one path and not the other; the design shows six steps that always exist. Rendering that over two maps means every step is duplicated in one map and absent from the other, and the bar's lookup table becomes the only thing holding the illusion together.
- **That lookup table is a paid-for bug class.** Phase 1 shipped precisely because origin and package shared a segment and completing the origin advanced the bar by nothing.

Conclusion unchanged; **the argument in §2.1 is rewritten before this becomes the decided record**, because a decided proposal is read later as the reasoning, not just the outcome.

### OQ1 — ✅ resolved by B2. Keep the shipped example-range pattern; reconcile the two range sets to one source. No computed ranges, no honored-quote risk.

### OQ2 — ✅ accept the reviewer's recommendation. Dates, hedged: *"Estimated Aug 21–23"*, never a bare "Arrives." Plain calendar arithmetic with a unit-tested fallback when `estimated_days` is absent.

### OQ3 — ✅ endorsement accepted; ❓ one sub-point is John's.

The reviewer endorses §2.3 (prominence moves, default stays) as what brief point 9 demanded. Accepted.

The catch is fair and was an unlisted departure: §2.3 puts *"The other person fills this in"* first **inside** the control, while the handoff puts *"I have it"* first on every screen. The proposal changed the handoff's within-control order without recording it in the Appendix. That is a one-token change with a real behavioral question behind it, so it goes to John rather than being settled here — see Tradeoffs.

### OQ4 — ✅ collapse confirmed in scope, with §2.1's argument rewritten per above.

---

## Tradeoffs for John

One item. Everything else converged.

**T1 — inside the skip control, which option reads first?**

Brief point 1 says the skip option must be "at the top of each question, not buried under a form," and §2.3's resolution — skip-first prominence, unchanged input default — is endorsed by the reviewer as the right reading. The open sub-question is narrower: within the two-option control itself, does *"The other person fills this in"* sit first, or does *"I have it"*?

| Option | What it gains | What it costs |
|---|---|---|
| **A — skip listed first** (proposal as written) | Reads most literally as "the skip is at the top." Strongest signal that handing off is a first-class answer, which is the product's actual insight. | Departs from the handoff, which puts "I have it" first on all three screens. The label path is all revenue to date, and its option is now second in reading order on every question. |
| **B — "I have it" first** (handoff as delivered) | Matches the design exactly. The revenue path leads. The control still sits above the form, so brief point 1 is satisfied by *position on the screen* rather than order within the control. | Slightly weaker version of "skipping is first-class" — it is prominent, but not first. |

**Author's recommendation: B.** Brief point 1 is about the control being above the form, and both options deliver that. The handoff chose "I have it" first on all three screens, and there is no evidence it was accidental. Option A trades a real click on the revenue path for a rhetorical point already made by position — which is the same trade brief point 9 warned against. This is a one-token change either way, and it is reversible after launch with real data.

---

## Decision — T1

```
decided_by: John
decided_at: 2026-08-19
```

**T1 — skip-control order: B. "I have it" reads first, matching the handoff as delivered.** Decided from a side-by-side mockup of both resting states.

Rationale, recorded because the body argues the other way and a later reader needs to know this was chosen rather than overlooked: seen side by side, option A makes the first thing a first-time user reads on the first screen an instruction about a person who is not them, before the screen has established what it is for. B reads in the order the user is already thinking — *do I have this? yes → type it · no → hand it off*. The "skipping is a first-class answer" signal that brief point 1 demands is carried by the control's **position** — a full-width segmented control above the form — not by winning a word race inside it. This also keeps the revenue path leading, which is what brief point 9 warned about protecting.

**Consequent amendments to the body (§2.3 and the Appendix), which otherwise still describe option A:**

1. **§2.3** — the control renders **"I have it" first, "Sender fills this in" second**, on all three question steps. Everything else in §2.3 stands unchanged: the control sits above the fields, neither option is pre-selected, and the address fields stay live and focusable on arrival so a creator who simply types has answered without touching the control.
2. **Appendix** — "Neither toggle option pre-selected — softened to skip-first prominence" is **withdrawn as a departure**. The handoff's within-control order is kept as designed, so the only surviving intent is prominence-by-position. The reviewer's OQ3 catch — that the proposal had inverted the handoff's order without listing it — is resolved by conforming to the handoff rather than by documenting the divergence.

**Still open on this proposal:** John has not yet given the overall go. Per his sequencing call (2026-08-19), the process fixes in [`2026-08-19_shipping-process-and-stale-branch-rca.md`](2026-08-19_shipping-process-and-stale-branch-rca.md) land **before** PR 1 of this proposal begins.
