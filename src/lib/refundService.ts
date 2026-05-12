/**
 * Refund service for SendMo.
 *
 * Auto-refunds (label-purchase fails after the card was charged) are handled
 * server-side inside the /labels Edge Function — see supabase/functions/labels.
 *
 * This client helper is for ADMIN-INITIATED refunds (e.g., a Dashboard
 * "Refund" button on a shipment row) and is wired against a future
 * /refunds Edge Function. No UI calls it yet.
 *
 * Stripe Phase A note (migration 017): the legacy `payments` table was
 * dropped. Refunds now read from the `transactions` ledger — the original
 * charge is the row WHERE type='charge' AND shipment_id = ?. The Phase F
 * implementation will call Stripe Refunds API on that charge's PI, and the
 * stripe-webhook function (sole ledger writer) will append a type='refund'
 * row when charge.refunded fires.
 */

export interface RefundRequest {
  shipmentId: string;
  /** UUID of the originating type='charge' row in `transactions` for this shipment. */
  chargeTransactionId: string;
  amountCents: number;
  reason: "label_voided" | "customer_request" | "admin_override";
}

export interface RefundResult {
  success: boolean;
  /** Stripe Refund object id (`re_...`) populated by the stripe-webhook handler on charge.refunded. */
  stripeRefundId?: string;
  /** UUID of the appended type='refund' row in `transactions`. */
  refundTransactionId?: string;
  error?: string;
}

/**
 * Issue a refund via the /refunds Edge Function.
 * NOT YET IMPLEMENTED — endpoint doesn't exist. Phase F wires this up.
 */
export async function processRefund(_request: RefundRequest): Promise<RefundResult> {
  throw new Error(
    "Admin-initiated refunds not implemented yet (Phase F). Auto-refund on label-buy failure is wired in /labels.",
  );
}
