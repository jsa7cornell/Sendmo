/**
 * Refund service for SendMo — admin-initiated refunds.
 *
 * Auto-refunds (label-purchase fails after the card was charged) are handled
 * server-side inside the /labels Edge Function — see supabase/functions/labels.
 *
 * This client helper calls the /refunds Edge Function, which is the Phase F /
 * H3 pre-launch implementation. The function is admin-only (requireAdmin gate).
 *
 * Stripe Phase A note (migration 017): the legacy `payments` table was
 * dropped. Refunds now read from the `transactions` ledger — the original
 * charge is the row WHERE type='charge' AND shipment_id = ?. The /refunds
 * function calls Stripe Refunds API on that charge's PI (identified via the
 * chargeTransactionId), and the stripe-webhook function (sole ledger writer)
 * appends a type='refund' row when charge.refunded fires.
 *
 * B2 fix (decided proposal 2026-05-22): chargeTransactionId is REQUIRED —
 * the UUID of the originating type='charge' row. The /refunds endpoint resolves
 * the PI from this row, giving per-PI scoping (B1) for free and ensuring the
 * admin picks a specific charge to refund against rather than fuzzy-matching
 * the shipment.
 *
 * N1 fix: amountCents is now OPTIONAL (omit → full remaining balance refunded).
 * The endpoint returns expected_post_refund_balance for optimistic UI.
 */

import { supabase } from "@/lib/supabase";

const SUPABASE_FN_URL = import.meta.env.VITE_SUPABASE_URL + "/functions/v1";

export interface RefundRequest {
  shipmentId: string;
  /** UUID of the originating type='charge' row in `transactions` for this shipment. Required (B2 fix). */
  chargeTransactionId: string;
  /** Cents to refund. Omit to refund the full remaining balance. */
  amountCents?: number;
  reason: "requested_by_customer" | "duplicate" | "fraudulent" | "admin_override";
}

export interface RefundResult {
  success: boolean;
  /** Stripe Refund object id (`re_...`) */
  stripeRefundId?: string;
  /** Amount actually refunded in cents */
  amount_cents?: number;
  /** Expected balance after this refund (optimistic — webhook may not have landed yet) */
  expected_post_refund_balance?: number;
  error?: string;
}

/**
 * Issue a refund via the /refunds Edge Function.
 *
 * Uses the admin session JWT (N3 fix — Bearer session token, not anon key).
 * verify_jwt=true on the function requires a real JWT; the anon key would 401.
 */
export async function processRefund(request: RefundRequest): Promise<RefundResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return { success: false, error: "Not authenticated" };
  }

  let res: Response;
  try {
    res = await fetch(`${SUPABASE_FN_URL}/refunds`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shipment_id: request.shipmentId,
        chargeTransactionId: request.chargeTransactionId,
        amount_cents: request.amountCents,
        reason: request.reason,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return { success: false, error: msg };
  }

  if (!res.ok) {
    let errText: string;
    try {
      const json = await res.json();
      errText = json.error || `HTTP ${res.status}`;
    } catch {
      errText = await res.text().catch(() => `HTTP ${res.status}`);
    }
    return { success: false, error: errText };
  }

  const json = await res.json();
  return {
    success: true,
    stripeRefundId: json.refund_id,
    amount_cents: json.amount_cents,
    expected_post_refund_balance: json.expected_post_refund_balance,
  };
}
