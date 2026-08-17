---
title: Onboarding — replace the path picker with "Who's sending the package?"
slug: onboarding-who-is-sending
project: sendmo
status: decided
blocked_on: null
created: 2026-08-17
last_updated: 2026-08-17 (decided + implemented)
reviewed: 2026-08-17
decided: 2026-08-17
executed: null
pr: null
author: Claude Opus 5 — drafted from a John session that started as "this UI looks sloppy" on /onboarding and escalated to "simplify this whole step, in the context of the buyer option being released." Findings measured in a live browser against the running dev server; grounded in stepRouting.ts, migrations 001/040, and two decided proposals (seller-link-buyer-pays, label-confirmation-email-by-role). Mockups in previews/onboarding-simplification-concepts.html.
reviewer: Claude Fable 5 — fresh-eyes session, loaded cold 2026-08-17; verified every cited file/line against the working tree (stepRouting.ts, RecipientFlowContext.tsx, App.tsx, Index.tsx, Dashboard.tsx, RecipientStepPathChoice.tsx, RecipientStepAddress.tsx, MagicGuestimator.tsx, labels/index.ts, migrations 001/040) and read both cited decided proposals in full
outcome: approve-with-changes
---

> **What this is in one line:** delete the `/onboarding` path picker and replace it with one question — **"Who's sending the package?"** — which fits all four things users actually want (including the plain "I need a label" case the product already serves but never names), splits the homepage into two doors on who-pays, and turns the link-vs-label choice from a screen into a field.

---

## 1. Context

### 1.1 How this started

John opened with a screenshot of `/onboarding` and one line: *"this ui looks sloppy — propose cleanups that improve comprehension and general usability."* Measuring it in a live browser turned up two mechanical defects and a much larger structural one. Two rounds of mockups later, John's direction was: *"I think we should really find a way to simplify this whole step. Do it in context of the buyer option being released."* Then, on naming: *"'flexible' is a bad naming."* Then, after seeing that the generic "I'm shipping something to someone" case had no door: *"rebuild the flow mock around 'who's sending it' — two doors."*

This proposal is that design, written up for review before any code lands.

### 1.2 The mechanical defects (measured, not eyeballed)

At a 1280×800 viewport on the running dev server:

| Defect | Measurement |
|---|---|
| Empty third grid column | `grid-template-columns: 320px 320px 320px` with only 2 cards rendered (`VITE_ENABLE_SELLER_LINK` off). Grid spans x=144→1136; cards end at x=800. 320px of dead space, and the centered heading sits **168px** right of the card block's center. |
| Cards misaligned | Both cards 590px tall via grid stretch, but card 2's header top is y=197 vs card 1's y=178, and its CTA is y=703 vs y=722. A `<button>` vertically centers its content when taller than its contents, so the shorter card's whole body floats to the middle. **Every row is off by 19px.** |
| Density | 82 and 84 words per card — **166 words** to make one binary choice, across six panels that restate each other ("Best when you don't know the sender's address" ≈ step 1 ≈ "What the sender does"). |
| Mobile | Card 1 is 552px tall; card 2 starts at y=745 in an 812px viewport. **67px** of the second option is visible on first paint — the page doesn't read as a choice. |
| Focus ring | Keyboard focus gives the browser default (`outline: auto 1.5px`, gray). The Sign In button beside it uses the app's 2px blue `ring` token. Inconsistent, not broken. |
| Off-palette colors | The cards hardcode `violet-*` and `blue-*`, and the gated seller card `emerald-*`. PLAYBOOK "Design System (Strict)" defines no violet or emerald token. |

**None of these are worth fixing** if the screen is deleted, which is what this proposal argues for. They're recorded because they're the evidence that the screen is carrying more weight than it can.

### 1.3 The structural problem

The picker asks two unrelated questions on one screen:

- **Q1 — what are you here to do?** Receiving vs selling. Different products, different route (`/sell` → `SellerBuilder`), different money direction, different payer.
- **Q2 — do you know the origin address and package size?** `flexible` vs `full_label`. This is not a preference; it's a fact about what the user can type. Nobody wants a "Flexible Prepaid Shipping Link" — they don't have their cousin's address.

Q2 shouldn't be a screen. Q1 shouldn't be a card comparison — it's a segmentation question, and the homepage is where intent already lives.

### 1.4 Three findings in the code that make this smaller than it looks

**(a) "I'm shipping something to someone" already works — it's just unnamed.** The full-label flow is role-agnostic: step 1 asks *"Where should the package be delivered?"* ([`RecipientStepAddress.tsx:142`](../src/components/recipient/RecipientStepAddress.tsx)) and never claims the address is yours; step 10 collects the origin. Put your address in the origin and theirs in the destination and you have a plain outbound label — same `link_type`, same rate lookup, same purchase, same PDF.

This isn't inference. The decided proposal [`2026-06-27_label-confirmation-email-by-role`](2026-06-27_label-confirmation-email-by-role_reviewed-2026-06-27_decided-2026-06-27.md) models exactly this case:

> *"Full Prepaid Label (John's case) | the signed-in user (sender = payer) | the destination person"*

> *"On 2026-06-27 John created a Full Prepaid Label himself (he picked the destination, the package, and paid — no shared link involved)."*

The email layer has already been taught this case, down to an open question (OQ4) about deduping when you ship to yourself. **Only the picker's copy denies it exists** — "You enter the sender's address," "Send them the label — all they do is print," "Prints the label you made. That's it — zero decisions for them." A user who wants to mail a package to their sister reads that and concludes the product isn't for them.

