# Proposal — Unify confirmation into `/t/<code>` (one page, state-driven)

> **Status:** Author final — submitted for fresh-eyes review (2026-05-19)
> **Slug:** `2026-05-19_unify-confirmation-into-tracking`
> **Visual artifact:** [`previews/proposal-unify-confirmation-into-tracking.html`](../previews/proposal-unify-confirmation-into-tracking.html) — the primary review artifact. All mockups, the state-matrix, nit responses, and per-state design decisions are visual. **Reviewers: open the HTML first.** This markdown is a metadata sidecar for `proposals/` institutional memory.
>
> **Local server:** project root → `python3 -m http.server 4521` → http://localhost:4521/previews/proposal-unify-confirmation-into-tracking.html

---

## Problem (one paragraph)

The recipient post-purchase confirmation lives inline in `LabelReady` inside [`RecipientStepPayment.tsx:46`](../src/components/recipient/RecipientStepPayment.tsx). It re-implements a subset of the tracking page (label preview, Print/Download, share link, shipment details) without the F1 polish that landed on `/t/<code>` (carrier-specific drop-off via [`dropOffCopy()`](../src/components/sender/senderState.ts), print-count chip, cancel modal with token-derived auth, cancelled-state banner). Three consequences: drift (recent F1 work only landed on `/t/<code>`), no real URL (refresh loses state), two stories for one surface.

## Proposed change (one paragraph)

Drop `LabelReady` from `RecipientStepPayment`. On payment success, redirect to `/t/<publicCode>?just=bought&cancel=<token>` (the `?cancel=<hex>` transport already exists on `TrackingPage.tsx`; `?just=bought` is the new ephemeral flag). `TrackingPage` becomes the single surface for label-related UI, with three lifecycle states (pre-drop-off / post-drop-off / post-delivery) as the primary axis and viewer-identity (payer / anonymous) as the orthogonal augmentation that swaps three blocks (receipt presence, cancel surface, "Everything OK?" support link). Apply the same redirect to `SenderFlow` for parity.

## Key design decisions (see HTML for visuals)

1. **State hero** — three illustrated SVG scenes (package+sparkles, SendMo delivery truck, package-on-doormat with green check) inline, one per lifecycle state. v1 ships with the crude inline SVGs; revisit during a later illustration pass.
2. **ETA banner** — prominent blue-tinted banner on every pre-drop-off variant, carrier-aware: *"Drop off at USPS today → arrives Sat, May 23."* New helper `computeDeliveryEta(carrier, estimatedDays, now)` in `src/lib/deliveryEta.ts`. Carrier delivery schedules + cutoffs + USPS holidays as constants tables. Hides itself when `estimated_days` is null.
3. **Drop-off** — single home: existing `HowToShipStrip` 3-step strip below Print/Download. Step 3 number circle replaced with the map-pin glyph; existing `dropOffCopy()` continues to power the carrier-specific body + "Find a location" deep link. No new wiring.
4. **Print/Download buttons** — reuse existing server-side print counter (`shipments.print_count` + `/label-print` endpoint). Buttons stay thinner (8px vertical padding) and equal-width. Count surfaces as a small line below: *"Not printed yet"* or *"✓ Printed 1× · tap again to reprint"*. Print button gains soft-green tint on done. HowToShipStrip step 1 numbered circle becomes a green check on done.
5. **Receipt block** — lives at the bottom of the scroll, below Shipment Details. Two densities: full (payer + just-bought) vs. condensed single-line (payer returning). **Anonymous viewers see no receipt block at all and no link to one** — payers reach receipts via Dashboard sign-in.
6. **Cancel** — destructive-red link inside the Shipment Details card, payer-only. When ineligible (scanned, delivered), replaced by an inert grey note.
7. **Delivered state — "Everything OK?"** — single `mailto:support@sendmo.co` link with pre-filled subject + shipment-context body. Support email confirmed at `src/pages/Terms.tsx`. Real support-intake system → wishlisted.

## Wishlisted (deferred from v1)

Both added to [`WISHLIST.md`](../WISHLIST.md) under "Added 2026-05-19":

- "Email me the receipt" modal for anonymous viewers
- Real support-intake system (Zendesk / inline form + tickets table)

## Open questions for reviewer

See the HTML's "Open questions for reviewer" section for the full list with author stances. Summary:

1. **"Payer" gate signals** — auth session match + post-payment cookie + signed email-link param. Right three? (Author stance: yes, fall back to anonymous.)
2. **ETA helper edge cases** — late-night cutoff (proposal: 5pm), federal holidays (proposal: static USPS list), missing `estimated_days` (proposal: hide banner).
3. **Sender-flex parity** — should senders get the same `?just=bought` moment? (Author stance: yes, same surface, same rules.)
4. **Cancel placement when ineligible** — inert grey note in Details vs. hide the slot. (Author stance: show the note.)
5. **e2e suite impact** — ~3 specs assert on the inline `LabelReady` view; need to follow the redirect. (Action: pre-merge audit.)

## Trade-offs & risks

See the HTML's "Trade-offs & risks" section. Summary:

- **Variant complexity** — 3 lifecycle × 3 viewer = 9 combinations. Manageable because viewer axis only swaps three blocks.
- **SVG illustrations are crude** — functional, not portfolio-ready. Ship v1, revisit during product-wide illustration pass.
- **ETA helper accuracy** — "drop today → arrives X" is a promise. v1 uses "around X" phrasing + small "*estimated" tooltip. v2 could surface EasyPost's `delivery_date_guaranteed` when available.

## Implementation sketch

