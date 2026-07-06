// Shared refund helpers for Edge Functions.
//
// Per-PI balance helper — B1 fix from the decided refund-system-implementation
// proposal (2026-05-21_refund-system-implementation_reviewed-2026-05-21_
// decided-2026-05-22.md).
//
// The helper scopes to a SINGLE PaymentIntent (stripe_intent_id column on
// transactions) because Stripe refunds are per-PI. Summing across a shipment
// would overstate the balance if the shipment has two charge rows against two
// PIs (re-charge after a failed first attempt, etc.).
//
// Throws on query error (per the nit) — a failed query returns data=null which
// would silently return 0 and block every refund attempt. Callers must handle
// the thrown Error.
//
// Type-only import so Vitest can import this module directly with a typed mock
// client (same pattern as _shared/budget.ts, established 2026-05-23).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.0";
import { createRefund } from "./stripe.ts";
import { log } from "./logger.ts";

/**
 * Remaining Stripe-refundable balance for a specific PaymentIntent, in cents.
 *
 * = sum(charge rows where stripe_intent_id = PI) + sum(refund rows where
 *   stripe_intent_id = PI).
 *
 * Refund rows carry negative amount_cents, so a full refund returns 0.
 * A partially-refunded PI returns the remaining positive balance.
 *
 * v1 NOTE: carrier_adjustment rows on the same PI are NOT included. If a
 * carrier adjustment exists on the PI being refunded, the `/refunds` endpoint
 * rejects with a 409 "use the carrier-adjustment flow" hint. Mixed-flow
 * handling moves to v2 alongside the H2 build. Silently including only
 * charge+refund and calling it "the full balance" would misstate the customer's
 * true refundable amount.
 */
export async function getRefundableBalanceForPI(
  supabase: SupabaseClient,
  stripe_payment_intent_id: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("transactions")
    .select("type, amount_cents")
    .eq("stripe_intent_id", stripe_payment_intent_id)
    .in("type", ["charge", "refund"]);

  if (error) {
    throw new Error(`refundable-balance lookup failed: ${error.message}`);
  }

  return (data ?? []).reduce((sum: number, r: { type: string; amount_cents: number }) => sum + r.amount_cents, 0);
}

/**
 * Decide the shipment `refund_status` to write when a cancel/void succeeds.
 *
 * The load-bearing invariant: **a shipment that carries a PaymentIntent had a
 * real charge and is refundable** ('submitted'); one without a PI is a comp
 * label with no money to move ('not_applicable'). This is exactly the check
 * that broke flex (Pattern D) shipments before the off-session PI was stitched
 * onto `shipments.stripe_payment_intent_id` — a paid flex label read as `hasPI
 * = false` and was wrongly marked 'not_applicable', skipping the refund. Kept
 * as a pure helper so that contract is unit-pinned (Rule 12) and every caller
 * decides identically (Rule 6).
 *
 * `epRefundStatus === "rejected"` (carrier refused the void) wins over both —
 * there is nothing to refund if the label wasn't voided.
 */
/**
 * Result of initiateCancelRefund. Discriminated on `skipped` so callers can
 * branch without null-checks: a skipped result carries the reason; a
 * non-skipped result carries the Stripe refund id (for Email B) and the
 * exact amount sent to Stripe.
 */
export type CancelRefundResult =
  | { skipped: true; reason: "no_refundable_balance" }
  | { skipped: false; stripeRefundId: string | null; amountCents: number };

/**
 * Initiate the customer-side Stripe refund after EasyPost confirms a void.
 *
 * Single owner of the cancel-refund money decision (Rule 6) — previously
 * triplicated across tracking/index.ts (lazy poll), webhooks/index.ts
 * (refund.successful arm), and cron-refund-sweep/index.ts, where two of the
 * three passed `amount_cents: balance > 0 ? balance : undefined` to Stripe.
 * `undefined` means "refund ALL remaining" to Stripe, so a ledger that
 * (wrongly) said 0 refundable triggered an UNBOUNDED refund instead of a
 * skip. This helper makes zero/negative balance a hard skip: it logs a
 * `cancel.stripe_refund_skipped_no_balance` event and never calls Stripe.
 *
 * The idempotency key `refund_${easypostShipmentId}_user_cancel` is UNCHANGED
 * from what all three call sites already shared — Stripe dedupes across
 * whichever trigger fires first (poll, webhook, sweep).
 *
 * `createRefundFn` / `getBalanceFn` are injectable for unit tests (same
 * direct-Vitest-import pattern as getRefundableBalanceForPI above); they
 * default to the real _shared/stripe.ts createRefund and the local
 * getRefundableBalanceForPI.
 *
 * Throws when the balance lookup or the Stripe call throws — callers keep
 * their existing catch/log/retry semantics.
 */