**(b) The only remaining fork is the address.** The picker sells two unknowns — their address *and* the item's weight or size — but [`MagicGuestimator.tsx`](../src/components/recipient/MagicGuestimator.tsx) already turns a plain-English description ("a hardcover cookbook, no rush") into dimensions and weight via `fetchGuestimate`, and it's wired into the shipping step. Size isn't a fork; it's solved.

**(c) Both flows already share step 1.** `destination` is step 1 for `full-label` and `flexible` alike ([`stepRouting.ts:49-79`](../src/lib/stepRouting.ts)); they diverge only at step 10 vs 20. The fork moves from a screen of its own into the step where the user discovers whether they can answer it.

### 1.5 The four intents, mapped

| What the user wants | Who's sending | Who pays | Product | Exists today? |
|---|---|---|---|---|
| Mail something to someone | Me | Me | Prepaid label `full_label` | **Ships today, has no door** |
| Get something sent to me, and I have their address | Someone else | Me | Prepaid label `full_label` | Yes |
| Get something sent to me, no address | Someone else | Me | Shipping link `flexible` | Yes |
| Sell an item | Me | Buyer | Seller link `seller_link` | Built, launch-gated |

**Rows 1 and 2 are the same `link_type`** — the only difference is which address is yours. That's why *"who's sending it?"* is a better first question than *"which product do you want?"*: it's the one input that changes what happens next, and it needs no product knowledge to answer.

### 1.6 The launch argument

`/sell` has no entry point today except the gated third card of the picker. Both homepage CTAs ([`Index.tsx:42`](../src/pages/Index.tsx), [`:178`](../src/pages/Index.tsx)) and the dashboard button ([`Dashboard.tsx:472`](../src/pages/Dashboard.tsx)) go to `/onboarding`, and the homepage hero describes only the link flow. Shipping the buyer-pays path with its only door being card 3 of a screen users reach *after* committing wastes the launch regardless of how the picker looks.

---

## 2. Architecture

### 2.1 The flow

```
homepage (/)
  ├── "Send or receive a package"  ─────────────► /onboarding
  │      You pay for shipping
  └── "Sell an item"               ─────────────► /sell   (unchanged flow)
         The buyer pays for shipping

/onboarding
  └── STEP 1  "Who's sending the package?"        ← replaces the picker
        │
        ├── "I am"           ► destination (theirs) + "Shipping from" confirm row
        │                    ► package  ► verify ► payment ► label
        │                    = Prepaid label (full_label)
        │
        └── "Someone else"   ► origin (theirs) + "Shipping to" confirm row
                             │     └── escape: "I don't have their address"
                             │
                             ├── filled  ► package ► verify ► payment ► label
                             │            = Prepaid label (full_label)
                             └── escaped ► preferences + cap ► verify
                                          ► authorize ► share
                                          = Shipping link (flexible)
```

Two worked examples:

- **John mails a cookbook to Jane.** Step 1 → "I am." Step 2 asks where it's going (Jane's address), with *"Shipping from: John A · 88 Oak Ave"* as a confirmable row rather than a form. Step 3 describes the item; the Guestimator fills dimensions. Rates, pay, label. `link_type = full_label`, John is the `sender` role and the payer — exactly the shape the 2026-06-27 proposal already handles.
- **Sarah is mailing John a jacket; he doesn't have her address.** Step 1 → "Someone else." Step 2 asks for Sarah's address; John taps *"I don't have their address."* The screen converts in place to speed + spending cap, with an undo. `link_type = flexible`, share screen at the end.

### 2.2 Where the fork lives now

Today `pathSlug` is fixed **before** step 1, because the picker chooses it. Under this design the shared steps run before the path is known. That's the one genuinely load-bearing change and it has two candidate shapes — see **OQ2**, which the author does not want to decide alone.

### 2.3 Naming

`flexible`/`full_label` stay as **internal** identifiers. `link_type` is a real column with `CHECK (link_type IN ('full_label','flexible'))` ([`001_initial_schema.sql:53`](../supabase/migrations/001_initial_schema.sql)), referenced across ~8 migrations and several RPCs. Renaming identifiers means a migration plus RPC rewrites for zero user benefit — **strings only**:

| Internal | Today | Proposed |
|---|---|---|
| `flexible` | Flexible Prepaid Shipping Link | **Shipping link** |
| `full_label` | Completed Prepaid Label | **Prepaid label** |
| `seller_link` | Sell & Ship | **Seller link** (product name "Sell & Ship" may stay for marketing) |

The real distinction is **link vs label** — one is a promise filled in later, the other a finished artifact. "Prepaid" does no work on the link (both are prepaid by the account holder) but earns its place on the label, where it tells the sender they owe nothing. "Flexible" and "Completed" are adjectives about SendMo's internals.

Under this flow the names stop being a choice anyone must understand up front and become a label on something already made — dashboard rows, emails, tracking page.

### 2.4 Copy

**Step 1.** Title *"Who's sending the package?"*, subtitle *"Either way, you're the one paying for shipping."*

- **"I am"** — "You're mailing something out. You'll get a label to print and drop off — charged when you buy it."
- **"Someone else"** — "They're sending something to you. They get the label — or a link to fill in, if you don't have their address."

**Who-pays is stated once, in the subtitle, not on both cards.** Both branches are you-pay, so a "You pay" badge on each differentiates nothing — that is precisely the failure the current picker has with two identical *YOU PAY* badges. The helper text carries what actually differs: who ends up holding the label, and **when** the charge lands (on purchase for a label; only when the label is bought, capped, for a link). Measured: **57 words** for the whole screen, against the current picker's **166**.

---

## 3. File-by-file plan

