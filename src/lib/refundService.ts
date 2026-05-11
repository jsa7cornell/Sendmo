/**
 * Refund service for SendMo.
 *
 * Auto-refunds (label-purchase fails after the card was charged) are handled
 * server-side inside the /labels Edge Function — see supabase/functions/labels.
 *
 * This client helper is for ADMIN-INITIATED refunds (e.g., a Dashboard
 * "Refund" button on a shipment row) and is wired against a future
 * /refunds Edge Function. No UI calls it yet.
 */

export interface RefundRequest {
  shipmentId: string;
  paymentId: string;
  amountCents: number;
  reason: "label_voided" | "customer_request" | "admin_override";
}

export interface RefundResult {
  success: boolean;
  stripeRefundId?: string;
  error?: string;
}

/**
 * Issue a refund via the /refunds Edge Function.
 * NOT YET IMPLEMENTED — endpoint doesn't exist. Throws if called.
 */
export async function processRefund(_request: RefundRequest): Promise<RefundResult> {
  throw new Error(
    "Admin-initiated refunds not implemented yet. Auto-refund on label-buy failure is wired in /labels.",
  );
}