See HTML's "Implementation sketch" for the full list. Highlights:

- `RecipientStepPayment.tsx` + `SenderFlow` success → `navigate('/t/${publicCode}?just=bought', { replace: true })`.
- `TrackingPage.tsx` derives `lifecycleState` from shipment status + `viewerIdentity` from existing auth signals.
- New components: `StateHero`, `EtaBanner`, `ReceiptBlock`, `ContactSupportCard`.
- New helper: `src/lib/deliveryEta.ts` with carrier-schedule constants table.
- `ShipmentLabelSection` collapses; cancel moves to `DetailsCard`.
- `HowToShipStrip` gains `printDone` prop (step 1 → green check) and the map-pin tweak on step 3.
- e2e: update inline-confirmation specs to follow redirect; add specs for state hero / ETA banner / viewer variants.

## Cross-links

- Earlier proposal that shaped the tracking page IA: [`2026-05-13_tracking-page-ia-polish_*.md`](2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md) — drop-off relocation, print-count chip, lifecycle progress.
- Cancel-and-change proposal: [`2026-05-11_label-cancel-and-change_*.md`](2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md) — the cancel auth model this proposal preserves.
- Public-tracking-code proposal: [`2026-05-11_sendmo-public-tracking-code_*.md`](2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md) — defined `/t/<public_code>` as the canonical share URL.

## Decision

Pending fresh-eyes review.

---

## Review

> **Reviewer:** fresh-eyes Claude session, 2026-05-19
> **Reading order followed:** Protocol → SendMo PLAYBOOK + LOG → HTML proposal (full) → MD sidecar → Related decided proposals (IA polish 2026-05-13, label-cancel 2026-05-11, sender-wizard 2026-05-11, public-tracking-code 2026-05-11) → Code paths (`TrackingPage.tsx`, `RecipientStepPayment.tsx:46–167`, `tracking/index.ts`, `labels/index.ts`, `label-print/index.ts`, `SenderFlow.tsx`, `HowToShipStrip.tsx`, `ShipmentLabelSection.tsx`, `senderState.ts`, `api.ts`, `types.ts`, `tests/e2e/onboarding.spec.ts`) → WISHLIST.
> **Verdict (advisory — John decides):** approve-with-changes. The direction is right and largely cleans up real drift between two surfaces; several findings below need to land before merge, and one (anonymous-viewer payment-field gating) is a security-shaped finding that must move server-side.

### What the proposal got right

1. **The premise — drift is real.** `RecipientStepPayment.tsx:46–167`'s `LabelReady` view is functionally a parallel implementation of `/t/<code>`'s F1 family, and it has been falling further behind every IA polish ship (2026-05-13 print-count + DetailsCard + HowToShipStrip + CancelledShipmentBanner all landed on `/t/<code>` only). Today the inline `LabelReady` still shows the old 2x2 details grid, a "View Label"/"Download PDF" pair without print-count, no drop-off strip, no cancel surface, and no real URL (refresh loses state). Naming this as drift-from-spec rather than "new design" is the right framing.
2. **The redirect choice and the prior-art reuse.** Sender flow ALREADY redirects to `/t/<publicCode>?fresh=1` via `SenderFlow.tsx:191` and stashes the cancel_token in `sessionStorage` keyed by `public_code` (lines 178–190). The proposal correctly identifies that the *recipient* path is the asymmetric one — the recipient finishes payment then sits on an inline LabelReady instead of redirecting. Bringing the recipient path into the same shape as the sender path closes a real symmetry gap and reuses code that already exists.
3. **Receipt placement at the bottom + payer-only is the right call.** Senders showing up at `/t/<code>` should not see the recipient's payment method or charge total; payers landing fresh from checkout need to see what they paid. The mockup's full-vs-condensed density for payer-just-bought vs payer-returning is well-judged. The decision to wishlist the "email me the receipt" anonymous-payer modal rather than ship it in v1 keeps scope tight.
4. **Existing-helper reuse.** `dropOffCopy()` in `senderState.ts:150`, the `HowToShipStrip` component (`HowToShipStrip.tsx`), the `label-print` endpoint, `shipments.print_count`, and the existing cancel-token transport are all real and the proposal correctly reuses them rather than reinventing. No new Edge Functions proposed for v1 — that's a strength.
5. **Wishlist hygiene.** Two items added under "Added 2026-05-19 — Confirmation/tracking unification follow-ups" cross-link cleanly to the proposal slug. No duplicate entries elsewhere in WISHLIST.md. Both items are correctly scoped as "after v1, if usage justifies."

### Blocking findings