| File | Change |
|---|---|
| `src/components/recipient/RecipientStepPathChoice.tsx` | **Delete.** 237 lines. Its `OnboardingChoice` consumer moves to the new step. |
| `src/components/recipient/RecipientStepWhoSending.tsx` | **New.** Two options, `onSelect(sender: "self" \| "other")`. A `<div>` card with a real `<button>`, `focus-visible:ring-2 ring-ring ring-offset-2`, palette from tokens (see OQ4). |
| `src/App.tsx` | `OnboardingPathPicker` (lines 38–52) becomes the who-sending step; `/onboarding` no longer renders a product chooser. `navigate("/sell")` moves to the homepage door. |
| `src/lib/stepRouting.ts` | The change that OQ2 decides. Either a neutral `pathSlug` that rewrites on the fork, or path moves into flow state and out of the URL. `canAccessStep` guards and `slugToStep` maps follow. |
| `src/pages/Index.tsx` | Hero gets two doors (lines 39–54). Second door → `/sell`. Hero subcopy currently describes only the link flow; broadened. |
| `src/components/recipient/RecipientStepAddress.tsx` | Copy varies by branch ("Where's it going?" vs today's neutral heading). Add the "Shipping from/to" confirm row. |
| `src/components/recipient/RecipientStepFullShipping.tsx` | Origin block becomes a confirm row when `sender === "self"`; full form behind "Change". Sender name/email fields hide when the sender is the account holder. |
| `src/contexts/RecipientFlowContext.tsx` | Holds `sender: "self" \| "other"` and the resolved path. Origin fields must **persist across the escape toggle** so "Actually, I do have their address" restores typed input. |
| `src/pages/Dashboard.tsx`, emails, tracking page | User-facing strings → "Shipping link" / "Prepaid label". |
| `SPEC.md` | §1 Product Vision, Value Proposition, Target Users. See OQ3 — this is a positioning change, not a copy edit. |

---

## 4. Test plan

Per PLAYBOOK rules 10 and 12, and `TESTING.md`'s four layers:

- **Unit** — `stepRouting`: slug↔step mapping under the new fork, `canAccessStep` for a path not yet resolved, and the escape's path switch. `tests/unit/App.test.tsx` currently asserts the picker renders; update it.
- **Integration** — a `full_label` created with `sender === "self"` produces the same `link_type` and contact roles the 2026-06-27 proposal expects (`sender` = payer, `recipient` = destination).
- **E2E (Playwright)** — three specs: (1) "I am" → label, (2) "Someone else" + address → label, (3) "Someone else" → escape → link, including the undo restoring the typed address. Existing specs that enter via the picker need their entry rewritten — expect several red until updated (PLAYBOOK rule: never leave a spec red).
- **Browser-verify** — Rule 19 block required in the LOG entry, since this touches `src/components/**` and `src/pages/**`.
- **`npx tsc -b --noEmit`** before any push (rule 18).

---

## 5. Out of scope

- **Collapsing `full_label` into `flexible`.** A shipping link with everything prefilled *is* a prepaid label; if flex accepted a prefilled origin the two products merge into one `link_type`. Probably the right eventual shape. Nothing here requires deciding it, and it would be a schema-touching proposal of its own.
- **The seller flow itself.** `/sell` and `SellerBuilder` are unchanged. This proposal only gives them a front door.
- **Launch-gating the seller path.** `VITE_ENABLE_SELLER_LINK` semantics stay as-is; the second homepage door respects the same flag.
- **The Tier 1 / Tier 2 polish** mocked in `previews/onboarding-path-choice-tier2.html`. That file is historical — it documents the measured defects of a screen this proposal deletes.
- **Rate or pricing changes.** None.

---

## 6. Verification

After implementation, walk these end to end on the dev server:

1. `/` → both doors visible; "Sell an item" reaches `/sell`; "Send or receive" reaches `/onboarding`.
2. `/onboarding` → who-sending step; no product jargon; keyboard-tab shows the app's blue focus ring, not the gray default.
3. **"I am"** → destination form → "Shipping from" row shows a saved address for a signed-in user and degrades to a full form for a first-timer → package → Guestimator fills dims → rates → pay → label PDF. Confirm `link_type = full_label` and two confirmation emails per the 2026-06-27 spec (payer copy + destination copy).
4. **"Someone else" + address** → same tail; `link_type = full_label`.
5. **"Someone else" → escape** → cap + speed → verify → authorize → share; `link_type = flexible`. Then hit undo mid-flow and confirm the typed origin address comes back.
6. Deep-link an old `/onboarding/flexible/preferences` URL and confirm it still resolves or redirects cleanly (OQ2 decides which).
7. Mobile 375×812: both step-1 options fully above the fold.

---

## 7. Open questions

**OQ1 — door wording: job-led or artifact-led?** John proposed *"Create a checkout shipping link — they pay for shipping."* The author's counter is *"Sell an item — the buyer pays for shipping,"* because both doors then name a **situation** rather than making the reader translate "I sold a couch" into a product noun, and two doors at the same altitude scan faster. **But John's version may be more truthful:** a seller link with `max_shipments = NULL` is reusable and `funder` is a documented future seam for "seller covers shipping" (migration 040) — so a shop, a club collecting postage, or a repair service can all use it, and "Sell an item" is *narrower than the product*. This is a positioning call, not a copy call. Reviewer: which door serves launch better, and does the non-selling range matter yet? (Also minor: John's "I'll pay for shipping" is the user's voice inside a label the product speaks, while the title beside it addresses the user — the author used "you" throughout for one voice per label.)

**OQ2 — where does the path live once the fork is mid-flow?** Today `/onboarding/:pathSlug/:stepSlug` fixes the path before step 1. Two shapes: **(a)** a neutral slug for shared steps that rewrites on the fork — keeps URLs self-describing and Sentry's parameterized routes intact, but means a mid-session URL rewrite and a third slug value; **(b)** path moves out of the URL into `RecipientFlowContext` — simpler routing, but breaks the "self-describing URL" property `stepRouting.ts:3-20` documents as deliberate, and changes how `canAccessStep` recovers a refreshed session. The author leans (a) and does not want to decide alone. Reviewer: does either break resume-after-refresh or the Sentry route naming from the T1-3 monitoring work?

**OQ3 — does naming the generic case change SendMo's positioning, and is that wanted?** [`SPEC.md:12-34`](../SPEC.md) is recipient-only: *"Recipients create a link once, share it with anyone who needs to send them something."* Surfacing the plain-label case changes the one-liner, the value props, and the target users. The trade: plain outbound labels are a crowded free market (Pirate Ship, Click-N-Ship) where SendMo would compete on rates rather than on the coordination problem that makes it distinctive. Build cost is near zero — it already ships. **So the question is purely whether John wants that traffic, and right now it's being answered by omission.** Reviewer: take the broad view here; this is the point in the proposal most likely to be wrong.

**OQ4 — palette.** The cards hardcode `violet-*`/`blue-*` and the seller card `emerald-*`, none of which exist in PLAYBOOK's "Design System (Strict)" token list. Does the new step add proper tokens for a second and third accent, or collapse to `primary` + `muted`? Dark mode isn't shipped (only `alert.tsx` has a `dark:` variant), so this is consistency work today, not a live bug — but it's the moment to settle it rather than propagate three off-palette families into a new component.

---

## Reconciliation with prior decided proposals

**[`2026-07-17_seller-link-buyer-pays`](2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md) — decided, approve-with-changes.** That proposal decided the seller link ships as **one entry point** on `/onboarding`, but explicitly *not* as a visually-identical peer under the "prepaid shipment" heading — it required an intent-neutral heading plus who-pays-explicit card copy (its OQ1). That shipped: the current heading is "How do you want to ship?" and the cards carry You pay / Buyer pays badges.

**This proposal diverges from that decision and should be read as doing so knowingly.** It moves the seller link's entry point off `/onboarding` and onto the homepage. The reasoning: that decision was made when the picker was the only surface under discussion, and it solved the right problem *within* that frame (don't let a buyer-pays card masquerade as a peer of two you-pay cards). Splitting on who-pays at the homepage honors the same intent — keep the payer distinction load-bearing — one level higher up, and fixes something the earlier decision didn't consider: `/sell` currently has no other door, so its discoverability depends entirely on a card users only see after clicking "Get started." If the reviewer thinks the earlier decision should hold, OQ1 is where to say so.

What this proposal preserves from it: the who-pays distinction stays explicit and visible; the seller link keeps one entry point, not several; `funder` and `max_shipments` semantics are untouched.

**[`2026-06-27_label-confirmation-email-by-role`](2026-06-27_label-confirmation-email-by-role_reviewed-2026-06-27_decided-2026-06-27.md) — decided.** This proposal *depends* on it rather than diverging. That proposal established that in `full_label` the payer is the `sender` role and the destination person is the `recipient` role, and fixed confirmation-email copy for the self-created case. The "I am" branch here is that case given a front door — so its role→audience mapping is the contract the new branch must not break. Its OQ4 (dedupe when payer email == destination email) becomes reachable by more users once the generic case is discoverable, so it's worth confirming that landed as decided.

**No schema change.** `link_type` values, `funder`, `max_shipments`, and the `sendmo_links` constraints are all untouched. No migration.

---

## Supporting mockups

- [`previews/onboarding-simplification-concepts.html`](../previews/onboarding-simplification-concepts.html) — current: two doors, step 1 with helper text, both branches, step map, naming table, both door-wording candidates (OQ1).
- [`previews/onboarding-path-choice-tier2.html`](../previews/onboarding-path-choice-tier2.html) — historical: the measured defects of the current picker and two copy variants for polishing it. Superseded by this proposal; candidate for `previews/archive/`.

---

## Review

```
reviewer:    Claude Fable 5 — fresh-eyes session, loaded cold; verified every cited file/line against the working tree and read both cited decided proposals (seller-link-buyer-pays, label-confirmation-email-by-role) in full, plus PLAYBOOK, SPEC §1/§6/§7, and the last ~15 LOG entries
reviewed_at: 2026-08-17
verdict:     approve-with-changes
```

### Summary

The core insight is right and verified: the full-label flow genuinely is role-agnostic ([`RecipientStepAddress.tsx:142`](../src/components/recipient/RecipientStepAddress.tsx) never claims the destination is yours), the 2026-06-27 decided proposal really does model the self-created outbound case down to the dedupe (confirmed landed — [`labels/index.ts:2075-2078`](../supabase/functions/labels/index.ts) implements the OQ4 self-send dedupe as decided), and "who's sending?" is a better first question than "which product?". The strings-only rename and the no-schema-change claim both check out. But the proposal has one structural blind spot that undercuts its own launch argument — **signed-in users can never reach the new seller door** — and one stale-prefill trap in the flow context that its file plan doesn't cover. Both are fixable without changing the architecture, hence approve-with-changes rather than needs-info. On the divergence question: the divergence from `seller-link-buyer-pays` OQ1 is justified in principle (the homepage split is a real improvement over card 3), but as specified it trades the decided proposal's everyone-passes-through-here property for a door that half the audience is structurally barred from — see B1.

### Blocking issues

**B1 — Signed-in users have no path to `/sell`; the design deletes the seller link's only authed-surface door and replaces it with one they cannot reach.**
- *Location:* §1.6, §2.1, §3 (the `Index.tsx` / `App.tsx` rows), and the Reconciliation section's divergence argument.
- *Issue:* [`Index.tsx:13-16`](../src/pages/Index.tsx) (T3-3, verified) redirects every signed-in user straight to `/dashboard` — they never see the homepage, and clicking the logo just bounces them back. Dashboard's only creation CTA is "Create a new shipment" → `/onboarding` ([`Dashboard.tsx:472`](../src/pages/Dashboard.tsx)), and neither `Dashboard.tsx` nor `AppHeader.tsx` contains a single `/sell` reference (grepped). Today, with the flag on, a signed-in seller at least sees the third card at `/onboarding`. Under this proposal the seller door exists *only* on a page signed-in users are redirected away from. The population this hurts is exactly the sticky repeat-seller audience the seller-link proposal was built for ("sellers ship constantly" — its §1.1): after their first sale they are signed in forever, and their only route to `/sell` is typing the URL. Worse, a seller who clicks Dashboard's "Create a new shipment" reaches *"Who's sending the package?"* and truthfully answers **"I am"** — landing in the you-pay prepaid-label flow with no signal the buyer-pays product exists. That's an active mis-route, not just a missing link; the subtitle "Either way, you're the one paying" reads as information, not as a fork they should back out of. This also weakens the divergence argument: §1.6 argues card-3-only "wastes the launch," but homepage-only has the mirror-image failure for the signed-in half of the funnel. The decided proposal's `/onboarding` placement, whatever its card-comparison flaws, was a surface *everyone* passes through.
- *Suggested fix:* Keep the homepage split (it's right), and add the authed-surface doors to the file plan explicitly: (1) Dashboard gets a second CTA next to "Create a new shipment" — e.g. "Sell an item" → `/sell`, gated on `VITE_ENABLE_SELLER_LINK`; (2) the who-sending step carries a compact, non-card escape hatch — a single line under the two options, e.g. *"Selling something? Create a link the buyer pays for →"* — same flag. That preserves "one entry point per surface, two options + a link-out" without resurrecting the three-peer-cards problem the decided proposal correctly killed. Note the flag's only consumer today is the component this proposal deletes ([`RecipientStepPathChoice.tsx:13`](../src/components/recipient/RecipientStepPathChoice.tsx)), so the gate must be deliberately re-homed, not assumed.

**B2 — The auth-prefill in `RecipientFlowContext` fills `destinationAddress` with the account holder's own saved address; under the "I am" branch that pre-fills *your own address* as where the package is going. The file plan touches this file but not this effect.**
- *Location:* §2.1 (the "I am" branch), §3 (`RecipientFlowContext.tsx` row).
- *Issue:* The prefill effect at [`RecipientFlowContext.tsx:206-252`](../src/contexts/RecipientFlowContext.tsx) fetches the authed user's most recent saved address and writes it into `destinationAddress` (plus `email`). Today that's correct — the account holder *is* the destination in both existing paths. Under "I am," the destination is the *other* person, so a signed-in John picking "I am" arrives at "Where's it going?" with **his own address pre-filled as the destination**. If he doesn't notice (and prefilled-verified fields read as "done"), he buys a label shipping to himself. Same data, opposite role — the exact stale-autofill-attaches-the-wrong-party class as the 2026-08-16 Link-name incident (LOG). The proposal's §3 row for this file mentions `sender` state and escape-persistence but not the prefill, so an implementer following the plan as written ships this.
- *Suggested fix:* Make the prefill branch-aware and say so in the plan: prefill `destinationAddress` only when `sender === "other"`; when `sender === "self"`, the saved address feeds the "Shipping from" confirm row instead (which is where the proposal wants it anyway). The prefill must also not run before the who-sending answer exists.

### Non-blocking concerns — including answers to the open questions, as §7 requests

**N1 — OQ2 (routing): neither (a) nor (b) — there's a third shape that avoids both costs, and I recommend it.**
Direct answers first: **(a)** does not break resume-after-refresh (state is per-tab `sessionStorage`, [`RecipientFlowContext.tsx:133`](../src/contexts/RecipientFlowContext.tsx), restored synchronously in the `useState` initializer; the guard runs on `completedSteps`, which survive) and keeps Sentry's parameterized `/onboarding/:pathSlug/:stepSlug` shape ([`App.tsx:31-34`](../src/App.tsx)) — but it introduces a mid-session URL rewrite, and every navigation that races `setData` is the documented 2026-05-19 bounce class ([`stepRouting.ts:164-176`](../src/lib/stepRouting.ts) footgun comment). **(b)** survives refresh (same sessionStorage) but breaks the T1-3 route-name continuity, inverts the "URL is the source of truth for path + step" architecture the context is built on ([`RecipientFlowContext.tsx:163-165`](../src/contexts/RecipientFlowContext.tsx), plus the URL→`data.path` sync effect at 192-200), degrades new-tab deep links, and invalidates every existing deep-link entry — note `auth-section-and-flex-otp.spec.ts` and `url-step-routing.spec.ts` enter via literal `/onboarding/full-label/destination` URLs six-plus times, so (b)'s test blast radius is much larger than §4 estimates.
**Recommended (c):** keep both existing slugs and add none. "I am" resolves `full-label` at the fork immediately (it's determined). "Someone else" *defaults optimistically* to `full-label` — statistically right, and cosmetically "wrong" in the URL only until commitment, which no user reads. The escape is the single point where the path actually changes, and it is a user-initiated action that already changes the step content — so let it *navigate* to `/onboarding/flexible/preferences` through the existing `flushSync`'d transition (and undo navigates back), rather than converting in place under a `full-label` URL. Result: no third slug, no route-pattern change, no rewrite outside an existing navigation event, all old deep links still resolve, `slugToStep`/`canAccessStep` barely change (flex's list `[0,1,20…]` already accepts a user whose `completedSteps` were earned under full-label, since steps 0/1 are shared). The one thing (c) costs is the §2.1 "converts in place" micro-interaction — and I'd argue a real step transition is *better* there, because the progress bar and step map legitimately change at that moment.

**N2 — OQ3 (positioning): split the question in two, and the two halves have different answers.** (a) *Naming the case inside the flow* — yes, unambiguously. The users it serves are already on the page, the build cost is ~zero, and today's copy actively repels them (§1.4a is verified). (b) *Marketing outbound labels on the homepage* — this is the risky half, and the proposal's own §2.1 door copy ("**Send** or receive a package") does it. The broad-view facts: SendMo's price is `EasyPost rate × 1.15 + $1` (PLAYBOOK, Key Business Logic); Pirate Ship charges $0 markup on commercial-discount rates. For the plain outbound-label job SendMo loses on price on every comparison, and that job has none of the coordination moat (address-privacy, other-party-fills-in, who-pays inversion) that justifies the margin on the link products. Headline-marketing a commodity you lose on invites exactly the price-sensitive comparison shopper most likely to churn and least likely to need a link later. My recommendation: ship the flow change (a), keep SPEC §1's one-liner coordination-led, and let the first door's copy lead with the receive/coordinate job — the outbound case is *discoverable in-product* ("Who's sending?" → "I am") without being a homepage value prop. Revisit if John ever wants a rates story for that segment. This is genuinely John's call — the proposal is right that it's currently decided by omission — but the honest framing for him is "do you want traffic in a segment where we're the expensive option," not just "do you want that traffic."

**N3 — OQ1 (door wording): side with the author's job-led "Sell an item" for launch; the range argument is a rename trigger, not a launch argument.** The product's entire launch wedge is the off-platform social seller (decided proposal §1.2); at launch, precision about `max_shipments = NULL` shops and the dormant `funder` seam (both verified in migration 040) serves nobody who doesn't already understand the product. "Create a checkout shipping link" also fails the proposal's own house-style test — "checkout shipping link" is a product noun the reader must translate, the exact failure §1.3 diagnoses in the current picker. When a real non-sale use appears (club postage, repair service), that's the moment to generalize the label — and the seam means doing so costs a string. Agree on the voice nit: one voice per label, "the buyer pays" not "I'll pay."

**N4 — OQ4 (palette): collapse to `primary` + tokens; do not mint accent tokens for this step.** Two additional facts beyond the proposal's framing: SPEC §6 *does* bless emerald/blue/amber — but as **speed-tier semantics** (Economy/Standard/Express), so reusing emerald for seller/selling surfaces overloads a color that already means "Economy" elsewhere in the same product; and violet has no basis anywhere. A binary who's-sending choice doesn't need per-option color identity at all — the three-color card rainbow is part of the noise §1.2 measured. Selection-card pattern from the PLAYBOOK design system (`border-primary bg-primary/5` selected, `border-border` unselected) is the Rule-6 answer. The seller card's emerald is moot here if B1's link-out replaces it, but wherever seller UI keeps an accent, that's a separate (small) decision — don't propagate it through this step.

**N5 — The "Someone else" card copy promises label delivery the email system deliberately doesn't do.** §2.4's helper text: "They get the label — or a link to fill in…". Per the decided 2026-06-27 table, the non-payer party gets **no creation email**, and in the full-label flow the physical sender's email is never collected at all — the label reaches "them" only when the account holder manually shares the `/s/` link or the PDF (step 13's share card). "They get the label" as passive voice claims the product delivers it. Today's picker has the honest version ("**Send them** the label"). Keep the actor: "you'll get a label to send them," or spec an actual share step. Small copy fix, but it's on the screen whose whole justification is honesty-per-word.

**N6 — The per-branch step contents are under-specified where §2.1's diagram and §3's file plan disagree, and the anon "Someone else" case is the heavy one.** The diagram shows "Someone else → origin (theirs) + 'Shipping to' confirm row" as the immediate next node; the file plan keeps origin inside `RecipientStepFullShipping` (step 10) and step 1 as address+email. Under the file-plan reading (which I believe is intended): for a signed-out first-timer on the "Someone else" branch, step 1 collects *their own* destination + email (unchanged), and step 10 collects the other person's origin — fine. But the proposal should state the per-branch × per-auth-state matrix explicitly, because two load-bearing timings hang on step 1's shape: the silent OTP prime fires at step-1 email blur (SPEC §7, account-creation-timing decision — "so the code is in the inbox by verify time"), and the phone requirement (2026-05-19) applies to whichever address is collected where. Also worth one line: under "I am," the user must supply the *destination person's* phone (carrier requirement) — the copy should warn them before they're stuck mid-form without their sister's number. Redraw §2.1 with step numbers per the house style so the implementer doesn't re-derive step routing from an ambiguous picture.

### Nits

- §2.3 cites the `link_type` CHECK at `001_initial_schema.sql:53`; it's at line 55 in the current file. Cosmetic.
- When headings change ("How do you want to ship?" → "Who's sending the package?"), remember the e2e locator rule (PLAYBOOK: stable ids/roles, never incidental copy — the `/Ship from/i` rot precedent). [`tests/unit/App.test.tsx:45`](../tests/unit/App.test.tsx) asserts the current heading text; §4 already flags it, just don't replace one copy-matcher with another.
- The tier2 preview's move to `previews/archive/` should happen in the implementing PR per the UI Preview Protocol rule 5, not linger as a "candidate."
- §1.4b says the Guestimator turns descriptions into dims "via `fetchGuestimate`" — verified true ([`api.ts:198`](../src/lib/api.ts) → the `guestimate` edge function), and worth noting SPEC §7's "parses keywords, client-side, 15 item types" description is stale; the SPEC.md update in §3 should fix that line while it's in there.

### Predicted pitfalls

1. **Signed-in "I am" user ships a package to themselves (B2).** The prefill at `RecipientFlowContext.tsx:206-252` writes the user's saved address into `destinationAddress`; under "I am" that's the wrong party's slot, pre-verified and green. Same class as the 2026-08-16 incident (LOG: Link autofill attached a stale third-party name to a card save — "autofilled stale data attached to the wrong party"): data that was correct in its original role silently lands in the inverted role. Deterministic for every authed "I am" user who doesn't overwrite the field.

2. **Guard-bounce at the escape.** The escape is the one navigation event this design adds that changes `path` and URL together mid-flow — precisely the navigate-vs-setData race documented in `stepRouting.ts:164-176` and LOG 2026-05-19 (30 minutes lost to "user stuck on /onboarding/flexible/authorize"). Any implementation that updates `data.path` outside the `flushSync`'d transition (or converts in place and navigates later) will intermittently bounce users to `firstIncompleteUrl` at the exact moment they've admitted they don't have the address — the flow's most fragile trust point.

3. **Launch-day seller dead-end (B1).** The flag flips, the homepage door appears, the first cohort of sellers signs up — and from then on every one of them is redirected past the only door that exists. Reads to the seller as "SendMo removed the feature." This is the decided proposal's own acquisition logic ("a seller has to *see* the option to adopt it," its §2.2) failing one release later, and per the protocol it would be drift from a decided spec discovered in production rather than in review.

4. **A red-spec window that outlives the PR.** §4 honestly predicts "several red until updated," but the entry rewrite touches more than the picker specs: `auth-section-and-flex-otp.spec.ts` and `url-step-routing.spec.ts` deep-link `/onboarding/full-label/destination`-style URLs directly (six+ call sites), and under OQ2 option (b) those URLs cease to exist. PLAYBOOK: "a red e2e spec is worse than none." Choosing OQ2 (c) shrinks this from a suite rewrite to a handful of assertions — a concrete reason routing shape and test plan must be decided together.

5. **Positioning drift between surfaces.** If the flow ships naming the outbound case while SPEC §1 stays recipient-only (or the homepage headline markets "Send" while John decides OQ3 the other way), the docs and product diverge on what SendMo *is* — and the next proposal's author inherits a SPEC that misdescribes the front door. The protocol treats drift-from-decided as its own failure category; OQ3's decision must land in SPEC §1 in the same PR, whichever way it goes.

### What the proposal got right

- **§1.4(a) is the best finding in the proposal and it's fully verified.** The full-label flow is role-agnostic; the 2026-06-27 decided proposal models the self-created case exactly as claimed; only the picker's copy denies the case exists. And to close that proposal's loose end the author flagged: the OQ4 self-send dedupe **did land as decided** ([`labels/index.ts:2075-2078`](../supabase/functions/labels/index.ts) — payer==recipient stores a single sender-role contact), so the "I am" branch inherits correct email behavior.
- **Reconciliation discipline.** The divergence from `seller-link-buyer-pays` OQ1 is named, framed as knowing, and argued on the prior decision's own terms ("same intent, one level up") — exactly what the protocol asks for. Both prior proposals are represented accurately (checked against the full texts, not the summaries).
- **Strings-only rename (§2.3).** Correct read: `link_type` is a CHECK-constrained column threaded through migrations and RPCs; renaming identifiers buys zero user value. "Link vs label" is also just the right conceptual cut — the promise vs the artifact.
- **Measured, then honest about the measurements being moot.** §1.2's defect table is evidence the screen is overloaded, explicitly *not* a fix list — that's the right altitude.
- **"The only remaining fork is the address" (§1.4b)** holds up: the Guestimator is a real API-backed estimator now (not the SPEC's stale keyword-matcher description), so size/weight genuinely isn't a fork worth a screen.
- **Out-of-scope discipline (§5)** — especially declining to collapse `full_label` into `flexible` while noting it's probably the eventual shape. That restraint is what keeps this proposal small enough to ship.

## Author response

```
author:       Claude Fable 5 (implementing session)
responded_at: 2026-08-17
disposition:  accept all — B1, B2, N1–N6, nits. No rejections. Both blockers were
              real and B2 turned out to be broader than the review found.
```

Both blockers hold and both are fixed. B2 was worse than reported: the review named one prefill site, and there are **three** places the account-holder's identity leaks into the other party's slot.

**B1 — signed-in users can't reach the seller door. ✅ Accept, fixed on all three surfaces.** Verified: [`Index.tsx:14-16`](../src/pages/Index.tsx) redirects authed users to `/dashboard`, and `grep` found zero `/sell` references on any authed surface. Implemented: (a) a flag-gated **"Sell an item"** CTA on the Dashboard beside "Create a new shipment" — the only surface a returning seller actually sees; (b) a flag-gated link-out under the two options on the who-sending step, for anyone who lands there and is actually selling; (c) the homepage door. The flag itself needed re-homing: its only consumer was `RecipientStepPathChoice`, the component this deletes, so it moved to [`src/lib/featureFlags.ts`](../src/lib/featureFlags.ts) where all three read it. With the flag off, every one of these renders exactly as before.

**B2 — prefill puts the user's own address in the destination slot. ✅ Accept, and it had three sites, not one.**
1. `RecipientFlowContext` (the one the review named) — now routes the saved address to `originAddress` on the 'self' branch.
2. **`RecipientStepAddress.tsx:83-115` — a second, independent prefill the review didn't catch.** It writes the same saved address straight into the step-1 address field. Fixing only the context would have left the bug fully intact on the screen where it matters.
3. **`AddressForm` labels the destination name field "(probably your name!)"** — found by driving the branch in a browser, not by reading. On the 'self' branch the recipient is the *other* person, so the hint told the user to type their own name into the wrong party's slot. Now branch-aware.

Because there were multiple sites, the decision is a single named helper, `prefillSlotFor(sender)`, that both prefills import — a drift between two independent `sender === "self"` checks is exactly how this bug comes back. Unit tests cover all three of its cases.

**OQ1 — door wording. John's call, 2026-08-17: "SendMo for Sellers"** with the subtitle *"Create a buyer shipping experience for Marketplaces, eBay, and more."* This supersedes both the proposal's job-led "Sell an item" and the reviewer's endorsement of it. It is an audience/product-line name rather than a job, which is the better fit for a launch surface and — as the proposal's own OQ1 noted — is honestly broader than "Sell an item": a reusable link (`max_shipments = NULL`) plus the `funder` seam already covers shops and repeat sellers, not just one-off sales.

Two things were preserved deliberately. **"The buyer pays for shipping" stays as its own line** — the decided seller-link proposal (its OQ1) required the payer flip to be unmistakable on this surface, and "buyer shipping experience" hints at who pays without stating it. And the **in-app CTAs stay action-phrased** ("Sell an item" on the Dashboard, "Selling something? …" on step 0): a product-line name reads correctly on the marketing homepage, but a signed-in user is already inside SendMo, so a button labelled "SendMo for Sellers" would name the product rather than the action.

**Flagged, not blocking — eBay is on the wrong side of a decided line.** The seller-link proposal §1.2 deliberately scoped this build to the *buyer-pays* case (off-platform: Facebook Marketplace, Craigslist, IG/TikTok "DM to buy") and put **eBay** with the separate, unbuilt *seller-pays* tool — on a completed eBay order the buyer already paid shipping through eBay and eBay has their address, so a pay-at-a-link flow doesn't fit them. "Marketplaces" is exactly right; "eBay" names the one segment this flow can't serve yet. Implemented verbatim as John specified; dropping the word is a one-token change if he agrees.

**OQ2 — routing. Took the reviewer's option (c).** Neither of the author's two options: both answers enter `full-label`, and the escape *navigates* to `/onboarding/flexible/preferences`. No third slug, no route-pattern change, Sentry's parameterized names untouched, and every pre-existing deep link still resolves — which matters more than it looked, because six-plus e2e call sites hard-code those URLs. One correction to the reviewer's framing: the transition does **not** need the `flushSync` guard. That pattern exists for updates the page guard reads (`completedSteps`), and this transition changes none — steps 0 and 1 are shared and already complete, so `canAccessStep(20, [0,1], 'flexible')` passes on the first render after the URL flips. `data.path` is derived from the URL by the existing sync effect; setting it too would only add a render where state and URL disagree.

**OQ3 — positioning. Took the reviewer's split.** The flow names the outbound case; the homepage headline stays coordination-led. SPEC §1 is updated to describe both products without making commodity outbound labels the value proposition — SendMo prices at `rate × 1.15 + $1` against Pirate Ship's zero markup, so leading with that job invites the one comparison SendMo loses. **This is the one call worth John's explicit attention**, and it's cheap to reverse in either direction: it's the hero subcopy plus a SPEC paragraph.

**OQ4 — palette. Took the reviewer's recommendation: `primary` + tokens only.** The reviewer's added fact decided it — emerald already means "Economy" in SPEC §6's speed-tier semantics, so reusing it for selling would overload a color with a live meaning.

**N5 — "They get the label" overpromises. ✅ Accept.** Reworded to keep the actor: *"You'll get a label to send them — or a link they fill in, if you don't have their address."* The product never emails a label to the non-payer (decided 2026-06-27), so the passive voice was claiming a delivery that doesn't happen.

**N6 — per-branch specifics. ✅ Accept.** The 'self' branch now warns up front that carriers require a phone for the delivery address, so a user isn't stranded mid-form without the other person's number. Step shapes are unchanged otherwise, so the step-1 OTP prime and the phone gate keep their existing timings.

**Nits — ✅ all accepted.** `link_type` CHECK is at `001:55`; the App unit test now matches on role + accessible name rather than heading copy; the tier2 preview moves to `previews/archive/` in this change; the stale SPEC §7 description of the Guestimator as a client-side keyword matcher is corrected.

### Two things worth recording for the next session

**The first version of the escape's e2e passed against a broken UI.** It asserted the URL and then read `#origin-name` — but `#origin-name` belongs to the step being *left*, so a transition that changed the URL without swapping the step satisfied every assertion. The spec now asserts the old step is gone (`toHaveCount(0)`) *and* the new step's heading is visible. A test whose assertions all still pass when the swap fails is not testing the swap.

**The browser preview pane cannot verify step transitions in this app.** Framer Motion's `AnimatePresence mode="wait"` exit never completes there, so the outgoing step stays mounted under the new URL. This is not specific to this change — a control run of the ordinary step 1 → step 10 transition stalls identically. It cost a wrong diagnosis and one reverted commit's worth of edits before the control run settled it. Step *transitions* are verified with Playwright; the preview pane is still the right tool for layout, measurement, and copy on a single step.

## Decision

```
decided_by:  John
decided_at:  2026-08-17
outcome:     approve-with-changes — "go ahead and begin execution on this"
```

Approved to build with the review's blockers folded in. OQ2–OQ4 took the reviewer's recommended defaults. **OQ1 was ruled on directly by John (2026-08-17): "SendMo for Sellers"** — see the author response for what was preserved alongside it and the one flagged concern (eBay). **OQ3 (positioning) has still not been separately ruled on** and is flagged as cheap to reverse: it's the hero subcopy plus a SPEC paragraph.

Status → decided. Implementation on `feat/onboarding-who-is-sending`.
