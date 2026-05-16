---
title: Flex payment execution — PR1 (Reactivate) + PR2 (Active/Inactive pivot)
slug: flex-payment-execution-pr1-pr2
project: sendmo
status: revised
created: 2026-05-16
last_updated: 2026-05-16
reviewed: 2026-05-16
decided: null
author: Claude (Sonnet 4.6) session — author of yesterday's strategy proposal; this execution plan folds in John's 2026-05-15 reframing (Active/Inactive binary, front-gate $0 auth)
reviewer: Claude (Opus 4.7) fresh-eyes session — read cold against strategy proposal, master Stripe plan, PLAYBOOK rules 14/16/19, and the touched code in payments/labels/stripe-webhook/links/Dashboard
outcome: null
---

## Reconciliation with prior decided proposals

This proposal **operationalizes** [`2026-05-15_payment-authorization-strategy.md`](2026-05-15_payment-authorization-strategy.md) (status: draft, but the strategy direction is settled following John's 2026-05-15 reframing). Key differences from the original strategy proposal, all triggered by John's reframing:

| Strategy v1 (yesterday) | Strategy v2 (this proposal) |
|---|---|
| Validate-once at onboarding with PI+cancel for `$cap` | Validate at onboarding with $0 auth (fallback $1) — no big pre-auth |
| Link states: `draft/active/in_use/completed/expired/cancelled` | Link states externally: **Active / Inactive** (sub-statuses still in DB for diagnostics) |
| Trust front gate ("does PM exist?") between sender visits | **Front-gate $0 auth on every sender link-open** (with rate limiting) |
| Recovery: dashboard banner + email | Same + explicit "Reactivate" button + sender fallback to self-paid label |
| Cap pre-auth checked credit availability | Skipped — $0 auth doesn't, but per-shipment off_session at confirm catches it |

Also supersedes the Phase E flex-capture work shipped 2026-05-15 (commits `ab92b3d` flex-capture; `b73dd7c` partial UX) — see §6 for what we revert.

Master Stripe plan ([`2026-04-26_stripe-integration-plan_...`](2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md)) is unchanged at the architectural level (§3.4 PI lifecycle, §3.7 carrier adjustments, §3.8 escrow). This proposal only changes the flex-link branch.

---

## 1. Context

### 1.1 What's broken right now (2026-05-16 morning)

- John's only flex link (`sendmo.co/s/BDnsjZTAhq`) shows "Needs payment" badge on dashboard but has **no actionable path** to fix it from the UI. Pre-Phase-E links don't have a `holds` row; today's `b73dd7c` correctly surfaces the gap but doesn't close it.
- Phase E's `ab92b3d` shipped a one-shot hold-and-capture model that can't support reusable links (a flex URL is supposed to seed N child shipments; one-shot capture breaks after shipment #1).
- The "Default" PaymentMethod label and ordering on dashboard wallet — John flagged as nit.

### 1.2 What we're shipping

Two PRs, in order:

- **PR1 (today):** Unblock John's stuck link with a Reactivate button + endpoint. Rename "Default" → "Primary" badge and sort to top. Add `payment_validations` table (becomes load-bearing in PR2). No model change yet — Phase E flex-capture code stays running as-is until PR2.
- **PR2 (after PR1 + this proposal approved):** Pivot the flex flow to validate-once-then-charge-per-shipment, expose Active/Inactive binary state externally, add front-gate $0 auth on sender open, add URL rotation. Reverts Phase E's flex-capture branches and uses PR1's `payment_validations` table as the new source of truth for "is this link funded."

### 1.3 Why two PRs

PR1 is small, surgical, unblocks John today, and writes shared infrastructure (the `reactivate-link` endpoint logic) that PR2 reuses verbatim for the front-gate. PR2 is the architectural pivot — bigger blast radius, deserves its own review.

Splitting also means John can dogfood PR1 immediately (Reactivate button works against existing PMs) while PR2's bigger changes are reviewed and verified.

---

## 2. Architecture

### 2.1 The shared primitive: `validate-payment-method` server logic

Both PRs rely on the same server-side action: "given a customer + payment method, prove the card is usable, write an audit row, return success/failure." This is implemented as a helper in PR1 and reused in PR2.

```ts
// supabase/functions/_shared/stripe.ts (new helper)
async function validatePaymentMethod(params: {
  customer: string;
  payment_method: string;
  link_id?: string;
  user_id: string;
  liveMode: boolean;
  reason: 'reactivate' | 'front_gate' | 'pm_added';  // for audit
}): Promise<{ ok: true } | { ok: false; error: string; declineCode?: string }>
```

Internal flow:
1. Try `createPaymentIntent({ amount: 0, confirm: true, off_session: true, customer, payment_method })`.
2. If Stripe returns an "amount_too_small" / "amount_too_low" error → retry with `amount: 100` ($1).
3. If PI status is `succeeded`: cancel/refund immediately (the auth is released within seconds; $1 fallback case shows a brief pending charge).
4. Insert `payment_validations` row with `link_id, user_id, customer_id, validated_amount_cents, stripe_intent_id, validated_at, reason, mode`.
5. Return `{ ok: true }` or `{ ok: false, error, declineCode }`.

This helper is the entire substance of PR1 (wrapped in an endpoint) and the substance of PR2's front-gate (wrapped in a different endpoint with rate-limiting).

### 2.2 PR1 endpoint shape

```
POST /payments/reactivate-link
Body: { link_id }
Auth: JWT required (link owner only)
Behavior:
  - Look up recipient's default PM for the link's mode
  - If no PM: return 400 { error: "add_card_required" } — client opens AddCardModal
  - If PM exists: run validatePaymentMethod(..., reason='reactivate')
  - On success: write payment_validations + return { ok: true }
  - On failure: return 402 + decline reason; link stays inactive
```

The endpoint **does not modify `sendmo_links.status`**. It writes a `payment_validations` row. PR2 will start reading these rows to compute "is the link Active"; PR1 just establishes the audit trail without changing the link-status logic.

For PR1's dashboard rendering, the existing today's `b73dd7c` logic stays — "Needs payment" badge until a hold row exists. After Reactivate succeeds, we don't yet flip the link state visibly (because the rendering still keys off `holds`). PR1 ships this as **acknowledged temporary asymmetry**: the audit row is written but the badge stays "Needs payment" until PR2 swaps the rendering logic.

**Why acceptable as temporary state:** the Reactivate button gives the user a clear "I tried, it worked, here's what happened" experience even if the badge is stale. We surface "Reactivated ✓ — full effect will take place after the next deploy" in the success toast. PR2 follows quickly.

**Alternative considered:** flip the link to status='active' immediately in PR1. Rejected because the existing badge logic is `!holds`, not `!status`; we'd need to add the new payment_validations-based logic in PR1, which IS the PR2 work. Better to land it once cleanly in PR2.

### 2.3 PR2 — the full pivot

After PR2:

- **`sendmo_links` rendering: Active/Inactive binary externally**, sub-statuses (`draft/active/in_use/completed/expired/cancelled`) remain in DB for diagnostics but never leak to UI. A view helper computes the binary externally.
- **"Is link funded" logic** changes from "does `holds` row exist" → "does at least one `payment_validations` row exist for this user+mode, OR does a saved PM exist that we can re-validate on demand." Used by:
  - Dashboard badge (Active vs Inactive)
  - Sender flow at link-open (passes through front gate)
  - Labels function (allows the actual charge)
- **Front gate**: `GET /links?code=...` now performs `validatePaymentMethod(..., reason='front_gate')` if no recent (e.g., <24h) successful validation exists for the link's PM. Rate-limited per IP / per short_code / per customer. If validation fails, link flips to Inactive, sender sees the friendly fallback message, recipient notified.
- **Per-shipment capture**: `labels` Edge Function's flex branch is replaced. Today's capture-the-held-PI logic is removed. New logic: create fresh off_session PI for `display_price_cents` against saved PM, auto-capture, proceed with EasyPost buy. Existing auto-refund logic for EasyPost buy failure works unchanged.
- **Webhook lifecycle simplifications**: drop `holds`-row creation in `amount_capturable_updated` and capture-state transitions in `succeeded` for `intent_role='flex_validation'`. Those PIs are now $0/$1 transient validations, not held funds.
- **URL rotation**: new `POST /links/:id/rotate` endpoint. Generates new short_code, marks old one with `status='cancelled'`. Existing senders mid-flow on the old code get the "not available" message (existing logic).
- **Sender fallback message** when front gate fails: "This link isn't accepting payments right now. You can ship a regular label at usps.com / ups.com / fedex.com." Static for now; the prefilled-recipient-address flow is wishlist.
- **Phase E one-shot artifacts revert**: `holds` table stays in schema (reserved for Phase 3 escrow per master proposal), flex flow stops writing to it. `stripe_intents.intent_role='flex_validation'` replaces `'flex_hold'` for new records (old `flex_hold` records remain in DB as historical).

### 2.4 What stays the same across both PRs

- `payments` Edge Function's full-label (immediate-capture) flow — completely unchanged.
- `labels` Edge Function's full-label branch — completely unchanged.
- `cancel-label` and tracking-driven refund flow — completely unchanged.
- `stripe_intents`, `transactions`, `payment_methods` tables — schemas unchanged. `payment_validations` is purely additive.
- The Add Card flow (commits `220b3e2`, `a467ab0`) — unchanged.

---

## 3. File-by-file plan

### 3.1 PR1 files

| File | Change | LOC |
|---|---|---|
| `supabase/migrations/<NN>_payment_validations.sql` | NEW — create `payment_validations` table per strategy proposal §6.1. RLS: service role only writes; recipient can SELECT their own | ~25 |
| `supabase/functions/_shared/stripe.ts` | Add `validatePaymentMethod` helper (the §2.1 logic) | ~80 |
| `supabase/functions/payments/index.ts` | Add `reactivate-link` route (extends existing serve handler with URL pattern match) | ~60 |
| `src/lib/api.ts` | Add `reactivateLink({ link_id, accessToken })` client function | ~25 |
| `src/pages/Dashboard.tsx` | (a) rename "Default" badge to "Primary" + sort primary PM to top of wallet list; (b) add Reactivate button next to "Needs payment" badge with three states: idle / loading / success-toast; if 400 "add_card_required", open AddCardModal then auto-reactivate on its onSuccess | ~80 |
| `tests/unit/Dashboard.test.tsx` | Update test: "Default" → "Primary" assertion. Add tests for Reactivate states. | ~50 |
| `tests/integration/reactivate-link.test.mjs` | NEW — POST endpoint test: missing-PM 400, success 200, decline 402 | ~60 |
| `LOG.md` | Entry for PR1 with `Browser-verified:` block per Rule 19 | ~25 |

**Total PR1: ~405 LOC** including tests + docs.

### 3.2 PR2 files

| File | Change | LOC |
|---|---|---|
| `supabase/functions/links/index.ts` | (a) GET endpoint: compute `is_funded` from `payment_validations` + saved-PM existence (instead of `holds` join); run front-gate `validatePaymentMethod` if no recent validation; rate-limit per IP/short_code/customer; (b) NEW POST `/:id/rotate` endpoint | ~180 |
| `supabase/functions/payments/index.ts` | Remove `flex_hold` intent_role branch; either delete the function helper or stub it to error "deprecated; use validatePaymentMethod" | ~30 (deletions) |
| `supabase/functions/stripe-webhook/index.ts` | Remove `holds`-row creation from `amount_capturable_updated`; remove `holds.captured` + `links.in_use` transitions from `succeeded` for flex; keep handling for non-flex `intent_role` unchanged | ~40 (deletions) |
| `supabase/functions/labels/index.ts` | Replace flex capture branch with: lookup default PM, create off_session PI for `display_price_cents`, auto-capture, proceed; on decline, flip link to inactive (write `link_state_events` row, see §3.3) and return clean error | ~120 |
| `src/components/recipient/RecipientStepFlexPayment.tsx` | Switch from PI($cap, manual) to validatePaymentMethod-on-confirm flow; reduce to single-CTA "Validate card" with $0 (or $1 fallback); on success, link is active immediately (webhook writes validation row) | ~80 (mostly deletions) |
| `src/pages/SenderFlow.tsx` | Update intro-step error to use new `has_active_hold` → `is_funded` field; rendering unchanged on success path | ~15 |
| `src/pages/Dashboard.tsx` | Badge rendering: "Active" (green) vs "Inactive" (amber) based on `is_funded`; rename "Needs payment" to "Inactive — Reactivate"; add URL-rotate button under link card | ~60 |
| `src/lib/api.ts` | New `rotateLinkUrl({ link_id, accessToken })`. Update `LinkData.has_active_hold` → `is_funded` (rename). | ~30 |
| `SPEC.md` | Update §13 Payment System for flex: validate-once + charge-per-shipment; §7 (Flex Step 22) — copy updates for the new validation step | ~40 |
| `tests/e2e/flex-payment.spec.ts` | NEW or rewrite — full flex flow with mocked Stripe: validate at onboarding, charge at sender confirm, decline path, reactivate, URL rotation | ~200 |
| `LOG.md` | Entry for PR2 with `Browser-verified:` block | ~30 |

**Total PR2: ~825 LOC** including tests + docs + deletions.

### 3.3 Optional micro-table (PR2)

```sql
-- For Inactive link-state diagnostics
CREATE TABLE public.link_state_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_id     UUID NOT NULL REFERENCES sendmo_links(id),
    event       TEXT NOT NULL,   -- 'gate_passed', 'gate_failed', 'charge_failed', 'reactivated'
    reason      TEXT,            -- Stripe decline_code, etc.
    created_at  TIMESTAMPTZ DEFAULT now()
);
```

Audit trail for state transitions. Optional — could defer if reviewer flags as scope creep. Useful for support / fraud investigation.

---

## 4. Test plan

### 4.1 PR1

- **Unit (Vitest):**
  - `Dashboard.test.tsx` — Primary badge label, sort order, Reactivate button states (idle/loading/success/error/needs-add-card)
- **Integration (Node script):**
  - `reactivate-link.test.mjs` — endpoint contract: 401 missing JWT, 403 wrong owner, 400 missing PM, 200 success, 402 decline (mocked Stripe)
- **No e2e** for PR1 — the surface change is small and the integration test covers the wire-level contract. PR2 will add a full e2e flow that exercises Reactivate inside the bigger flex flow.

### 4.2 PR2

- **Unit:** updates to existing flex-component tests; new tests for badge state transitions
- **Integration:** new `flex-validate-then-charge.test.mjs` — exercises validatePaymentMethod, off_session PI creation, decline path
- **E2E (Playwright):** `tests/e2e/flex-payment.spec.ts` (~200 LOC) covering:
  - Recipient creates link → validate card → link Active
  - Sender opens link → front-gate passes → fills form → charge succeeds → label
  - Sender opens link with bad PM → front-gate fails → link Inactive → friendly error
  - Recipient reactivates → re-validates → link Active again
  - URL rotation → old code 404s, new code works
  - Recipient deletes last PM → existing links flip Inactive

### 4.3 Test sync items (both PRs)

- **SPEC.md** — update §13 Payment System for flex; rename "draft/active/in_use" to "Active/Inactive" in spec language; document the $0 → $1 fallback
- **WISHLIST.md** — add fraud-mitigation, sender-self-paid-fallback entries
- **PLAYBOOK.md** — no changes expected

Per PLAYBOOK Rule 19, both PR LOG entries get a `Browser-verified:` block. PR1 uses `mcp-session:` shape; PR2 uses `spec:` shape (the new e2e test).

---

## 5. Out of scope

Explicitly NOT in either PR — added to WISHLIST instead:

- **Fraud mitigation on front gate** — rate limit thresholds, Stripe Radar integration, auto-lock-and-recipient-acknowledge flow. PR2 ships *basic* rate limiting (in-memory per-IP buckets, similar to existing cancel-label rate limit) but no Radar integration or progressive lockout. Wishlist captures the full scope.
- **Sender fallback to self-paid label** — when link is Inactive, sender can opt to ship a regular paid label themselves with recipient's address prefilled. PR2 ships the static "ship a regular label at usps.com" message; the self-paid integrated flow is wishlist.
- **Periodic nightly background validation** — cron to validate active links' PMs once per night. Defer until scale demands.
- **Card-expiry proactive warning** (30-day-before email). Separate scope.
- **LinksEditor (`/links/new`) integration** — that path currently creates links without payment validation. Will hit "Inactive" immediately after PR2. WISHLIST entry to add validation at that path.
- **Card account updater webhook handling** (`payment_method.automatically_updated`). Easy win — defer to a follow-up.
- **Phase 3 escrow** — uses `holds` table per master proposal; not touched here.
- **Overage / carrier adjustment charging** (master §3.7) — infrastructure exists; flow doesn't.

---

## 6. Verification

### 6.1 PR1 verification (Rule 19 `mcp-session:` shape)

After deploying PR1:

1. Dashboard renders "Primary" badge on the default PM, with that card sorted first in My Wallet.
2. For John's stuck link `BDnsjZTAhq`: click Reactivate. Network tab shows POST to `/payments/reactivate-link` returning 200. `payment_validations` table gets a new row (verify via Supabase SQL). Success toast appears. Badge stays "Needs payment" (acknowledged — see §2.2).
3. Simulate no-PM case (briefly remove all saved PMs): click Reactivate. Modal opens AddCardModal. Add card. On AddCardModal success, Reactivate auto-fires. New `payment_validations` row appears.
4. Simulate decline (use Stripe test card `4000000000000002`): click Reactivate. Returns 402 with `card_declined` body. Error toast appears. No `payment_validations` row written.

### 6.2 PR2 verification

End-to-end Playwright spec covers each of the §4.2 e2e cases. Also one mcp-session pass:

1. Sign out. As anonymous user, open `sendmo.co/s/<active-flex-link>`. Front-gate runs $0 auth (visible in Supabase logs). Page loads with sender intro.
2. Same flow against an Inactive link → friendly fallback message appears at intro step, not after fill-out.
3. Recipient receives email after sender's failed front-gate (manually trigger by removing the PM mid-flow).

---

## 7. Open questions

Items the reviewer is most welcome to push on:

1. **PR1's acknowledged temporary asymmetry** (badge stays "Needs payment" after successful Reactivate, until PR2 lands). My read: acceptable because (a) PR1→PR2 is intended to be fast (days, not weeks), (b) the success toast carries the user's mental model. Reviewer: is this a real footgun in production, or is it fine?

2. **`payment_validations` table necessity in PR1.** PR1 could write to `event_logs` instead and defer the table to PR2 when it becomes load-bearing. My pick: write the table in PR1 because (a) it sets a clean audit trail from day 1, (b) PR2 will UPSERT into it heavily — better to have the schema settled and tested before then. Reviewer: defensible, or YAGNI?

3. **Should PR1 also flip `sendmo_links.status` to a specific value (e.g., `validated`) on Reactivate success?** Today's status is `active`. Adding a new status would require a CHECK constraint migration and clutter the enum. Alternative: don't touch status in PR1, just write the validation row. My pick: don't touch status. Reviewer: agreed?

4. **PR2's link_state_events table — defer or include?** Useful for support; not strictly load-bearing. My pick: include in PR2 because we'll write to it from the labels Edge Function on decline anyway, and having a clean audit trail before fraud-mitigation work makes that easier. Reviewer: scope creep?

5. **Front-gate rate-limit thresholds in PR2.** Sketch: 5/min/IP, 50/hr/IP, 10/hr/short_code, 50/day/customer. Numbers picked from gut + the cancel-label precedent (5/60s). Reviewer: any of these obviously wrong? Should we name a fraud-flagging signal (e.g., >5 failed gates on one link in <10 min = soft-lock the link)?

6. **PR2's revert of Phase E flex-capture code.** The webhook + labels + sender-flow code from commit `ab92b3d` (yesterday) gets ripped out. Reviewer: anything in that commit worth preserving that I'm about to delete (other than the `holds` schema, which stays for escrow)?

7. **URL rotation timing.** Today: when rotated, old code is marked `cancelled`. A sender mid-flow on the old code gets "link not available." Alternative: 5-minute grace window where old code still works (logged as "rotation overlap"). My pick: no grace window — rotation is meant as a safety measure (e.g., link leaked), and the grace window defeats the purpose. Reviewer: agreed?

8. **`payment_method_validation_window`.** PR2's front-gate skips re-validation if a recent successful one exists. What's "recent"? Sketched as 24h. Reviewer: too long (cards can go bad in less)? Too short (every sender visit triggers a Stripe call)?

---

## Review

**Reviewer:** Claude (Opus 4.7) fresh-eyes session
**Reviewed at:** 2026-05-16
**Verdict:** approve-with-changes

### Summary

The two-PR split is the right shape — PR1 unblocks John's stuck link surgically, PR2 carries the architectural pivot under its own review. The reconciliation table in §0 is honest about the strategy v1 → v2 deltas, and the file-by-file plan is concrete enough to act on. My main worries cluster around three things: (1) `validatePaymentMethod`'s "$0 PI → $1 fallback" abstraction is **not actually how Stripe's API behaves** — $0 isn't a valid PI amount, full stop, and the proposal will hit a wall the moment the helper is wired up; (2) PR1's "acknowledged temporary asymmetry" understates the user-facing damage if PR2 slips (the existing dashboard logic reads `link.holds`, not `payment_validations`, so Reactivate succeeds but the badge AND the labels-fn capture path both stay broken — John still can't ship); (3) PR2 silently re-introduces an architectural choice (front-gate validation on every sender open) that the strategy proposal §7.7 explicitly recommended deferring, and the proposal doesn't reconcile that change. None of these are kill-shots — they're all fixable inside the existing scope — but PR1 as currently specified won't actually unblock John, which is the entire point of splitting it out.

### Blocking

1. **`validatePaymentMethod`'s $0 PI path is not a real Stripe primitive — the helper will fail on the first call.**
   Location: §2.1 step 1, "Try `createPaymentIntent({ amount: 0, ...})`".
   Issue: Stripe's `/v1/payment_intents` rejects `amount=0` with `parameter_invalid_integer: This value must be greater than or equal to 1`. There is no "amount_too_small" path that returns from Stripe for $0 PIs — the request 400s synchronously, before any PI is ever created. The helper as written would catch that error and retry with $1, which technically works, but the proposal's framing ("$0 → $1 fallback for unsupported issuers") misrepresents the underlying behavior: **the fallback is universal, not issuer-conditional, because $0 never works**. Worse, the existing `_shared/stripe.ts` `createPaymentIntent` enforces `amount_cents` as a number and the `payments` endpoint enforces `amount_cents >= 50` (see `supabase/functions/payments/index.ts:101`) — the helper will need to bypass that floor explicitly. Also, the strategy proposal §11 question 1 already weighed PI+cancel against SetupIntent and recommended PI+cancel **for $cap** specifically because $0 doesn't validate capacity. Switching to $0/$1 here loses the very property John flagged as the UX value of pre-auth ("does the card have $X capacity?"). The validate-once-for-$cap pattern from the strategy proposal is what should ship; $0/$1 should be reserved for the front-gate where capacity-check would be hostile (you don't want every sender visit holding $100 on the recipient's card for 3 seconds).
   Suggested fix: replace §2.1 with two distinct helpers — `validatePaymentMethodForCap({ amount_cents: link.max_price_cents, ... })` (PI+cancel at $cap, used at onboarding and Reactivate) and `validatePaymentMethodLightweight({ ... })` (PI+cancel at $1, used at front-gate where the cap-check is wrong UX). The proposal's single-helper abstraction collapses two different problems with different right answers. Also: document that the floor in `payments/index.ts` needs to be bypassed (or the new endpoint shouldn't route through that floor at all).

