---
title: Flex payment execution — PR1 (Reactivate) + PR2 (Active/Inactive pivot)
slug: flex-payment-execution-pr1-pr2
project: sendmo
status: in-review
created: 2026-05-16
last_updated: 2026-05-16
reviewed: null
decided: null
author: Claude (Sonnet 4.6) session — author of yesterday's strategy proposal; this execution plan folds in John's 2026-05-15 reframing (Active/Inactive binary, front-gate $0 auth)
reviewer: null
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

<!-- Sections 8-11 (Review, Author response, Tradeoffs for John, Decision) appended as the proposal progresses. -->
