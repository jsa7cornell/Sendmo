// supabase/functions/admin-recon-action/index.ts
//
// POST /admin-recon-action
//
// Admin-only. Action buttons from the Reconciliation tab's Needs-Attention panel.
// Body: { action: 'dispute' | 'recharge' | 'absorb', carrier_adjustment_id: UUID, expected_credit_cents?: number }
//
// Actions:
//   dispute  — set recovery_status='disputed', store expected_credit_cents (N4 fix).
//              Admin then files manually with the carrier (USPS/UPS/FedEx).
//   recharge — call resolveRecovery / createAdjustmentRecharge even for >$10 (admin override).
//   absorb   — set recovery_status='absorbed'. Terminal.
//
// Returns the updated carrier_adjustment row + an audit event_logs entry.
//
// Decided proposal:
//   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
//   §2.4 (recovery — tiered policy), §3 admin-recon-action Edge Function, N4

import { requireAdmin } from "../_shared/auth.ts";
import { log } from "../_shared/logger.ts";
import { resolveRecovery } from "../_shared/adjustments.ts";
import { createAdjustmentRecharge } from "../_shared/stripe.ts";
import type { AdjustmentShipment, AdjustmentPaymentContext } from "../_shared/adjustments.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let supabase;
  let adminUser;
  try {
    ({ supabase, user: adminUser } = await requireAdmin(req, corsHeaders));
  } catch (r) {
    if (r instanceof Response) return r;
    throw r;
  }

  const sessionId = `recon_action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let body: {
    action?: string;
    carrier_adjustment_id?: string;
    expected_credit_cents?: number;
  } = {};

  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { action, carrier_adjustment_id, expected_credit_cents } = body;

  if (!action || !carrier_adjustment_id) {
    return new Response(
      JSON.stringify({ error: "action and carrier_adjustment_id are required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const validActions = ["dispute", "recharge", "absorb"];
  if (!validActions.includes(action)) {
    return new Response(
      JSON.stringify({ error: `action must be one of: ${validActions.join(", ")}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // Fetch the carrier adjustment + its shipment.
    const { data: adj, error: adjErr } = await supabase
      .from("carrier_adjustments")
      .select(`
        id,
        shipment_id,
        delta_cents,
        reason,
        recovery_status,
        recovery_tx_id,
        expected_credit_cents,
        created_at,
        resolved_at,
        source_event_id,
        shipments (
          id,
          public_code,
          carrier,
          is_test,
          stripe_payment_intent_id,
          easypost_shipment_id,
          sendmo_links!inner (
            user_id,
            profiles (
              email,
              stripe_customer_id_live,
              stripe_customer_id_test
            )
          )
        )
      `)
      .eq("id", carrier_adjustment_id)
      .single();

    if (adjErr || !adj) {
      return new Response(
        JSON.stringify({ error: "Carrier adjustment not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const sh = (adj as unknown as {
      shipments: {
        id: string;
        public_code: string;
        carrier: string | null;
        is_test: boolean;
        stripe_payment_intent_id: string | null;
        easypost_shipment_id: string | null;
        sendmo_links: {
          user_id: string;
          profiles: { email: string; stripe_customer_id_live: string | null; stripe_customer_id_test: string | null } | null;
        } | null;
      };
    }).shipments;

    if (!sh) {
      return new Response(
        JSON.stringify({ error: "Associated shipment not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const adjData = adj as unknown as {
      id: string;
      delta_cents: number;
      reason: string | null;
      recovery_status: string;
      created_at: string;
    };

    let updatedAdj: object = adj as object;

    // ── Handle each action ─────────────────────────────────────────────────

    if (action === "absorb") {
      // Terminal — no further action, no customer charge.
      const { data: updated, error: updateErr } = await supabase
        .from("carrier_adjustments")
        .update({
          recovery_status: "absorbed",
          resolved_at: new Date().toISOString(),
        })
        .eq("id", carrier_adjustment_id)
        .select()
        .single();

      if (updateErr) throw new Error(`Failed to update: ${updateErr.message}`);
      updatedAdj = updated;

    } else if (action === "dispute") {
      // Mark as disputed. Admin will file with carrier manually.
      // N4 fix: store expected_credit_cents so the sweep can pattern-match
      // a later unexplained EP wallet credit.
      const updates: Record<string, unknown> = {
        recovery_status: "disputed",
        resolved_at: new Date().toISOString(),
      };
      if (expected_credit_cents != null) {
        updates.expected_credit_cents = expected_credit_cents;
      }

      const { data: updated, error: updateErr } = await supabase
        .from("carrier_adjustments")
        .update(updates)
        .eq("id", carrier_adjustment_id)
        .select()
        .single();

      if (updateErr) throw new Error(`Failed to update: ${updateErr.message}`);
      updatedAdj = updated;

    } else if (action === "recharge") {
      // Admin override — force recharge even for >$10.
      // We bypass the $10 threshold check that resolveRecovery would apply,
      // but still use the same recharge primitive for consistency.
      const userId = sh.sendmo_links?.user_id;

      if (!userId) {
        return new Response(
          JSON.stringify({ error: "Could not resolve user for this shipment" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // payment_methods is not nested under shipments — fetch separately by user_id.
      const { data: pms } = await supabase
        .from("payment_methods")
        .select("id, stripe_payment_method_id, is_default, deleted_at")
        .eq("user_id", userId)
        .is("deleted_at", null);
      const activePMs = pms ?? [];
      const defaultPM = activePMs.find((pm) => pm.is_default) ?? activePMs[0];

      if (!defaultPM) {
        return new Response(
          JSON.stringify({ error: "No saved payment method on file for this shipment's user" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const profile = sh.sendmo_links?.profiles;
      const customerId = sh.is_test
        ? (profile?.stripe_customer_id_test ?? null)
        : (profile?.stripe_customer_id_live ?? null);

      if (!customerId) {
        return new Response(
          JSON.stringify({ error: "No Stripe Customer ID found for this user" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const shipmentContext: AdjustmentShipment = {
        id: sh.id,
        public_code: sh.public_code ?? sh.id.slice(0, 8),
        user_id: userId,
        carrier: sh.carrier,
        is_test: sh.is_test,
        stripe_payment_intent_id: sh.stripe_payment_intent_id,
      };

      // Admin override: use attempt=99 to distinguish from auto-recharge attempts.
      // (Fixed 2026-07-15: this call previously passed a `shipment:` object and
      // omitted shipmentId/publicCode — a nonexistent-param bug that silently
      // produced `adjustment_undefined_…` idempotency keys. Same class as the H2
      // repair; corrected while the signature gained the required userId param.)
      const rechargeResult = await createAdjustmentRecharge({
        shipmentId: shipmentContext.id,
        publicCode: shipmentContext.public_code,
        userId: userId,
        deltaCents: adjData.delta_cents,
        carrierAdjustmentId: carrier_adjustment_id,
        attempt: 99, // admin override attempt
        paymentMethodId: defaultPM.stripe_payment_method_id,
        customerId,
        liveMode: !sh.is_test,
      });

      const rechargeSuccess = rechargeResult?.status === "succeeded";

      const { data: updated, error: updateErr } = await supabase
        .from("carrier_adjustments")
        .update({
          recovery_status: rechargeSuccess ? "recovered" : "pending",
          resolved_at: rechargeSuccess ? new Date().toISOString() : null,
        })
        .eq("id", carrier_adjustment_id)
        .select()
        .single();

      if (updateErr) throw new Error(`Failed to update: ${updateErr.message}`);
      updatedAdj = updated;

      if (!rechargeSuccess) {
        return new Response(
          JSON.stringify({
            error: "Recharge PaymentIntent did not succeed",
            pi_status: rechargeResult?.status,
            carrier_adjustment: updatedAdj,
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Audit log entry.
    await log({
      event_type: `recon.admin_action`,
      session_id: sessionId,
      severity: "info",
      entity_type: "carrier_adjustment",
      entity_id: carrier_adjustment_id,
      properties: {
        action,
        admin_user_id: adminUser.id,
        admin_email: adminUser.email,
        shipment_id: sh.id,
        delta_cents: adjData.delta_cents,
        expected_credit_cents: expected_credit_cents ?? null,
        previous_recovery_status: adjData.recovery_status,
      },
    });

    return new Response(
      JSON.stringify({ ok: true, action, carrier_adjustment: updatedAdj }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("admin-recon-action error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
