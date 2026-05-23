import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { createRefund } from "../_shared/stripe.ts";
import { getRefundableBalanceForPI } from "../_shared/refunds.ts";
import { log } from "../_shared/logger.ts";

// POST /refunds
//
// Admin-only endpoint that issues a Stripe refund for a specific shipment.
// Resolves the PaymentIntent from the named charge transaction row (B2 fix —
// per-PI scoping via chargeTransactionId, not fuzzy by shipment_id).
//
// Body: {
//   shipment_id:        string   (required — UUID; cross-validated against the charge row)
//   chargeTransactionId: string  (required — UUID of the type='charge' row for the PI to refund)
//   amount_cents?:      number   (optional — omit to refund the full remaining balance)
//   reason:             string   (Stripe enum: 'requested_by_customer' | 'duplicate' | 'fraudulent',
//                                 or 'admin_override' mapped to 'requested_by_customer')
// }
//
// Returns: { success, refund_id, amount_cents, expected_post_refund_balance }
//
// Rule 16 compliance: this function calls createRefund and never writes to
// transactions. The -refund ledger row lands when charge.refunded fires in
// stripe-webhook (the sole writer for refund rows).
//
// N1 — the async webhook window: the returned expected_post_refund_balance lets
// the admin UI render optimistically. The actual transactions row lands seconds
// later when charge.refunded fires. A second rapid call during that window will
// see a stale balance; the admin button is disabled for ~10s after success to
// reduce the chance of a double-partial race.

// ── In-memory rate limit: 5 requests / 60s per ip ──────────────────────────
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBucket = new Map<string, number[]>();
function isRateLimited(key: string, now: number): boolean {
  const arr = (rateBucket.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) {
    rateBucket.set(key, arr);
    return true;
  }
  arr.push(now);
  rateBucket.set(key, arr);
  return false;
}

