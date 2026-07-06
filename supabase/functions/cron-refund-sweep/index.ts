import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";
import { isCronCall } from "../_shared/cron-auth.ts";
import { initiateCancelRefund } from "../_shared/refunds.ts";
import { getPaidAmountCentsForShipment } from "../_shared/paid-amount.ts";
import { writeEasypostRefund } from "../_shared/ledger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { refundUnsuccessfulEmail, refundCompletedEmail } from "../_shared/email-templates.ts";
import { log } from "../_shared/logger.ts";

// =============================================================================
// cron-refund-sweep — H5 of the pre-launch P1 build
//
// Decided proposals:
//   2026-05-21_refund-system-implementation_..._decided-2026-05-22.md (D3/D4/D5)
//   2026-05-23_pre-launch-handoff-plan.md §Package H5
//
// Purpose: Find refund_status='submitted' shipments older than 28 days, poll
// EasyPost one last time, and resolve:
//
//   EP 'refunded'  → fire createRefund (catches missed webhook + easypost_refund ledger row)
//   EP 'rejected'  → mark refund_status='rejected' + send Email C
//   EP 'submitted' → mark refund_status='rejected' (timeout terminal per D3)
//                    leave easypost_refund_status='submitted' as the timeout signature
//                    + send Email C
//
// STALE_DAYS = 28 (was 21) — aligned with the documented "refunds take 2–4
// weeks" policy so a carrier confirming in week 4 arrives BEFORE the terminal
// 'rejected' + "refund unsuccessful" email, not after. A carrier confirmation
// that still lands after the timeout is not lost: the refund.successful
// webhook path fires the Stripe refund regardless (its stripe-webhook advance
// is being widened to rejected→refunded in a parallel change).
//
// Auth: admin-only (requireAdmin) for manual invocation; service role JWT for
// the pg_cron scheduled path (cron registration is DEFERRED to fast-follow —
// see migration 035 Block 2).
//
// No recon_state cursor: the scan is fully determined by the
// refund_submitted_at < (now - STALE_DAYS) filter, and processed shipments
// leave refund_status='submitted', so runs are naturally idempotent. (A
// key='refund_sweep' cursor was written here until 2026-07 but never read —
// dead bookkeeping, removed.)
//
// Cron schedule (when pg_cron is enabled): daily 04:30 UTC — offset 30 min
// from H4's reconciliation-sweep (04:00 UTC) to avoid concurrent load.
// =============================================================================

const APP_URL = "https://sendmo.co";
const STALE_DAYS = 28;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Send Email C (refund unsuccessful) with notifications_log dedup. */
async function sendEmailC(
  supabase: ReturnType<typeof createClient>,
  shipment: {
    id: string;
    public_code: string;
    carrier: string | null;
    rate_cents: number | null;
    stripe_payment_intent_id: string | null;
    link_user_id: string | null;
  },
  reason: string | null,
  trigger: string,
): Promise<void> {
  if (!shipment.stripe_payment_intent_id) return;

  // Dedup: attempt to insert a notifications_log row.
  const { error: logErr } = await supabase
    .from("notifications_log")
    .insert({
      shipment_id: shipment.id,
      contact_id: null,
      channel: "email",
      event_type: "refund.unsuccessful",
      status: "sent",
      provider_id: shipment.stripe_payment_intent_id,
    });

  if (logErr && /duplicate key|unique constraint/i.test(logErr.message)) {
    return; // already sent
  }
  if (logErr) throw new Error(`notifications_log insert failed: ${logErr.message}`);

  // Look up payer email via link owner.
  let payerEmail: string | null = null;
  if (shipment.link_user_id) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", shipment.link_user_id)
      .maybeSingle();
    payerEmail = (profile as { email?: string | null } | null)?.email ?? null;
  }
  if (!payerEmail) return;

  // Quote what the CUSTOMER paid (the +charge ledger row), not
  // shipments.rate_cents (SendMo's EasyPost cost — ~15%+$1 lower). Falls
  // back to rate_cents when no charge row exists.
  const paidAmountCents = await getPaidAmountCentsForShipment(
    supabase,
    shipment.stripe_payment_intent_id,
    shipment.rate_cents ?? 0,
  );
  const tpl = refundUnsuccessfulEmail({
    amount_cents: paidAmountCents,
    carrier: shipment.carrier ?? "the carrier",
    public_code: shipment.public_code,
    tracking_url: `${APP_URL}/t/${shipment.public_code}`,
    reason,
  });

  await sendEmail({ to: payerEmail, subject: tpl.subject, html: tpl.html });
  log({
    event_type: "refund.unsuccessful_email_sent",
    source: "cron-refund-sweep",
    severity: "info",
    entity_type: "shipment",
    entity_id: shipment.id,
    properties: {
      recipient: payerEmail,
      payment_intent_id: shipment.stripe_payment_intent_id,
      trigger,
    },
  });
}

