// supabase/functions/reconciliation-report/index.ts
//
// GET /reconciliation-report
//
// Admin-only endpoint. Returns JSON for the Reconciliation dashboard:
//   { summary, needs_attention, rows }
//
// Query params:
//   start_date — ISO date string (default: 7 days ago)
//   end_date   — ISO date string (default: today)
//
// Net-margin identity (from the decided proposal §2.5 + dashboard mockup line ~450):
//   Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback
//   − Label cost + Refund from EasyPost − Adjustment charged = Net margin
//
// All terms come from the `transactions` ledger — no shipments-column lookups
// for money math. Pure ledger arithmetic.
//
// Decided proposal:
//   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
//   §2.5 (admin dashboard), §3 reconciliation-report Edge Function

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAdmin } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

// Dispute deadline windows per carrier (days from carrier_adjustments.created_at).
const DISPUTE_WINDOW_DAYS: Record<string, number> = {
  USPS: 60,
  UPS: 120,
  FedEx: 90,
  // Default for unknown carriers.
  default: 60,
};

function getDisputeWindowDays(carrier: string): number {
  const upper = (carrier || "").toUpperCase();
  if (upper.includes("USPS") || upper.includes("USGA")) return DISPUTE_WINDOW_DAYS.USPS;
  if (upper.includes("UPS")) return DISPUTE_WINDOW_DAYS.UPS;
  if (upper.includes("FEDEX") || upper.includes("FED_EX")) return DISPUTE_WINDOW_DAYS.FedEx;
  return DISPUTE_WINDOW_DAYS.default;
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

// ─── EasyPost wallet balance ─────────────────────────────────────────────────

async function fetchEasyPostWalletBalance(): Promise<number | null> {
  const apiKey = Deno.env.get("EASYPOST_API_KEY");
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.easypost.com/v2/users", {
      headers: {
        Authorization: `Basic ${btoa(apiKey + ":")}`,
      },
    });
    if (!res.ok) return null;
    const body = await res.json();
    // EasyPost returns balance in dollars as a string, e.g. "122.63"
    const balance = body.balance;
    if (balance == null) return null;
    return Math.round(parseFloat(balance) * 100);
  } catch {
    return null;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    let supabase;
    try {
      ({ supabase } = await requireAdmin(req, corsHeaders));
    } catch (r) {
      if (r instanceof Response) return r;
      throw r;
    }

    const url = new URL(req.url);
    const now = new Date();
    const defaultStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const startDate = url.searchParams.get("start_date") ?? defaultStart.toISOString().slice(0, 10);
    const endDate = url.searchParams.get("end_date") ?? now.toISOString().slice(0, 10);
    // end_date is inclusive — extend to end of day
    const endDatetime = `${endDate}T23:59:59.999Z`;
    // Environment filter — inherits from Admin.tsx top toolbar (All / Production
    // / Test). Applied to the shipments query so BOTH summary cards AND
    // per-shipment rows respect the chosen env. Unset / 'all' = no filter.
    const envParam = url.searchParams.get("env");
    const envFilter: "production" | "test" | null =
      envParam === "production" ? "production" : envParam === "test" ? "test" : null;

    // ── 1. Fetch shipments with transactions, carrier_adjustments, and refunds ──
    let shipQuery = supabase
      .from("shipments")
      .select(`
        id,
        easypost_shipment_id,
        carrier,
        service,
        tracking_number,
        label_url,
        rate_cents,
        status,
        is_test,
        is_live,
        payment_method,
        refund_status,
        easypost_refund_status,
        refund_submitted_at,
        cancelled_at,
        created_at,
        delivered_at,
        stripe_payment_intent_id,
        sendmo_links!inner (
          short_code,
          link_type,
          status,
          user_id,
          profiles (
            id,
            email,
            stripe_customer_id_live,
            stripe_customer_id_test
          )
        ),
        transactions (
          id,
          type,
          amount_cents,
          stripe_intent_id,
          idempotency_key,
          created_at
        ),
        carrier_adjustments (
          id,
          delta_cents,
          reason,
          claimed_weight_oz,
          captured_weight_oz,
          recovery_status,
          recovery_tx_id,
          expected_credit_cents,
          created_at,
          resolved_at,
          source_event_id
        ),
        sender_address:sender_address_id ( name, street1, city, state, zip ),
        recipient_address:recipient_address_id ( name, street1, city, state, zip )
      `)
      .gte("created_at", `${startDate}T00:00:00.000Z`)
      .lte("created_at", endDatetime);

    if (envFilter === "production") shipQuery = shipQuery.eq("is_test", false);
    else if (envFilter === "test") shipQuery = shipQuery.eq("is_test", true);

    const { data: shipments, error: shipErr } = await shipQuery.order("created_at", { ascending: false });

    if (shipErr) {
      throw new Error(`Shipments query failed: ${shipErr.message}`);
    }

    // ── 1b. Stripe-side ledger via PI back-reference ────────────────────────
    // `transactions` is append-only (no UPDATE grant for service_role), so
    // charge/refund/fee_stripe/chargeback rows are written with shipment_id
    // IS NULL — by the time the PI succeeds, the shipments row doesn't exist
    // yet (it's minted later in labels/index.ts). We instead reverse the
    // join: labels/index.ts populates shipments.stripe_payment_intent_id
    // after admin_insert_shipment, and the historical backfill script
    // (scripts/backfill-charge-shipment-links-2026-05-23.mjs) populated it
    // for pre-existing rows. Here we look up the Stripe-side ledger rows by
    // shipments.stripe_payment_intent_id ↔ transactions.stripe_intent_id and
    // merge them into each shipment's transactions array. Net-margin math
    // below is unchanged — it still sums by type.
    const piIds = ((shipments as Array<{ stripe_payment_intent_id: string | null }>) ?? [])
      .map((s) => s.stripe_payment_intent_id)
      .filter((p): p is string => !!p);

    const piTxMap = new Map<string, Array<{
      id: string;
      type: string;
      amount_cents: number;
      stripe_intent_id: string | null;
      idempotency_key: string | null;
      created_at: string;
    }>>();

    if (piIds.length > 0) {
      const { data: piTxs, error: piTxErr } = await supabase
        .from("transactions")
        .select("id, type, amount_cents, stripe_intent_id, idempotency_key, created_at")
        .in("stripe_intent_id", piIds)
        .in("type", ["charge", "refund", "fee_stripe", "chargeback"]);
      if (piTxErr) {
        throw new Error(`PI-side transactions query failed: ${piTxErr.message}`);
      }
      for (const t of piTxs ?? []) {
        if (!t.stripe_intent_id) continue;
        const arr = piTxMap.get(t.stripe_intent_id) ?? [];
        arr.push(t);
        piTxMap.set(t.stripe_intent_id, arr);
      }
    }

    // ── 2. Compute per-shipment financials ──────────────────────────────────
    type TxRow = {
      id: string;
      type: string;
      amount_cents: number;
      stripe_intent_id: string | null;
      idempotency_key: string | null;
      created_at: string;
    };

    type AdjRow = {
      id: string;
      delta_cents: number;
      reason: string | null;
      claimed_weight_oz: number | null;
      captured_weight_oz: number | null;
      recovery_status: string;
      recovery_tx_id: string | null;
      expected_credit_cents: number | null;
      created_at: string;
      resolved_at: string | null;
      source_event_id: string | null;
    };

    interface ShipmentRow {
      id: string;
      easypost_shipment_id: string | null;
      carrier: string | null;
      service: string | null;
      tracking_number: string | null;
      label_url: string | null;
      rate_cents: number | null;
      status: string;
      is_test: boolean;
      is_live: boolean;
      payment_method: string | null;
      refund_status: string | null;
      easypost_refund_status: string | null;
      refund_submitted_at: string | null;
      cancelled_at: string | null;
      created_at: string;
      delivered_at: string | null;
      stripe_payment_intent_id: string | null;
      sendmo_links: {
        user_id: string;
        short_code: string;
        link_type: string;
        status: string;
        profiles: { id: string; email: string; stripe_customer_id_live: string | null; stripe_customer_id_test: string | null } | null;
      } | null;
      transactions: TxRow[] | null;
      carrier_adjustments: AdjRow[] | null;
      sender_address: { name: string; street1: string; city: string; state: string; zip: string } | null;
      recipient_address: { name: string; street1: string; city: string; state: string; zip: string } | null;
    }

    const rows: object[] = [];
    const needsAttention: object[] = [];

    let totalNetMarginCents = 0;
    let reconciledCount = 0;
    let carrierAdjsTotalCents = 0;
    let refundsInFlightCents = 0;
    let chargebacksCount = 0;

    for (const sh of (shipments as ShipmentRow[]) ?? []) {
      // Per-shipment ledger = shipment_id-linked rows (label_cost,
      // easypost_refund, comp_grant) + PI-linked rows resolved through
      // shipments.stripe_payment_intent_id (charge, refund, fee_stripe,
      // chargeback). Dedupe by id in case a row carries both linkages
      // (defensive — should not happen with current writers).
      const shipTxs = sh.transactions ?? [];
      const piTxs = sh.stripe_payment_intent_id
        ? (piTxMap.get(sh.stripe_payment_intent_id) ?? [])
        : [];
      const seenIds = new Set<string>(shipTxs.map((t) => t.id));
      const txs: TxRow[] = [...shipTxs];
      for (const t of piTxs) {
        if (!seenIds.has(t.id)) {
          txs.push(t);
          seenIds.add(t.id);
        }
      }

      // Sum each transaction type.
      const sumByType = (type: string) =>
        txs.filter((t) => t.type === type).reduce((sum, t) => sum + t.amount_cents, 0);

      const paid = sumByType("charge");                          // + customer paid
      const stripeFee = Math.abs(sumByType("fee_stripe"));       // absolute (stored negative)
      const refundedToCustomer = Math.abs(sumByType("refund"));  // absolute (stored negative)
      const adjustmentCollected = sumByType("carrier_adjustment") > 0
        ? 0
        : Math.abs(txs.filter((t) => t.type === "carrier_adjustment" && t.amount_cents > 0)
            .reduce((sum, t) => sum + t.amount_cents, 0));
      // Adjustment collected = positive carrier_adjustment tx (re-charge rows)
      const adjCollected = txs
        .filter((t) => t.type === "carrier_adjustment" && t.amount_cents > 0)
        .reduce((sum, t) => sum + t.amount_cents, 0);
      const chargebackSum = Math.abs(sumByType("chargeback"));   // absolute (stored negative)
      const labelCost = Math.abs(sumByType("label_cost"));       // absolute (stored negative)
      const easypostRefund = sumByType("easypost_refund");       // + EP credited back
      // Adjustment charged (EasyPost billed wallet) = negative carrier_adjustment txs
      const adjCharged = Math.abs(txs
        .filter((t) => t.type === "carrier_adjustment" && t.amount_cents < 0)
        .reduce((sum, t) => sum + t.amount_cents, 0));

      // Net margin identity (proposal §2.5, mockup line ~450):
      // Paid − Stripe fee − Refund to customer + Adjustment collected
      // − Chargeback − Label cost + Refund from EasyPost − Adjustment charged
      const netMargin = paid - stripeFee - refundedToCustomer + adjCollected
        - chargebackSum - labelCost + easypostRefund - adjCharged;

      totalNetMarginCents += netMargin;
      carrierAdjsTotalCents += adjCharged;
      if (chargebackSum > 0) chargebacksCount++;

      // In-flight refunds: submitted but not yet confirmed
      if (sh.refund_status === "submitted") {
        refundsInFlightCents += paid - refundedToCustomer;
      }

      // Reconciliation status
      const hasPendingAdj = (sh.carrier_adjustments ?? []).some(
        (a) => a.recovery_status === "pending"
      );
      const hasOpenChargeback = chargebackSum > 0; // simplified — real impl would check dispute status
      const isStuckRefund = sh.refund_status === "submitted" &&
        sh.refund_submitted_at != null &&
        daysSince(sh.refund_submitted_at) > 21;

      let reconStatus = "reconciled";
      if (hasPendingAdj) reconStatus = "adjustment_review";
      else if (hasOpenChargeback) reconStatus = "chargeback";
      else if (isStuckRefund) reconStatus = "refund_overdue";

      if (reconStatus === "reconciled") reconciledCount++;

      // Needs-attention items
      if (hasOpenChargeback) {
        needsAttention.push({
          type: "chargeback",
          shipment_id: sh.id,
          shipment_public: `SM-${sh.id.split("-")[0].slice(0, 4).toUpperCase()}`,
          carrier: sh.carrier,
          amount_cents: chargebackSum,
          tracking_number: sh.tracking_number,
        });
      }

      if (hasPendingAdj) {
        for (const adj of (sh.carrier_adjustments ?? []).filter(
          (a) => a.recovery_status === "pending"
        )) {
          const windowDays = getDisputeWindowDays(sh.carrier ?? "");
          const daysElapsed = daysSince(adj.created_at);
          const daysUntilDeadline = windowDays - daysElapsed;
          needsAttention.push({
            type: "carrier_adjustment",
            shipment_id: sh.id,
            shipment_public: `SM-${sh.id.split("-")[0].slice(0, 4).toUpperCase()}`,
            carrier: sh.carrier,
            carrier_adjustment_id: adj.id,
            delta_cents: adj.delta_cents,
            reason: adj.reason,
            claimed_weight_oz: adj.claimed_weight_oz,
            captured_weight_oz: adj.captured_weight_oz,
            days_until_dispute_deadline: daysUntilDeadline,
            deadline_past: daysUntilDeadline < 0,
          });
        }
      }

      if (isStuckRefund) {
        needsAttention.push({
          type: "stuck_refund",
          shipment_id: sh.id,
          shipment_public: `SM-${sh.id.split("-")[0].slice(0, 4).toUpperCase()}`,
          carrier: sh.carrier,
          refund_submitted_at: sh.refund_submitted_at,
          days_since_submitted: sh.refund_submitted_at ? daysSince(sh.refund_submitted_at) : null,
        });
      }

      rows.push({
        shipment_id: sh.id,
        shipment_public: `SM-${sh.id.split("-")[0].slice(0, 4).toUpperCase()}`,
        easypost_shipment_id: sh.easypost_shipment_id,
        carrier: sh.carrier,
        service: sh.service,
        tracking_number: sh.tracking_number,
        label_url: sh.label_url,
        is_test: sh.is_test,
        is_live: sh.is_live,
        payment_method: sh.payment_method,
        link_short_code: sh.sendmo_links?.short_code ?? null,
        link_type: sh.sendmo_links?.link_type ?? null,
        owner_user_id: sh.sendmo_links?.user_id ?? sh.sendmo_links?.profiles?.id ?? null,
        owner_email: sh.sendmo_links?.profiles?.email ?? null,
        // Timeline
        label_created_at: sh.created_at,
        shipped_at: null, // shipments.shipped_at column doesn't exist; derive from tracker events in a future pass
        delivered_at: sh.delivered_at,
        cancelled_at: sh.cancelled_at,
        // Addresses
        sender_address: sh.sender_address,
        recipient_address: sh.recipient_address,
        // Financials (all in cents)
        paid_cents: paid,
        stripe_fee_cents: -stripeFee,                  // negative = cost
        refunded_to_customer_cents: -refundedToCustomer, // negative = outflow
        adjustment_collected_cents: adjCollected,
        chargeback_cents: -chargebackSum,              // negative = loss
        label_cost_cents: -labelCost,                  // negative = cost
        easypost_refund_cents: easypostRefund,
        adjustment_charged_cents: -adjCharged,         // negative = cost
        net_margin_cents: netMargin,
        // Status
        shipment_status: sh.status,
        refund_status: sh.refund_status,
        easypost_refund_status: sh.easypost_refund_status,
        recon_status: reconStatus,
        // Carrier adjustments
        carrier_adjustments: (sh.carrier_adjustments ?? []).map((a) => ({
          id: a.id,
          delta_cents: a.delta_cents,
          reason: a.reason,
          claimed_weight_oz: a.claimed_weight_oz,
          captured_weight_oz: a.captured_weight_oz,
          recovery_status: a.recovery_status,
          created_at: a.created_at,
          resolved_at: a.resolved_at,
          days_until_dispute_deadline: (() => {
            const w = getDisputeWindowDays(sh.carrier ?? "");
            return w - daysSince(a.created_at);
          })(),
        })),
        // Raw transactions for the detail view
        transactions: txs.map((t) => ({
          id: t.id,
          type: t.type,
          amount_cents: t.amount_cents,
          created_at: t.created_at,
        })),
        // References
        stripe_payment_intent_id: sh.stripe_payment_intent_id,
      });
    }

    // ── 3. EasyPost wallet balance ──────────────────────────────────────────
    const walletBalanceCents = await fetchEasyPostWalletBalance();

    // ── 4. Summary ─────────────────────────────────────────────────────────
    const totalCount = (shipments ?? []).length;
    const summary = {
      total_count: totalCount,
      reconciled_count: reconciledCount,
      needs_attention_count: needsAttention.length,
      net_margin_cents: totalNetMarginCents,
      carrier_adjustments_total_cents: carrierAdjsTotalCents,
      refunds_in_flight_cents: refundsInFlightCents,
      chargebacks_count: chargebacksCount,
      easypost_wallet_balance_cents: walletBalanceCents,
      period: { start_date: startDate, end_date: endDate },
      last_run_at: new Date().toISOString(),
    };

    return new Response(
      JSON.stringify({ summary, needs_attention: needsAttention, rows }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("reconciliation-report error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
