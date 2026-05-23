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