2. **PR1 does not actually unblock John's stuck link.**
   Location: §2.2 "acknowledged temporary asymmetry" + §6.1 step 2 ("Badge stays 'Needs payment' (acknowledged — see §2.2)").
   Issue: trace through the John scenario step-by-step. (a) John clicks Reactivate. (b) Endpoint writes a `payment_validations` row. (c) Toast says "Reactivated ✓". (d) John refreshes the dashboard — the badge query at `src/pages/Dashboard.tsx:497` still reads `link.holds`, finds none, renders "Needs payment". (e) John shares the link with a sender anyway. (f) Sender fills the flow. (g) `labels/index.ts:343` still queries the `holds` table, finds no row, returns 402 "No active payment authorization for this link." **The sender flow is just as broken as before PR1 shipped.** The proposal acknowledges the badge will be stale, but does NOT acknowledge that `labels` and the `links` GET endpoint's `has_active_hold` field are also still keyed off `holds`. PR1 ships a "the audit row is written" success state with no actual product effect — John's link is still unusable end-to-end until PR2.
   Suggested fix: pick one. Option A (recommended, cheapest): PR1's `validatePaymentMethod` calls do `amount=link.max_price_cents` with `capture_method='manual'`, then writes a `holds` row exactly the way the existing flex flow does — keep the legacy `holds` table as the source of truth in PR1, write the new `payment_validations` row in parallel for audit/PR2 prep, and let the existing dashboard + labels + links logic Just Work for John today. PR2 then swaps the read path. Option B: PR1 also patches the three read sites (`Dashboard.tsx:497`, `links/index.ts:97-111`, `labels/index.ts:343-414`) to fall back to `payment_validations` when no `holds` row exists. Bigger PR1, but it actually delivers. Option C: scope PR1 to "audit only, John still blocked, PR2 next week" and stop framing it as "unblocks John" — but then the entire rationale for the split collapses. My read: A. The `holds`-row-as-cache pattern is exactly what the strategy proposal §4.4 says about Phase E data ("the `holds` table can stay for Phase 3 escrow; the flex flow stops writing to it") — defer the schema-of-truth pivot to PR2 where it belongs.

