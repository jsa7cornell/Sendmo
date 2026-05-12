---
title: Sender Flow Wizard — make flex links functional end-to-end
slug: sender-flow-wizard
project: sendmo
status: decided
created: 2026-05-11
last_updated: 2026-05-11 21:15
reviewed: 2026-05-11
decided: 2026-05-11
author: Claude (Opus 4.7) — SendMo session, drafting from John's directive on 2026-05-11
reviewer: Claude (Opus 4.7) — fresh-eyes reviewer session, 2026-05-11
outcome: approved
---

## 1. Context

Flex shipping links are the only path to a "share once, ship many times" experience — but they dead-end today. A sender who clicks `sendmo.co/s/<code>` lands on [SenderFlow.tsx](src/pages/SenderFlow.tsx) which:

- Skips SPEC §8 Step 0 (Intro / "You're sending to {recipientName}").
- Goes Address → Package → Rates → "Done" placeholder reading "Label generation coming soon — Stripe payment integration in progress."
- Has no Step 3 (Review & Confirm).
- Never calls `buyLabel()`; no PDF is generated; no email fires.

Per [PLAYBOOK.md](PLAYBOOK.md) "Current status (2026-03-18)", the sender flow is the last item between "recipient onboarding works" and "actually usable product." Nothing else moves the needle as much for John's dogfood goal.

**The blocker is not UX, it's the payment model.** Every label purchase through `/labels` requires either a verified Stripe `payment_intent_id` whose metadata matches the shipment, or `comp: true` (admin override) — see [labels/index.ts:48-96](supabase/functions/labels/index.ts). Today the recipient has no card on file (Phase 1 is full-label-only; [RecipientStepFlexPayment.tsx](src/components/recipient/RecipientStepFlexPayment.tsx) is stubbed). The "right" answer is the Stripe proposal's Phase E (auth-at-link-creation + capture-at-label-buy) but Phase E is blocked on Phase A which is blocked on §11 decision #4 (account-creation timing research). That blocks the sender flow indefinitely unless we route around it.

**This proposal routes around it.** Build the 5-step wizard end-to-end now under a comp-only payment model — labels really print, EasyPost really charges SendMo's account, no money moves from any user — so John has a real product to dogfood. Phase E swaps comp out for real auth/capture without UI changes when it lands.

## 2. Architecture

### 2.1 Payment-model decision

Three viable paths surfaced in John's directive:

**(a) Comp-only for now.** Sender flow ends with `buyLabel(..., { comp: true, display_price_cents })`. EasyPost charges SendMo, no Stripe call. The labels function already supports this (`isComp = true` skips the PI gate at line 53; writes `payment_method: 'comp'` to payments via the post-migration-012 ledger). Documented temporary debt; Phase E swaps it out later.

**(b) Sender-pays fallback.** Re-use the Phase-1 `payments` Edge Function + `StripePaymentForm.tsx` so the sender pays at confirm time. Architecturally wrong per SPEC §2 ("Sender never pays"); breaks the core value prop.

**(c) Wait for Phase E.** Don't build sender flow. Blocks indefinitely on chained decisions.

**Recommendation: (a).** Reasoning:

1. **Real product to dogfood today.** John can use his own flex link end-to-end and shake out UX/copy/edge cases that no proposal will surface in advance.
2. **Aligns with SPEC §2.** "Sender never pays" is a load-bearing brand promise; (b) violates it even temporarily.
3. **Phase E swap is mechanical.** The UI doesn't change between (a) and Phase E — only the API contract on confirm. `buyLabel(..., { comp: true })` becomes `buyLabel(..., { payment_intent_id })` where the PI is captured server-side from the recipient's stored card. The step components stay identical.
4. **Risk surface is small.** Link creation is gated to John today (the `/login` + auth flow is live but only John has a flex link in production). Anyone else with a flex link in the next 2-4 weeks is by invitation. Free-shipping abuse is not a real risk in the pre-launch window. Cost ceiling: roughly $5-15 per real label John or invitees print.
5. **Reversibility.** The comp path is a single conditional at confirm-time. Swapping to PI-driven flow when Phase E lands is one function call.

**Caveats made explicit:**
- The `comp` flag is server-trusted today (anyone calling `/labels` with `comp: true` from the anon key currently bypasses payment). This must be gated to admin requests before the sender flow is wired up — otherwise any sender with a curl command can self-comp. See §3.5.
- Section 4.6 of the Stripe proposal makes carrier-rate-change exposure on flex links a real concern. Comp-only sidesteps the financial exposure (we eat 100%) but doesn't sidestep the operational exposure (no cap means someone could ship a $200 package). Hard cap enforced server-side: see §3.6.

### 2.2 5-step wizard structure

Matches SPEC §8 exactly. Step numbers are internal IDs, not displayed.

| Step | ID | What | Status today |
|------|-----|------|--------------|
| 0 | `intro` | "You're sending to {recipientName}" + insurance banner + "How it works" + Get Started CTA | **Missing** |
| 1 | `package` | Origin address + Magic Guestimator + packaging + dimensions + weight | Exists, needs split into clearer subsections + sticky destination card |
| 2 | `rates` | Carrier method selection (no prices shown; "Preferred by {name}" badge) | Exists; needs price-hiding on cards, preferred badge, fix copy ("Continue" not "Continue to confirm") |
| 3 | `review` | Package summary + method + email-for-tracking + checkboxes + Confirm-and-generate w/ AlertDialog | **Missing** |
| 4 | `done` | Success banner + label preview + Print PDF (largest button) + drop-off instructions | Placeholder; needs real EasyPost PDF + print CSS + drop-off copy |

Progress bar is non-clickable per SPEC §8 line 432.

### 2.3 File structure

Extract step components out of `SenderFlow.tsx` into `src/components/sender/`. Matches the established pattern from `src/components/recipient/`. Keeps `SenderFlow.tsx` as a state-machine + AnimatePresence wrapper, ~150 lines.

```
src/components/sender/
  SenderStepIntro.tsx        # NEW
  SenderStepPackage.tsx      # extracted from SenderFlow.tsx, lightly refactored
  SenderStepRates.tsx        # extracted, copy fixes + preferred badge
  SenderStepReview.tsx       # NEW
  SenderStepDone.tsx         # NEW (replaces placeholder)
  SenderProgressBar.tsx      # NEW — 5-dot progress, non-clickable
  senderState.ts             # NEW — shared types: SenderState, SenderStep
```

`SenderFlow.tsx` becomes the orchestrator (fetch link, state machine, AnimatePresence, error/loading states).

### 2.4 Label PDF & print

EasyPost returns `postage_label.label_url` (PDF) — already persisted to `shipments.label_pdf_url` via `admin_insert_shipment`. Step 4 renders:

- **Visual label preview card** — uses the URL as `<img>` (EasyPost serves PNG variants at `?format=png`) OR embeds the PDF in an iframe; iframe is more reliable cross-browser.
- **"Print Label" button (largest CTA on the page)** — opens `label_url` in a new tab; print CSS targets the print dialog via a dedicated print stylesheet:
  ```css
  @media print {
    @page { size: 4in 6in; margin: 0; }
    body * { visibility: hidden; }
    .label-print, .label-print * { visibility: visible; }
    .label-print { position: absolute; top: 0; left: 0; width: 4in; height: 6in; }
  }
  ```
  But since the actual label is a PDF served by EasyPost, the simpler pattern is: render a `<a target="_blank">` to the PDF and let the user's PDF viewer print. The 4×6 thermal-print CSS only applies if we want to print the SendMo preview page itself. Recommend the simpler PDF path; flagged as open question.
- **"Download PDF" secondary button** — `<a download href={label_url}>`.

### 2.5 Drop-off instructions

Static carrier→location strings, no API call. Three carriers + fallback:

| Carrier | Drop-off copy |
|---------|---------------|
| USPS | "Drop off at any USPS Blue Box, Post Office, or hand to your mail carrier." |
| UPS | "Drop off at any UPS Store, UPS Drop Box, or UPS Access Point. [Find a location ↗](https://www.ups.com/dropoff)" |
| FedEx | "Drop off at any FedEx location, FedEx Drop Box, or participating retailer. [Find a location ↗](https://www.fedex.com/locate)" |
| Other / fallback | "Drop off at any authorized {carrier} location." |

Plus universal reminder: "Tape the label securely to the largest flat side of the package. Cover any old shipping labels."

### 2.6 Email notifications

[labels/index.ts:367-410](supabase/functions/labels/index.ts) already sends the label-confirmation email to `recipient_email` when passed. **Privacy gap to fix:** the sender flow cannot pass the recipient's email — Rule 7 forbids exposing recipient PII to senders. The `links` GET endpoint correctly omits recipient_email today.

Two options:
- **(i)** Labels function looks up `recipient_email` server-side from `sendmo_links.user_id → profiles.email` when `link_short_code` is passed in the request. Sender client never sees it.
- **(ii)** Add a second notification trigger: separate `sendmo_links → profiles.email` lookup in labels function when neither `recipient_email` nor `sender_email` was passed but `link_short_code` was.

**Recommend (i).** Adds `link_short_code` to the `buyLabel()` body and to the labels function input; when present, the function joins `sendmo_links` + `profiles` server-side to find the owner's email and uses it as the recipient_email for the notification. The client never receives the email address.

Sender-side: Step 3 collects sender's own email; passed as `sender_email` to `buyLabel()`. The existing notification dispatcher ([_shared/notifications.ts](supabase/functions/_shared/notifications.ts)) already handles role-aware templates; no template change needed.

## 3. File-by-file plan

### 3.1 `src/components/sender/senderState.ts` (NEW)

```typescript
export type SenderStep = "intro" | "package" | "rates" | "review" | "done";

export interface SenderParcel {
  length: number;
  width: number;
  height: number;
  weightOz: number;        // canonical unit; UI converts from lbs
  description: string;
  packaging: "box" | "envelope" | "tube";
}

export interface SenderState {
  step: SenderStep;
  senderAddress: AddressInput;
  parcel: SenderParcel | null;
  rates: ShippingRate[];
  selectedRate: ShippingRate | null;
  senderEmail: string;
  saveInfo: boolean;        // localStorage opt-in
  shareContact: boolean;    // share name+email with recipient (default off per SPEC)
  // Phase 4 result fields
  labelUrl: string | null;
  trackingNumber: string | null;
  publicCode: string | null;
}
```

### 3.2 `src/components/sender/SenderStepIntro.tsx` (NEW)

Pure presentational. Props: `{ linkData: LinkData; onContinue: () => void }`.

```tsx
- Badge: "SendMo Label Link" (small pill, primary/10 bg)
- H1: "You're sending a package to {recipient_name}"
  - If no name: "You're sending a package via this prepaid link"
- P: city/state only ("Shipping to {city}, {state}") — never street/zip per Rule 7
- Insurance banner (conditional on linkData.notes containing "insurance" — flagged
  as open question, see §7; SPEC §8 says "conditional: green badge if recipient
  enabled protection" but LinkData has no insurance field today)
- "How it works" card with 3 numbered steps:
    1. Tell us about your package
    2. Choose a shipping method
    3. Print the label and ship — {recipient_name} already paid
- CTA: "Get Started" (full-width, primary, rounded-xl shadow-sm)
```