// Map admin_override (our UI label) to the Stripe enum value.
function mapReason(r: string): "requested_by_customer" | "duplicate" | "fraudulent" {
  if (r === "duplicate") return "duplicate";
  if (r === "fraudulent") return "fraudulent";
  // 'requested_by_customer' and 'admin_override' both map to this Stripe value.
  return "requested_by_customer";
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  if (isRateLimited(ip, Date.now())) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded — slow down" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  let supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"];
  let adminUser: Awaited<ReturnType<typeof requireAdmin>>["user"];
  try {
    const ctx = await requireAdmin(req, corsHeaders);
    supabase = ctx.supabase;
    adminUser = ctx.user;
  } catch (r) {
    if (r instanceof Response) return r;
    throw r;
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: {
    shipment_id?: string;
    chargeTransactionId?: string;
    amount_cents?: number;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { shipment_id, chargeTransactionId, amount_cents, reason } = body;

  if (!shipment_id || typeof shipment_id !== "string") {
    return new Response(JSON.stringify({ error: "shipment_id is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!chargeTransactionId || typeof chargeTransactionId !== "string") {
    return new Response(JSON.stringify({ error: "chargeTransactionId is required (UUID of the type='charge' row)" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!reason || typeof reason !== "string") {
    return new Response(JSON.stringify({ error: "reason is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (amount_cents !== undefined && (typeof amount_cents !== "number" || !Number.isInteger(amount_cents) || amount_cents <= 0)) {
    return new Response(JSON.stringify({ error: "amount_cents must be a positive integer when provided" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Resolve PI from the charge transaction row (B2 fix) ───────────────────
  // The charge row tells us: which PI to refund, that this is indeed a charge
  // (not a comp_grant or something else), and whether the shipment_id matches.
  const { data: chargeTx, error: txErr } = await supabase
    .from("transactions")
    .select("id, type, shipment_id, stripe_intent_id")
    .eq("id", chargeTransactionId)
    .maybeSingle();

  if (txErr) {
    return new Response(JSON.stringify({ error: `Transaction lookup failed: ${txErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!chargeTx) {
    return new Response(JSON.stringify({ error: "Charge transaction not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (chargeTx.type !== "charge") {
    return new Response(JSON.stringify({ error: `Transaction ${chargeTransactionId} is type='${chargeTx.type}', not 'charge'` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (chargeTx.shipment_id !== shipment_id) {
    return new Response(JSON.stringify({ error: "chargeTransactionId does not belong to this shipment_id" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stripe_intent_id: string = chargeTx.stripe_intent_id;
  if (!stripe_intent_id) {
    return new Response(JSON.stringify({ error: "Charge row has no stripe_intent_id — cannot refund" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Fetch shipment to get is_test ──────────────────────────────────────────
  const { data: shipment, error: shipErr } = await supabase
    .from("shipments")
    .select("id, is_test")
    .eq("id", shipment_id)
    .maybeSingle();

  if (shipErr || !shipment) {
    return new Response(JSON.stringify({ error: "Shipment not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── v1 carrier_adjustment guard ───────────────────────────────────────────
  // If any carrier_adjustment rows exist on this shipment, the refundable
  // balance computation (charge+refund only) would understate the true amount.
  // Reject now with a clear hint rather than silently block a legitimate refund.
  // Mixed-flow handling moves to v2 alongside H2 carrier-adjustment build.
  const { count: adjCount } = await supabase
    .from("carrier_adjustments")
    .select("id", { count: "exact", head: true })
    .eq("shipment_id", shipment_id);

  if ((adjCount ?? 0) > 0) {
    return new Response(JSON.stringify({
      error: "This shipment has carrier adjustments. Use the carrier-adjustment flow to refund — direct refund is not supported in v1 when adjustments exist.",
    }), {
      status: 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Compute refundable balance ─────────────────────────────────────────────
  let balance: number;
  try {
    balance = await getRefundableBalanceForPI(supabase, stripe_intent_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `Balance lookup failed: ${msg}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (balance <= 0) {
    return new Response(JSON.stringify({ error: "No refundable balance remaining for this PaymentIntent" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const refundAmountCents = amount_cents ?? balance;
  if (refundAmountCents > balance) {
    return new Response(JSON.stringify({
      error: `Requested refund (${refundAmountCents}¢) exceeds remaining refundable balance (${balance}¢)`,
      remaining_balance_cents: balance,
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Generate idempotency key server-side (Rule 14 spirit) ─────────────────
  const refund_request_id = crypto.randomUUID();

  // ── Call Stripe createRefund ───────────────────────────────────────────────
  let stripeRefund: { id: string; amount: number; status: string };
  try {
    stripeRefund = await createRefund({
      payment_intent_id: stripe_intent_id,
      amount_cents: refundAmountCents,
      reason: mapReason(reason),
      metadata: {
        shipment_id,
        admin: "true",
        admin_user_id: adminUser.id,
        refund_request_id,
      },
      idempotency_key: `refund_admin_${shipment_id}_${refund_request_id}`,
      liveMode: !shipment.is_test,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({
      event_type: "refund.admin_initiated_failed",
      severity: "error",
      entity_type: "shipment",
      entity_id: shipment_id,
      properties: {
        stripe_intent_id,
        amount_cents: refundAmountCents,
        reason,
        error_message: msg,
        admin_user_id: adminUser.id,
      },
    });
    return new Response(JSON.stringify({ error: `Stripe refund failed: ${msg}` }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Log success — do NOT write transactions (Rule 16) ─────────────────────
  // The charge.refunded webhook is the sole writer of the -refund ledger row.
  log({
    event_type: "refund.admin_initiated",
    severity: "info",
    entity_type: "shipment",
    entity_id: shipment_id,
    properties: {
      stripe_refund_id: stripeRefund.id,
      stripe_intent_id,
      amount_cents: refundAmountCents,
      refund_request_id,
      reason,
      admin_user_id: adminUser.id,
      live_mode: !shipment.is_test,
    },
  });

  // N1 — return expected post-refund balance for optimistic UI. The real
  // transactions row lands asynchronously when charge.refunded fires.
  return new Response(
    JSON.stringify({
      success: true,
      refund_id: stripeRefund.id,
      amount_cents: refundAmountCents,
      expected_post_refund_balance: balance - refundAmountCents,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