export async function initiateCancelRefund(params: {
  supabase: SupabaseClient;
  stripePaymentIntentId: string;
  easypostShipmentId: string;
  shipmentId: string;
  publicCode: string;
  trigger: string;
  liveMode: boolean;
  createRefundFn?: typeof createRefund;
  getBalanceFn?: typeof getRefundableBalanceForPI;
}): Promise<CancelRefundResult> {
  const getBalance = params.getBalanceFn ?? getRefundableBalanceForPI;
  const doCreateRefund = params.createRefundFn ?? createRefund;

  const refundableBalance = await getBalance(
    params.supabase,
    params.stripePaymentIntentId,
  );

  if (refundableBalance <= 0) {
    log({
      event_type: "cancel.stripe_refund_skipped_no_balance",
      source: "edge_fn",
      severity: "warn",
      entity_type: "shipment",
      entity_id: params.shipmentId,
      properties: {
        payment_intent_id: params.stripePaymentIntentId,
        refundable_balance_cents: refundableBalance,
        trigger: params.trigger,
      },
    });
    return { skipped: true, reason: "no_refundable_balance" };
  }

  const refund = await doCreateRefund({
    payment_intent_id: params.stripePaymentIntentId,
    amount_cents: refundableBalance,
    reason: "requested_by_customer",
    metadata: {
      shipment_id: params.shipmentId,
      public_code: params.publicCode,
      trigger: params.trigger,
    },
    idempotency_key: `refund_${params.easypostShipmentId}_user_cancel`,
    liveMode: params.liveMode,
  });

  return {
    skipped: false,
    stripeRefundId: (refund as { id?: string } | null)?.id ?? null,
    amountCents: refundableBalance,
  };
}

export function resolveRefundStatus(
  epRefundStatus: string,
  hasPaymentIntent: boolean,
): "submitted" | "not_applicable" | "rejected" {
  if (epRefundStatus === "rejected") return "rejected";
  if (!hasPaymentIntent) return "not_applicable";
  return "submitted";
}

/**
 * D4 guard — decide whether a `charge.refunded` event may advance a shipment's
 * `refund_status` to 'refunded' (which also gates the "refund completed"
 * Email B).
 *
 * `refund_status` is written by the cancel/void state machine:
 *   - 'submitted'  → cancel-label got a successful Stripe createRefund; a
 *                    customer refund is genuinely in flight. Always advance.
 *   - 'rejected'   → OVERLOADED. Either a timeout-healed cancel (the day-21
 *                    cron marked it 'rejected' but the carrier confirmed the
 *                    void later, so `easypost_refund_status='refunded'`) OR a
 *                    carrier-REFUSED void (never EP-refunded), where NO
 *                    customer refund is owed. Advance ONLY the healed case —
 *                    otherwise an admin goodwill partial refund on a
 *                    carrier-refused shipment would flip it to 'refunded' and
 *                    fire a false Email B.
 *   - anything else (incl. 'refunded', 'not_applicable', null) → do not
 *                    advance; no customer cancel flow to close.
 *
 * Pure so the D4 decision is unit-pinned (Rule 12) independent of the two
 * sequential PostgREST updates that implement it in stripe-webhook (which
 * express "submitted OR (rejected AND ep=refunded)" as attempt-then-fallback).
 */
export function shouldAdvanceRefundStatusOnChargeRefunded(
  currentRefundStatus: string | null | undefined,
  easypostRefundStatus: string | null | undefined,
): boolean {
  if (currentRefundStatus === "submitted") return true;
  if (currentRefundStatus === "rejected") return easypostRefundStatus === "refunded";
  return false;
}