### 3.3 `src/components/sender/SenderStepPackage.tsx`

Mostly extracted from current `SenderStepPackage` in [SenderFlow.tsx:108-212](src/pages/SenderFlow.tsx). Additions:

- **Sticky top card** ("Shipping to {recipient_name} — {city}, {state}") so the destination is always visible while scrolling — matches SPEC §8 Step 1 "Destination display" and matches the equivalent sticky pattern from Step 10 of the recipient onboarding flow.
- **Origin address** — moves out of Step 0 (current code) into this step. SPEC §8 Step 1 has both origin + package in one step.
- **Packaging type 3-option grid** (currently missing): Box (default), Envelope, Tube. Hides Height field when Envelope is selected.
- **Item description** (optional text input) — wired to Magic Guestimator output.
- **Validation summary block** above the Continue button when `tried && hasErrors` — matches the "try-then-show" pattern from PLAYBOOK Design System.

### 3.4 `src/components/sender/SenderStepRates.tsx`

Extracted from current code, with these fixes:

- **Hide price on cards** per SPEC §8 Step 2 line 454 ("No pricing shown — recipient pays"). Today the code shows `{formatCents(rate.display_price_cents)}` prominently. Replace with carrier + service + delivery estimate only.
- **"Preferred by {recipient_name}" badge** on rates whose speed tier matches `linkData.preferred_speed`. Mapping: economy=usps_ground/ups_ground; standard=usps_priority/ups_3day; express=usps_priority_express/ups_2nd_day. Re-uses existing `pickRecommendedRate()` in `src/lib/api.ts` for the "default selection" logic.
- **Default-select first matching `standard` speed tier** on render.
- **Methods over price cap shown disabled** — already filtered server-side in [rates/index.ts](supabase/functions/rates/index.ts); the client just renders what comes back. Empty-result state is correct today.
- CTA copy: "Continue" → goes to Review step.

### 3.5 `src/components/sender/SenderStepReview.tsx` (NEW)

Per SPEC §8 Step 3:

- **Package summary card** with "Edit" button → `setStep('package')`. Shows: dimensions, weight, packaging type, description.
- **Shipping method card** with "Edit" button → `setStep('rates')`. Shows: carrier + service + delivery estimate. (No price visible.)
- **Email input**: "Get tracking updates" — `senderEmail`. Validated inline if non-empty (regex: `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`).
- **Checkboxes**:
  - "Save my information on this device" — checked by default; writes `{ senderAddress, senderEmail }` to `localStorage['sendmo:sender']` on confirm.
  - "Share my contact info with {recipient_name}" — unchecked by default. When checked, `sender_email` is passed to `buyLabel()`; when unchecked, only stored locally.
- **CTA**: "Confirm and generate label" — opens shadcn `AlertDialog` "Generate label for {recipient_name}?" → on confirm:
  1. Set `step='done'` immediately with a loading variant.
  2. Call `buyLabel(easypost_shipment_id, easypost_rate_id, fromAddress, toAddress, false, { sender_email: shareContact ? senderEmail : undefined, link_short_code: linkData.short_code }, { comp: true, display_price_cents: selectedRate.display_price_cents })`.
  3. On success, populate `labelUrl`, `trackingNumber`, `publicCode` from response and render the done content.
  4. On failure, render error state with retry + email-support fallback.

**Important — server-side comp gate (admin-or-flex-link override):**
The labels function today accepts `comp: true` from any anon caller. Before this flow goes live, [labels/index.ts:46](supabase/functions/labels/index.ts) must be tightened so `isComp` requires either:
- An admin JWT (re-use the new `requireAdmin` helper from migration 016 work), OR
- A valid `link_short_code` whose `sendmo_links.status = 'active'` and `link_type = 'flexible_link'`.

This is a server-side change scoped to this proposal — not the existing admin comp flow which already gates client-side via the floating toolbar. Without this fix, anyone with the function URL can mint free real labels.

### 3.6 Hard cap enforcement (server-side)

Belt-and-suspenders for the price-cap concern: even though [rates/index.ts](supabase/functions/rates/index.ts) filters by `max_price_cents`, the labels function must independently verify before buying:

```typescript
// In labels/index.ts, after link lookup (if link_short_code present):
if (link_short_code) {
  const { data: link } = await supabase
    .from('sendmo_links')
    .select('max_price_cents, status, link_type')
    .eq('short_code', link_short_code)
    .single();
  if (!link || link.status !== 'active') throw 403;
  if (link.link_type !== 'flexible_link') throw 403;
  if (display_price_cents > link.max_price_cents) throw 403;
}
```

This protects against: client-side cap bypass, race between rates and label purchase, and links being deactivated mid-flow.

### 3.7 `src/components/sender/SenderStepDone.tsx` (NEW)

```tsx
- Success banner (green/10 bg, CheckCircle2 icon): "Label ready!"
- Subtitle: "Print it, tape it to the package, and drop it off."

- Label preview card:
  - Dark header strip with "SendMo Label" + tracking number
  - <iframe src={labelUrl} title="Shipping label preview" />
    (iframe for cross-browser PDF rendering; alternative: <img> if EasyPost
    serves PNG variant — flagged in §7)
  - FROM / TO summary below (TO can show full address now — it's on the
    printed label anyway; this is the only point in the flow where Rule 7
    permits showing the recipient's street/zip)

- **Print CTA — largest button on the page** (text-lg py-4 px-8 shadow-md):
  <a href={labelUrl} target="_blank" rel="noopener noreferrer">
    <Printer /> Print Label (PDF)
  </a>

- Download PDF secondary button.

- Drop-off instructions card (carrier-specific copy, see §2.5).

- "Track this package" link → /t/{publicCode}.
- "Go to SendMo" → /.
```

### 3.8 `src/components/sender/SenderProgressBar.tsx` (NEW)

5 dots, current step highlighted in primary, completed steps filled, future steps muted. Non-clickable per SPEC §8 line 432. Hidden on intro step ("Get Started" is its own welcome moment).

### 3.9 `src/pages/SenderFlow.tsx` (REFACTORED)

Trims to ~150 lines. State machine + AnimatePresence + fetch link + error/loading. Imports all step components.

### 3.10 `src/lib/api.ts`

Extend `buyLabel()` signature:

```typescript
export async function buyLabel(
  easypostShipmentId: string,
  easypostRateId: string,
  from: AddressInput,
  to: AddressInput,
  liveMode: boolean = false,
  contacts?: { recipient_email?: string; sender_email?: string; link_short_code?: string },
  payment?: { payment_intent_id?: string; comp?: boolean; display_price_cents?: number },
): Promise<LabelResult>
```

Add `link_short_code` to the request body alongside existing contact fields.

### 3.11 `supabase/functions/labels/index.ts`

Three changes:

1. **Accept `link_short_code` in request body.** Use it to look up the link server-side, derive recipient_email from `sendmo_links.user_id → profiles.email`, and pass to the existing notification path. Sender client never sees recipient email.
2. **Tighten the `comp` gate** per §3.5 — `isComp` only allowed with valid admin JWT OR valid active flex-link.
3. **Server-side cap enforcement** per §3.6.

No migration needed; both checks use existing columns.

### 3.12 `src/App.tsx`

No change — route at `/s/:shortCode` already mounts `SenderFlow`.

## 4. Test plan

### 4.1 Unit (Vitest)

New tests in `tests/unit/sender/`:

- `SenderStepIntro.test.tsx` — renders recipient name; calls onContinue on CTA click.
- `SenderStepReview.test.tsx` — email regex validation; Edit buttons fire correct callbacks; AlertDialog opens on Confirm; localStorage write on `saveInfo`; `sender_email` only passed when `shareContact === true`.
- `SenderStepDone.test.tsx` — renders Print as largest button; drop-off copy matches selected carrier.
- `senderState.test.ts` — defaults match SPEC; localStorage round-trip.
- `pickRecommendedRate.test.ts` — extend existing tests to verify the "Preferred by name" badge logic via a small `isPreferredRate(rate, linkData)` helper.

Target: ~25 new unit tests.

### 4.2 E2E (Playwright)

New `tests/e2e/sender-flow.spec.ts`:

```
1. Seed: create a flex link via authenticated API call (John's account, test mode).
2. Visit /s/<short_code> as anonymous user.
3. Step 0: assert recipient name visible, address NOT visible. Click Get Started.
4. Step 1: fill origin address (test address). Fill package via Guestimator.
   Click Get shipping options.
5. Step 2: assert no prices visible. Assert "Preferred by" badge on standard
   rate. Click first rate. Click Continue.
6. Step 3: assert Edit buttons. Fill sender_email. Confirm checkbox state.
   Click Confirm and generate. Confirm AlertDialog.
7. Step 4: assert label PDF iframe loaded. Assert Print Label is the largest
   button (by computed font-size). Assert drop-off copy matches.
8. Verify shipment row in DB has correct comp payment_method.
```

Runs in test mode (EasyPost EZTK key); zero real money.

### 4.3 Type-check + lint

Per PLAYBOOK Rule 18: `npx tsc -b --noEmit && npm run lint` must pass before push.

### 4.4 Manual dogfood

John runs the full flow on his own flex link in **live comp** mode and prints a real EasyPost label to verify the PDF is physically printable on a 4×6 thermal printer (and a normal 8.5×11 printer scaled).

## 5. Out of scope

- **Real flex-link payment auth/capture.** That's the Stripe proposal's Phase E — blocked on Phase A which is blocked on §11 decision #4. Re-visited when those unblock.
- **Magic Guestimator improvements.** Reuses the existing `MagicGuestimator` component as-is.
- **Multi-link support, sender-saved-profiles, "ship again from this profile."** Phase 2+.
- **Sender QR-code / private shipment links.** Phase 3.
- **Insurance UI on the sender side.** Insurance is recipient-side per SPEC §13; sender doesn't choose. If `LinkData` exposes insurance preference in the future, Step 0 banner reflects it then.
- **Carrier-rate-change sweep-through.** Stripe proposal §4.6; relevant only once real money is in the flow.
- **Sender account creation / login.** Senders are anonymous per SPEC §17 line 815.

## 6. Verification

End-to-end dogfood pass after implementation, before merging to main:

1. **Pre-flight checks**:
   - `npx tsc -b --noEmit` clean.
   - `npm run lint` clean.
   - `npm run test:unit` all green.
2. **Test-mode flow**:
   - Spin up local dev server: `op run --env-file=.env.tpl -- npm run dev`.
   - Create a flex link as John via `/onboarding`.
   - Open the link in an incognito window.
   - Walk through all 5 steps with the standard EasyPost test addresses (PLAYBOOK lines 333-339).
   - Verify: PDF renders in Step 4; tracking page at `/t/<publicCode>` shows the shipment; `event_logs` has the expected `label.created` event with `link_short_code` property.
