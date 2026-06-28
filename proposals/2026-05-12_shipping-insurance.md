---
title: Real shipping insurance — declared value, EasyPost coverage, SendMo markup
slug: shipping-insurance
project: sendmo
status: in-review
created: 2026-05-12
last_updated: 2026-05-12
reviewed: null
decided: null
author: Claude Opus 4.7 — full-label shipping-step audit
reviewer: null
outcome: null
---

## 1. Context

The "Add shipping insurance" toggle on the full-label shipping step ([RecipientStepFullShipping.tsx:341-358](../src/components/recipient/RecipientStepFullShipping.tsx)) is **cosmetic**. We collect a flat $2.50 from the user ([api.ts:370](../src/lib/api.ts), [useRecipientFlow.ts:184](../src/hooks/useRecipientFlow.ts)) but the `/buy` call to EasyPost ([labels/index.ts:441](../supabase/functions/labels/index.ts)) never passes an `insurance` field. **No coverage is bound.** The shipment goes out with only whatever carrier-default coverage it would already have had (USPS Priority $100, FedEx/UPS Ground $100). If a package is lost or damaged, the customer has no claims path through us. That's a phantom charge and a trust/legal exposure as we move from comp to live charges.

This proposal replaces the dummy toggle with a real insurance product:

- Add a **declared value (USD)** field to the package-information block.
- The Magic Guestimator infers declared value from the user's item description and pre-fills it.
- The insurance toggle becomes gated by a non-zero declared value; when on, we pass `insurance: <declaredValue>` to EasyPost's `/buy` call so coverage actually binds.
- Pricing: **SendMo charges `$3.00 + 0.5%` of declared value**; we pay EasyPost `1%` (min $1.00); margin = the difference. See §2.4 for the math and where this formula breaks.
- Customer-facing copy is explicit: **coverage provided by EasyPost; SendMo facilitates the claim.** §2.5 covers the claims SOP.

This is **scoped to the full-label flow only** for v1. The flex-link sender wizard ([SenderFlow.tsx](../src/pages/SenderFlow.tsx)) does not currently expose any insurance UI; extending it there is a follow-up after we've seen real claims volume.

## Reconciliation with prior decided proposals

- **Stripe integration plan §11 #1 (decided 2026-05-11):** "refund destination = original card." Honored. Insurance payouts to customers are a separate motion (claims disbursement, §2.5 §3.5), not a Stripe refund. They route through the EasyPost-payout → SendMo-balance → customer path, not back through the original PI.
- **Stripe integration plan §11 #2 (decided 2026-05-11):** "$1 flat fee." That's the SendMo *shipping* margin baseline. Insurance is priced separately and additively per the formula in §2.4. The two fees are visible as separate line items in the price summary so customers can see what they're paying for.
- **Sender-flow wizard Round 2 (decided 2026-05-11):** the full-label wizard step structure is settled. This proposal adds one field to the package-information card and one transformation of the insurance toggle's behavior — no new wizard steps.
- **Account-creation timing (decided 2026-05-11):** the user is verified (Supabase auth) before they reach the shipping step. We can attach `declared_value_cents` and `insurance_cost_cents` to the `payments` row with the user's identity already established. No anonymous-payment-with-insurance edge case to handle.

## 2. Architecture

### 2.1 The four moving pieces

```
[Magic Guestimator]                     [Manual fields]
        │                                     │
        ▼                                     ▼
  declared_value_usd (number, default 0)
        │
        ▼
  [Add shipping insurance ◯] ← disabled when declared_value_usd === 0
        │
        ▼ on
  Premium = round_cents($3.00 + 0.005 × declared_value_usd)
        │
        ▼ at /buy
  EasyPost POST /v2/shipments/<id>/buy { rate, end_shipper_id, insurance: declared_value_usd }
        │
        ▼ on success
  shipments.declared_value_cents = declared_value_usd × 100
  shipments.insurance_cost_cents = premium
  shipments.insurance_easypost_id = buyData.insurance.id  (new column — see §3.1)
```

### 2.2 New state field

[`useRecipientFlow.ts`](../src/hooks/useRecipientFlow.ts) gains `declared_value: number` (dollars, default 0). The existing `insurance: boolean` toggle stays, but its semantics tighten: `insurance === true && declared_value === 0` is invalid and the Continue button disables with the message "Set a declared value to add insurance." Validation in [`validateRecipientFlow`](../src/hooks/useRecipientFlow.ts:130) gets one new rule:

```typescript
if (state.insurance && state.declared_value <= 0) {
  errors.push("Insurance requires a declared value greater than $0");
}
if (state.declared_value > 5000) {
  errors.push("Declared value cannot exceed $5,000");  // EasyPost's standard ceiling
}
```

The $5,000 cap matches EasyPost's "standard coverage" tier — above that they require a separate quote process. Out of scope for v1.

### 2.3 UI changes

[`RecipientStepFullShipping.tsx`](../src/components/recipient/RecipientStepFullShipping.tsx):

- **Package information card** (existing) gains a "Declared value (USD)" input below the weight fields. Label tooltip: "What's the item worth if lost or damaged? Used to set shipping insurance coverage."
- **Insurance card** (existing) restructures to:

```
┌──────────────────────────────────────────────────────────────┐
│ Add shipping insurance                                  [ ◯ ]│
│ Premium: $3.50  (covers up to $100 declared value)           │
│ Coverage provided by EasyPost; SendMo facilitates claims.    │
└──────────────────────────────────────────────────────────────┘
```

- When declared value is 0: toggle is **disabled** with helper text "Enter a declared value above to enable insurance."
- When declared value is set: toggle is **enabled**; premium and coverage line update live as the field changes.
- "Coverage provided by EasyPost..." is a small one-line disclosure with a `(?)` info tooltip that expands to: "If your package is lost or damaged in transit, file a claim with SendMo within 30 days. We submit it to EasyPost (the underlying coverage provider) and pass any payout through to you. Typical resolution: 30–60 days."

[`MagicGuestimator.tsx`](../src/components/recipient/MagicGuestimator.tsx) gains a `declared_value_usd` field in the tool schema (see §3.4). On a successful guesstimate, [`onResult`](../src/components/recipient/RecipientStepFullShipping.tsx) sets `declared_value` alongside the existing dimensions/weight. The user can override.

[`RecipientStepPayment.tsx:274`](../src/components/recipient/RecipientStepPayment.tsx) — the price-summary block — gets a new line "Insurance ($X.XX declared value)" with the computed premium. The existing `state.insurance && ...` conditional is reused.

### 2.4 Pricing formula — and where it breaks

Per the requirement: charge `$3.00 + 0.005 × declared_value_usd`; pay EasyPost `max($1.00, 0.01 × declared_value_usd)`.

| Declared value | SendMo charges | EasyPost cost | Margin |
|---:|---:|---:|---:|
| $50  | $3.25  | $1.00 | $2.25 |
| $100 | $3.50  | $1.00 | $2.50 |
| $250 | $4.25  | $2.50 | $1.75 |
| $500 | $5.50  | $5.00 | $0.50 |
| $600 | $6.00  | $6.00 | **$0.00** |
| $1000 | $8.00 | $10.00 | **−$2.00** |
| $5000 | $28.00 | $50.00 | **−$22.00** |

**The formula crosses into loss at ~$600 declared value.** Three responses, only one of which I think is right:

- **(a) Cap declared value at $500.** Hard ceiling. Simplest. Forfeits the higher-value market entirely.
- **(b) Switch to `$3.00 + 1.5%`** so we always net at least 0.5% above EasyPost. At $100 user pays $4.50 (vs $3.50), at $500 user pays $10.50 (vs $5.50). User-visible price ~doubles.
- **(c) Tier the formula** — use $3 + 0.5% up to $300, switch to $3 + 1.5% above $300. Cleaner cost curve, more complex to explain.

**Author lean: (b).** A consistent formula is easier to defend to the user ("$3 base + 1.5% of value, $1 of which is the EasyPost cost") than a kink at $300. The $3 base is the part that genuinely covers payment processing on small declared values; the percentage scales with risk and EasyPost's underlying cost. 1.5% gross / 0.5% net is conservative but not aggressive. If we want to be more aggressive later that's a price tweak, not a restructure.

**§7 OQ#1 surfaces this as a tradeoff** because John explicitly asked for $3 + 0.5% and the math doesn't sustain.

### 2.5 Claims — what we're signing up for

When a customer's insured package is lost or damaged, they contact SendMo. Today there's no email or support inbox; v1 of this proposal includes a single-purpose `claims@sendmo.co` mailbox (forwarder to John initially) and an in-page "Report a problem" button on `/t/<public_code>` that opens a `mailto:` to that address with a pre-filled subject containing the public_code. Out of scope: a real claims portal, structured intake form, claim-status tracking UI. The pipe today is: customer email → John reads → John files with EasyPost → EasyPost pays → John refunds customer through their original Stripe card.