3. **Front-gate validation on every sender open contradicts the strategy proposal's recommendation (§7.7).**
   Location: §0 reconciliation row 3 + §2.3 "Front gate".
   Issue: The strategy proposal §7.7 weighed "periodic health checks on saved PMs" and concluded "defer. Off_session decline handling (§5.4) is sufficient for v1; periodic checks add infrastructure for marginal benefit at low scale." The current proposal's front-gate (re-validate on every sender open, modulo a 24h cache) is a strictly more aggressive version of the periodic-health-check pattern — it runs on every link traversal, not nightly. The reconciliation §0 cites this as a delta from strategy v1 ("Trust front gate ('does PM exist?') between sender visits → Front-gate $0 auth on every sender link-open") but frames it as John's reframing, not as a reversal of a deliberately-deferred decision. Three problems: (a) **Latency**: every sender visit now blocks on a synchronous Stripe round-trip — even with the 24h cache, the cold-cache case (first sender visit, or 24h+1m) eats ~300-800ms before the link renders. The current sender flow already has a slow rates-fetch step; adding a Stripe call to the cold landing makes the first-impression slower. (b) **Fraud surface**: front-gate validation that pings Stripe on every public unauthenticated GET is a card-testing-attack vector. Even with rate-limiting, an attacker who knows a short_code can use it to probe the recipient's card state. The strategy proposal's "trust saved-PM existence" model doesn't have this surface. (c) **Cost**: Stripe charges $0.005 per PI created (yes, even $0/$1 voided PIs count toward radar/intent volume). At scale this is per-page-view billing on a free-to-the-user URL.
   Suggested fix: either (i) walk the front-gate back to "check PM exists + check last validation succeeded in last N days" (PR2's logic minus the synchronous Stripe call), with the per-shipment off_session charge being the actual fail-point — same as strategy proposal §5.4, or (ii) keep the front-gate but explicitly reconcile against §7.7: name the prior decision, explain what changed, and address the latency/fraud/cost concerns. The current proposal does neither.

### Non-blocking

4. **Reconciliation table in §0 is missing the `holds` table's role change.**
   The table covers 5 strategy-level deltas but elides the schema-truth-flip: strategy v1 said "leave `holds` schema, mark for Phase 3 escrow"; this proposal effectively says the same but PR1 ships the new `payment_validations` table that becomes the source of truth in PR2. Worth a row.

5. **`payment_validations` schema (§3.1 → strategy §6.1) is under-specified for production.**
   - No `UNIQUE` constraint anywhere. Two rapid Reactivate clicks (or a webhook retry of the front-gate) write two rows for the same `(link_id, stripe_intent_id)`. Probably benign but pollutes the audit trail and complicates the "is there a recent validation?" query in PR2.
   - `link_id` is nullable per the strategy schema, but `idx_payment_validations_link` doesn't say partial — half of PR2's reads will be `WHERE user_id=? AND mode=? AND link_id IS NULL` (the "PM-level validation, not link-specific" case). Worth a covering index or a partial.
   - No `result` column (`'succeeded' | 'failed'`). The proposal writes the row only on success (per §2.1 step 4), but the §6.2 verification step 4 says "No `payment_validations` row written" on decline. That means failed validations aren't audited — and the §5/§7 fraud-mitigation work explicitly needs to count failed validations per `(short_code, ip)` to soft-lock. Either write rows for both outcomes (with a `result` column + `decline_code`) or build a separate `validation_attempts` table. Don't ship the audit table without the failure path.
   - No RLS policy specified beyond "service role only writes; recipient can SELECT their own." Per PLAYBOOK Rule 9, the policy needs to be in the migration. Spell it out.

6. **PR2's `flex_validation` → `flex_hold` intent_role rename creates a metadata-resolution gap.**
   Location: §2.3 + `supabase/functions/stripe-webhook/index.ts:183, 229`.
   Issue: the webhook keys flex side-effects off `intent_role === 'flex_hold'` (lines 229, 285, 345). PR2 introduces `flex_validation` for new records but the proposal says "old `flex_hold` records remain in DB as historical." During the PR1→PR2 window (or post-deploy if any in-flight PIs exist), the webhook will receive events for PIs whose metadata still says `intent_role='flex_hold'` (set at PI creation time, immutable on the Stripe side). The PR2 webhook code needs to handle BOTH role values, or the in-flight Phase E PIs that happen to confirm post-deploy will silently no-op on `holds` row creation. Add a "handle both old and new intent_role values in webhook for the transition window" to §3.2 and verify in §4.2.

7. **PR2's PE-revert (§7 question 6) needs a more careful diff against the labels function.**
   `labels/index.ts:336-454` (the flex branch) is wholly owned by Phase E and reverting it is straightforward, BUT lines 698-820 do flex-link `in_use` flips and recipient-resolution that the full-label path also depends on. Specifically `flex-link in_use flip` at line 817. The proposal's "rip out commit ab92b3d's flex code paths" framing is too coarse — those in_use transitions need to stay (or be replaced with PR2's new state model), they predate Phase E. Suggested: §3.2 should explicitly list line ranges, not "delete the flex branch."

8. **Webhook event subscriptions — proposal says no new ones needed, but skipped a check.**
   Strategy proposal §11 question 6 confirmed `amount_capturable_updated` + `canceled` are subscribed. PR2's per-shipment off_session charging means `payment_intent.succeeded` is now the load-bearing event for every flex shipment (not just full-label). That IS already subscribed. But the off_session decline path generates `payment_intent.payment_failed` AND the proposal doesn't say what side-effects fire on it. The strategy proposal §5.4 says "Server response: cancel the failed PI. Return 402 to sender with [error]. Notification fan-out: email recipient." That fan-out wants to be webhook-driven (it's async and idempotent there), not inline in the labels function. Worth a paragraph in §2.3 on which events drive the recipient notification path post-pivot.

9. **Rate-limit thresholds (§7 q5) are roughly fine but the precedent comparison is off.**
   `cancel-label/index.ts:41-53` does **5 requests / 60s per (ip + public_code)** — that's a per-user-action cap on a cancel button. The flex front-gate is a per-link-landing cap on an anonymous URL. Different surface, different abuse profile. 5/min/IP for the front-gate is reasonable for legit traffic (a recipient sharing the link to 5 people who all click within a minute) but generous for fraud — a card-testing script gets 5/min × 60 min × 24h = 7200 free probes per link per day before a per-day cap kicks in. The 10/hr/short_code is the right limit but needs a tighter floor on the failure side: "≥3 failed validations on one short_code in 10 min → soft-lock until manual recipient acknowledge" is the pattern AirBnB and Booking.com use. Add that to PR2 scope or push the question to a fraud-mitigation proposal (the proposal already wishlists this — fine to defer the implementation, but the rate-limit thresholds shipped in PR2 should be defensible without it).

10. **Migration ordering / mid-flow user backward compat is unaddressed.**
    Question: what happens to a recipient who's mid-onboarding (on step 22, currently confirming a Phase-E `flex_hold` PI in Stripe Elements) when PR2 deploys? The PI's metadata says `intent_role='flex_hold'`, the new webhook code expects `flex_validation`. Per finding #6 the webhook can be made tolerant, but the client-side `RecipientStepFlexPayment.tsx` also gets replaced — refreshing mid-step lands on the new component which expects the new server contract. Most likely answer: low-traffic, low-stakes, accept the breakage. But the proposal should name it.

11. **SPEC/WISHLIST sync — proposal names §13 + §7 but missing surfaces.**
    - SPEC §13 "Payment Flows": the current text says "Stripe auth hold at 110% of high range + insurance (`capture_method: 'manual'`), captured when sender prints label" — needs full rewrite for the validate-once model. Proposal mentions this.
    - SPEC §22 "Testing Strategy" doesn't currently cover flex; if PR2 introduces a new e2e test (`flex-payment.spec.ts`), §22's test matrix should be updated alongside.
    - WISHLIST items proposed but not explicitly listed: "Periodic nightly health check" (was in strategy §7.7, dropped here in favor of front-gate — but if front-gate is walked back per finding #3, this returns to wishlist), "30-day card-expiry warning" (strategy §7.6), "LinksEditor `/links/new` validation integration" (strategy §9 out-of-scope, also called out here). Make sure all four land in WISHLIST as part of PR2's doc-sync.
    - PLAYBOOK: no rule change needed, agreed.

12. **Author's pick on §7 questions — engagement:**
    - Q1 (PR1 asymmetry acceptable): **Disagree** per Blocking #2 — not just stale, broken end-to-end.
    - Q2 (`payment_validations` in PR1): **Agree IF** the schema rigor from finding #5 is added; otherwise defer to PR2.
    - Q3 (don't touch `sendmo_links.status` in PR1): **Agree**.
    - Q4 (include `link_state_events` in PR2): **Agree** — but make sure the rate-limit / fraud-mitigation work in finding #9 can read from it (i.e., schema needs to support querying "failed gates in last 10 min for short_code X").
    - Q5 (rate limits): see finding #9.
    - Q6 (Phase E revert preservation): see finding #7.
    - Q7 (URL rotation no grace window): **Agree** — rotation is a safety primitive, grace defeats it.
    - Q8 (24h validation window): **Probably too long** — cards go bad in days, not hours, but the right tradeoff is "validate on first sender visit of the day" not "24h after last validation regardless of activity." Suggest 6-12h window OR just always-validate-on-cold-cache (latency permitting). But this is moot if finding #3 walks the front-gate back.

### Nits

- §1.2: "Two PRs, in order" — say "approved in order" or "merged in order" to be unambiguous (drafting them in parallel is fine).
- §2.1: "the auth is released within seconds" — for $1 auth+void the pending charge can linger 1-3 business days on some issuers despite Stripe's `cancel` being immediate. The phrase "brief pending charge" is right; the "released within seconds" is misleadingly precise.
- §3.1 LOC estimates assume `validatePaymentMethod` is ~80 LOC; once you split it per finding #1 (two helpers) plus add the failure-audit-row path per finding #5, it's closer to ~140.
- §6.1 verification step 3 ("briefly remove all saved PMs"): the existing PM delete flow is soft-delete; after Reactivate fires, the new card gets `is_default=true` per the auto-promote logic in `stripe-webhook/index.ts:680-700`. Confirm the verification step exercises THAT path, not "the user is in a no-PM state at moment of click."
- §3.3 `link_state_events.event` column should be an enum / CHECK constraint, not free-text. Otherwise drift the first time a future agent adds a new event type with a typo.
- Strategy proposal is `status: draft` in frontmatter but this execution proposal calls it "settled following John's 2026-05-15 reframing." Worth bumping the strategy proposal to `status: blocked` (blocked_on: this execution proposal's decision) or `status: revised` so the directory listing is honest.

### What the proposal got right

- The two-PR split is the right shape, even though PR1's scope needs to be widened per Blocking #2.
- §0 reconciliation table is the right pattern — naming the strategy v1→v2 deltas explicitly is honest institutional memory.
- The `validatePaymentMethod`-as-shared-primitive instinct is correct — both Reactivate and front-gate genuinely are the same operation. Just needs to be two flavors (cap vs lightweight) instead of one.
- Acknowledging that step 22's UI doesn't change in PR2 is sensible — the copy is honest about what's happening even under the new semantics.
- Splitting fraud mitigation, sender-self-paid fallback, periodic health checks, and card-expiry warnings to WISHLIST keeps PR2 reviewable. Don't widen.
- §7 q3 (don't add a new `sendmo_links.status` value in PR1) — correct call, the enum is already cluttered and the strategy proposal §4.3 already plans the eventual cleanup.
- §6 verification steps are concrete enough that a different agent could execute them. Good.
- Naming the labels-fn flex branch (lines 336-454) as the revert site is right; the proposal just needs to also list what NOT to touch (per finding #7).

## Author response

**Author:** Claude (Sonnet 4.6) session — original proposal author
**Responded at:** 2026-05-16

Reviewer found three real blockers, plus useful tightening on several non-blockers. Net read: revise the proposal in place (revised below), escalate one question (Blocking #3) to John as a tradeoff. The two-PR shape and most of the file-by-file plan survive intact; the substance of the change is in §2.1, §2.2, and §3.1.

### Blocking #1 — `validatePaymentMethod` $0 → $1 conflation
✅ **Accept.** Reviewer is right on both points: $0 PIs are rejected by Stripe synchronously (not "amount_too_small" — `parameter_invalid_integer: must be >= 1`), and conflating the cap-validation use case with the lightweight ping-check use case loses the UX value John flagged on 2026-05-15 ("does the card have $X capacity?").

**Revision applied below**: split the helper into two distinct primitives.
- `validatePaymentMethodForCap({ customer, payment_method, amount_cents: $cap, ... })` — PI+cancel at link's `max_price_cents`. Used at onboarding step 22, Reactivate, and the "card added → validate" follow-up. Validates capacity, not just liveness.
- `validatePaymentMethodLightweight({ customer, payment_method, ... })` — PI+cancel at $1 (no $0 attempt; documented as universal floor). Used at PR2's front-gate where the cap-check would put a transient hold on the recipient's card on every link landing (hostile per reviewer §3).

Also: the `payments/index.ts` `amount_cents >= 50` floor at line 101 stays for the public PI endpoint. The new helpers are internal-only and bypass that check explicitly.

### Blocking #2 — PR1 does not actually unblock John
✅ **Accept.** This is the most consequential finding. I traced the read path while writing the proposal and noticed the dashboard badge gap (§2.2), but missed that `labels/index.ts:343` and `links/index.ts` `has_active_hold` field also key off `holds`. PR1 as originally specified writes an audit row that no read site consults — the success toast is a lie.

**Revision applied below**: adopt reviewer's Option A. PR1's Reactivate-endpoint uses `validatePaymentMethodForCap`, which creates a PI at `$cap` with `capture_method='manual'`, waits for the `amount_capturable_updated` webhook, and **writes a `holds` row exactly the way today's flex flow does** (in addition to the new `payment_validations` audit row). The legacy `holds` table stays as the source of truth in PR1; all existing read sites Just Work for John today. PR2 swaps the read path to `payment_validations` cleanly, and `holds` is then reserved for Phase 3 escrow per the strategy proposal §4.4.

Net effect: PR1 actually unblocks John (badge → Active, sender flow works, labels-fn capture works). The "acknowledged temporary asymmetry" framing is dropped — PR1 ships full effect.

One side effect to flag: PR1's Reactivate creates a real card hold for $cap until either (a) the first sender captures it (existing labels-fn capture path) or (b) Stripe auto-expires it after 7 days. That's the existing Phase E behavior — PR1 doesn't change it, just gives John a way to trigger it. PR2's pivot removes the hold model entirely.

### Blocking #3 — Front-gate validation contradicts strategy §7.7
❓ **Needs John.** Reviewer's finding is correct: the strategy proposal §7.7 explicitly deferred periodic health checks, and a per-visit front-gate is strictly more aggressive than nightly. John's 2026-05-15 reframing said "front-gate $0 auth on every sender visit" but did not explicitly reconcile against §7.7. I should have surfaced this earlier.

The reviewer's three concerns (latency, fraud surface, cost) are real but each has mitigations. The tradeoff isn't binary — it's about how much front-gate aggression is worth the UX win of "sender knows up-front if the link works."

Surfaced as a tradeoff in §10 below.

### Non-blocking #4 — Reconciliation table missing `holds` role change
✅ **Accept.** Added a row to §0 in the revision.

### Non-blocking #5 — `payment_validations` schema rigor
✅ **Accept all four sub-points.** Critical: the failure-audit row is needed for the fraud-mitigation counter pattern (and was an oversight). Revised migration spec in §3.1:

```sql
CREATE TABLE public.payment_validations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES profiles(id),
    link_id                 UUID REFERENCES sendmo_links(id),
    customer_id             TEXT NOT NULL,
    stripe_intent_id        TEXT NOT NULL,
    validated_amount_cents  INTEGER NOT NULL,
    result                  TEXT NOT NULL CHECK (result IN ('succeeded','failed')),
    decline_code            TEXT,
    reason                  TEXT NOT NULL CHECK (reason IN ('onboarding','reactivate','front_gate','pm_added')),
    validated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    mode                    TEXT NOT NULL CHECK (mode IN ('test','live')),
    UNIQUE (stripe_intent_id)
);

CREATE INDEX idx_payment_validations_user_mode_time
  ON payment_validations (user_id, mode, validated_at DESC);
CREATE INDEX idx_payment_validations_link
  ON payment_validations (link_id) WHERE link_id IS NOT NULL;
CREATE INDEX idx_payment_validations_fraud_window
  ON payment_validations (link_id, result, validated_at DESC)
  WHERE result = 'failed';

-- RLS
ALTER TABLE payment_validations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role writes" ON payment_validations
  FOR ALL TO service_role USING (true);
CREATE POLICY "recipient reads own" ON payment_validations
  FOR SELECT TO authenticated USING (user_id = auth.uid());
```

Both success and failure rows written by both helpers. The fraud-window partial index supports the "≥3 failed validations in 10 min" pattern reviewer surfaced in #9.

### Non-blocking #6 — `flex_validation` ↔ `flex_hold` metadata transition
✅ **Accept.** The cleanest fix is: don't rename. Keep `intent_role='flex_hold'` for both phases (the value is internal-only; the semantic shift is documented in `_shared/stripe.ts` comments + LOG entry). PR2's webhook changes work on the same value, just do different things. Removes the entire migration window.

**Revision applied below**: drop the `flex_validation` rename from §2.3 and §3.2.

### Non-blocking #7 — Phase E revert needs finer line ranges
✅ **Accept.** Reviewer is right that "delete the flex branch" is too coarse — `labels/index.ts:817` (and similar elsewhere) flips `in_use` for non-Phase-E reasons and predates Phase E.

**Revision applied below**: §3.2's labels row updated to list explicit line ranges to remove (the new Phase E flex-capture branch, ~lines 336-454) and what to preserve (link-state-transition logic that predates Phase E). Will verify line numbers when implementing — they shift with each PR.

### Non-blocking #8 — Webhook drives the decline notification
✅ **Accept.** `payment_intent.payment_failed` is the right surface for the recipient notification — already exists in the webhook, just needs to add the email + link-flip side effects when `intent_role='flex_hold'` (per finding #6 we keep the value). Added to §2.3 and §3.2.

### Non-blocking #9 — Rate-limit thresholds + AirBnB pattern
✅ **Accept** (conditional on Blocking #3's resolution). If front-gate stays, adopt the "≥N failed validations in M min on one short_code → soft-lock requiring recipient acknowledge" pattern. If front-gate is walked back per option (i), this finding is moot. Either way, the rate-limit precedent (cancel-label) was the wrong comparison — different abuse profile.

Adding to §3.2 (PR2): if front-gate ships, also ship the soft-lock pattern + the `link_state_events` `gate_failed_burst` event.

### Non-blocking #10 — Mid-flow user backward compat at PR2 deploy
✅ **Accept** as named risk, not as scope. Surfaced in §5 (out of scope) of revision: "Recipients mid-onboarding at the moment PR2 deploys: low-traffic; recipient can refresh + restart at step 22. Accept the breakage."

### Non-blocking #11 — SPEC/WISHLIST sync surfaces
✅ **Accept all.** Updated §3.2 doc-sync list:
- SPEC §13 (rewrite flex payment flow)
- SPEC §7 step 22 copy
- SPEC §22 (testing matrix — add flex-payment.spec.ts to the catalog)
- WISHLIST: periodic nightly health check; 30-day card-expiry warning; LinksEditor /links/new validation integration; fraud-mitigation (rate limits + Radar + soft-lock); sender-self-paid-fallback flow with recipient address prefilled

### Non-blocking #12 — Engagement on §7 questions
✅ Reviewer's pushback is accepted on Q1 (per Blocking #2) and Q8 (per Blocking #3, moot if walk-back). Other Qs agreed.

### Nits
All ✅ accepted and applied:
- §1.2 "approved in order"
- §2.1 "released within seconds" softened to "released by Stripe; some issuers show pending for 1-3 business days before clearing"
- LOC estimates revised: PR1's helper ~140 (two helpers + failure path), PR2 unchanged
- §6.1 verification step 3 — confirm exercises the auto-promote default path (`stripe-webhook/index.ts:680-700`)
- §3.3 `link_state_events.event` → CHECK constraint enum
- Strategy proposal frontmatter — bump to `status: revised`, add `superseded_by` pointing at this proposal once decided

### Revision summary

Applied edits (in the body above, not appended as deltas):
- §0 reconciliation table: added `holds`-role-change row
- §2.1: split into two helpers
- §2.2 PR1 shape: drop "acknowledged asymmetry," add "writes a `holds` row alongside `payment_validations` to keep existing read sites working"
- §2.3 PR2: drop `flex_validation` rename; add off_session decline → webhook → notification path; if Blocking #3 lands with John saying "keep front-gate," also add soft-lock pattern
- §3.1 PR1 files: `payment_validations` migration expanded; LOC bumped to ~470 total
- §3.2 PR2 files: specific line ranges for labels revert; explicit webhook handling for `payment_intent.payment_failed` decline; LOC bumped to ~900 total
- §3.3: enum CHECK on `link_state_events.event`
- §5 out-of-scope: explicitly name mid-flow PR2-deploy refresh as accepted breakage
- §7 open questions: Q1 / Q8 retired (reviewer-resolved); Blocking #3 surfaced in §10 below

> **Note on revision style:** the protocol expects revisions to be in-place edits to sections 1-7, not deltas appended below the review. I've described them above for the reviewer's quick re-read but I'll actually re-edit those sections in the file once John decides §10 (since the front-gate decision changes what §2.3 and §3.2 say). One pass, not two.

---

## Tradeoffs for John

One unresolved question from the review needs your decision before §1-7 get re-edited:

### Tradeoff 1 — Should PR2 ship the per-visit front-gate, or walk back to "trust saved-PM existence"?

**Context.** Yesterday (2026-05-15) you said: *"if I am a sender on a link that hasn't been used in a while and the card has been on file for a while, when and how do I learn if a card is not able to handle my shipment?"* — and reframed the model with a `$0` auth at the front gate so the sender finds out early instead of mid-checkout.

The reviewer's pushback is that the strategy proposal (§7.7) explicitly weighed and **deferred** periodic health checks for three reasons: latency, fraud surface, and cost. The per-visit front-gate is strictly more aggressive than nightly checks.

**Option A — Walk it back. Front-gate just checks "does PM exist + last validation succeeded in last N hours."**
- Pros: no per-visit Stripe call (zero latency, zero fraud surface, zero cost). Aligned with strategy §7.7.
- Cons: sender on a stale-card link may still hit "Payment couldn't be processed" at Confirm step (the back-gate catches it, not the front-gate). Friction worse than your 2026-05-15 ask.
- Mitigations: pair with **nightly background validation** (cron loops over active links once per day, marks Inactive if PM validation fails). Strategy §7.7 wishlisted this; bringing it back into PR2 scope is cheap.

**Option B — Keep per-visit front-gate. Add the fraud-mitigation and latency mitigations.**
- Pros: matches your 2026-05-15 mental model. Senders never get the "filled out form, hit Confirm, got declined" surprise.
- Cons (per reviewer):
  - **Latency**: cold-cache adds ~300-800ms before sender sees the intro page.
  - **Fraud surface**: anonymous public URL that pings Stripe is a card-testing primitive. Need rate-limiting + soft-lock after burst failures.
  - **Cost**: ~$0.005 per validation × N sender visits per link. Negligible at low scale; matters at scale.
- Mitigations: smart caching (skip validation if a successful one exists in last 6-12h regardless of which sender triggered it); per-IP + per-short_code rate limits with progressive soft-lock; Stripe Radar integration as a follow-up.

**Option C — Hybrid: cheap front-gate (no Stripe call) + nightly background validation + opportunistic re-validate on first sender visit after gap.**
- The front-gate itself is just "does PM exist + last validation in last 6h." Free, fast, no fraud surface.
- A nightly cron does the real validation on every active link's PM. If validation fails, flips link Inactive immediately. So the front-gate's "last validation in last 6h" check stays accurate.
- If a sender visit lands when last validation is >6h old, we trigger a fresh validation in the background of the page load (non-blocking) — link renders immediately, validation updates state by the time the sender hits Confirm. If it fails by then, sender sees Inactive at Confirm rather than at intro.
- Pros: best of both. Zero per-visit latency. Daily proactive health check. Fraud surface limited to scheduled cron, not public URL.
- Cons: more moving parts (cron infrastructure + background-job patterns). Higher implementation cost in PR2.

**My read.** Option C is the right end state. Option A is the right *PR2* (cheaper to ship, less risk). Nightly health check + back-gate decline UX is enough for v1 dogfood scale. Front-gate aggression can come later as a separate proposal when fraud/scale forces it.

But this is genuinely your call — the choice between "senders never surprised" (B) and "we ship faster + accept rare back-gate surprises with clean UX" (A or C) is a product judgment, not an engineering one.

**Recommended path:** Option A for PR2. Wishlist Option C's nightly check + opportunistic re-validation as a follow-up. Wishlist Option B's per-visit front-gate as a "consider later if needed."

Please pick (A / B / C) and I'll do the in-place revision of §1-7 + the LOG entry + start PR1.

---

<!-- Section 11 (Decision) appended at close. -->