3. **Live-comp flow** (real label, no money charged to anyone):
   - Same path with admin toolbar flipped to Live Comp.
   - Print the real PDF on John's printer.
   - Verify drop-off copy matches the carrier on the label.
4. **Privacy verification**:
   - Inspect network tab in DevTools across all 5 steps. Confirm no response payload contains the recipient's `street1` or `zip`. The `/track/<publicCode>` page (already-shipped) and the printed PDF are the only places the full address appears.
5. **Cap enforcement**:
   - Create a flex link with `price_cap=$10`.
   - Use Postman/curl to call `/labels` directly with `display_price_cents=2000` and a valid `link_short_code` — expect 403.
6. **Negative paths**:
   - Visit `/s/INVALID` — error state renders.
   - Use an `expired` or `cancelled` link — 410 surfaces correctly.
   - Disconnect network mid-Confirm — retry button reappears, no partial shipment row.

## 7. Open questions for the reviewer

1. **Print path — PDF in iframe vs `<a target="_blank">` to PDF + thermal CSS?** EasyPost's PDF is the canonical artifact (4×6 already). Embedding an iframe is nicer UX but PDF rendering in iframes is inconsistent across browsers (Safari especially). The fallback "open PDF in new tab; user prints from PDF viewer" is more reliable but less polished. **Author lean:** iframe with `<a>` fallback link directly under it. Reviewer: pick.
2. **Insurance banner on Step 0 — what field drives it?** SPEC §8 says "green badge if recipient enabled protection." The current `LinkData` has no `insurance` field. Two options: (a) extend `LinkData` to include `insurance: 'none' | '100' | '300'` (column exists per SPEC §12; not currently selected by the GET handler) and gate banner on `insurance !== 'none'`; (b) drop the banner for now and revisit when insurance is part of the flex-link payment story (Phase E). **Author lean:** (a), 5-line change to [links/index.ts:32-44](supabase/functions/links/index.ts). Reviewer: confirm.
3. **Comp gate hardening — is the `link_short_code` path strict enough?** The §3.5 check rejects requests without admin JWT *and* without a valid active flex-link. A determined attacker who knows a real flex-link short_code could mint free real labels by crafting requests directly. Mitigations: the price cap server check (§3.6) limits per-label exposure to the cap value; the link's status can be revoked; rate-limiting on `/labels` by IP+link_id (already in SPEC §14 Rate Limits, 5/min). **Is this enough for the John-only pre-launch window?** Or should every comp label require John's explicit admin JWT (forcing John to be logged in to dogfood his own link)?
4. **"Share contact info" checkbox default — unchecked per SPEC, but does that mean recipient never gets sender's email even for the label-confirmation email?** SPEC §8 Step 3 defaults the share-contact checkbox to off, but SPEC §16 says label-created email goes to "Recipient + Sender." Interpretation: the sender_email is *always* used for the sender's own tracking email; "share contact info" only controls whether the recipient sees the sender's name/email in their dashboard/email. Author plan matches this read. Reviewer: confirm or correct.

## 8. Reconciliation with prior decided proposals

- **[2026-04-26 Stripe integration plan (decided 2026-05-11)](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md).** This proposal explicitly defers Phase E (flex-link auth/capture) and routes around it with comp-only. When Phase E lands, the only file in this proposal's surface that changes is `SenderStepReview.tsx` — `comp: true` becomes `payment_intent_id`. No schema impact; no other UI surface changes. The §11 #2 decision (flat $1 surcharge) is already live in [rates/index.ts](supabase/functions/rates/index.ts) — the sender-side prices reflect it transparently because the sender doesn't see prices at all. The §11 #5 decision (role-based admin auth) shipped in commit `f137b06`; this proposal re-uses the `requireAdmin` helper from migration 016 work for the comp-gate fix.
- **[2026-04-26 Links manager (decided 2026-04-26)](proposals/2026-04-26_links-manager_reviewed-2026-04-26_decided-2026-04-26.md).** That proposal extracts step components from the recipient onboarding wizard into reusable presenters. This proposal mirrors the pattern on the sender side. No file overlap; pattern parity.
- **[2026-05-11 SendMo public tracking code (decided 2026-05-11)](proposals/2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md).** The Step 4 "Track this package" link uses the new `/t/<publicCode>` URL contract. No change required here — `buyLabel()` already returns the public_code via the response (see labels/index.ts post-RPC `.then()` callback at line 347-360).

## Review

**reviewer:** Claude (Opus 4.7) — fresh-eyes reviewer session
**reviewed_at:** 2026-05-11 18:08
**verdict:** approve-with-changes

### Summary

The 5-step structure, the comp-only routing decision, and the recognition that the comp gate must be tightened are all sound — this is the right call given the Stripe Phase A/E blocked-on-#4 reality. But several of the load-bearing claims in §3 and §8 are inconsistent with the actual code at HEAD: the labels function doesn't return `public_code` to the client (proposal §8 says it does), `link_type` in the DB is `'flexible'` not `'flexible_link'` (proposal §3.5 would reject every valid flex link), and the sender client never has the recipient's `street1` (proposal §3.7 plans to display "TO full address" client-side, which it cannot). There's also a coordination problem with the decided Stripe Phase A that the proposal doesn't acknowledge: Phase A's gating criterion is **zero `payments.insert` references**, but this proposal extends the comp path on top of those very inserts. Fixable, but worth surfacing now rather than at merge.

### Blocking issues

1. **`link_type` mismatch — §3.5 cap/comp gate will reject every real flex link.**
   - **Location:** Proposal §3.5 / §3.6 cap-enforcement snippet: `if (link.link_type !== 'flexible_link') throw 403;`
   - **Issue:** [`supabase/functions/links/index.ts:189`](supabase/functions/links/index.ts) inserts `link_type: "flexible"` (no `_link` suffix). The migration-001 CHECK constraint on `sendmo_links.link_type` is presumably `'flexible' | 'full_label'`. With the proposal's check as written, no flex link in the DB matches, every `/labels` call from sender flow returns 403, and the sender flow is dead on arrival in QA.
   - **Suggested fix:** Either change the check to `link.link_type !== 'flexible'` (lower-friction, matches existing data) or audit the schema CHECK constraint and decide whether to migrate to `'flexible_link'` (higher friction, would need a migration + data backfill + every existing reference updated). Verify by running `select distinct link_type from sendmo_links;` on prod before writing the gate.

2. **labels function doesn't return `public_code` to the client.**
   - **Location:** §3.5 step 3 ("On success, populate `labelUrl, trackingNumber, publicCode` from response"); §8 last bullet ("`buyLabel()` already returns the public_code via the response").
   - **Issue:** [`supabase/functions/labels/index.ts:540-548`](supabase/functions/labels/index.ts) returns only `{ tracking_number, label_url, carrier, service }`. The `public_code` is logged inside the fire-and-forget `.then()` callback (line 349, 359) but never reaches the response body. The DB insert is also fire-and-forget — by the time the labels function returns, the shipment row may not yet exist, so even a follow-up `?code=` lookup isn't reliable.
   - **Suggested fix:** As part of this proposal, await the RPC and add `public_code` to the response payload. This is a small change but it's a real shape change to the labels function contract, not the "no other UI surface changes" framing in §8. The Stripe Phase A round-2 B2 decision is already to remove the fire-and-forget pattern from labels — this proposal can ride along on that change, but it must own it explicitly.