The disclosure copy commits us to this pipe. We should not promise faster than "30–60 days" because EasyPost's resolution is typically 30 days and we want a buffer for our own ops. If the customer asks "when do I get paid?" the answer is "after EasyPost resolves the claim, we pass the payout to you within 5 business days."

**Float exposure:** EasyPost pays us after they resolve. If we want to pay the customer faster (good for trust), we float the payout. At low volume that's fine; at scale it's a working-capital line item. v1 does not commit us to fronting payouts — the disclosure says "we submit and pass through," which honestly describes "you wait for EasyPost."

**Legal / regulatory check (§7 OQ#3):** marking up an insurance product can in some US states require an insurance-agent license. Pass-through resale (we bill what EasyPost bills us) is generally safe; markup is the gray area. The shape we're proposing — EasyPost is the named coverage provider on customer-facing copy, we describe ourselves as "facilitating," our markup is bundled as a service fee — is the standard reseller posture and is what most shipping platforms (Pirate Ship, Shippo) do. But before we go live with markup on real charges, John or a lawyer should confirm:

1. EasyPost's API TOS allows reselling insurance with markup.
2. CA/NY/TX (the three states with the most regulatory bite on insurance) consider our posture pass-through-with-fee rather than insurance-broker activity.

This is a 30-minute legal-eagle review, not a multi-week engagement. It blocks **go-live**, not implementation.

### 2.6 What gets persisted

[`shipments` table](../supabase/migrations/) gets three new columns:

```sql
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS declared_value_cents INTEGER,
  ADD COLUMN IF NOT EXISTS insurance_cost_cents INTEGER,
  ADD COLUMN IF NOT EXISTS insurance_easypost_id TEXT;
```

- `declared_value_cents` — what the customer told us the item is worth (in cents to match the rest of the schema).
- `insurance_cost_cents` — what we charged the customer (renamed if needed; `insurance_cost_cents` already exists in [`Admin.tsx:21`](../src/pages/Admin.tsx); verify it's a real column or if Admin.tsx is reading a derived field). The admin page already renders this column ([Admin.tsx:399](../src/pages/Admin.tsx)) so the data model has been anticipated.
- `insurance_easypost_id` — `buyData.insurance.id` from EasyPost's response. Needed when we file a claim against it later.

If `insurance_cost_cents` already exists as a column, this migration drops to two new fields. Confirm in §3.1.

### 2.7 EasyPost wire format

[`supabase/functions/labels/index.ts:441`](../supabase/functions/labels/index.ts) — the `/buy` call gains an `insurance` field when the request body includes a declared value:

```typescript
const buyBody: Record<string, unknown> = {
  rate: { id: easypost_rate_id },
  end_shipper_id: endShipperData.id,
};
if (declared_value_cents && declared_value_cents > 0) {
  buyBody.insurance = (declared_value_cents / 100).toFixed(2);  // EasyPost expects USD string
}
```

EasyPost's response includes `insurance` as a sibling of `tracking_code` with `id` and `amount` fields. Persist `id` into `shipments.insurance_easypost_id` alongside the existing rate-cost persistence ([labels/index.ts:596](../supabase/functions/labels/index.ts)).

### 2.8 Where the premium actually charges

Today the displayed total in [`useRecipientFlow.ts:184`](../src/hooks/useRecipientFlow.ts) is `display_total = rate_with_margin + 250¢ if insurance`. After this proposal:

```typescript
const insurancePremiumCents =
  state.insurance && state.declared_value > 0
    ? Math.round(300 + state.declared_value * 100 * 0.015)  // §2.4 formula (b)
    : 0;
return rateCentsWithMargin + insurancePremiumCents;
```

The same `insurancePremiumCents` is what gets passed to [`payments/index.ts`](../supabase/functions/payments/index.ts) as part of the `amount_cents`, and what gets persisted into `shipments.insurance_cost_cents` so the admin report (P&L) is accurate.

## 3. File-by-file plan

### 3.1 Migration: declared value + insurance bookkeeping

[`supabase/migrations/018_insurance.sql`](../supabase/migrations/) (new — confirm next number based on what 017 landed as):

```sql
-- Declared value: user-attested item worth used to set insurance coverage
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS declared_value_cents INTEGER;

COMMENT ON COLUMN public.shipments.declared_value_cents IS
  'Declared value in cents. Source: user input on shipping step. NULL when insurance not opted into.';

-- EasyPost insurance object ID — needed to file claims later
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS insurance_easypost_id TEXT;

COMMENT ON COLUMN public.shipments.insurance_easypost_id IS
  'EasyPost insurance object id (e.g. ins_xxx) returned from POST /shipments/:id/buy when insurance was requested. Used to file claims via POST /insurances/:id/refunds.';

-- insurance_cost_cents may already exist — admin UI references it. Conditional add:
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS insurance_cost_cents INTEGER;
```

Validation in §6 verifies `insurance_cost_cents` either already exists (in which case the third `ADD` is a no-op) or is being added now. If admin.tsx was reading a column that doesn't exist (silently null), this migration is the moment we make the field real.

### 3.2 Flow state

[`src/hooks/useRecipientFlow.ts`](../src/hooks/useRecipientFlow.ts):

- Add `declared_value: number` (USD; default 0) to `RecipientFlowState`.
- Update initial state and `useReducer` paths.
- Update `validateRecipientFlow` per §2.2.
- Update `getTotalPriceCents` to compute insurance premium via §2.4 formula (b).

[`src/contexts/RecipientFlowContext.tsx`](../src/contexts/RecipientFlowContext.tsx): mirror the same field addition. (This file and `useRecipientFlow.ts` carry duplicated shape — proposal `links-manager` already noted this duplication; out of scope to unify here.)

### 3.3 UI

[`src/components/recipient/RecipientStepFullShipping.tsx`](../src/components/recipient/RecipientStepFullShipping.tsx):

- Add the declared-value input to the package-information card. Reuse the existing `Input` shadcn component pattern. Label: "Declared value (USD)". `inputMode="decimal"`. Helper text below: "What it's worth if lost/damaged."
- Replace the existing static insurance card with the dynamic version from §2.3:
  - Compute `insurancePremiumCents` inline from `state.declared_value`.
  - Disable the Switch when `state.declared_value <= 0`.
  - Render the premium amount and coverage cap (= declared value) live.
  - Render the disclosure line with an info tooltip (reuse [`ui/tooltip`](../src/components/ui/tooltip.tsx) — verify it's wired up; if not, the disclosure is plain inline text for v1).

[`src/components/recipient/RecipientStepPayment.tsx`](../src/components/recipient/RecipientStepPayment.tsx):

- The existing `{state.insurance && ...}` block now reads `state.declared_value` and shows a richer line: "Insurance ($X declared value): $Y.YY". Same conditional gate.

### 3.4 Guestimator: tool-schema extension

[`supabase/functions/guestimate/index.ts`](../supabase/functions/guestimate/index.ts):

- Add `declared_value_usd: { type: "number", description: "Estimated retail value of the item in USD. Use replacement cost for common items; use marketplace value (eBay/Etsy median) for collectibles. Round to nearest dollar." }` to the tool's `input_schema.properties`.
- Add `"declared_value_usd"` to the `required` array.
- Update `SYSTEM_PROMPT` with one bullet: `- declared_value_usd: estimate the item's retail/replacement value. Be conservative — underestimating limits coverage; over-estimating raises the premium unnecessarily. For "gift"/"stuff"/vague, default to 50.`

[`src/lib/api.ts`](../src/lib/api.ts) — the `GuestimateApiResult` interface gains `declared_value_usd: number`. Backward-compat: old responses that lack the field are treated as `declared_value_usd: 0` (the consumer-side default).

[`src/lib/types.ts`](../src/lib/types.ts) — `GuestimatorResult` gains `declaredValueUsd: number`.

[`src/components/recipient/MagicGuestimator.tsx`](../src/components/recipient/MagicGuestimator.tsx) — pass `declaredValueUsd: est.declared_value_usd ?? 0` into `onResult`.

[`RecipientStepFullShipping.tsx`](../src/components/recipient/RecipientStepFullShipping.tsx) — the `onResult` handler that today writes packaging/length/width/height/weight from the guesstimate also writes `declared_value: result.declaredValueUsd`. Auto-toggles `insurance: true` when `result.declaredValueUsd >= 50` (heuristic — anything cheap probably doesn't warrant the premium; user can flip the toggle if they disagree). §7 OQ#2 surfaces whether auto-on is the right default.

### 3.5 Labels function: pass insurance to EasyPost + persist

[`supabase/functions/labels/index.ts`](../supabase/functions/labels/index.ts):

- New required body field: `declared_value_cents?: number`. When provided, included in EasyPost `/buy` body per §2.7.
- New required body field: `insurance_cost_cents?: number`. Server **verifies** this against the §2.4 formula given `declared_value_cents` (PLAYBOOK Rule 14: never trust client-supplied price). Reject with 422 if mismatch beyond ±1¢ rounding tolerance.
- After successful buy, persist `declared_value_cents`, `insurance_cost_cents`, and `buyData.insurance?.id` into the new `shipments` columns via the existing `admin_insert_shipment` RPC (which gains three optional parameters) or a follow-up UPDATE on the inserted row.
- Augment the `payments/index.ts` PaymentIntent amount handoff to include the insurance premium in `amount_cents`. The existing handoff already takes `amount_cents` as a single number; this proposal just makes sure the computed total in [`useRecipientFlow.ts:getTotalPriceCents`](../src/hooks/useRecipientFlow.ts) is what flows through.

### 3.6 Customer-facing claims path (minimal v1)

[`src/components/tracking/ShipmentLabelSection.tsx`](../src/components/tracking/ShipmentLabelSection.tsx):

- When `shipment.insurance_easypost_id` is present (server returns it on the tracking response — extend [`tracking/index.ts`](../supabase/functions/tracking/index.ts)'s response shape), and `shipment.status` is in `['in_transit', 'delivered', 'returned']`, render a "Report a problem" link below the carrier-status block.
- Link is a `mailto:claims@sendmo.co?subject=Claim%20for%20<public_code>&body=...`. Body pre-fills public_code, declared value, ship date, and a prompt for "photos of damage + receipt of value."

[`supabase/functions/_shared/email-templates.ts`](../supabase/functions/_shared/email-templates.ts) — add a `labelInsuredEmail` variant (or extend the existing label-purchased email) noting "Your shipment is insured up to $X. If anything goes wrong, reply to this email with photos and we'll file a claim."

Setting up `claims@sendmo.co` as a forwarder to John is out of scope for code but is the **single required ops setup** before this feature can go live. Tracked in §7 OQ#5.

### 3.7 API helper

[`src/lib/api.ts`](../src/lib/api.ts):

- `BuyLabelInput` gains `declared_value_cents?: number; insurance_cost_cents?: number;`.
- Remove the now-unused `addInsurance` helper and `INSURANCE_FLAT_CENTS` constant — the premium is computed inline from declared value in `useRecipientFlow.ts`.

### 3.8 Admin

[`src/pages/Admin.tsx`](../src/pages/Admin.tsx) already renders an Insurance column; this proposal makes the column source from `shipments.insurance_cost_cents` (real values, not nullable hand-entry from `LabelTest`). Verify the existing column rendering — if it was hand-populated via the LabelTest path it may need a one-line fix to read from the new column.

## 4. Test plan

### 4.1 Vitest (frontend logic)

- **`tests/unit/useRecipientFlow.insurance.test.ts`** (new, ~8 tests):
  - `getTotalPriceCents` with `insurance=false` → no premium added.
  - `insurance=true, declared_value=0` → premium = 0; validation rejects.
  - `insurance=true, declared_value=100` → premium = $4.50 (formula b).
  - `insurance=true, declared_value=500` → premium = $10.50.
  - `declared_value > 5000` → validation rejects.
  - Auto-toggle behavior when guesstimate returns `declared_value_usd >= 50` — TODO if implemented.

- **`tests/unit/RecipientStepFullShipping.insurance.test.tsx`** (new, ~5 tests):
  - Switch disabled when `declared_value === 0`.
  - Switch enabled when `declared_value > 0`.
  - Premium line updates as declared value changes.
  - Disclosure line "Coverage provided by EasyPost..." present.
  - Continue blocked with helpful error when insurance on but declared value 0.

- **`tests/unit/MagicGuestimator.test.tsx`** (extend):
  - Guesstimate result with `declared_value_usd` propagates into `onResult`.

### 4.2 Edge function

- **`supabase/functions/labels`** (extend existing tests or add curl smoke):
  - Body with `declared_value_cents` triggers `insurance` field on EasyPost `/buy` body.
  - Body with `insurance_cost_cents` mismatched against formula → 422.
  - Body without declared value → no `insurance` field sent (existing behavior).
  - Successful response persists all three new columns.

### 4.3 Manual dogfood

- Live Comp toolbar → Full Prepaid Label → describe "a hardcover cookbook" in Guestimator → declared value field auto-fills to ~$30 → toggle is enabled → premium shows $3.45 → Confirm → on `/t/<code>` the printed label PDF references the insurance (EasyPost adds it to the label data) → admin report shows non-null insurance_cost_cents.
- Same but enter a $500 vase → premium $10.50 → confirm carries through.
- Toggle insurance off → declared value persists in form but no premium, no `insurance` field on `/buy`.
- Try $6,000 declared value → validation blocks.

### 4.4 Live charge dry-run (gated on Stripe Phase E)

Not in scope for this proposal's verification; tracked as a Phase E prerequisite check.

## 5. Out of scope

- **Flex-link sender wizard insurance.** The sender flow at `/s/:shortCode` does not currently expose insurance at all. Adding it there requires deciding whether the recipient or the sender picks (and pays for) the declared value — a real product question. Defer until we've seen v1 in production.
- **Claims portal / structured intake / claim-status UI.** v1 is mailto: + manual John triage. A real portal is a follow-up once volume warrants.
- **Customer-facing payouts UI / refund tracking.** v1 disbursements go through Stripe `createRefund` against the original card (already exists in code) or — if the refund window has closed — manual ACH. The customer learns the outcome via email from John. Building dashboard UX is a follow-up.
- **Carrier-default coverage stacking.** USPS Priority and FedEx/UPS Ground include $100 free coverage. EasyPost coverage is additive. We do **not** subtract the carrier default from declared value in v1 — the customer gets one combined "lost/damaged" claim path through us. Clean conceptually; slightly suboptimal economically (we pay EasyPost on the first $100 even though USPS would cover it for free). Optimizing this is its own proposal.
- **High-value (>$5,000) declared value.** EasyPost requires a separate quote process. Out of scope.
- **Restricted-content rules.** EasyPost does not insure certain items (cash, jewelry over thresholds, hazardous materials, perishables). v1 does not surface a restricted-items list to the user — we add it post-MVP after we see what actually gets shipped.

## 6. Verification

End-to-end after implementation:

1. **Schema verifies.** `psql … -c '\d shipments'` shows the three new columns. Existing rows have `NULL` for all three (expected for legacy shipments).
2. **Comp flow with insurance.** `/admin → Live Comp → Full Prepaid Label → Guestimator: "a hardcover cookbook" → declared value field populated → toggle enabled → premium displays → Confirm.` `shipments` row has `declared_value_cents=3000`, `insurance_cost_cents=345`, `insurance_easypost_id='ins_…'`. EasyPost dashboard shows the insurance object under the shipment.
3. **Comp flow without insurance.** Same but toggle off. All three new columns are NULL. No `insurance` field in the `/buy` call (verify in EasyPost dashboard request log).
4. **Validation rejection.** Try `declared_value=0` with insurance on → Continue disabled with helpful error. Try `declared_value=6000` → blocked with "cannot exceed $5,000."
5. **Server-side price check.** Curl the labels endpoint directly with a tampered `insurance_cost_cents` that doesn't match the formula → 422.
6. **Premium displays through to receipt email.** The post-buy email sent via [`email-templates.ts`](../supabase/functions/_shared/email-templates.ts) shows the insurance amount as a separate line item.
7. **Admin P&L correct.** Insurance-cost column populated; aggregate margin in [`Admin.tsx:292`](../src/pages/Admin.tsx) reflects insurance revenue minus EasyPost cost.
8. **Claims pipe smoke test.** Send a `mailto:claims@sendmo.co` from a test address → John receives it (validates the forwarder).

## 7. Open questions

1. **Pricing formula — John's stated $3 + 0.5% loses money above $600 declared value (§2.4). Pick (a) cap at $500, (b) raise to $3 + 1.5% always, or (c) tier?**

   The constraint as stated isn't sustainable at typical shipping values for higher-priced items (a $500 phone, a $1,200 laptop). All three responses have costs:
   - (a) Cap at $500 — clean for v1; loses anyone shipping a laptop or higher-end electronics. Maybe acceptable if "we don't insure above $500 yet" is an honest constraint we surface to the user.
   - (b) Switch to $3 + 1.5% — formula stays flat across all values; user price ~doubles at $100 declared value ($4.50 vs $3.50). May feel expensive on the low end.
   - (c) Tier — $3 + 0.5% under $300, $3 + 1.5% above. Best economics. Hardest to explain on the receipt.

   **Author lean: (b).** A flat formula that always nets us a small positive margin is the right starting shape. We can tune percentages later without restructuring. The $3 base is what genuinely covers payment processing on small declared values; the 1.5% scales with EasyPost's own cost. At small declared values the user pays a couple bucks more; at high declared values the margin is thin but never negative.

2. **Auto-toggle insurance ON when Guesstimator returns `declared_value_usd >= 50`?**

   Yes: friendly default — most users shipping a >$50 item want coverage. Cost: one more thing the toggle does implicitly. No: respect user opt-in; an "on by default" feels nudge-y for a paid product. **Author lean: yes**, with the threshold at $50. The reasoning: the Guesstimator is already an opinionated auto-filler; this is one more opinionated default in the same spirit. Easy to flip off if the user notices and disagrees.

3. **Insurance-reseller regulatory exposure — when do we need legal review?**

   The shape we're proposing (EasyPost named as coverage provider in customer copy; SendMo as facilitator; markup as a service fee) is the standard reseller posture and Pirate Ship / Shippo both do it. But "standard posture" isn't a defense in itself, and CA/NY/TX have stricter insurance-broker rules than most. **Author lean: 30-minute legal-eagle review before this ships behind real charges (i.e. before Stripe Phase E goes live with insurance enabled).** Until then we can ship in comp mode and validate the technical pipe without the regulatory risk. If the review surfaces issues, fall back to pass-through pricing (we bill what EasyPost bills us, no markup) and re-architect later.

4. **Should the price summary show `Insurance — $3.50` or break it down `Insurance fee: $3.00 + Coverage: $0.50`?**

   Single line is simpler and matches how Stripe-billed apps usually present ancillary fees. Itemized is more transparent and could pre-empt "wait, what's the $3 for?" support questions. **Author lean: single line in v1.** Add an itemization tooltip on hover if support volume warrants. The disclosure ("Coverage provided by EasyPost; SendMo facilitates") already cues the user that the fee includes both coverage cost and our facilitation.

5. **`claims@sendmo.co` setup — is the mailto: pipe + John-as-triage the right v1?**

   Yes for v1: claims volume will be ~0 for a while; building real intake UX before there are real claims is premature. But if we go live with markup and claims start arriving, the SLA on John reading those emails becomes load-bearing. **Author lean: mailto: + clear ops doc in [`LOG.md`](../LOG.md)** that says "John triages claims; target response 48h." If that doc isn't honored, we're committing fraud against our own disclosure.

6. **Existing `insurance_cost_cents` column — does it already exist or is admin.tsx silently reading null?**

   The migration in §3.1 includes `ADD COLUMN IF NOT EXISTS` so either path works, but it's worth running `\d shipments` once during implementation to confirm and remove the `IF NOT EXISTS` clause if appropriate (cleaner migration history). Low-stakes, low-effort, just don't forget.

---

**Proposal file:** `/Users/ja/AI-Brain/sendmo/proposals/2026-05-12_shipping-insurance.md`

**Three questions I most want the reviewer to focus on:**

1. **The pricing-formula math (§2.4, §7 OQ#1).** John explicitly asked for $3 + 0.5% and the math doesn't sustain past ~$600 declared value. I've recommended raising to $3 + 1.5% which keeps the formula flat and always positive-margin, but the user-visible price ~doubles on low-value shipments. Is that the right trade?
2. **Claims-as-product (§2.5, §7 OQ#5).** v1 commits us, in customer-facing copy, to "we'll file the claim and pass the payout through." That's an ops obligation, not just code. Is mailto: + John triage genuinely enough for v1, or should we delay the launch until there's at least a structured intake form? Reviewer perspective: what's the smallest-credible claims product we can ship without breaking the trust the disclosure promises?
3. **Legal review timing (§2.5, §7 OQ#3).** Should the legal-eagle review on "is markup-on-insurance OK in CA/NY/TX" gate the merge of this code, or is it OK to ship the code (comp-mode only, no real charges) and gate the production charge flip on legal sign-off? Author lean: ship the code, gate the charge flip. Reviewer should poke holes.