/** Send Email B (refund completed) with notifications_log dedup. */
async function sendEmailB(
  supabase: ReturnType<typeof createClient>,
  shipment: {
    id: string;
    public_code: string;
    rate_cents: number | null;
    stripe_payment_intent_id: string | null;
    link_user_id: string | null;
  },
  stripeRefundId: string,
  trigger: string,
): Promise<void> {
  if (!shipment.stripe_payment_intent_id) return;

  const { error: logErr } = await supabase
    .from("notifications_log")
    .insert({
      shipment_id: shipment.id,
      contact_id: null,
      channel: "email",
      event_type: "refund.completed",
      status: "sent",
      provider_id: stripeRefundId,
    });

  if (logErr && /duplicate key|unique constraint/i.test(logErr.message)) return;
  if (logErr) throw new Error(`notifications_log insert failed: ${logErr.message}`);

  let payerEmail: string | null = null;
  if (shipment.link_user_id) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", shipment.link_user_id)
      .maybeSingle();
    payerEmail = (profile as { email?: string | null } | null)?.email ?? null;
  }
  if (!payerEmail) return;

  // Quote what the CUSTOMER paid (the +charge ledger row), not
  // shipments.rate_cents (SendMo's EasyPost cost — ~15%+$1 lower). Falls
  // back to rate_cents when no charge row exists.
  const paidAmountCents = await getPaidAmountCentsForShipment(
    supabase,
    shipment.stripe_payment_intent_id,
    shipment.rate_cents ?? 0,
  );
  const tpl = refundCompletedEmail({
    amount_cents: paidAmountCents,
    public_code: shipment.public_code,
    tracking_url: `${APP_URL}/t/${shipment.public_code}`,
    last4: null, // sweep path doesn't have the card details readily available
  });

  await sendEmail({ to: payerEmail, subject: tpl.subject, html: tpl.html });
  log({
    event_type: "refund.completed_email_sent",
    source: "cron-refund-sweep",
    severity: "info",
    entity_type: "shipment",
    entity_id: shipment.id,
    properties: {
      recipient: payerEmail,
      payment_intent_id: shipment.stripe_payment_intent_id,
      stripe_refund_id: stripeRefundId,
      trigger,
    },
  });
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sessionId = req.headers.get("x-session-id") || crypto.randomUUID();

  // ── Auth: pg_cron (service-role Bearer) OR manual admin (user JWT) ──────────
  // The cron path uses the service-role key as Bearer (isCronCall); the manual
  // path is admin-gated via requireAdmin. Either is valid. Note: this function
  // does NOT use the `supabase` client requireAdmin returns — it builds its own
  // `serviceSupabase` below for all DB work — so the cron path needs no client
  // binding here. (Fixes the silent-403-on-every-cron-run bug: previously this
  // called requireAdmin unconditionally, so a service-role Bearer resolved to a
  // principal with no profiles.role='admin' row → 403 → the sweep never ran.)
  if (!isCronCall(req)) {
    try {
      await requireAdmin(req, corsHeaders);
    } catch (r) {
      if (r instanceof Response) return r;
      throw r;
    }
  }

  const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
  if (!sbUrl || !sbKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // Use service-role client for all DB writes.
  const serviceSupabase = createClient(sbUrl, sbKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const easypostApiKey = Deno.env.get("EASYPOST_API_KEY");
  if (!easypostApiKey) {
    return new Response(JSON.stringify({ error: "EasyPost API key not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const runStarted = new Date().toISOString();
  const cutoffDate = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  log({
    event_type: "cron_refund_sweep.started",
    session_id: sessionId,
    severity: "info",
    source: "cron-refund-sweep",
    properties: { cutoff_date: cutoffDate, stale_days: STALE_DAYS },
  });

  // ── Fetch stale submitted-refund shipments ─────────────────────────────────
  // Find all live (non-test) shipments where:
  //   - refund_status = 'submitted' (void was submitted to carrier, waiting)
  //   - refund_submitted_at < (now - 28 days) — stale (2–4-week policy)
  //   - easypost_shipment_id is present (required for EP poll)
  //   - is_test = false (only live labels are real-money refunds)
  const { data: staleShipments, error: fetchErr } = await serviceSupabase
    .from("shipments")
    .select(
      "id, public_code, carrier, rate_cents, easypost_shipment_id, stripe_payment_intent_id, refund_submitted_at, is_test, sendmo_links!inner(user_id)"
    )
    .eq("refund_status", "submitted")
    .eq("is_test", false)
    .lt("refund_submitted_at", cutoffDate)
    .not("easypost_shipment_id", "is", null)
    .limit(100); // process at most 100 per run — safe for first months of operation

  if (fetchErr) {
    const msg = `Failed to fetch stale shipments: ${fetchErr.message}`;
    log({
      event_type: "cron_refund_sweep.fetch_error",
      session_id: sessionId,
      severity: "error",
      source: "cron-refund-sweep",
      properties: { error_message: msg },
    });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results = {
    processed: 0,
    refunded: 0,
    rejected: 0,
    timed_out: 0,
    errors: 0,
  };

  for (const rawShipment of (staleShipments ?? [])) {
    const linkJoin = rawShipment.sendmo_links as unknown as { user_id?: string } | null;
    const shipment = {
      ...rawShipment,
      link_user_id: linkJoin?.user_id ?? null,
    };

    results.processed++;

    try {
      // Poll EasyPost one last time.
      const epResp = await fetch(
        `https://api.easypost.com/v2/shipments/${shipment.easypost_shipment_id}`,
        { headers: { Authorization: "Basic " + btoa(easypostApiKey + ":") } }
      );

      if (!epResp.ok) {
        console.error(`[cron-refund-sweep] EasyPost fetch failed for ${shipment.id}: ${epResp.status}`);
        results.errors++;
        continue;
      }

      const epShip = await epResp.json();
      const epRefundStatus: string | null = epShip?.refund_status ?? null;

      // Extract the refund object (most recent).
      const refundObjects = (epShip.refunds as Array<{ id: string; amount: string | number; status: string; message?: string }> | null) ?? [];
      const refundObj = refundObjects[0] ?? null;

      if (epRefundStatus === "refunded") {
        // ── Branch 1: EP confirmed refunded (missed webhook) ─────────────────
        // Fire Stripe createRefund to catch the missed charge.refunded webhook.
        const refundObjId = refundObj?.id ?? `shp_fallback_${shipment.easypost_shipment_id}`;
        const refundAmountCents = refundObj?.amount
          ? Math.round(parseFloat(String(refundObj.amount)) * 100)
          : (shipment.rate_cents ?? 0);

        if (shipment.stripe_payment_intent_id) {
          // Shared helper (Rule 6) — computes the per-PI refundable balance
          // and skips the Stripe call when it is <= 0 (logs
          // cancel.stripe_refund_skipped_no_balance). Same idempotency key
          // as the tracking-poll and webhook triggers, so Stripe dedupes.
          const refundResult = await initiateCancelRefund({
            supabase: serviceSupabase,
            stripePaymentIntentId: shipment.stripe_payment_intent_id,
            easypostShipmentId: shipment.easypost_shipment_id!,
            shipmentId: shipment.id,
            publicCode: shipment.public_code,
            trigger: "cron_refund_sweep",
            liveMode: true, // only live shipments are processed
          });
          const stripeRefundId: string | null = refundResult.skipped
            ? null
            : refundResult.stripeRefundId;

          // Write easypost_refund ledger row (idempotent). Awaited — the
          // helper never throws by design, and ledger completeness matters
          // more than one cheap DB write of latency.
          await writeEasypostRefund({
            supabase: serviceSupabase,
            sessionId,
            shipmentId: shipment.id,
            userId: shipment.link_user_id ?? "00000000-0000-0000-0000-000000000001",
            linkId: null,
            easypostShipmentId: shipment.easypost_shipment_id!,
            easypostRefundObjectId: refundObjId,
            refundAmountCents,
            mode: "live",
            isComp: false,
            source: "cron_refund_sweep",
          });

          // Update easypost_refund_status — charge.refunded webhook will
          // advance refund_status to 'refunded' when it fires.
          await serviceSupabase
            .from("shipments")
            .update({ easypost_refund_status: "refunded" })
            .eq("id", shipment.id);

          // Send Email B if we have a Stripe refund id.
          if (stripeRefundId) {
            await sendEmailB(serviceSupabase, shipment, stripeRefundId, "cron_refund_sweep");
          }
        }

        results.refunded++;
        log({
          event_type: "cron_refund_sweep.resolved_refunded",
          session_id: sessionId,
          severity: "info",
          source: "cron-refund-sweep",
          entity_type: "shipment",
          entity_id: shipment.id,
          properties: { easypost_refund_status: "refunded", trigger: "cron" },
        });

      } else if (epRefundStatus === "rejected") {
        // ── Branch 2: EP rejected (carrier scanned the label) ────────────────
        await serviceSupabase
          .from("shipments")
          .update({ refund_status: "rejected", easypost_refund_status: "rejected" })
          .eq("id", shipment.id);

        const rejectedRefund = refundObjects.find((r) => r.status === "rejected");
        const reason = rejectedRefund?.message ?? null;

        await sendEmailC(serviceSupabase, shipment, reason, "cron_refund_sweep_rejected");

        results.rejected++;
        log({
          event_type: "cron_refund_sweep.resolved_rejected",
          session_id: sessionId,
          severity: "warn",
          source: "cron-refund-sweep",
          entity_type: "shipment",
          entity_id: shipment.id,
          properties: { ep_reason: reason },
        });

      } else {
        // ── Branch 3: EP still 'submitted' → timeout terminal (D3) ──────────
        // Decision D3: mark rejected after 28 days even if EP still says submitted.
        // Signature: refund_status='rejected', easypost_refund_status='submitted'
        // (the lingering 'submitted' is the timeout signature so admins can tell
        // this was a timeout vs a hard carrier rejection).
        await serviceSupabase
          .from("shipments")
          .update({ refund_status: "rejected" })  // easypost_refund_status stays 'submitted'
          .eq("id", shipment.id)
          .eq("refund_status", "submitted"); // idempotent guard

        await sendEmailC(serviceSupabase, shipment, null, "cron_refund_sweep_timeout");

        results.timed_out++;
        log({
          event_type: "cron_refund_sweep.resolved_timeout",
          session_id: sessionId,
          severity: "warn",
          source: "cron-refund-sweep",
          entity_type: "shipment",
          entity_id: shipment.id,
          properties: {
            ep_refund_status: epRefundStatus,
            days_old: Math.floor(
              (Date.now() - new Date(shipment.refund_submitted_at ?? runStarted).getTime()) / (1000 * 60 * 60 * 24)
            ),
          },
        });
      }

    } catch (shipErr) {
      const msg = shipErr instanceof Error ? shipErr.message : String(shipErr);
      console.error(`[cron-refund-sweep] Error processing shipment ${shipment.id}:`, msg);
      results.errors++;
      log({
        event_type: "cron_refund_sweep.shipment_error",
        session_id: sessionId,
        severity: "error",
        source: "cron-refund-sweep",
        entity_type: "shipment",
        entity_id: shipment.id,
        properties: { error_message: msg },
      });
    }
  }

  // (No recon_state cursor write — the sweep's query filters on
  // refund_submitted_at, so the key='refund_sweep' cursor was dead bookkeeping.)

  log({
    event_type: "cron_refund_sweep.completed",
    session_id: sessionId,
    severity: "info",
    source: "cron-refund-sweep",
    properties: results,
  });

  return new Response(
    JSON.stringify({
      success: true,
      cutoff_date: cutoffDate,
      ...results,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
