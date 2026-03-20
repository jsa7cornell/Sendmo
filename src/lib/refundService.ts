/**
 * Refund service stub for SendMo.
 *
 * When Stripe payment integration ships, this service will:
 * 1. Look up the payment_intent for the voided shipment
 * 2. Call Stripe's refund API
 * 3. Update the payments table status to 'refunded'
 * 4. Insert a transaction record in the ledger table
 *
 * For now, label voids go through EasyPost only (carrier refund).
 * Stripe refund will be triggered when EasyPost confirms refund_status = 'refunded'.
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
 * Process a refund to the user's payment method.
 * TODO: Implement when Stripe payment integration ships.
 */
export async function processRefund(_request: RefundRequest): Promise<RefundResult> {
  console.warn("[refundService] Stripe refund not yet implemented — stub returning success");
  return { success: true };
}
