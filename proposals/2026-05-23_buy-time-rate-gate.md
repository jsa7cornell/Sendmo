---
title: Buy-time rate gate — never sell a label for less than EasyPost charged us
slug: buy-time-rate-gate
project: sendmo
status: in-review
created: 2026-05-23
last_updated: 2026-05-23
reviewed: null
decided: null
author: Claude Opus 4.7 — pre-launch correctness pass; surfaced after John flagged GC37EXG ($9.62 loss on a single label, display_price $9.61 vs EP cost $19.23)
reviewer: null
outcome: null
---

## 1. Context

### 1.1 The incident

Shipment `public_code=GC37EXG` (carrier tracking `61292000676723398703`) shipped with:

| Field | Value |
|---|---|
| `display_price_cents` (customer paid) | **961** ($9.61) |
| `rate_cents` (EasyPost billed SendMo at buy time) | **1923** ($19.23) |
| Realized margin | **−$9.62** (loss of 100% of revenue) |

The customer was charged the rate-shop quote ($9.61). EasyPost's actual buy-time rate for the same `rate_id` was $19.23. The labels function persisted both numbers truthfully but never compared them — so the loss landed silently in the ledger as a `−label_cost` row dwarfing the `+charge` row.

### 1.2 Why today's code doesn't catch this

[`supabase/functions/labels/index.ts`](../supabase/functions/labels/index.ts) writes two fields after `/buy` succeeds:

- `p_rate_cents`  = `Math.round(parseFloat(buyData.selected_rate?.rate) * 100)` ← what EP actually billed
- `p_display_price_cents` = the client-posted `display_price_cents` (full-label) or the server-derived value (flex) ← what we charged the customer