**1. BLOCKING — Lifecycle-state model silently drops `cancelled` and `return_to_sender`.**
*Location:* §"Implementation sketch" item 2 in the MD; "Mental model" + "State × viewer matrix" in the HTML. *Issue:* The proposal defines exactly three lifecycle states (`pre-drop-off` / `post-drop-off` / `post-delivery`) and maps statuses as `label_created` → pre, `in_transit`/`out_for_delivery` → mid, `delivered` → post. But `TrackingPage.tsx:93–102` (`TERMINAL_BANNERS`) and `tracking/index.ts:29` (`TERMINAL_STATUSES`) already handle two more statuses that aren't in the proposal's model: `cancelled` and `return_to_sender`. Today `/t/<code>` renders these as **Family 3** per the decided 2026-05-13 IA polish proposal §2.1 — a distinct composition with `CancelledShipmentBanner`, `DetailsCard(family=3)`, and `PrintAnotherLabelCTA`. The new state-driven model has no slot for them. If `StateHero` is dispatched purely off the proposal's 3-state derivation, `cancelled` / `return_to_sender` shipments will fall through to a default branch (or worse — get classified as `pre-drop-off` because status `!= in_transit/out_for_delivery/delivered`, which is the most natural fall-through from `label_created` → pre-drop). That's a regression from a *decided* proposal that shipped six days ago. *Suggested fix:* Either explicitly preserve the F3 family as a 4th lifecycle state ("post-cancel" or "terminal") with its own hero + composition, or carve it out as the pre-condition: "if `status ∈ {cancelled, return_to_sender}` render existing F3 unchanged; else dispatch on the new 3-state axis." Add a `## Reconciliation with prior decided proposals` section naming `2026-05-13_tracking-page-ia-polish` and showing the explicit four-way mapping (F1=pre-drop-off, F2=post-drop-off mid-states, F2'=post-delivery, F3=cancelled/return_to_sender). The proposal currently asserts unification but is effectively a 3-of-4 spec.

**2. BLOCKING — Anonymous-viewer payment-info filtering must be server-side, not client-side.**
*Location:* §"Receipt block" + nit #4 in HTML; §5 of the MD ("Anonymous viewers see no receipt block at all"). *Issue:* The proposal describes anonymous viewers seeing no receipt block, but the only mechanism described is client-side: render `<ReceiptBlock>` only when `viewerIdentity === 'payer'`. Today's `tracking/index.ts:397` returns `paid: shipment.stripe_payment_intent_id != null` and `amount_paid_cents` on the response *unconditionally*. The field is currently null because no Stripe-paid shipments exist (per LOG 2026-05-13 "Two-step refund"), but Phase E/Pattern D shipped 2026-05-18 — paid shipments are imminent, and once they exist, the tracking response will carry `amount_paid_cents` to every caller including anonymous ones. Client-side filtering ≠ a security boundary; anyone curl'ing `/functions/v1/tracking?code=<x>` or scraping the JSON sees the payment fields regardless of what `ReceiptBlock` renders. *Suggested fix:* Gate `paid` / `amount_paid_cents` / any new receipt fields server-side in `tracking/index.ts` on `viewerIsRecipient || isAdmin`. Anonymous viewers should get `paid: undefined` or these fields omitted entirely. Add this to the file-by-file plan, and add an explicit test in the test plan ("anonymous tracking GET response contains no payment fields"). This is a small change but it's load-bearing — proposing it as a UI rule lets the bug slip when (not if) someone adds a fourth payment field client-side.

**3. BLOCKING — Two of the three "payer gate" signals are new infrastructure, not existing — and the proposal reads as if they exist today.**
*Location:* §"Open questions" #1 in HTML; §"Open questions" #1 in MD; §"Implementation sketch" #2 in MD. *Issue:* The proposal says viewer-identity derives from "(a) auth session userId matches link owner, (b) recent post-payment session cookie set for this shipment, (c) signed query param from the receipt/label email." Of these: (a) exists today as `viewer_is_recipient`, derived server-side in `tracking/index.ts:340–362` from JWT + `link.user_id`. (b) and (c) **do not exist** — there is no post-payment session cookie infrastructure anywhere in the codebase (grep'd `Set-Cookie`, `document.cookie`, signed-cookie helpers — nothing in the payment path), and no signed-email-link param surface (existing email transport is `?cancel=<hex>` from cancel-label, which is a sessionStorage handoff, not a signed-payer assertion). The proposal's three-signal model thus requires designing + shipping two new auth surfaces. That's a substantially larger scope than "redirect on payment success + restructure render." *Suggested fix:* For v1, narrow the payer-identity model to (a) JWT-match-link-owner (i.e., reuse existing `viewer_is_recipient`) **plus** the just-bought-tab signal (the navigation arrived with `?just=bought` carrying a server-issued one-shot token that the tracking page consumes on first render — see finding 4). Mark (b) post-payment cookie and (c) signed email link as **explicit out-of-scope** for v1 and wishlist them. The current proposal phrasing implies all three are minor wiring; they aren't.

**4. BLOCKING — `?just=bought` leaks to anyone the URL is shared with.**
*Location:* §"Mental model" referral axis; §"Open questions" #1 stance; mockups showing `?just=bought` literal in the URL strip. *Issue:* The proposal treats `?just=bought` as a per-tab flag that gets cleared on X-click / first print / next nav-without-flag. But the URL `/t/<code>?just=bought` is whatever the user's browser puts in the address bar — and people share these URLs (the share-link affordance is in the existing inline `LabelReady` and the recipient might paste it into a text message). If `?just=bought` flips the page into "payer just-bought" presentation — full receipt block, cancel link, celebration hero — anyone who receives the shared URL with the flag intact also gets the payer view. Combined with finding 2 (client-side payment filtering), this means an anonymous viewer who clicks a shared-with-flag URL could see receipt info if the proposal's gating relies on `?just=bought` to assert "payer". *Suggested fix:* Don't use `?just=bought` as an identity claim — use it strictly as a presentation hint (e.g., "show the welcome sub-headline" or "trigger one-shot confetti") and require an identity claim independent of the URL (JWT or a server-issued single-use token consumed on first GET and bound to a server-side session). Strip the flag from the URL with `setSearchParams(searchParams, { replace: true })` on first paint, matching the existing `?fresh=1` / `?cancel=<hex>` handling at `TrackingPage.tsx:181–185`. The current proposal's "shouldn't leak to other viewers — is this handled?" stance is "no, mockup just shows the literal URL." That's a real gap.

**5. BLOCKING — The `computeDeliveryEta` helper duplicates information the server already has + introduces drift-prone client logic.**
*Location:* §"Key design decisions" #2 in MD; nit response #2 in HTML; new file `src/lib/deliveryEta.ts`. *Issue:* Two things. *(a)* The tracking response already carries `promised_delivery_date` (a real date from EasyPost's `selected_rate.delivery_date`, persisted on `shipments.promised_delivery_date` per `labels/index.ts:875`) and `estimated_delivery` (formatted date string from the live EasyPost shipment) — both surfaced via `tracking/index.ts:375,379`. The status hero already displays "Expected {formatDeliveryDate(data.estimated_delivery)}" at `TrackingPage.tsx:440–443`. Adding a *new* client-side helper that re-derives a delivery date from `(carrier, estimated_days, now)` is reinventing what EasyPost already returned authoritatively. *(b)* The proposed helper bakes in business logic (carrier cutoff times, federal holidays, "drop today vs. tomorrow" pivoting) that will drift: USPS retail cutoffs vary by location, UPS/FedEx pickup cutoffs vary by ZIP and service tier, and a static USPS federal-holiday list in code will silently rot when 2027 holidays land. *Suggested fix:* For the ETA banner, render off the server-provided `promised_delivery_date` directly (server-authoritative, already accurate when EasyPost returned `delivery_date_guaranteed`). For the "drop today by 5pm" cutoff hint, simplify aggressively: a single generic hint per carrier ("Most USPS post offices accept drop-offs until late afternoon — check yours.") avoids ETA-misstatement liability while preserving the visual real-estate of the banner. If a precise cutoff is wanted, treat it as v2 with EasyPost's authoritative data as the source. Either approach removes the new file `src/lib/deliveryEta.ts` from v1, removes a constants table that will drift, and removes the "if cutoff/holiday logic is wrong, we'll under- or over-promise" risk the proposal already flags as a trade-off.

### Non-blocking concerns

**N1 — Sender-flex parity claim conflates "paid" with "payer of the displayed shipment."**
*Location:* §"Open questions" #3, author stance: "include senders. Same surface, same rules." *Issue:* Per PLAYBOOK Payment Flows, full-label is `capture_method: 'automatic'` (recipient is the payer of the shipment) but **flex-link sender flow uses Pattern D off_session charge** against the *recipient's* saved PM (`labels/index.ts` flex branch, decided 2026-05-16). In flex-flow, the sender is *not* the payer of the shipment — the recipient is, even though the sender just clicked Confirm. So if "payer" means "the financial party who funded this shipment," the sender in flex-flow is not the payer and shouldn't see the receipt block. If "payer" means "the human who just clicked Confirm and reached this URL," then in flex-flow the sender would see a receipt for a charge they didn't make, against a card they don't own. Both readings have a problem. *Suggested resolution:* For senders coming from `/s/<code>` Confirm in the flex-flow, treat them as a third viewer role ("sender, just-shipped") that gets the celebration hero + cancel surface + drop-off + ETA, but **not** the receipt block (which is the recipient's by Pattern D). For senders in full-label sender-flow... actually, in full-label, only the recipient finishes payment — senders don't reach the labels function with payment. So this case may not exist. Worth a sentence in the proposal making the model explicit.

**N2 — ETA banner duplicates information that appears 60px below it in the HowToShipStrip step 3.**
*Location:* HTML mockup #1 pre-drop-off — ETA banner says "Drop off at USPS today → arrives Sat, May 23 · USPS Ground Advantage · drop by 5pm today for next-day pickup." HowToShipStrip step 3 says "Drop off — any USPS Blue Box, Post Office, or hand to your mail carrier." Same drop-off context, two cards, immediately adjacent. *Suggested fix:* Either fold the cutoff hint into the strip's step 3 body and have the banner say only the arrives-date, or drop the strip's step 3 "drop off" body and keep the banner doing all the drop-off comms. The current arrangement isn't terrible, but the banner+strip pair reads like two passes at the same thought and is the kind of thing a polish pass three weeks later will reasonably want to consolidate.

**N3 — Print-counter green-tint state needs the initial-load source named.**
*Location:* §"Key design decisions" #4; nit #3 in HTML. *Issue:* The proposal says the Print button gets a soft-green tint when `print_count > 0` and the HowToShipStrip step 1 numbered circle turns into a green check. `print_count` arrives via the tracking response (`tracking/index.ts:412`, surfaced as `data.print_count`), so reading the state for *initial* paint is straightforward — but the proposal doesn't say so explicitly. Worth adding one sentence under that decision: "`print_count` from the tracking response on first paint; the existing optimistic-bump pattern at `TrackingPage.tsx:200,492` is preserved." Removes ambiguity for the implementer.

**N4 — e2e impact "~3 specs" is unsupported and probably high.**
*Location:* §"Open questions" #5; nit #4 in MD. *Issue:* I grep'd `tests/e2e/` for `LabelReady`, "Your shipping label", "Print Label", `labelResult`, `label_url`. The only spec that exercises the inline LabelReady view is `tests/e2e/onboarding.spec.ts` (line 258, "Step 12: Label Ready" — asserts on heading, tracking number, Download PDF and View Label buttons). `tests/e2e/url-step-routing.spec.ts:116` references `label_url` only in a mock object, not in assertions. So the actual count is **1 spec to follow the redirect**, plus net-new specs for state-hero / ETA-banner / viewer-variants that the proposal already plans to add. *Suggested fix:* Replace the "~3 specs" estimate with the concrete grep result. The pre-merge audit task isn't needed — the audit takes 30 seconds and the result fits in the proposal.

**N5 — The state hero is now the only thing distinguishing "post-purchase moment" from "routine tracking visit."**
*Location:* §"Trade-offs & risks" — SVG illustrations crude; nit #1 response (tearsheet dropped). *Observation:* The author dropped the tearsheet in v3 in favor of the SVG hero. The hero is the same SVG whether the user is fresh from checkout, returning a week later, or anonymous-via-shared-link (assuming `?just=bought` is gone after the first paint, which it should be per finding 4). The "moment" is then carried entirely by the headline copy ("Your label is ready to print — waiting for drop-off!") and the optional confetti flourish. Two questions worth surfacing back to the author: *(a)* Is the headline alone enough of a moment for the payer-just-bought case, given the rest of the page is identical to the payer-returning case? Pirate Ship and Shippo both differentiate the just-bought page from the tracking-page-revisited page (Pirate Ship via a "What's next?" panel; Shippo via a quick-print modal). *(b)* If yes, fine — but the author should be explicit that the choice is "one page, the difference is copy" rather than "celebration moment" since the tearsheet decision essentially removed the visual celebration. The proposal currently has it both ways: §"Mental model" calls it an "optional confetti flourish" but the §"Trade-offs" callout implies the SVG IS the celebration. Pick one.

**N6 — Cancel-eligibility model is preserved, but worth confirming the message-when-ineligible doesn't regress audit clarity.**
*Location:* §"Key design decisions" #6 + §"Open questions" #4. The cancel auth model from `2026-05-11_label-cancel-and-change` is preserved — `canCancel` derivation continues to use the JWT + viewer_is_recipient + sessionStorage cancel-token triplet (`TrackingPage.tsx:241–250`). Good. The mockup's "Cancel unavailable — package has been scanned" inert note in `DetailsCard` is fine for `in_transit`/`out_for_delivery`. *One subtle gap:* the current `ShipmentLabelSection` shows BOTH `Cancel label` and `Cancel & start over` (cancel + change). The proposal's `DetailsCard` mockup only shows a single "Cancel this label" destructive link. Is "Cancel & start over" intentionally dropped? If yes, the change-flow (which navigates back to `/s/<short_code>` per `TrackingPage.tsx:284–287`) needs an explicit replacement story. If no, two destructive links in DetailsCard might be visually crowded.

**N7 — The mailto support fallback hardcodes shipment IDs into the URL.**
*Location:* HTML mockup #3 post-delivery — `mailto:support@sendmo.co?subject=...%20940010020830311220&body=...Tracking%3A%209400%201002%200830%203112%2020...`. This is fine for the happy path but: *(a)* iOS Mail / Gmail Mobile sometimes truncate long mailto body params; the proposal should test a real tracking number with a real shipment context in the body to confirm encoded length doesn't blow through limits. *(b)* The body composition is real PII (origin + destination cities, delivered-at timestamp) — the wishlist item for "Real support intake system" notes this; just call out in v1 that the mailto includes city-level + timestamp data so the implementer doesn't second-guess.

### Out-of-scope observations

**O1 — Cancel-token sessionStorage convergence is robust today, but the proposal's "always pass cancel_token via redirect" deserves one sentence.** Per §"Proposed change," "the `?cancel=<hex>` transport already exists." It does — `TrackingPage.tsx:172–185` captures it from URL and writes to sessionStorage. But the proposal's redirect is `/t/${publicCode}?just=bought&cancel=<token>`. The existing recipient path puts the cancel_token into sessionStorage via a different mechanism (inline from `buyLabel` result on SenderFlow side; for the recipient side, the cancel_token comes back on `LabelResult.cancel_token` per `types.ts:209`). Worth confirming explicitly: the proposal should say "recipient redirect = `/t/${publicCode}?just=bought&cancel=${labelResult.cancel_token}` when `cancel_token` is non-null; else just `?just=bought`." That's the natural read of the proposal but isn't spelled out.

**O2 — `?fresh=1` rename to `?just=bought`.** The proposal uses `?just=bought` everywhere but the codebase has `?fresh=1` in multiple places: `TrackingPage.tsx:175,181`, `SenderFlow.tsx:191,310`, `RecipientStepEmailVerifySupabase.tsx:58` comment, `ShipAgainCTA.tsx:8` (`isFresh` prop). If the proposal lands and renames the flag to `?just=bought`, all five places need updating + the sender flow needs to switch its redirect to use the new name for sender-flex parity. Worth either (a) keeping `?fresh=1` as the wire-format and treating `just-bought` as an internal lifecycle-prop name, or (b) doing the rename comprehensively in v1 and naming it in the file-by-file plan. Today the proposal does neither.

**O3 — The proposal silently dissolves a separation of concerns.** Today `ShipmentLabelSection` owns label-PDF + Print + Download + share + cancel. `DetailsCard` owns identifiers. The proposal moves cancel from `ShipmentLabelSection` into `DetailsCard`, collapses `ShipmentLabelSection` into "ActionButtons + print-count line," and adds a new `ReceiptBlock` at the page bottom. That's a reasonable refactor but it's load-bearing: the `2026-05-13` IA polish proposal §2.1 places `ShipmentLabelSection` and `DetailsCard(family=1)` as separate compositional units. The new proposal effectively redraws those component boundaries. Worth one sentence in the new proposal: "the F1 composition becomes `[ActionButtons] + [HowToShipStrip] + [DetailsCard with cancel] + [ReceiptBlock]`; `ShipmentLabelSection` is removed." Right now the implementation sketch §5 mentions this in passing.

### On the five open questions

**Q1 — "Payer" gate signals.** Author stance: a + b + c. *My take:* a is real; b and c are new infrastructure (see blocking finding 3). For v1, stick to JWT-match-link-owner (already works as `viewer_is_recipient`) and a server-side one-shot token consumed at the post-payment redirect. Punt (b) and (c) to wishlist with their own proposals when there's a real need (anonymous-payer-who-isn't-signed-in is the use case; the existing "go sign in via Dashboard" fallback covers it for v1).