3. **Sender client has no `street1` for the recipient — §3.7 "TO can show full address" is not implementable client-side.**
   - **Location:** §3.7 SenderStepDone, "FROM / TO summary below (TO can show full address now)".
   - **Issue:** [`links/index.ts:78-94`](supabase/functions/links/index.ts) deliberately strips `street1` and returns only city/state/zip per Rule 7. The sender flow's `fetchSenderRates` even passes a `to` object without street1 ([`SenderFlow.tsx:401-407`](src/pages/SenderFlow.tsx)). Once `buyLabel()` is wired up, the proposal hasn't said where the full `to_address` (required by the labels function for `admin_insert_shipment`) comes from. Two real options: (a) labels function does the lookup server-side from `link_short_code` and never returns street1 — the printed PDF is the only place the address appears (matches Rule 7); (b) labels function returns the resolved `to_address` in the response for display purposes (Rule 7 says "until label is printed" — this is the printed state, so arguably allowed, but it's a privacy-policy call worth surfacing). Pick one explicitly.
   - **Suggested fix:** Recommend (a). Update §3.7 to drop the "TO full address" display from SenderStepDone — show city/state only, point to the printed label for the full address. Update §3.11 to add: "labels function resolves `to_address` server-side from `link_short_code` when present; client-supplied `to_address` is ignored if `link_short_code` is provided." This also closes a separate attack surface where the sender could buy a label to a different address than the recipient set.

4. **Drift collision with Stripe Phase A's "zero `payments.insert`" gate.**
   - **Location:** §8 Reconciliation says "No schema impact; no other UI surface changes." But the comp path this proposal extends is the same `payments.insert({ payment_method: 'comp' })` block at [`labels/index.ts:494-526`](supabase/functions/labels/index.ts) that the **decided** Stripe proposal §6 Phase A explicitly removes (round-2 B2: "After migration 012 ships, zero `payments.insert` references remain in the codebase — that's a Phase-A gating criterion").
   - **Issue:** This proposal sequences the sender flow *before* Phase A migration 012 lands (which is reasonable — Phase A is blocked on #4 account-timing research). But it doesn't acknowledge that when Phase A *does* land, the comp ledger move will silently regress every comp-path test the sender flow shipped with, unless the sender-flow tests are written against the abstraction (not the concrete `payments` row shape).
   - **Suggested fix:** Add a one-line acknowledgement in §8: "Comp-path persistence is read-only from this proposal's perspective — when Stripe Phase A migration 012 replaces `payments.insert(payment_method='comp')` with `transactions.insert(type='comp_grant')`, the sender flow inherits the change without UI work. Tests assert on label-creation success + email send, not on `payments` row shape." If §4.1 / §4.2 tests inspect the `payments` row directly, they need to be written to be moved alongside the ledger.

5. **Cap-bypass via client-supplied `display_price_cents`.**
   - **Location:** §3.6 snippet: `if (display_price_cents > link.max_price_cents) throw 403;`
   - **Issue:** `display_price_cents` is supplied by the client in the labels request body. A malicious sender can pass `display_price_cents: 500` while purchasing a real rate that costs $50. The proposal's own §2.1 caveat ("doesn't sidestep the operational exposure (no cap means someone could ship a $200 package)") flags this. Trusting client-supplied price for the cap check defeats the cap.
   - **Suggested fix:** Re-derive `display_price_cents` server-side from the `easypost_rate_id` (which EasyPost can resolve via `GET /v2/rates/{id}`) before the cap comparison — the rates function already does this math at [`rates/index.ts:146`](supabase/functions/rates/index.ts). Better: the labels function calls the same EasyPost rate lookup it would use for the buy, applies the markup formula, then compares. Closes the loophole and also eliminates the "EasyPost rate shifts between rate fetch and label buy" race that §3 hand-waves.

### Non-blocking concerns

- **§3.5 comp-gate "admin JWT OR valid active flex-link" is acceptable for the John-only pre-launch window, but the threat model deserves to be written down.** Anyone who guesses or scrapes a real `short_code` (10 chars, ~5.9×10^17 keyspace — fine in isolation, but link codes appear in URLs that get screenshotted, shared, indexed) can mint free real labels up to the cap value. The mitigations (cap, rate-limit at SPEC §14 5/min, link status revocable) are real but the cumulative exposure isn't zero. For pre-launch dogfood this is fine; before any link goes to a non-invited party, the gate should harden to admin-only OR add per-link daily count limits. Worth a sentence in §5 ("out of scope until Phase E").

- **localStorage `sendmo:sender` key — what's the schema, and what happens when it goes stale?** §3.5 writes `{ senderAddress, senderEmail }` but doesn't version it. If a future change adds a field, the read path needs a graceful fallback. Small, but the Inbox-Zero / pre-launch pattern is "version your localStorage from day one or regret it in 3 months."

- **§2.5 drop-off carrier strings are static, but `linkData.preferred_carrier` is optional.** What if the rate selected at Step 2 is `UPS Ground` but `linkData.preferred_carrier` was `usps`? The drop-off copy should be keyed off the **selected rate's carrier**, not the link's preferred carrier. Verify the implementation pulls from `selectedRate.carrier`, not `linkData.preferred_carrier`.

- **§4.2 E2E test misses the cap-bypass path.** §6 mentions cap enforcement via curl, which is good. But the E2E should also include the "tampered display_price_cents" path (related to blocking #5). One Playwright `page.route()` intercept that mutates the buyLabel body proves the server check holds.

- **Email rate-limiting test absent.** SPEC §14 has rate limits on `/labels` (5/min, IP + link_id). The test plan doesn't verify they fire. Not a blocker for ship, but the comp-only world means a buggy client retry loop could rack up real EasyPost charges on John's account before rate-limit kicks in.

- **Insurance banner open question (§7 #2) — author's lean (a) requires changing the links GET handler to expose `insurance`.** That's a public endpoint change. Worth checking the existing `LinkData` consumers (Dashboard, RecipientFlowSummary, etc.) won't break on the new field. Probably fine since it's additive, but flag.

### Nits

- §3.4 says "Default-select first matching `standard` speed tier on render." There's already a `pickRecommendedRate()` in `src/lib/api.ts` (referenced in §3.4). Re-use it; don't write a parallel selector. PLAYBOOK Rule 6 (global): "extend, don't invent."
- §3.7 "the only point in the flow where Rule 7 permits showing the recipient's street/zip" — Rule 7 wording is "Never show recipient's address in sender UI" full stop, no "until printed" carve-out. The carve-out is implicit (the PDF is the address) but the proposal asserts an explicit one. Either tighten the language to "on the printed PDF only, never in the SendMo UI text" or get John to confirm the carve-out is intentional.
- §3.7 iframe + the 4×6 print CSS in §2.4 are mutually exclusive: if the print path is "user prints from the PDF viewer that opened in a new tab," the `@page` rules in the SendMo app's CSS never fire (they apply to the SendMo page, not the PDF). The CSS is dead code in the recommended path. Drop §2.4's CSS block to avoid future-agent confusion.
- §3.5 `link_short_code` is added to `buyLabel()` body, but §3.10 signature still groups it under `contacts` (`{ recipient_email?; sender_email?; link_short_code? }`). `link_short_code` isn't a contact — it's an authorization claim. Move to a new arg or rename the group.
- §6.4 "Disconnect network mid-Confirm — retry button reappears, no partial shipment row" — possible only if the labels function is idempotent on `easypost_shipment_id`. EasyPost's `/buy` is idempotent server-side (a second buy with the same rate just returns the existing label), but the local `admin_insert_shipment` RPC will create a duplicate shipment row. Worth verifying or fixing.
- Proposal commits to `tsc -b --noEmit` (§4.3 explicitly cites PLAYBOOK Rule 18). It does **not** explicitly commit to writing a LOG.md entry on merge (PLAYBOOK Rule 17). Add one line in §6 ("on merge, LOG entry per Rule 17, cross-linking this proposal filename per the LOG cross-linking convention").

### Predicted pitfalls

1. **The `link_type = 'flexible_link'` typo ships, every sender flow returns 403, John can't dogfood his own link.** Mirrors the 2026-05-10 `verify_jwt` regression (LOG entry "[2026-05-10] Edge Function deploys: always pass `--no-verify-jwt`...") — a single mismatched string between code and config silently breaks the entire path, with a confusing error surface (sender sees generic failure, not "link rejected"). The 2026-05-11 LOG entry on `verify_jwt` recurrence on `tracking + webhooks` is the same pattern: code looks right, runtime says no. Mitigation: schema-derived constants, not hand-typed string literals. R-class: string-literal-vs-DB-enum drift.

2. **Cap-bypass via client-supplied `display_price_cents` lets a curl attacker mint a $50 label against a $10-cap link.** This is the same class as the 2026-05-11 "Role-based admin auth" LOG entry — client-side gate was theater; server didn't enforce. The proposal recognizes the *category* (§2.1 caveats client-trust) but the §3.6 implementation falls back into trusting `display_price_cents` from the body. Recurrence of R: "decisions derived from client state, not server state" — explicitly PLAYBOOK Rule 14 ("ALWAYS derive critical decisions (pricing, refund eligibility...) from server-side state").

3. **Fire-and-forget `admin_insert_shipment` + the new email-on-public_code path means the labels-function response returns before the shipment row exists, so the client can't reliably load `/t/<publicCode>` from Step 4.** Same Deno-fire-and-forget pattern flagged in the 2026-04-26 notification incident LOG entry ("notification system silently 100% broken — three independent bugs") and re-flagged in the 2026-05-11 tracking-code LOG entry ("every `.then()` callback on a Supabase write in a Deno Edge Function is a potential fire-and-forget hazard if Deno terminates the request before the promise resolves"). The proposal's §3.7 "Track this package" link will intermittently 404 in production until the user reloads — and the public_code isn't even returned, so the link can't be built without an extra lookup. Mitigation: await the RPC, return `public_code` in the response, then send the email. The decided Stripe proposal already requires this change in Phase A B2 — this proposal can land it now.

4. **Step 4 mobile Safari PDF-in-iframe falls back to "Safari opens PDF, user taps Back, SenderFlow state is gone, label disappears."** Not from a prior LOG entry but well-documented mobile-Safari behavior. The proposal flags this as open question #1 but recommends iframe-with-fallback. Mobile Safari is the modal device for the John-dogfood path (link clicked from text message). Recommend the simpler `<a target="_blank">` to the PDF as primary, drop the iframe entirely. Lose a little polish, gain "actually works the first time."

5. **The proposal's "Phase E swap is mechanical, one function call" framing under-counts the swap.** When Phase E lands, the labels function changes shape (B2 already-decided: `payments.insert` → `transactions.insert`, schema migration 012 lands, comp path moves off `payment_method`). The sender flow's test suite is the canary — if §4.1 tests assert `payments.payment_method === 'comp'`, those tests will be the surface that breaks on Phase A merge, not the UI. Write tests against label-success behavior, not row shape.

### What the proposal got right

- **Picking comp-only over wait-for-Phase-E is the right call.** The dependency chain on Stripe #4 is real; waiting blocks the dogfood goal indefinitely. The reasoning in §2.1 is honest about the tradeoffs.
- **Recognizing that the existing `comp: true` gate is broken** (§3.5) and scoping the fix into this proposal rather than leaving it for "later." Anyone with the function URL minting free labels is a real exposure the Stripe proposal hadn't yet closed.
- **Server-side recipient_email lookup via `link_short_code`** (§2.6 option (i)) keeps Rule 7 intact and is architecturally cleaner than threading the email through the client. Right instinct.
- **Five-step structure matches SPEC §8 exactly**, including the non-clickable progress bar and the Step 0 intro that's been missing. Resists the temptation to "improve" the spec.
- **Out-of-scope list is appropriately disciplined** — no scope creep into sender accounts, multi-link, QR codes, or insurance UI.
- **Cross-references to prior decided proposals (§8)** are present, even if the Stripe-Phase-A coordination point in blocking #4 is under-noted. The structural acknowledgement is there.
- **Drop-off copy as static strings, not an API** — right tradeoff for v1 (lower latency, no failure mode, easy to maintain).

## 9. Author response

**author response:** Claude (Opus 4.7) — original SendMo session
**responded_at:** 2026-05-11 18:30

Every finding holds up against the code. Accepting all five blocking issues, all six non-blocking, all five nits, and all five predicted pitfalls. No tradeoffs for John — the review is correct on the substance, and the resulting plan is strictly better. Concrete fold-in below; the proposal body remains as drafted, but §3, §6, and §8 are amended via this response.

### Blocking issues

**B1. `link_type` mismatch (`'flexible'`, not `'flexible_link'`) — ✅ accept.**
Verified via [`links/index.ts:189`](supabase/functions/links/index.ts). Update §3.5/§3.6 snippets to `link.link_type !== 'flexible'`. Before merge, the implementer will run `select distinct link_type from sendmo_links` against the real DB to confirm the universe of values; the gate is implemented against that observed set, not a hand-typed literal. The reviewer's R-class framing (string-literal-vs-DB-enum drift) is the right lens — adding a follow-up wishlist item to migrate `link_type` values to a shared TS enum derived from the DB CHECK constraint, but out of scope here.

**B2. labels function doesn't return `public_code` — ✅ accept.**
Verified via [`labels/index.ts:540-548`](supabase/functions/labels/index.ts) (response shape) + line 297 (fire-and-forget `.then(...)`). Scope expansion: this proposal now owns awaiting the `admin_insert_shipment` RPC and returning `public_code` + `shipment_id` in the labels response body. This aligns with Stripe Phase A's round-2 B2 ("zero `payments.insert` references after migration 012") — landing the `await` change here lets Phase A pick up the discipline without coordination cost. The Predicted-Pitfall-3 fire-and-forget recurrence (2026-04-26 notification incident + 2026-05-11 tracking-code re-flag) is exactly what this prevents.

**B3. Sender client has no `street1` — ✅ accept. Adopt option (a): server-side `to_address` resolution.**
Verified via [`links/index.ts:78-94`](supabase/functions/links/index.ts) (strips street1) + [`SenderFlow.tsx:401-407`](src/pages/SenderFlow.tsx) (passes `to` without street1). The proposal's §3.7 "TO full address" display is dropped — Step 4 shows only city/state in the SendMo UI, with the printed PDF as the only surface that carries the full address. The labels function additionally adopts the "server-side resolves `to_address` from `link_short_code` when present; client-supplied `to_address` is ignored if `link_short_code` is provided" rule. This is strictly better than the original plan: it closes an attack surface where a sender could swap addresses, and it aligns the recipient_email lookup (already server-side per §2.6) with the to_address lookup (now server-side too).

**B4. Drift collision with Stripe Phase A's "zero `payments.insert`" gate — ✅ accept.**
Verified the gate at [`2026-04-26_stripe-integration-plan...md` §6 Phase A B2](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md). Sender flow tests are rewritten against label-creation behavior (label_url returned, public_code returned, email send queued, drop-off copy keyed to selected rate) — never against `payments` row shape. §4.1 unit tests already follow this; §4.2 E2E will assert on the response payload + `event_logs.label.created` event, not on `select * from payments`. §8 reconciliation gains a one-liner: "Comp-path persistence is read-only from this proposal's perspective; when Phase A migration 012 replaces `payments.insert(payment_method='comp')` with `transactions.insert(type='comp_grant')`, the sender flow inherits the change without UI work."

**B5. Cap-bypass via client-supplied `display_price_cents` — ✅ accept. Server re-derives from EasyPost rate.**
Real PLAYBOOK Rule 14 violation. Fix: in the labels function, after the `link_short_code` lookup and before the EasyPost buy, fetch the rate via `GET /v2/rates/{easypost_rate_id}` (or read it back off the `selected_rate` from the shipment object the buy returns and gate *post-buy* with auto-void if cap-exceeded — slightly worse but avoids an extra API call). Apply the same `rate * 1.15 + $1.00` formula from [`rates/index.ts:5-6`](supabase/functions/rates/index.ts). Compare server-derived display price to `link.max_price_cents`. Client-supplied `display_price_cents` is used only for the audit log; the gate decision is server-derived. This also closes the "rate shifts between fetch and buy" race the original §3 hand-waved.

### Non-blocking concerns

- **Comp-gate threat model written down — ✅ accept.** Adding a paragraph to §5 ("out of scope until Phase E") naming the pre-launch window assumption: comp-gate is admin-JWT OR active-flex-link; before any link goes to a non-invited party, the gate hardens to admin-only OR adds per-link daily count limits. Out of scope for this proposal but flagged.
- **localStorage versioning — ✅ accept.** Storage key becomes `sendmo:sender:v1` with `{ version: 1, ... }` payload; reads tolerate a missing/mismatched version by returning `null`. Three lines of code, prevents a 3-month-out regret.
- **Drop-off carrier keyed to selected rate, not link preference — ✅ accept.** §2.5 is amended: `dropOffCopy(selectedRate.carrier)`. Implementation already had this implicitly; making it explicit in the proposal.
- **E2E cap-bypass test — ✅ accept.** Add to §4.2: a Playwright `page.route()` test that intercepts the `buyLabel` request and tampers `display_price_cents` upward — assert 403.
- **Email rate-limiting test — ✅ accept.** Add to §4.2: a test that calls `/labels` 6× in rapid succession against the same link_id, asserts the 6th gets 429.
- **Insurance banner LinkData additive change — ✅ accept.** Verified consumers of `LinkData`: `SenderFlow`, `Dashboard`, `MyLinksList` (planned, not shipped per links-manager proposal). All read fields by name; new optional `insurance` field is non-breaking. Implementation pulls from `sendmo_links.insurance` column already existing per migration 001 / SPEC §12.

### Nits

- **Re-use `pickRecommendedRate()` — ✅ accept.** §3.4 already names it; implementation extracts a small `isPreferredRate(rate, linkData)` helper that wraps it for the "Preferred by" badge logic. No parallel selector.
- **Rule 7 carve-out language — ✅ accept and moot.** Now that B3 drops the "TO full address" UI display, the SendMo UI never shows the recipient's street/zip. The PDF is the only address surface. The proposal text is amended to match.
- **§2.4 print CSS block is dead code — ✅ accept, drop the block.** Combined with Predicted-Pitfall-4 (mobile Safari), the print path becomes `<a href={labelUrl} target="_blank" rel="noopener noreferrer">` as primary, plus a "Download PDF" secondary. No iframe, no print CSS, no SenderFlow-side print stylesheet. Step 4 layout shifts slightly: the label preview becomes a static page-thumbnail (EasyPost serves PNG via `?format=png` query — verified). The "Print Label (PDF)" button opens the PDF in the user's PDF viewer, which handles printing reliably across desktop + mobile Safari.
- **`link_short_code` separation from contacts — ✅ accept.** `buyLabel()` signature becomes:
  ```typescript
  export async function buyLabel(
    easypostShipmentId: string,
    easypostRateId: string,
    from: AddressInput,
    to: AddressInput,  // pass empty/minimal when link_short_code provided; server resolves
    liveMode: boolean = false,
    contacts?: { sender_email?: string; recipient_email?: string },
    link?: { short_code?: string },
    payment?: { payment_intent_id?: string; comp?: boolean; display_price_cents?: number },
  ): Promise<LabelResult>
  ```
- **Idempotency on `admin_insert_shipment` — ✅ accept.** Implementer verifies idempotency before merge. If the RPC doesn't have a UNIQUE constraint on `easypost_shipment_id`, add one (cheap) and treat duplicate as no-op. The EasyPost `/buy` side is already idempotent; this just closes the DB side.
- **LOG entry commit (Rule 17) — ✅ accept.** §6 gains: "On merge, write a LOG.md entry per PLAYBOOK Rule 17, cross-linking this proposal filename per the LOG cross-linking convention in PROPOSAL-REVIEW-PROTOCOL.md."

### Predicted pitfalls — response

1. **`link_type` typo silently breaks every flow** — folded into B1.
2. **Cap-bypass via client-supplied price** — folded into B5.
3. **Fire-and-forget RPC + missing `public_code` in response** — folded into B2. The bigger win the reviewer surfaced: this proposal can land the `await` discipline that Phase A B2 also requires, without coordination cost.
4. **Mobile Safari iframe regression** — folded into the §2.4 / §3.7 nit acceptance. New plan: `<a target="_blank">` primary, no iframe. Lose 5% polish, gain "works on the device most likely to be John's dogfood entry point."
5. **Phase E swap brittleness via test row-shape assertions** — folded into B4.

### Status

No unresolved disagreements; no "## Tradeoffs for John" section needed. The amended plan is strictly better than the draft. Bringing to John for decision with the recommendation: **approve.** On approval, implementation begins; the response above is binding on the implementation (i.e., the implementer treats B1-B5 + the nits as part of the spec, not as optional follow-ups).

Frontmatter: `status: revised`. Reviewer + author both recommend approve. If John signs off, file renames to `..._reviewed-2026-05-11_decided-2026-05-11.md` and the implementation phase begins.

## 10. Decision

**John, 2026-05-11:** approved.

Approving the revised plan (sections 1–7 as drafted + author response in §9 as binding spec). Implementation begins immediately. Author response's B1–B5 plus all accepted nits + non-blocking concerns are part of the spec, not optional follow-ups. On merge, LOG.md entry per Rule 17 cross-linking this filename.

---

## 11. Round 2 — Post-label shipment page (proposed 2026-05-11 evening)

**author response:** Claude (Opus 4.7) — same SendMo session
**proposed_at:** 2026-05-11 20:00
**scope:** UX extension on top of the now-shipped sender flow. Not a re-architecture; promotes an existing surface (`/t/<public_code>`) to be the canonical post-generation page.

### Context

After Round 1 shipped, John dogfooded the flow end-to-end successfully. Three pieces of feedback surfaced:

1. **Per-label URL gap.** The "Done" step is component-state only — bookmark `/s/<short_code>` and you start over. Each label should have a stable URL the sender can return to.
2. **Tracker widget belongs on top.** The label's lifecycle (Label created → In transit → Out for delivery → Delivered) is the most useful information *after* the print step.
3. **Ship-again upsell.** Once a sender has shipped once, "Ship another package to the same recipient" is a near-zero-friction repeat action.

John's directional decisions (2026-05-11 evening):
- Link owner sees print/download on `/t/<code>` too (useful for reprinting if the sender lost the PDF). ✅
- Dashboard rows link to `/t/<code>` per shipment — already do; confirmed as the right destination after this change. ✅
- "Ship again to same recipient" CTA on the shipment page — explicit upsell flavor. ✅

### Architecture

**Promote `/t/<public_code>` to be the shipment page** instead of a tracking-only page. After label generation, sender's URL is replaced via `history.replaceState` from `/s/<short_code>` to `/t/<public_code>?fresh=1`. The same page renders for:
- Sender (just generated the label) — sees celebration banner + print + drop-off + tracker
- Sender returning later — same page minus celebration banner; print/drop-off auto-hide once `status !== 'label_created'`
- Recipient (link owner) viewing from Dashboard — same page, no celebration banner
- Anyone with the link (status visibility) — tracker + carrier deep link only

Single page, four viewer states. Cleaner than maintaining two parallel pages.

### Sections (top to bottom on `/t/<public_code>`)

1. **Lifecycle tracker (hero)** — 4-step visual: `Label created → In transit → Out for delivery → Delivered`. Current step highlighted; ETA + delivery-performance badge (the existing ✨/🎯/🐢 from 2026-05-11) docked here.
2. **Label section (conditional)** — visible when `status === 'label_created'`:
   - Label preview thumbnail (PNG via EasyPost `?format=png`)
   - Primary CTA: **Print Label (PDF)** — largest button, opens PDF in new tab
   - Secondary: **Download PDF**
   - Single-use note: *"This label is single-use. Duplicates are rejected by the carrier."*
3. **Drop-off (conditional)** — visible when `status === 'label_created'`. Same carrier-keyed copy as today's `SenderStepDone`.
4. **Ship again CTA (conditional)** — visible when the viewer is a sender (detected via `localStorage["sendmo:sender:v1"]` presence). One-line invitation: *"Ship another package to {recipient}?"* → links to `/s/<short_code>` with localStorage already pre-filling sender details. Hidden for recipients (Dashboard already has the link CTA elsewhere).
5. **Shipment summary** — From/To/Service/Tracking — existing content, unchanged.
6. **Existing tracker UI** — keep as fallback when label section is hidden; useful for the "package is in transit" state.

### File-by-file plan

- **New: [src/components/tracking/ShipmentLifecycleCard.tsx](src/components/tracking/ShipmentLifecycleCard.tsx)** — 4-step lifecycle component. Props: `{ status, createdAt, shippedAt, deliveredAt, eta, promisedDeliveryDate }`. Pure presentational.
- **New: [src/components/tracking/ShipmentLabelSection.tsx](src/components/tracking/ShipmentLabelSection.tsx)** — extracted from current `SenderStepDone`. Renders only when `status === 'label_created'`. Print + Download + drop-off + single-use note.
- **New: [src/components/tracking/ShipAgainCTA.tsx](src/components/tracking/ShipAgainCTA.tsx)** — conditional CTA card. Reads `localStorage.sendmo:sender:v1`; only renders if present and the sender flow's `short_code` is known (from the shipment's link).
- **Modify: [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx)** — compose the new sections. Read `?fresh=1` once on mount, strip it via `history.replaceState`, show celebration banner. Pull `short_code` from the tracking response for the ship-again CTA.
- **Modify: [src/pages/SenderFlow.tsx](src/pages/SenderFlow.tsx)** — `handleConfirm` success path: instead of `setStep("done")`, `navigate('/t/' + publicCode + '?fresh=1', { replace: true })`. The "done" branch can be removed.
- **Modify: [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts)** — extend response to include `label_url`, `link_short_code`, and the status/timestamps the lifecycle card needs (most are already there).
- **Delete: [src/components/sender/SenderStepDone.tsx](src/components/sender/SenderStepDone.tsx)** — no longer routed. Inline its content into `ShipmentLabelSection` (composed of the same parts).

### Privacy / abuse

- `public_code` (7-char Crockford base32, ~3.4×10¹⁰ keyspace) remains the only auth signal — same as today's `/t/<code>`. Not guessable.
- Print/Download exposed to anyone with the URL. Risk: duplicate-label printing. Mitigation: (a) the single-use note, (b) auto-hide once `status !== 'label_created'`, (c) carriers reject duplicate scans. Acceptable risk for the pre-launch window.
- Recipient's full address is on the PDF — same surface as today's `SenderStepDone`. No new exposure.

### Test plan

- **Unit (Vitest):**
  - `ShipmentLifecycleCard` renders the correct active step for each of the 5 status values (`label_created`, `in_transit`, `out_for_delivery`, `delivered`, `cancelled`/`return_to_sender`).
  - `ShipmentLabelSection` is hidden when `status !== 'label_created'`.
  - `ShipAgainCTA` is hidden when `localStorage.sendmo:sender:v1` is absent.
  - `?fresh=1` strips from the URL after first render.
- **E2E** — still deferred per Round 1 deferral; folded into the dogfood pass.

### Out of scope

- Auth gating beyond `public_code` (would change `/t/<code>` privacy contract; separate proposal if it ever becomes warranted).
- "Resume incomplete sender flow" — different problem (mid-flow bookmark of `/s/<short_code>` doesn't resume).
- Server-side schema/migration changes — the existing `shipments` columns (`status`, `shipped_at`, `delivered_at`, `eta`, `promised_delivery_date`) already cover the lifecycle card's needs.
- Webhook changes — EasyPost webhooks already populate the relevant status transitions.

### Verification

1. Generate a real label via the sender flow. After Confirm, the URL becomes `/t/<code>?fresh=1`, celebration banner shows, fresh param strips on next render.
2. Reload `/t/<code>` — same page minus banner; print/drop-off still visible.
3. Trigger an EasyPost test-mode webhook to flip `status` to `in_transit`. Reload — label section + drop-off auto-hide; lifecycle card advances.
4. Verify Dashboard row → `/t/<code>` lands on the same page (no celebration; print visible per question #1).
5. Visit `/t/<code>` in incognito (no localStorage) — Ship-again CTA absent.
6. Visit `/t/<code>` in the browser where the sender flow ran — Ship-again CTA present, links to `/s/<short_code>` with address pre-filled.
7. `npx tsc -b --noEmit` clean; new unit tests green.

### Open questions for the reviewer

1. **`?fresh=1` vs sessionStorage** for the celebration banner. Query param is debuggable + testable but creates an ugly URL for ~1 paint cycle. SessionStorage is cleaner but harder to verify in E2E. **Author lean:** query param.
2. **Ship-again CTA visibility heuristic.** Currently proposed: shown iff `localStorage.sendmo:sender:v1` is present. But this misses the case where the sender clicked "Save my info" off — they'd never see the CTA. **Author lean:** also show it if `?fresh=1` is in the URL (i.e., immediately after generation). Reviewer: pick.
3. **Auto-hide threshold for the label section.** Proposed: hide when `status !== 'label_created'`. But there's a real failure mode where the carrier hasn't scanned yet but the package is on its way — sender might still need to reprint. **Author lean:** keep visible until `shipped_at IS NOT NULL`; hide thereafter. Reviewer: confirm.
4. **Should the Round-2 work be a separate proposal file**, or this append? Appending keeps the history together (Round 1 was a 5-step wizard, Round 2 is "where senders end up after"). Either is fine — flagging because the protocol's filename convention assumes one decision per file.

## 12. Review — Round 2

**reviewer:** Claude (Opus 4.7) — fresh-eyes reviewer session, Round 2
**reviewed_at:** 2026-05-11 20:45
**verdict:** approve-with-changes

### Summary

Promoting `/t/<public_code>` from "tracking-only" to "the shipment page" is the right architectural call — one URL per shipment beats two parallel surfaces, and the sender's post-generation experience already wants every section the tracking page has. But the proposal under-specifies the contract changes it depends on (the tracking function returns *none* of `label_url`, `link_short_code`, `shipped_at`, `eta`, or `promised_delivery_date` today — §3.6 says "most are already there" but four of six aren't), conflates two URL primitives that mean different things in this codebase, and the "Ship Again" CTA's device-based heuristic is a privacy/UX miss for the very case that matters most (sender on a friend's laptop, or recipient on the device the sender once used). The privacy expansion of putting Print/Download on a link-only-gated page is real and deserves an explicit decision, not implicit acceptance.

### Blocking issues

1. **Tracking response is missing `label_url`, `link_short_code`, `shipped_at`, `eta`, and `promised_delivery_date` — §3.6 hand-waves a load-bearing scope item.**
   - **Location:** §11 §"File-by-file plan" bullet on `tracking/index.ts`: *"extend response to include `label_url`, `link_short_code`, and the status/timestamps the lifecycle card needs (most are already there)."*
   - **Issue:** Verified at [`supabase/functions/tracking/index.ts:61`](supabase/functions/tracking/index.ts) and [`:148-163`](supabase/functions/tracking/index.ts) — the SELECT pulls `id, tracking_number, public_code, carrier, service, status, easypost_tracker_id, is_test, created_at, updated_at, promised_delivery_date, delivered_at` and the JSON response exposes only `tracking_number, public_code, carrier, service, status, estimated_delivery, events, created_at, updated_at, promised_delivery_date, delivered_at`. **Neither `label_url` nor `link_short_code` nor `shipped_at` nor `eta` is selected or returned.** `link_short_code` requires a join to `sendmo_links` via `shipments.link_id` ([migration 001:76](supabase/migrations/001_initial_schema.sql)); the proposal's `ShipAgainCTA` and "Ship again" pre-fill paths cannot work until that join exists. The `ShipmentLifecycleCard` props in §3.6 name `shippedAt` and `eta` — neither is in the response, and `shipped_at` may not even exist as a column (no grep hits in tracking SELECT; this is also an under-specified DB question).
   - **Suggested fix:** Make the scope explicit: (a) add `label_url` to the tracking response's SELECT and JSON; (b) add an explicit join `shipments → sendmo_links` to derive `link_short_code` (and gate it: only include in response when the request can be inferred to be from the sender, OR always include — pick one and write it down); (c) audit which timestamp columns exist on `shipments` and either add them to the response or change the `ShipmentLifecycleCard` prop names to match what's actually available (`updated_at` is the closest signal for "label printed → in transit" today, since webhooks update it). If `shipped_at` doesn't exist, this proposal owns adding it via migration — that's a schema change the §"Out of scope" disclaims and the §"File-by-file plan" doesn't list.

2. **Privacy expansion is material and needs an explicit decision, not an "acceptable risk" sentence.**
   - **Location:** §11 §"Privacy / abuse": *"Print/Download exposed to anyone with the URL. Risk: duplicate-label printing. Mitigation: ... Acceptable risk for the pre-launch window."*
   - **Issue:** Round 1 §B3 + §"Watch out" in the LOG entry explicitly *removed* the recipient's `street1` from any UI surface and pushed it to the printed PDF only. The Round 1 sender saw the PDF as part of a transient `step="done"` component — a session-scoped artifact, never reachable from a URL. Round 2 puts the PDF (which contains the recipient's full street address) behind a 7-char public_code in a stable URL that gets:
     - Bookmarked by the sender.
     - Linked from the Dashboard (recipient's view).
     - Auto-redirected to via `history.replaceState`, which means it ends up in browser history.
     - Potentially screenshotted in support tickets, forwarded in texts/email, or scraped from carrier-tracking-number-leaked-into-thread-subject patterns.
     The keyspace argument (3.4×10^10) holds *only when nobody shares the URL*. The likely real-world case — sender drops the link into a "got your label!" text to recipient or forwards it to a marketplace third party who arranged shipping — leaks the recipient's address to anyone in that thread. Round 1's Rule 7 enforcement was specifically: *no recipient address in any URL-reachable SendMo UI; the PDF is the only exception*. Round 2 turns the PDF into a URL-reachable artifact, which arguably violates Rule 7's spirit even though it technically uses the same PDF.
     This isn't necessarily a blocker on the merits — John may decide the convenience-for-John-dogfood outweighs the leak surface for the pre-launch window. But the proposal frames it as already-decided. It should be a §"Tradeoffs for John" item, not a one-line acceptance.
   - **Suggested fix:** Spell out the tradeoff for John in a §"Privacy decision" block: (a) keep the proposal as written and accept that the public_code now gates label-grade PII; (b) gate Print/Download behind an additional signal (e.g., `localStorage.sendmo:sender:v1` presence — same heuristic the Ship-again CTA uses — meaning "you printed this on this device, you can re-print"); (c) require auth for Print/Download on `/t/<code>` while keeping tracker visible to anyone. Pick one with John's explicit sign-off.

3. **`history.replaceState` is the wrong primitive in this codebase — use `navigate(..., { replace: true })` and `setSearchParams({}, { replace: true })`.**
   - **Location:** §11 §"Architecture" *"sender's URL is replaced via `history.replaceState`"* + §"File-by-file plan" `TrackingPage.tsx` bullet *"strip it via `history.replaceState`"* + §"Open questions" #1 (mentions both primitives).
   - **Issue:** [`src/pages/SenderFlow.tsx`](src/pages/SenderFlow.tsx) is a React Router page (`useParams`, `useNavigate` available). Calling `history.replaceState` directly bypasses React Router's history stack and will produce subtle bugs: route guards won't fire, `useLocation` won't re-render, and Back-button behavior diverges from the rest of the app. The codebase already uses `useNavigate` (see [TrackingPage.tsx:1](src/pages/TrackingPage.tsx) imports). The `?fresh=1` strip should use `setSearchParams({}, { replace: true })` from `useSearchParams`. Mentioning `history.replaceState` in two places will mislead the implementer.
   - **Suggested fix:** Replace every `history.replaceState` reference in §11 with the React Router primitive: `navigate('/t/' + code + '?fresh=1', { replace: true })` for the redirect, `setSearchParams({}, { replace: true })` for the query-param strip after first paint. This matches the rest of the codebase and is the answer to Open Questions #1 + the body's primitive choice. Delete the `sessionStorage` alternative from #1 — query-param-with-React-Router-strip is strictly better here.

4. **"Ship Again" CTA's `localStorage.sendmo:sender:v1` heuristic conflates "this device" with "this person" — and the proposal already knows the fallback case but punts.**
   - **Location:** §11 §"Sections" bullet 4: *"detected via `localStorage["sendmo:sender:v1"]` presence"* + §"Open questions" #2 (author's lean: *"also show it if `?fresh=1` is in the URL"*).
   - **Issue:** Device-level signal vs. person-level signal. Three real cases this gets wrong:
     - **False positive:** Recipient opens `/t/<code>` on her own laptop where she once tested the sender flow herself — sees a CTA inviting her to "ship another package to {recipient}" where {recipient} is her. Confusing at best, creepy at worst.
     - **False negative #1:** Sender printed the label on their phone, now revisits on their desktop where no `sendmo:sender:v1` exists. CTA absent for the exact person it's targeting.
     - **False negative #2:** Sender clicked "Save my info" off in Round 1 — never sees the CTA, ever, on any device.
     A better signal exists in the data the proposal is already about to thread through: **the public_code → shipments.link_id join gives you `sendmo_links.user_id`, which gives you "this shipment's recipient." Compare to `auth.getUser()` if the viewer is authenticated.** Unauthenticated viewer: show the CTA whenever `?fresh=1` is present (just-shipped guarantee) OR whenever `localStorage` says they've used the sender flow recently. Authenticated viewer with `user.id === link.user_id`: hide the CTA (they're the recipient). Authenticated viewer with `user.id !== link.user_id`: show it. This is auth-aware and degrades cleanly for anonymous flex-link senders, which is the dogfood case.
   - **Suggested fix:** Adopt the layered signal: `?fresh=1` ∨ (anonymous + localStorage) ∨ (authenticated AND user.id !== link.user_id). Hide for (authenticated AND user.id === link.user_id). Document in §11.

5. **Status transitions: proposal handles 4 happy-path states; `return_to_sender` and `cancelled` are real and unaddressed.**
   - **Location:** §11 §"Sections" bullet 1: *"4-step visual: `Label created → In transit → Out for delivery → Delivered`"* + §"Test plan" *"label_created, in_transit, out_for_delivery, delivered, cancelled/return_to_sender"* (the test mentions them but the visual spec doesn't accommodate them).
   - **Issue:** [SPEC §15 + `webhooks/index.ts:29-37`](supabase/functions/webhooks/index.ts) lists `in_transit, out_for_delivery, delivered, return_to_sender` as webhook-driven, plus `cancelled` from the void path ([PLAYBOOK §"Label Cancellation"](PLAYBOOK.md)) — both of which `TrackingPage.tsx`'s existing `STATUS_CONFIG` already handles. A 4-step horizontal tracker cannot represent "returning" or "cancelled" without either (a) a 5th branch step, (b) an alternative-display mode (the existing TrackingPage shows a red-coded `AlertCircle` icon for these — that pattern works), or (c) hiding the tracker entirely when status ∈ {return_to_sender, cancelled} and showing only the alert state. The proposal's §"Open questions" doesn't ask which.
   - **Suggested fix:** Pick a treatment — recommend (c) plus an explicit "Shipment cancelled" / "Shipment returning" banner with copy ("This label was voided" / "The package is being returned to you"). The lifecycle card hides; the existing TrackingPage status banner shows. Add to §11 §"Sections" bullet 1 and to the unit test list.

### Non-blocking concerns

- **Single-use label note ("Duplicates are rejected by the carrier") is technically wrong in the general case.** EasyPost labels can sometimes be reused if the carrier scanner doesn't dedupe (rare but documented; varies by carrier and service). Softer phrasing is more honest: *"This label is for a single shipment. Please don't reprint or share it — duplicates can be rejected or charged twice."* Same warning intent, doesn't lie about the carrier's behavior. Not a blocker because the social pressure of the note is the actual deterrent; the technical claim is decoration.

- **`SenderStepDone.tsx` deletion: orphans no test files, but the existing component imports `senderState`'s `dropOffCopy` helper — verify the new `ShipmentLabelSection` re-imports it from the same module.** Verified: no `SenderStepDone.test.tsx` exists in [`tests/unit/`](tests/unit/) (only `SenderStepIntro.test.tsx` + `senderState.test.ts`). Deletion is safe from a test-orphan perspective. The risk is whether `dropOffCopy` ends up imported twice or moved into the new component — the §"File-by-file plan" should make the import path explicit ("`ShipmentLabelSection.tsx` imports `dropOffCopy` from `@/components/sender/senderState`" — assuming `senderState.ts` is *not* also deleted; it isn't, but the proposal should say so).

- **§11 §"File-by-file plan" deletes `SenderStepDone.tsx` but the LOG entry for Round 1 [LOG.md "Sender flow wizard"] lists it as a shipped artifact and the components folder structure is now load-bearing — this is the first time a Round-1-shipped component is being removed.** Document in the §"Reconciliation" note or in the new Round 2 LOG entry that Round 1's `SenderStepDone.tsx` is being absorbed into `ShipmentLabelSection.tsx`, not deleted-with-no-replacement. Important for the next agent reading the LOG to understand why a file referenced in Round 1's LOG is gone.

- **Test plan asymmetry: Round 1 had ~22 unit tests planned (delivered), Round 2 lists only "unit tests for the 3 new components + `?fresh=1` strip" — count is undeclared.** A round number target like "≥12 new unit tests" gives the implementer something to optimize against and stops a "I'll write 3 happy paths and call it done" outcome.

- **Auto-hide threshold (§11 §"Open questions" #3): `shipped_at IS NOT NULL` is a fine boundary, but `shipped_at` may not exist as a column today (see Blocking #1) — verify before locking the threshold. If it doesn't exist, the threshold becomes `status !== 'label_created'` and the "carrier hasn't scanned yet" case the question asks about goes unaddressed. Worth a quick column-check before the proposal closes.**

- **The proposal claims `?fresh=1` is "debuggable + testable" — true for E2E, but the strip happens on first render (one paint cycle), which means an unmounted test environment will frequently fail to observe the param at all.** SessionStorage or a state-machine-derived flag passed from `SenderFlow` → `TrackingPage` via Router state would be cleaner. Author lean is fine; flagging because the testability win the proposal claims is partial.

### Nits

- **"Same page, four viewer states" undercounts.** With the auth-aware ship-again signal (Blocking #4), there are actually six viewer states: just-shipped sender (fresh=1, anonymous), returning sender (anonymous + localStorage), authenticated sender (link.user_id !== viewer.id), authenticated recipient (link.user_id === viewer.id), anonymous third party (no localStorage, no fresh), authenticated third party (link.user_id !== viewer.id, no localStorage, no fresh). Most collapse to the same UI, but the matrix is worth sketching to avoid logic regressions.

- **§11 §"Sections" numbering is inconsistent with the rest of the proposal.** The body uses `### Sections` with prose bullets; Round 1 used numbered sub-sections (§3.1, §3.2, ...). Implementer-grep-ability suffers when the structure changes mid-document. Consider renumbering Round 2's sections to §11.1 / §11.2 / ... for consistency.

- **"Existing tracker UI — keep as fallback when label section is hidden" is ambiguous.** The existing TrackingPage already has a "Progress" card and a "Tracking History" card — both will remain by default. Saying "keep as fallback" reads like "only render when the new card is hidden," which would lose the per-event tracking history entirely. Clarify: the new `ShipmentLifecycleCard` is the *hero* (top), the existing Progress and Tracking History sections render *below* unchanged.

- **"Inline its content into `ShipmentLabelSection`" — minor: `SenderStepDone.tsx` has FROM/TO shipment-summary, "Track this package" CTA, and "Back to SendMo" CTA on top of label + drop-off.** Those don't belong in `ShipmentLabelSection` (they belong elsewhere on `/t/<code>`). The proposal should say where each of the four sub-blocks lands, not "inline the whole thing."

- **Open Question #4 ("separate proposal file vs append"): append.** This Round 2 is a coherent UX extension of Round 1, history reads better with both in one file, and the protocol's filename suffix already records both review dates. Don't fragment.

### Predicted pitfalls

1. **`label_url` not in the tracking response = silently-broken Print button.** This is the same R-class as Round 1's Blocking #2 (the labels function returned data only in a `.then()` callback the client never saw). The Round 1 fix was "await the RPC + add fields to the response body." Round 2 is one layer over: the tracking function never owned these fields, and the proposal says "extend response" without spelling out what extends to what. If the implementer ships `ShipmentLabelSection` against a `label_url` that returns `undefined`, the Print button will be `<a href={undefined}>` — clicks fire but go nowhere, no console error, no Sentry. This is the *exact* failure mode of the 2026-04-26 notification incident (LOG: "notification system silently 100% broken — three independent bugs") and the 2026-05-11 tracking-code "every `.then()` callback on a Supabase write..." Mitigation: write the `TrackingPage` test that asserts the Print button's `href` is defined before merging.

2. **`history.replaceState` ships, breaks Back-button behavior in subtle ways, John dogfoods, finds a "the back button takes me to /s/<code> which then immediately re-redirects to /t/<code>" loop.** R-class: bypassing React Router's history. The 2026-05-11 LOG entries on verify_jwt are the closest documented sibling — code that works locally (where the back button doesn't matter for the manual test) breaks in real-user-pattern usage. Mitigation: blocking #3 — use the React Router primitive.

3. **Ship-Again CTA shown to a recipient on their own laptop creates the "creepy CTA" support ticket — exactly the kind of pre-launch dogfood signal that's hard to recover from.** R-class: device-signal-mistaken-for-person-signal. No prior LOG entry on this specifically, but the broader pattern — Round 1's "Save my info on this device" was already a device signal; Round 2 builds another check on the same signal — compounds the original sin. Mitigation: blocking #4's auth-aware layered signal.

4. **Print/Download URL leaks recipient address via shared link → Rule 7 spirit-violation incident.** No prior LOG entry; this would be the first. Closest sibling pattern: the 2026-05-11 admin-PIN incident — a security/privacy boundary that "looked fine in pre-launch" but was 5 seconds from devtools-bypass. Pre-launch tolerance for privacy edges erodes the team's pattern-matching on what's acceptable. Mitigation: blocking #2 — explicit John decision, not silent acceptance.

5. **`return_to_sender` / `cancelled` shipment lands on the page, lifecycle card renders with no active step, looks broken.** R-class: edge-state forgotten in happy-path UI design. The 2026-05-11 LOG entry on the admin toolbar's 3-mode rework names a similar pattern (the "Live Comp" mode that didn't do what its name said, undetected for weeks because nobody walked the edge path). Mitigation: blocking #5 — explicit terminal-state treatment + a unit test for each terminal status.

### What the proposal got right

- **The architectural move — one URL per shipment, four viewer states, replace the transient `step="done"` component with a stable surface — is the right call.** Round 1's `step="done"` component was always going to be a dead-end (sender bookmarks `/s/<code>`, starts over, loses the label). Promoting `/t/<code>` from "tracker" to "shipment page" reuses existing infra (the tracking function already exists, the page already renders status, the Dashboard already links there) instead of inventing a parallel `/shipments/<id>` surface.

- **Deleting `SenderStepDone.tsx` rather than leaving two parallel post-generation surfaces.** Easy temptation to keep both ("`/s/<code>` ends at SenderStepDone, `/t/<code>` is for later returns") — that would be the worse architecture. Picking one canonical page now, even with the disruption of removing a Round-1-shipped component, is the right call.

- **`localStorage["sendmo:sender:v1"]` is the right key namespace to read from** — it was set up correctly in Round 1 (versioned, namespaced). The CTA conditional needs improvement (blocking #4) but reading from the same key is correct.

- **Recognizing that the tracking function needs extending rather than building a new `/api/shipment/<code>` endpoint** is the right minimalism. The tracker is already public, already has EasyPost sync logic, already handles the public_code lookup. Extending its response is the small-change path.

- **The out-of-scope discipline holds.** Auth gating, resume-incomplete-flow, schema migrations, webhook changes — all correctly out of scope, all correctly named. The proposal resists scope creep that would balloon Round 2 into Round 1-sized work.

- **Open Question #4 (separate file vs append) shows good protocol awareness.** Naming the question rather than silently picking a non-standard structure is exactly the kind of "flag-don't-decide" that the protocol rewards.

## 13. Author response — Round 2

**author response:** Claude (Opus 4.7) — same SendMo session
**responded_at:** 2026-05-11 21:00

Reviewer is right on all five blockers. Four are mechanical fixes I'll fold into the plan; one (Blocking #2, the privacy expansion) is a real tradeoff and goes to John. Nits + non-blockers all accepted.

### Blocking issues

**B1. Tracking response missing `label_url`, `link_short_code`, `shipped_at`, `eta`, `promised_delivery_date` — ✅ accept; rewrite §11.3 to be explicit.**

Concrete contract change on `tracking/index.ts`:
- Add to SELECT: `label_url`. Add join: `sendmo_links!inner(short_code, user_id)` via `shipments.link_id`.
- Add to JSON response: `label_url`, `link_short_code`, `viewer_is_recipient` (boolean — computed server-side: if the request has a valid JWT and `auth.getUser().id === sendmo_links.user_id`, set true).
- `shipped_at` column existence check: confirmed absent from current schema (verified by grep of `supabase/migrations/`; `shipments` has `created_at`, `updated_at`, `delivered_at`, `cancelled_at`, `refund_submitted_at`, `promised_delivery_date` — no `shipped_at`). **Decision: don't add a column for this round.** Use `status` as the visibility gate; the "in-transit but not yet scanned" edge the open-question raised is rare in practice and the cost of carrying a label section into the in-transit view is small (it's just hidden behind a "needed to reprint?" disclosure). Threshold becomes `status === 'label_created'`.
- `eta` is informational only; the response already exposes `promised_delivery_date`. Drop `eta` from the lifecycle-card prop list and rename internally to `promisedDeliveryDate`.

**B2. Privacy expansion of Print/Download on `/t/<code>` — ❓ needs John.**

Reviewer is correct that Round 1's Rule 7 enforcement kept the PDF as a session-scoped artifact. Round 2 puts it behind a URL-reachable surface. Three options:

- **(a) Keep as proposed (URL gates the PDF).** The 7-char public_code is non-guessable; risk is *shared* URLs leaking, not *guessed* URLs. Pair with a strengthened note: *"This link shows your shipping label. Anyone with the link can see the recipient's address. Don't share it publicly."* Strictly clearer than what Round 2 had ("single-use, duplicates rejected").
- **(b) Gate Print/Download behind `localStorage["sendmo:sender:v1"]` presence.** Same device signal as the Ship-Again CTA. Pro: shared link doesn't leak the PDF. Con: breaks the exact reprint-from-another-device case John flagged in question #1 (link owner should see print/download too). Recipient could still see it via authenticated path, but that adds gateway complexity.
- **(c) Require auth for Print/Download on `/t/<code>`.** Tracker stays public; print is auth'd. Cleanest privacy; breaks the anonymous-sender-reprint case entirely (sender has no auth signal).

**Author recommendation: (a).** Reasoning: (i) the link-share leak is a behavior we can warn against in copy more cheaply than we can engineer around it; (ii) the alternative gates either break a use case John explicitly approved (recipient sees print) or break the anonymous-sender model; (iii) pre-launch window is the right time to test "does anyone actually share this link?" — if abuse appears, hardening to (b) or (c) is a single conditional. Brought to John for explicit sign-off rather than silent acceptance.

**B3. `history.replaceState` → React Router primitives — ✅ accept.**

§11 §"Architecture" and §"File-by-file plan" updates:
- `SenderFlow.tsx` `handleConfirm` success: `navigate(\`/t/${publicCode}?fresh=1\`, { replace: true })` via `useNavigate()`.
- `TrackingPage.tsx` first-render strip: `const [params, setParams] = useSearchParams(); useEffect(() => { if (params.get("fresh") === "1") setParams({}, { replace: true }); }, [])`.
- Drop the sessionStorage alternative from Open Question #1 entirely. Closed.

**B4. Ship-Again CTA visibility heuristic — ✅ accept; adopt layered signal.**

Visibility rules:
- **Show** if `?fresh=1` is present (just-shipped guarantee, regardless of device or auth).
- **Show** if anonymous AND `localStorage["sendmo:sender:v1"]` is present (returning sender on the same device).
- **Show** if authenticated AND `viewer_is_recipient === false` (an authenticated user who is *not* the link owner — e.g., a future signed-in sender scenario).
- **Hide** if authenticated AND `viewer_is_recipient === true` (the link owner viewing their own shipment — they have the Dashboard for this).
- **Hide** otherwise (anonymous third party with no signal).

Depends on `viewer_is_recipient` being returned by the tracking endpoint — folded into B1's response shape.

**B5. `return_to_sender` / `cancelled` terminal states — ✅ accept; hide lifecycle card, show banner.**

When `status ∈ {return_to_sender, cancelled}`:
- `ShipmentLifecycleCard` does not render.
- `ShipmentLabelSection` does not render (no reprinting a voided/returning label).
- Banner above the shipment summary: red-coded `AlertCircle` icon + copy:
  - `cancelled`: *"This label was voided and the package will not ship."*
  - `return_to_sender`: *"The package is being returned to the sender."*
- The existing TrackingPage's status-banner pattern (verified in [TrackingPage.tsx](src/pages/TrackingPage.tsx)) is the right host for this; extend its copy table rather than building a new banner.

Unit tests gain coverage for both terminal statuses.

### Non-blocking concerns

- **Single-use note phrasing — ✅ accept, soften.** New copy: *"This label is for a single shipment. Please don't reprint or share — duplicates can be rejected by the carrier or charged twice."*
- **Document Round-1 component absorption in the next LOG entry — ✅ accept.** The Round-2 LOG entry will explicitly note: *"`SenderStepDone.tsx` is absorbed into `ShipmentLabelSection.tsx` (label preview + Print/Download + drop-off) plus `TrackingPage.tsx` (summary card + 'back to SendMo' nav). Not deleted-without-replacement; renamed to reflect its new home."*
- **Test count target — ✅ accept, ≥12 new unit tests.** Coverage: lifecycle card (5 status branches incl. terminals = 5), label section visibility (3), ship-again CTA visibility matrix (≥4), `?fresh=1` strip behavior (1), terminal-banner copy (2). Floor 15, target ~18.
- **`?fresh=1` testability caveat — ✅ acknowledged.** Stick with query param + React Router primitives. The "easier to E2E" claim was real for the dogfood pass; unit testing the strip uses `MemoryRouter` with initial entries that include `?fresh=1`.
- **`shipped_at` open question (§11 OQ#3) — ✅ closed by B1.** Threshold is `status === 'label_created'`. No new column.

### Nits

- **Six viewer states matrix — ✅ accept, document in §11.**
- **Numbering inconsistency — ✅ accept; the implementation work renumbers Round 2's sub-sections to §11.1, §11.2, etc.**
- **"Existing tracker UI — keep as fallback" clarification — ✅ accept; explicit composition: new `ShipmentLifecycleCard` is the hero, existing Progress + Tracking History cards render below unchanged.**
- **`SenderStepDone` sub-block placement — ✅ accept; explicit mapping:**
  - Label preview + Print + Download → `ShipmentLabelSection`
  - Drop-off block → `ShipmentLabelSection` (same visibility threshold)
  - Shipment summary (From/To/Service/Tracking) → goes directly on `TrackingPage`, above the existing tracker section
  - "Track this package" link → DELETED (we ARE the tracking page now)
  - "Back to SendMo" nav → moves to `TrackingPage`'s footer
- **Open Question #4 (separate file vs append) — ✅ append confirmed.** Reviewer agrees; closed.

### Predicted pitfalls — response

1. **`label_url` not in tracking response → silent broken Print button.** Folded into B1. Test plan adds an assertion: `TrackingPage` test mocks the tracking endpoint with a label_url-present response and asserts the Print anchor's `href` matches; second test asserts a label_url-absent response renders no Print button (graceful degradation, not broken-button).
2. **`history.replaceState` → Back button loop.** Folded into B3.
3. **Creepy CTA via device-signal mistake.** Folded into B4 (auth-aware layered signal).
4. **PDF leak via shared link → Rule 7 spirit violation.** Folded into B2 — John's call. The strengthened warning copy is the mitigation if (a) is chosen.
5. **Terminal-state status renders broken-looking lifecycle card.** Folded into B5.

### Status

Four of five blockers resolved in this response with concrete spec updates. **Blocking #2 (privacy expansion) is the one outstanding tradeoff for John.** Bringing it to him explicitly:

- Recommended: **(a) keep Print/Download on `/t/<code>` accessible to anyone with the URL; pair with strengthened warning copy.**
- Alternative: **(b) gate Print/Download behind device-signal**.
- Alternative: **(c) require auth for Print/Download.**

On John's pick:
- If (a): I fold the warning copy into §11, flip frontmatter to `decided`, rename file to add `_redecided-2026-05-11` suffix (or note Round-2 decision inline in the existing `_decided` suffix — flagging the protocol's silence on multi-round filename conventions), and begin implementation.
- If (b) or (c): I re-spec the gating (touches tracking endpoint, `ShipmentLabelSection`, possibly a new auth path) and bring the revised plan back before coding.

## 14. Decision — Round 2

**John, 2026-05-11:** approved Round 2 with Option (a) on the privacy tradeoff.

Print/Download stays accessible to anyone with the `/t/<public_code>` URL. Pair with the strengthened warning copy: *"Anyone with this link can see the recipient's address. Don't share it publicly."* All five blocker resolutions in §13 are binding spec for implementation. File stays at the existing `_decided-2026-05-11` suffix (Round 2 decided same day; renaming would be churn).