There is no comparison between the two. The hard invariant *"EP cost ≤ what we charged the customer"* is currently unenforced. The H2 carrier-adjustment system ([SPEC §13.4](../SPEC.md#134-carrier-adjustment-recovery-h2)) catches **post-pickup** drift (USPS reweighs, dim-weight reconciliations) — but the **buy-time** gap, between rate-shop quote and `/buy` commit, has no gate.

### 1.3 Industry-standard posture

Shippo, ShipStation, and Pirate Ship all refuse-and-surface when the buy-time rate exceeds the quoted rate by more than a small margin, treating *"never sell a label for less than the carrier charged us"* as a correctness invariant. SendMo should do the same. This proposal builds that gate.

### 1.4 Why this belongs in proposals (per PLAYBOOK and PROPOSAL-REVIEW-PROTOCOL)

The labels function is in the H1–H5 *don't touch lightly* launch-readiness window ([`2026-05-22_reconciliation-and-carrier-adjustments`](2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md), [`2026-05-23_pre-launch-handoff-plan.md`](2026-05-23_pre-launch-handoff-plan.md)). This is a legitimate pre-launch correctness fix — not a feature — but per protocol it still goes through review before code lands.

## 2. Architecture

### 2.1 The invariant

```
buy_time_rate_cents ≤ display_price_cents      (hard — never sell below cost)
```

Where `buy_time_rate_cents = Math.round(parseFloat(buyData.selected_rate.rate) * 100)`.

A configurable **margin floor** (`LABEL_BUY_GATE_MARGIN_FLOOR_PCT`, default `0`) lets the gate refuse earlier — e.g., refuse if EP cost eats into the bottom 5% of customer payment, preserving at least a 5% gross margin. Default 0 means "strict no-loss" — the minimum any prod build should ever run with.

### 2.2 Where the gate fires — recommendation: AFTER `/buy`, react-and-void

EasyPost's `/buy` response (`buyData.selected_rate.rate`) is the **authoritative** post-commit rate. Three placements were considered:

| Option | Latency | Side effects on miss | UX on miss |
|---|---|---|---|
| **A — BEFORE `/buy` (refetch rate)** | +1 EP HTTP call on every label buy (~150–300 ms) | None (no label created) | Client re-shops, no carrier artifact |
| **B — AFTER `/buy` (gate on response)** | 0 ms happy-path | Label briefly exists + must be voided via EP refund | Customer refunded; voided shipment visible on /t/ briefly |
| **C — Hybrid: BEFORE for high-risk carriers (FedEx/UPS), AFTER otherwise** | Conditional | Mixed | Mixed |

**Recommendation: Option B (AFTER).** Rationale:
- The drift case is rare (one known incident); paying ~200 ms latency on 100% of buys to spare a void path on <1% misses is a bad trade for sub-launch volume.
- The void + customer-refund machinery already exists — the labels function's existing auto-refund block ([`labels/index.ts:891-938`](../supabase/functions/labels/index.ts#L891)) for EP-buy-failure cases is one extension away from handling this case too.
- EasyPost's `/refund` endpoint for a just-bought label is the same call `cancel-label/index.ts` already uses; the void → carrier-confirms → easypost_refund chain wired by H1 already handles eventual EP-side credit recovery.
- The customer-facing copy "your purchase couldn't complete at the price you saw — here's the new rate" is identical in both A and B; only the backend cleanup differs.

(This is the single biggest call John may want to push back on. Flagged as **OQ#1**.)

### 2.3 The structured client error

When the gate trips, the response shape is:

```jsonc
// HTTP 409 Conflict
{
  "error": "rate_changed",
  "code": "BUY_TIME_RATE_EXCEEDS_DISPLAY_PRICE",
  "message": "The shipping cost changed and we couldn't complete your purchase at the price you saw. Please review the new rate.",
  "easypost_shipment_id": "shp_xxx",
  "easypost_rate_id": "rate_xxx",
  "quoted_display_price_cents": 961,
  "buy_time_rate_cents": 1923,
  "new_display_price_cents": 1320,    // applyMarkup(buy_time_rate)
  "refunded": true,
  "payment_intent_id": "pi_xxx",
  "void_submitted": true              // EP refund POSTed; carrier confirmation lazy
}
```

The client surface (full-label `RecipientStepPayment`, flex `SenderStepReview`) catches `error === "rate_changed"` and renders a rate-changed dialog: *"The rate changed from $9.61 to $13.20. We refunded $9.61. Continue at the new price or cancel?"* A confirm re-enters the flow at `/rates` → `/payments` → `/labels` with a fresh quote.

### 2.4 The two log events

```ts
// Hard miss — gate refused, label voided, customer refunded.
event_type: "label.buy_time_rate_exceeded"
severity: "error"
properties: {
  quoted_display_price_cents,
  buy_time_rate_cents,
  margin_loss_cents,                  // buy_time_rate_cents − quoted_display_price_cents
  margin_floor_pct,
  flow,                               // "full_label" | "flex"
  carrier, service,
}

// Soft warning — rate drifted up but still profitable; proceed.
event_type: "label.buy_time_rate_drift"
severity: "warn"
properties: {
  quoted_rate_cents,                  // back-derived: (display_price - 100) / 1.15
  buy_time_rate_cents,
  drift_pct,
  margin_remaining_cents,             // display_price - buy_time_rate
  flow, carrier, service,
}
```

Soft-warning threshold: `buy_time_rate_cents > quoted_rate_cents * 1.05` (5% drift in EP cost while still below display_price). Gives observability into rate volatility without blocking buys.

### 2.5 Coverage

Both full-label and flex paths flow through the same `/buy` call at [`labels/index.ts:850`](../supabase/functions/labels/index.ts#L850). One gate after one call covers both. Flex's existing rate re-derive (lines 254–333) is complementary, not redundant — it gates against `link.max_price_cents`, this gate enforces the EP-cost invariant.

### 2.6 What about Phase 3 (escrow / money transmission)?

The gate strengthens the invariant Phase 3 will depend on: *"the ledger row pair (charge, label_cost) for any shipment satisfies +charge ≥ −label_cost"*. Adding this gate now means Phase 3 can lean on that invariant rather than retrofit it.

## 3. File-by-file plan

### 3.1 `supabase/functions/labels/index.ts` — primary change

**Insert a new block immediately after the `if (!buyResponse.ok || buyData.error)` failure handler closes (around line 953), before `const carrier = buyData.selected_rate?.carrier`.**

```ts
// ─── Buy-time rate gate (proposal 2026-05-23_buy-time-rate-gate) ─
// Hard invariant: EP's buy-time rate must not exceed what we charged
// the customer. If it does, void the label and refund the PI.
const buyTimeRateCents = Math.round(
    parseFloat(buyData.selected_rate?.rate ?? "0") * 100
);
const effectiveDisplayPriceCents = typeof display_price_cents === "number"
    ? display_price_cents
    : 0;
const marginFloorPct = parseFloat(
    Deno.env.get("LABEL_BUY_GATE_MARGIN_FLOOR_PCT") ?? "0"
);
const gateThresholdCents = Math.floor(
    effectiveDisplayPriceCents * (1 - marginFloorPct / 100)
);

if (
    effectiveDisplayPriceCents > 0 &&
    buyTimeRateCents > gateThresholdCents &&
    !isComp                                  // comp labels are absorbed by SendMo by design
) {
    const marginLossCents = buyTimeRateCents - effectiveDisplayPriceCents;
    log({
        event_type: "label.buy_time_rate_exceeded",
        session_id: sessionId,
        severity: "error",
        entity_type: "label",
        entity_id: easypost_shipment_id,
        properties: {
            quoted_display_price_cents: effectiveDisplayPriceCents,
            buy_time_rate_cents: buyTimeRateCents,
            margin_loss_cents: marginLossCents,
            margin_floor_pct: marginFloorPct,
            flow: resolvedLink ? "flex" : "full_label",
            carrier: buyData.selected_rate?.carrier ?? null,
            service: buyData.selected_rate?.service ?? null,
            tracking_number: buyData.tracking_code ?? null,
        },
    });

    // Void the just-bought label via EasyPost /refund (same call cancel-label
    // uses). Best-effort; carrier confirms async via easypost_refund_status.
    let voidSubmitted = false;
    try {
        const voidResp = await fetch(
            `https://api.easypost.com/v2/shipments/${easypost_shipment_id}/refund`,
            { method: "POST", headers: { Authorization: authHeader } },
        );
        voidSubmitted = voidResp.ok;
        if (!voidResp.ok) {
            console.error(
                `[Session ${sessionId}] [labels] post-gate void failed:`,
                await voidResp.text(),
            );
        }
    } catch (voidErr) {
        console.error(
            `[Session ${sessionId}] [labels] post-gate void threw:`,
            voidErr instanceof Error ? voidErr.message : String(voidErr),
        );
    }

    // Refund the customer immediately. Same auto-refund pattern as the
    // EP-buy-failure path below.
    let refundIssued = false;
    if (verifiedPaymentIntent) {
        try {
            const refund = await createRefund({
                payment_intent_id: verifiedPaymentIntent.id,
                reason: "requested_by_customer",
                metadata: {
                    easypost_shipment_id,
                    failure_reason: "buy_time_rate_exceeded",
                    margin_loss_cents: String(marginLossCents),
                },
                idempotency_key:
                    `refund_${easypost_shipment_id}_buy_time_rate_exceeded`,
                liveMode: isLive,
            });
            refundIssued = true;
            log({
                event_type: "label.auto_refund_issued",
                session_id: sessionId,
                severity: "warn",
                entity_type: "payment_intent",
                entity_id: verifiedPaymentIntent.id,
                properties: {
                    refund_id: refund.id,
                    amount_cents: refund.amount,
                    easypost_shipment_id,
                    reason: "buy_time_rate_exceeded",
                },
            });
        } catch (refundErr) {
            const refundMsg = refundErr instanceof Error
                ? refundErr.message : String(refundErr);
            console.error(
                `[Session ${sessionId}] [labels] buy-time-gate refund failed:`,
                refundMsg,
            );
            log({
                event_type: "label.auto_refund_failed",
                session_id: sessionId,
                severity: "error",
                entity_type: "payment_intent",
                entity_id: verifiedPaymentIntent.id,
                properties: {
                    error_message: refundMsg,
                    easypost_shipment_id,
                    reason: "buy_time_rate_exceeded",
                },
            });
        }
    }

    // Structured client error — gives the UI enough to surface the new rate.
    const newDisplayPriceCents = Math.round(
        buyTimeRateCents * MARKUP_MULTIPLIER + MARKUP_FLAT_CENTS
    );
    return new Response(
        JSON.stringify({
            error: "rate_changed",
            code: "BUY_TIME_RATE_EXCEEDS_DISPLAY_PRICE",
            message: "The shipping cost changed and we couldn't complete your purchase at the price you saw. Please review the new rate.",
            easypost_shipment_id,
            easypost_rate_id,
            quoted_display_price_cents: effectiveDisplayPriceCents,
            buy_time_rate_cents: buyTimeRateCents,
            new_display_price_cents: newDisplayPriceCents,
            refunded: refundIssued,
            payment_intent_id: verifiedPaymentIntent?.id ?? null,
            void_submitted: voidSubmitted,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
}

// Soft-warning band: rate drifted up but still profitable.
{
    const quotedRateCentsApprox = Math.max(
        0,
        Math.round((effectiveDisplayPriceCents - MARKUP_FLAT_CENTS) / MARKUP_MULTIPLIER)
    );
    if (
        quotedRateCentsApprox > 0 &&
        buyTimeRateCents > Math.round(quotedRateCentsApprox * 1.05)
    ) {
        log({
            event_type: "label.buy_time_rate_drift",
            session_id: sessionId,
            severity: "warn",
            entity_type: "label",
            entity_id: easypost_shipment_id,
            properties: {
                quoted_rate_cents_approx: quotedRateCentsApprox,
                buy_time_rate_cents: buyTimeRateCents,
                drift_pct: Math.round(
                    ((buyTimeRateCents - quotedRateCentsApprox) /
                        quotedRateCentsApprox) * 100
                ),
                margin_remaining_cents:
                    effectiveDisplayPriceCents - buyTimeRateCents,
                flow: resolvedLink ? "flex" : "full_label",
                carrier: buyData.selected_rate?.carrier ?? null,
                service: buyData.selected_rate?.service ?? null,
            },
        });
    }
}
```

**Note — placement is critical.** This block must fire BEFORE the existing `const carrier = buyData.selected_rate?.carrier` assignments and the `admin_insert_shipment` RPC call, so no `shipments` row is persisted and no `label_cost` ledger row is written for a refused buy. The voided EasyPost shipment remains discoverable via the EP API (we logged the `easypost_shipment_id`) but does not enter SendMo's database.

### 3.2 `src/lib/api.ts` — surface the structured error

Extend the `buyLabel` return type:

```ts
export type BuyLabelRateChangedError = {
    error: "rate_changed";
    code: "BUY_TIME_RATE_EXCEEDS_DISPLAY_PRICE";
    quoted_display_price_cents: number;
    buy_time_rate_cents: number;
    new_display_price_cents: number;
    refunded: boolean;
    payment_intent_id: string | null;
};
```

The fetch wrapper should pass the 409 body through to callers (don't throw on 409 — let callers handle it).

### 3.3 `src/components/recipient/RecipientStepPayment.tsx` — full-label client surface

Catch the `rate_changed` error and render a `RateChangedDialog` (new component, ~80 LOC):

> *"The shipping cost changed from $9.61 to $13.20 while we were buying your label. We've refunded your $9.61 charge. You can continue at the new price or cancel."*
> [**Continue at $13.20**] [**Cancel**]

On Continue: re-enter at `RecipientStepRates` with the same parcel, fetch fresh rates (display the new options including the changed rate), re-select, re-pay, re-buy. The original PI is already refunded; a new one is created at re-pay.

### 3.4 `src/components/sender/SenderStepReview.tsx` — flex client surface

Same `RateChangedDialog` (component shared). On Continue: re-enter at `SenderStepRates`. The off_session PI is already refunded server-side; the next /labels call creates a fresh one.

### 3.5 `SPEC.md` §13 — document the invariant

Add §13.6:

```markdown
## 13.6 Buy-Time Rate Gate

SendMo's labels function enforces a hard correctness invariant at EasyPost `/buy` time:

> **EasyPost's buy-time rate must not exceed the price the customer was quoted (`display_price_cents`).**

If the buy-time rate exceeds the quoted price (e.g., EasyPost recomputed the rate between
shop and commit), the labels function:

1. Voids the just-bought label via EasyPost `/refund` (carrier confirms async).
2. Issues an immediate Stripe refund to the customer for the full quoted amount.
3. Returns HTTP 409 with `error: "rate_changed"` and the new buy-time rate, so the
   client can re-show the rate and let the customer re-confirm.

Comp labels are exempt (SendMo absorbs EasyPost cost by design). A configurable margin
floor (`LABEL_BUY_GATE_MARGIN_FLOOR_PCT`, default 0) lets the gate refuse earlier,
preserving a minimum gross margin.

A soft-warning event (`label.buy_time_rate_drift`, severity warn) fires whenever the
buy-time rate drifted >5% from the quoted rate while still below display_price —
gives observability into rate volatility without blocking buys.

Complements §13.4 (carrier-adjustment recovery, H2): §13.4 handles post-pickup drift
(USPS reweighs, dim adjustments, address surcharges); §13.6 handles the buy-time
quote-to-commit drift.

Reference: [proposals/2026-05-23_buy-time-rate-gate.md](proposals/2026-05-23_buy-time-rate-gate.md).
```

### 3.6 `LOG.md` — entry at merge

Standard LOG entry per Rule 17. Browser-verified block: full-label rate-changed dialog screenshot from a forced-trigger test (see §6.2).

### 3.7 Files NOT changed

- **No new migration.** Per the user's PLAYBOOK note. The gate is pure code.
- **No change to `_shared/adjustments.ts`** — H2 governs post-pickup adjustments; this is a separate (buy-time) concern.
- **No change to `payments/index.ts`** — the PI is created upstream; the labels function refunds it on gate trip via the existing `createRefund` import.
- **No change to `stripe-webhook/index.ts`** — the refund path through `charge.refunded` is unchanged; the gate-triggered refund flows through the same webhook handler.

## 4. Test plan

### 4.1 Unit tests — pure gate logic

New file `tests/unit/labels-buy-time-gate.test.ts`:

| Case | Input | Expected |
|---|---|---|
| Strict no-loss, EP under quote | `display=961, buy=900, floor=0` | proceed |
| Strict no-loss, EP equals quote | `display=961, buy=961, floor=0` | proceed (≤, not <) |
| Strict no-loss, EP over quote by $0.01 | `display=961, buy=962, floor=0` | refuse |
| Margin floor 5%, EP at quote | `display=1000, buy=1000, floor=5` | refuse (threshold=950) |
| Margin floor 5%, EP at threshold | `display=1000, buy=950, floor=5` | proceed |
| Soft warning, drift >5% but profitable | `display=1500, quoted_rate=1217, buy=1300` | proceed + drift event logged |
| Comp label exempt | `display=961, buy=1923, isComp=true` | proceed (no gate) |
| Missing display_price_cents | `display=undefined, buy=900` | proceed (gate inert — can't compare; warning logged separately) |

These exercise the gate-decision math without spinning up the function.

### 4.2 Integration test — labels function end-to-end

New file `tests/integration/labels-buy-time-gate.test.ts` (Vitest, uses EP TEST key):

1. Create a fresh test-mode shipment + rate via EP.
2. POST to local labels function with `display_price_cents` deliberately set BELOW the test rate (force the gate).
3. Assert: 409 response, `error: "rate_changed"`, body has expected fields, no `shipments` row, no `label_cost` ledger row, PI is refunded (Stripe test-mode).
4. Assert: EP shipment shows a submitted refund (poll EP API for `refund_status='submitted'`).
5. Run same test with `comp: true` — assert no gate triggered, label persists.

### 4.3 Playwright e2e — full-label rate-changed dialog

New spec `tests/e2e/buy-time-rate-changed.spec.ts`:

1. Run full-label flow end-to-end with a test backend that forces the labels function to return the 409 shape (mock at the network level via Playwright's `route()`).
2. Assert: `RateChangedDialog` renders with old + new prices.
3. Click Continue → assert flow re-enters `RecipientStepRates` with fresh rates.
4. Click Cancel → assert flow returns to `/dashboard` with a "Your charge was refunded" toast.

### 4.4 Regression test (per PLAYBOOK Rule 12)

Before this gate, GC37EXG would have shipped unblocked. Add `tests/integration/regression-gc37exg.test.ts`:
- Synthesize the GC37EXG numbers (display=961, buy=1923).
- Run the gate's decision function against them.
- Assert refuse + structured error body.

This pins the gate against the exact incident class.

## 5. Out of scope

- **Backfill of existing shipments to detect prior losses.** Worth doing — see OQ#5 — but a separate ops script, not part of this code change.
- **Rate-stability alerting / carrier-blacklisting.** If a specific carrier's rates routinely drift >5%, that's a separate intelligence layer.
- **Replacing rate-shop with EP's `quote_id`-based rate-lock primitive** (EP offers this for some carriers). Larger architectural change — see WISHLIST candidate at end.
- **Phase 3 escrow ledger invariants.** This proposal enforces the buy-time piece; Phase 3 will compose multiple invariants when it lands.
- **Customer messaging for the soft-warning band.** No customer-facing copy changes when the rate drifts but stays profitable — internal logging only.

## 6. Verification

### 6.1 Synthetic forced-trigger in test mode

1. Pull a real test-mode `easypost_shipment_id` + `easypost_rate_id` via the rates flow.
2. POST to `https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/labels` with the legitimate IDs but `display_price_cents: 1` (deliberately impossibly low).
3. Expect: HTTP 409, body matches §2.3 shape, `payment_intent_id` is refunded in Stripe test dashboard, EP shipment has refund submitted, no Supabase `shipments` row created.

### 6.2 Browser-verified (PLAYBOOK Rule 19)

Run the Playwright e2e from §4.3 against a local dev server with the labels function mocked to return 409. Capture screenshot of `RateChangedDialog`. Attach to LOG entry.

### 6.3 Live-mode dry run

After merge but before flipping any feature flag, run one live-mode test purchase deliberately under-quoted (admin tool) and confirm the gate trips with a real Stripe refund. Then return `LABEL_BUY_GATE_MARGIN_FLOOR_PCT` to its prod value.

### 6.4 Log verification

After 7 days in prod, query `event_logs` for `label.buy_time_rate_drift` to see baseline drift rates. If >10% of labels trip the soft warning, raise the warning threshold or investigate per-carrier rate stability.

## 7. Open questions

**OQ#1 — BEFORE-buy refetch vs AFTER-buy void-and-refund?**
Recommendation: AFTER (Option B in §2.2). The +200 ms BEFORE-path latency on 100% of buys, to catch what should be a <1% drift case, is a bad trade for current volume. But AFTER leaves a brief voided-label artifact on the carrier side. John, this is the single biggest decision and I want your weigh-in.

**OQ#2 — Margin floor default: 0% (strict no-loss) or 5% (preserve minimum margin)?**
Recommendation: ship default 0, with env-var override for ops experimentation. Aggressive floors protect margin but cause more friction (more rate-changed dialogs). Start permissive, tighten with data.

**OQ#3 — Does the gate apply when the flex-link's server-derived `display_price_cents` and the buy-time rate disagree?**
The flex path already server-derives `display_price_cents` from EP at lines 254–333 of [`labels/index.ts`](../supabase/functions/labels/index.ts), then charges the customer for that amount, then calls `/buy`. There's a small window for drift between the rate re-derive and `/buy`. Recommendation: YES, apply the gate uniformly to both flows — it's a correctness invariant, not a flow-specific check. Code as written in §3.1 does this.

**OQ#4 — Should comp labels be gated?**
Recommendation: NO (gate explicitly excludes `isComp`). Comp labels are SendMo absorbing EP cost by design; comparing to `display_price_cents` (which doesn't represent customer payment for comp) is meaningless. Already excluded in §3.1's `&& !isComp`.

**OQ#5 — Backfill / audit script?**
GC37EXG may not be alone. A one-off `scripts/audit-buy-time-rate-margins-YYYY-MM-DD.mjs` would scan `shipments` for `rate_cents > display_price_cents` and surface a list. Out of scope for this proposal but the reviewer should weigh whether to bundle. If bundled, it informs whether the gate's prod thresholds need tuning before launch.

**OQ#6 — Should the gate's refund use a different `reason` than the existing EP-buy-failure path?**
Both currently fall under Stripe's `requested_by_customer`. EP-buy-failure is technically "we failed", not "they requested". This is a longstanding wart — out of scope here but flagging.

## 8. Reconciliation with prior decided proposals

- **[`2026-05-22_reconciliation-and-carrier-adjustments`](2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md)** — H2 (`shipment.invoice` handler) addresses POST-PICKUP rate drift. This proposal addresses BUY-TIME drift. They are complementary, not overlapping: H2 reconciles between buy-time rate and final carrier invoice; this gate reconciles between rate-shop quote and buy-time rate.
- **[`2026-05-21_refund-system-implementation`](2026-05-21_refund-system-implementation_reviewed-2026-05-21_decided-2026-05-22.md)** — The gate's customer refund flows through the same `createRefund` + `charge.refunded` webhook → `transactions` `−refund` row pipeline H5 already wires. No new email is needed (H5's emails are for cancel-initiated refunds; the gate-triggered refund is system-initiated and the client shows the dialog immediately, so the inbox lifecycle email would be redundant). Flagged as confirmation point for the reviewer.
- **[`2026-05-11_sender-flow-wizard`](2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md)** — Phase D's flex flow already server-derives `display_price_cents` from the rate-shop endpoint. This gate adds a second check at `/buy` time. No drift from the decided spec; this strengthens it.