**Q2 — ETA helper edge cases.** Author stance: 5pm cutoff, static USPS holiday list, hide-on-null. *My take:* This is the wrong frame because the helper itself is misconceived (see blocking finding 5). The server has `promised_delivery_date` already; use that. If you want a cutoff hint, make it generic ("most carrier locations accept until late afternoon"), not a per-carrier-per-day rules engine in client code that will drift. The author's instinct to hide the banner when data is missing is correct and should carry over.

**Q3 — Sender-flex parity.** Author stance: yes, same surface, same rules. *My take:* Mostly yes, with one carve-out (see non-blocking N1). The "sender just paid" model doesn't hold for flex-flow where the recipient's saved PM was charged off_session. Senders in flex-flow get the celebration + cancel + drop-off + ETA, but should not see the receipt block (which is the recipient's). This is a one-paragraph clarification in the proposal, not a structural change.

**Q4 — Cancel placement when ineligible.** Author stance: show inert grey note. *My take:* Agreed. "Why isn't the cancel button there anymore?" is a real question and the inert note answers it cheaply. Worth being explicit in the implementation sketch that the inert-note copy should match the existing `TrackingPage.tsx:93–102` `TERMINAL_BANNERS` voice, not invent a new tone.

**Q5 — e2e suite impact.** Author stance: ~3 specs, pre-merge audit task. *My take:* The audit is one grep that fits in the proposal (see N4). The real count is 1 existing spec to update (`onboarding.spec.ts:258`) + N new specs to add. The author should also add an e2e for the anonymous-viewer payment-field-absent assertion (finding 2) — that's the load-bearing test that prevents the client-side-filtering regression from sneaking back in.

---

*Reviewer summary in 3 lines:* (1) verdict: approve-with-changes — the unification direction is right and reuses real existing code; (2) top blocking issue: anonymous-viewer payment fields must be gated server-side in `tracking/index.ts` rather than via client-side render conditioning, because Pattern D ships paid shipments now (2026-05-18) and `amount_paid_cents` is one webhook away from being non-null; (3) top thing the proposal got right: correctly identifying the inline `LabelReady` as drift from the decided `/t/<code>` IA spec rather than as new design — drift framing is the right institutional-memory framing per the protocol.

---

## Author response

> **Author:** same Claude session that drafted v3, 2026-05-19
> **Verdict accepted:** approve-with-changes — all 5 blockers accepted; revisions land in v4 of the HTML + this MD; net-new design directives from John 2026-05-19 logged at the bottom; execution starts with the server-side payment-gating fix (smallest correctness PR), then proceeds in passes.

### Overall — the review caught real things

The two findings I'd weight highest are (#2 server-side gating) and (#5 `computeDeliveryEta` is reinventing EasyPost's authoritative data). Both are cases where I designed around what I assumed the server returned instead of reading the response shape. The reviewer fixed both with one grep each. The lifecycle-coverage gap (#1) is straight drift from the decided IA-polish proposal that shipped six days ago — that I missed it is on me.

### Responses to blocking findings

**#1 — Lifecycle drops `cancelled` / `return_to_sender`. ACCEPTED.**
v4 adds a fourth lifecycle bucket: **terminal**, gating on `status ∈ {cancelled, return_to_sender}` *before* the 3-state dispatch. Terminal preserves the existing F3 composition unchanged (`CancelledShipmentBanner` + `DetailsCard(family=3)` + `PrintAnotherLabelCTA` per `2026-05-13_tracking-page-ia-polish` §2.1). Adding a `## Reconciliation with prior decided proposals` section to v4's HTML naming the explicit four-way mapping: F1 (pre-drop-off, `label_created`) → F2 (post-drop-off, `in_transit`/`out_for_delivery`) → F2′ (post-delivery, `delivered`) → F3 (terminal, `cancelled`/`return_to_sender`). The 3-state model is now a 3-state model *layered on top of* the existing F1/F3 split — not a replacement for it.

**#2 — Anonymous-viewer payment-info filtering must be server-side. ACCEPTED — this is the must-fix.**
Gating moves to `tracking/index.ts` around line 397. `paid`, `amount_paid_cents`, and any future receipt fields are conditionally included on the response only when `viewerIsRecipient || isAdmin`. Anonymous response shape omits the fields entirely (not `null`, omitted). New e2e: `tracking anonymous response omits payment fields` — assertion on JSON shape, not on rendered UI. This is the first execution pass — small, isolated, no UI changes, low blast radius.

**#3 — Payer gate signals (b) and (c) are net-new infrastructure. ACCEPTED with the reviewer's narrowing.**
v1 payer-identity model is **only** (a) `viewer_is_recipient` (existing JWT-match-link-owner, already computed server-side at `tracking/index.ts:340–362`). The "post-payment session cookie" and "signed email-link param" become explicit out-of-scope wishlist items under the same 2026-05-19 confirmation/tracking-unification follow-up section. For the just-bought celebration moment, we use a presentation-only flag (see #4) and don't conflate it with identity.

**#4 — `?just=bought` leaks via URL sharing. ACCEPTED.**
v4 treats `?just=bought` as strictly a presentation hint, never as an identity claim. On first paint, `TrackingPage` strips the flag from the URL via `setSearchParams(searchParams, { replace: true })`, mirroring the existing `?fresh=1` / `?cancel=<hex>` handling at `TrackingPage.tsx:181–185`. Local component state remembers "celebrating" for this render only. Sharing the URL after that point conveys the URL without the flag. The receipt block, cancel link, and "Need help" all gate on server-derived `viewerIsRecipient`, never on the URL flag.

**#5 — `computeDeliveryEta` reinvents EasyPost's authoritative data. ACCEPTED — this is genuinely a better answer than what I proposed.**
v4 drops `src/lib/deliveryEta.ts` entirely. The ETA banner reads from the existing `data.promised_delivery_date` (already on the tracking response, sourced from EasyPost's `selected_rate.delivery_date` at `labels/index.ts:875` and surfaced at `tracking/index.ts:375`). For the cutoff hint, v4 uses generic per-carrier copy ("Most USPS post offices accept drop-offs until late afternoon — check yours.") instead of a per-carrier rules engine. If `promised_delivery_date` is null (older shipments, certain carriers), the banner hides itself entirely. No new helper file, no constants table that will rot, no federal-holiday list to maintain.

### Responses to non-blocking concerns

**N1 — Sender-flex parity carve-out for the receipt block. ACCEPTED — with John's 2026-05-19 affirmative-confirmation addition.**
Sender-in-flex-flow is a third viewer role: celebration hero + cancel + drop-off + ETA, but **no receipt block** (the receipt is the recipient's per Pattern D off_session model). **John's 2026-05-19 directive:** instead of leaving the receipt slot empty, replace it with an affirmative confirmation block: a soft-green check + "<strong>[Recipient first name] has paid for shipping</strong> · No charge to you — the prepaid label is on the recipient." This turns the absence of a receipt into a positive — the sender knows they're not on the hook, and they know the prepayment went through. New `viewerRole` value `'sender_flex'` derived server-side from `(viewerHoldsCancelToken && !viewerIsRecipient)`, where `viewerHoldsCancelToken` reuses the same auth proof already shipped in [2026-05-11_label-cancel-and-change](2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md). Recipient first name surfaces via the existing `sendmo_links.user_id → profiles` join (need to add `first_name` to the SELECT). Privacy: sender already knows the recipient (they just shipped to them) — first-name reveal is not a leak. See v4 mockup's middle variant in the variants row.

**N2 — ETA banner duplicates drop-off info from HowToShipStrip step 3. ACCEPTED — let strip carry the cutoff hint.**
v4: banner shows only the arrives-date ("Drop off at USPS today → arrives Sat, May 23"). The "drop by late afternoon" cutoff hint moves into HowToShipStrip step 3's body. One thought, one place.

**N3 — Print-counter green-tint initial-load source needs naming. ACCEPTED.**
One sentence added to "Key design decisions" #4: "`print_count` reads from the tracking response on first paint (`tracking/index.ts:412`); existing optimistic-bump at `TrackingPage.tsx:200,492` is preserved."

**N4 — e2e impact "~3 specs" was overstated. ACCEPTED — concrete count is 1.**
Replacing the estimate with the reviewer's grep result. Existing spec to update: `tests/e2e/onboarding.spec.ts:258` ("Step 12: Label Ready"). Net-new specs: state-hero per lifecycle, ETA banner copy when `promised_delivery_date` is present/null, viewer-variant payer/anonymous, and anonymous-payment-field-absent (the load-bearing assertion for blocking finding #2).

**N5 — Hero is now the only post-purchase-vs-routine differentiator. ACKNOWLEDGED, but a tweak from John 2026-05-19 (below) makes the heroes 25% smaller and replaces the ETA-banner calendar icon with a "person walking with package" illustration that matches the truck hero style.** With that, the differentiator becomes (a) the ETA banner only appears pre-drop-off, (b) the headline copy is state-specific. Pirate Ship's "What's next?" / Shippo's quick-print pattern are noted; if first-week usage data shows the just-bought moment feels flat, we revisit a confetti-or-modal flourish as a v1.1 follow-up.

**N6 — Cancel + Change duplication risk. CLARIFIED.**
v4 DetailsCard shows **one** destructive link: Cancel. "Cancel & start over" (the change-flow) is preserved as a button row above DetailsCard for the rare case where both apply — but per [2026-05-11_label-cancel-and-change](2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md), Change is a sender-flow concept only and not relevant for the recipient post-purchase view. Two destructive links never appear together in the recipient-payer case.

**N7 — mailto length + PII. ACCEPTED with one tweak from John (below).**
John has directed (2026-05-19) that the "Need help" surface should use the same mailto pattern but live as a link inside DetailsCard (next to or in place of cancel), not as a separate "Everything OK?" card. Body composition stays: tracking, from/to cities, delivered-at timestamp, empty "What happened:" field. The mailto-body-length concern is real; v4 includes a 1200-char cap on the body with a "…(continued at link)" fallback that points at `/t/<code>`. PII disclosure is acknowledged — wishlist item for "Real support intake system" notes the data shape.

### Responses to out-of-scope observations

**O1 — Cancel-token redirect needs explicit conditioning. ACCEPTED.**
v4 implementation sketch spells out: `navigate('/t/' + publicCode + '?just=bought' + (labelResult.cancel_token ? '&cancel=' + labelResult.cancel_token : ''), { replace: true })`.

**O2 — `?fresh=1` vs `?just=bought` rename. PICKED option (a) per reviewer's framing.**
**Keep `?fresh=1` as the wire-format flag** for consistency with the existing sender flow (`SenderFlow.tsx:191,310`, `TrackingPage.tsx:175,181`, `RecipientStepEmailVerifySupabase.tsx:58`, `ShipAgainCTA.tsx:8` `isFresh` prop). `?just=bought` was author-side naming for clarity in the proposal; v4 uses `?fresh=1` everywhere in the implementation sketch. No rename; just a docs cleanup pass in v4 to switch references.

**O3 — `ShipmentLabelSection` removal touches IA-polish component boundaries. ACCEPTED.**
v4 adds an explicit sentence: "F1 composition becomes `[StateHero] + [EtaBanner] + [ActionButtons + PrintCountLine] + [HowToShipStrip with printDone prop] + [DetailsCard with cancel + 'Need help' link] + [ReceiptBlock (payer only)]`. `ShipmentLabelSection` is deleted." Now it's named, not implied.

### On the five open questions — convergence

- **Q1 (payer signals):** converged to (a) only for v1 (reviewer's narrower model). (b) and (c) → wishlist.
- **Q2 (ETA edge cases):** moot — helper deleted; use server's `promised_delivery_date` (reviewer was right).
- **Q3 (sender-flex parity):** converged with the N1 carve-out — sender-flex gets the surface but not the receipt.
- **Q4 (cancel ineligible placement):** John has now directed (2026-05-19, below): **don't render the cancel slot at all** when ineligible. No inert grey note. Drops the "match the TERMINAL_BANNERS voice" sub-question.
- **Q5 (e2e count):** 1 spec to update; concrete count cited in implementation plan.

### New design directives from John (2026-05-19, post-review)

1. **ETA banner gets an illustrated SVG hero** — same visual language as the truck/package-on-mat heroes, showing a person walking with a package in their hand. Replaces the small calendar icon that currently sits in the banner. The banner becomes a mini-hero strip in itself, not just a card with a label and icon.
2. **State heroes get 25% smaller globally** — both the SVG scene and the headline text. The page already has a lot going on; the heroes shouldn't dominate. The v3 heroes are ~86px tall; v4 targets ~64px tall.
3. **"Everything OK?" delivered-state card is removed.** Replaced by a "Need help" link inside DetailsCard, positioned next to Cancel when present or in the cancel slot when cancel isn't there. Clicking opens the same mailto: with pre-filled shipment context so John can handle support inbound.
4. **When cancel is ineligible (scanned/in-transit/delivered/cancelled), don't render the slot at all** — no inert grey "Cancel unavailable" note. The Need-help link remains in that slot.
5. **Pickup-vs-drop-off as a future state — added as a wishlist item.** v1 assumes drop-off (which matches today's reality — SendMo has no pickup wiring). If/when the EasyPost Pickup API is integrated, the pre-drop-off hero adapts (e.g., "carrier arriving at your door" illustration) and the ETA banner copy changes to reflect the pickup schedule. New wishlist entry added under 2026-05-19 follow-ups.
6. **Non-paying sender ("sender_flex") needs an affirmative "the recipient paid" block** in place of the receipt. Not just an absent receipt — a positive confirmation: "Jane has paid for shipping · No charge to you." Lands as a new viewer role `sender_flex` derived server-side from a valid cancel_token match (no new auth infrastructure needed; the cancel-token transport from 2026-05-11_label-cancel-and-change is the proof). Recipient first name surfaces via existing `sendmo_links.user_id → profiles` join.

### Next steps — execution plan

The proposal is large; landing in passes. Roughly:

1. **Pass 1 — server-side payment-field gating** (`tracking/index.ts`). Smallest correctness fix, isolated, addresses blocking finding #2 directly. Includes the new e2e assertion. **First PR.**
2. **Pass 2 — UI mockup tweaks in `previews/proposal-unify-confirmation-into-tracking.html`** to reflect John's 2026-05-19 directives (smaller heroes, walking-person SVG in ETA banner, removed "Everything OK?" card, "Need help" link in DetailsCard, removed cancel-unavailable note, terminal-state mockup added). Visual confirm before code restructure.
3. **Pass 3 — `TrackingPage` lifecycle dispatch** including the new fourth (terminal) bucket. Hooks for `?fresh=1` flag-strip and `viewerRole` derivation server-side.
4. **Pass 4 — `RecipientStepPayment.tsx` LabelReady removal + redirect.** Drop the inline view; add `navigate('/t/' + publicCode + '?fresh=1' + (cancel_token ? '&cancel=...' : ''), { replace: true })`.
5. **Pass 5 — new components.** `StateHero`, `EtaBanner` (consuming `promised_delivery_date`), `ReceiptBlock` (payer-only), `PaidByRecipientBlock` (sender_flex only — "Jane has paid for shipping"), `HelpLink` (in DetailsCard).
6. **Pass 6 — `HowToShipStrip` updates.** `printDone` prop, map-pin on step 3, cutoff hint folded into step 3 body.
7. **Pass 7 — e2e suite.** Update `onboarding.spec.ts:258`; add new specs for state-hero / ETA / viewer-variant / payment-field-absent.
8. **Pass 8 — sender-flex parity.** Server-side: `tracking/index.ts` derives `viewerRole` = `payer` / `sender_flex` / `anonymous` and surfaces `recipient_first_name` (joined from `sendmo_links.user_id → profiles`) when `viewerRole === 'sender_flex'`. Client-side: `PaidByRecipientBlock` renders when `viewerRole === 'sender_flex'`, replacing the receipt slot.

Each pass = own commit (or PR if scope warrants). Status moves to `decided` after Pass 1 lands clean — formal rename of this file when John gives the go-ahead.

---

