import { createClient } from "jsr:@supabase/supabase-js@2.97.0";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { dispatchNotifications } from "../_shared/notifications.ts";
import { writeEasypostRefund } from "../_shared/ledger.ts";
import { resolveRecovery, type AdjustmentShipment, type AdjustmentPaymentContext } from "../_shared/adjustments.ts";
import { initiateCancelRefund } from "../_shared/refunds.ts";
import { runInBackground } from "../_shared/background.ts";

/**
 * Webhook handler for EasyPost tracker updates.
 * POST /webhooks — EasyPost sends tracker.updated events here.
 *
 * Updates shipment status in DB and dispatches notifications to all
 * registered contacts (sender + recipient) via the notification system.
 *
 * HMAC verification (Stripe-proposal Phase 0):
 * EasyPost signs each webhook body with HMAC-SHA256 of the raw request
 * body using a shared secret. We verify the X-Hmac-Signature header.
 *
 * Rollout-safe enforcement: if EASYPOST_WEBHOOK_HMAC_SECRET is unset,
 * verification is skipped (current behavior) and we log a warning so
 * John can see it's not configured. Once the secret is set as a Supabase
 * function secret AND the matching value is in the EasyPost dashboard,
 * verification turns on automatically with the next request — no code
 * deploy needed to flip it.
 *
 * Header name is `X-Hmac-Signature` per EasyPost docs (round-2 N6 fix
 * in the Stripe proposal).
 */

// Maps EasyPost tracker.status values to SendMo shipment.status values.
//
// EasyPost status taxonomy (from docs.easypost.com/docs/trackers):
//   pre_transit   — label created, not yet picked up by carrier
//   in_transit    — carrier has the package
//   out_for_delivery — on the delivery vehicle
//   delivered     — confirmed delivery
//   available_for_pickup — held at facility
//   return_to_sender — being returned
//   failure       — delivery failed (non-terminal in EasyPost; may recover)
//   error         — tracking error / unknown carrier response
//   cancelled     — tracker cancelled (usually because the label was voided)
//   unknown       — no tracking info yet / unrecognised
//
// "pre_transit" and "cancelled" were the missing values producing
// webhook.easypost_unknown_status events — all 5 prod instances were one
// of these two. Fix: map them explicitly. pre_transit → label_created
// (no status change, but we record the event). cancelled → cancelled
// (only appears on voided labels; the shipment's refund_status is the
// authoritative refund signal — this just marks it carrier-cancelled).
//
// Statuses not in the map (available_for_pickup, failure, error, unknown)
// are skipped via the !shipmentStatus guard — we log them as
// webhook.easypost_unknown_status so gaps surface in telemetry.
const STATUS_MAP: Record<string, string> = {
  pre_transit: "label_created",      // label exists; carrier hasn't scanned yet
  in_transit: "in_transit",
  out_for_delivery: "in_transit",    // sub-state of in_transit for SendMo
  delivered: "delivered",
  return_to_sender: "return_to_sender", // DB constraint value; was "returned" (pre-existing bug)
  cancelled: "cancelled",            // label voided at carrier level
};

// EasyPost statuses that trigger notifications. return_to_sender added 2026-07-06
// (T3-2) — previously a silent DB state (webhook wrote the status but sent no
// email); kept in lockstep with tracking/index.ts NOTIFY_STATUSES.
const NOTIFY_STATUSES = new Set(["in_transit", "out_for_delivery", "delivered", "return_to_sender"]);

const APP_URL = "https://sendmo.co";

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Constant-time string compare to avoid timing side channels.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function bytesToHex(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Compute HMAC-SHA256(secret, rawBody) and compare against the header.
 * Returns { ok: true } when signature matches, { ok: false, reason } otherwise.
 * Returns { ok: true, skipped: true } when secret is not configured — the
 * caller should log this so John can see verification is dormant.
 */
async function verifyEasypostHmac(
  rawBody: string,
  signatureHeader: string | null,
): Promise<{ ok: true; skipped?: boolean } | { ok: false; reason: string }> {
  const secret = Deno.env.get("EASYPOST_WEBHOOK_HMAC_SECRET");
  if (!secret) {
    // SECURITY (pre-launch review 2026-07-06, M4): fail CLOSED in production.
    // An unset secret must never mean "accept unsigned" on this money-adjacent
    // webhook — a forged refund.successful / shipment.invoice.created can write
    // ledger rows and recharge a customer's card. Keyed on SENDMO_ENV
    // (environment identity, like the T2-4 key guard), NOT the kill switch, so
    // an incident flip can't disarm it. Dev/preview still skip so local testing
    // isn't blocked.
    if (Deno.env.get("SENDMO_ENV") === "production") {
      return { ok: false, reason: "secret_not_configured_in_production" };
    }
    return { ok: true, skipped: true };
  }

  if (!signatureHeader) {
    return { ok: false, reason: "missing_signature_header" };
  }

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
    const computedHex = bytesToHex(sigBytes);
    // EasyPost sends the V1 header value as `hmac-sha256-hex=<hex>`; strip
    // the algorithm prefix before comparing. Lowercase normalization in case
    // a future EasyPost change uppercases the hex.
    const provided = signatureHeader
      .trim()
      .replace(/^hmac-sha256-hex=/i, "")
      .toLowerCase();
    if (timingSafeEqual(computedHex, provided)) return { ok: true };
    return { ok: false, reason: "signature_mismatch" };
  } catch (err) {
    return {
      ok: false,
      reason: `crypto_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Read raw body BEFORE parsing — signature verification needs the
  // exact bytes EasyPost signed, not a re-serialized JSON shape.
  const rawBody = await req.text();

  // HMAC verification (skipped silently when secret is unset; rejects on
  // mismatch otherwise).
  const sigHeader =
    req.headers.get("X-Hmac-Signature") ||
    req.headers.get("x-hmac-signature");
  const hmacResult = await verifyEasypostHmac(rawBody, sigHeader);
  if (!hmacResult.ok) {
    log({
      event_type: "webhook.hmac_invalid",
      severity: "error",
      source: "webhook",
      properties: {
        reason: hmacResult.reason,
        has_header: !!sigHeader,
        body_len: rawBody.length,
      },
    });
    return new Response(
      JSON.stringify({ error: "Invalid signature" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  if (hmacResult.skipped) {
    log({
      event_type: "webhook.hmac_skipped",
      severity: "warn",
      source: "webhook",
      properties: {
        reason: "EASYPOST_WEBHOOK_HMAC_SECRET not set — verification dormant",
      },
    });
  }

  // Deliberate no-op outcomes (dedup, malformed-skip, not-found, collision)
  // return 200 inside the handler so EasyPost doesn't retry them. Genuine
  // processing errors fall through to the catch below and return 500 so
  // EasyPost DOES retry — swallowing them as 200 lost tracker updates and
  // refund confirmations.
  try {
    const body = JSON.parse(rawBody);
    const description = body.description || "";
    const result = body.result || {};

    // ── EasyPost ShipmentInvoice events (H2 — carrier adjustments) ───────────
    //
    // shipment.invoice.created / shipment.invoice.updated arrive when a
    // carrier re-bills the rate post-pickup (reweigh, dim adjustment,
    // address-correction surcharge). Docs:
    //   https://docs.easypost.com/docs/events — ShipmentInvoice section.
    //
    // The `.updated` event corrects a prior `.created` event's amount — both
    // arms UPSERT on `source_event_id` (the partial UNIQUE index from
    // migration 032), so the latest amount wins. Pitfall 3 from the decided
    // proposal review: silently dropping `.updated` would leave SendMo on a
    // stale delta.
    //
    // Flow:
    //   1. Resolve the SendMo shipment by EasyPost shipment id.
    //   2. UPSERT carrier_adjustments row (dedup on source_event_id).
    //   3. INSERT transactions row type='carrier_adjustment'
    //      (idempotency_key = ShipmentInvoice id).
    //   4. Call resolveRecovery → fires off_session recharge if tier matches.
    //
    // Decided proposal:
    //   2026-05-22_reconciliation-and-carrier-adjustments §2.3 + §2.4.
    if (description === "shipment.invoice.created" ||
        description === "shipment.invoice.updated") {
      const supabase = getSupabase();

      // EasyPost's ShipmentInvoice payload (verified against docs.easypost.com):
      //   result.id                       — 'si_…' the ShipmentInvoice id (dedup key)
      //   result.shipment_id              — 'shp_…' the linked Shipment id
      //   result.adjustment_amount        — string dollars (e.g. "1.25")
      //   result.adjustment_reason        — 'reweigh', 'dim', 'address_correction', ...
      //   result.claimed_details          — { declared_weight_oz, billed_weight_oz, ... }
      const sourceEventId: string | undefined = result.id;
      const epShipmentId: string | undefined = result.shipment_id;
      const adjustmentAmountStr = result.adjustment_amount;
      const adjustmentReason: string | null = result.adjustment_reason ?? null;
      const claimedDetails = (result.claimed_details ?? {}) as {
        declared_weight_oz?: number | string;
        billed_weight_oz?: number | string;
      };

      if (!sourceEventId || !epShipmentId || adjustmentAmountStr === undefined) {
        log({
          event_type: "webhook.shipment_invoice_malformed",
          severity: "warn",
          source: "webhook",
          properties: {
            description,
            has_source_event_id: !!sourceEventId,
            has_shipment_id: !!epShipmentId,
            has_adjustment_amount: adjustmentAmountStr !== undefined,
            result_keys: Object.keys(result),
          },
        });
        return new Response(JSON.stringify({ ok: true, skipped: "malformed" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const deltaCents = Math.round(parseFloat(String(adjustmentAmountStr)) * 100);
      const claimedWeightOz = claimedDetails.declared_weight_oz != null
        ? Math.round(Number(claimedDetails.declared_weight_oz)) : null;
      const capturedWeightOz = claimedDetails.billed_weight_oz != null
        ? Math.round(Number(claimedDetails.billed_weight_oz)) : null;

      // Look up the SendMo shipment.
      const { data: adjShipment, error: adjFetchErr } = await supabase
        .from("shipments")
        .select("id, public_code, user_id, carrier, is_test, stripe_payment_intent_id, link_id")
        .eq("easypost_shipment_id", epShipmentId)
        .maybeSingle();

      if (adjFetchErr || !adjShipment) {
        log({
          event_type: "webhook.shipment_invoice_shipment_not_found",
          severity: "warn",
          source: "webhook",
          properties: { easypost_shipment_id: epShipmentId, source_event_id: sourceEventId },
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Outer webhook_events dedup — same belt-and-braces as refund.successful.
      const invoiceEventId = body.id || `ep_shipinv_${sourceEventId}_${Date.now()}`;
      const { error: invoiceDupeErr } = await supabase.from("webhook_events").insert({
        source: "easypost",
        event_id: invoiceEventId,
        event_type: description,
        payload: body,
      });
      if (invoiceDupeErr?.code === "23505") {
        return new Response(JSON.stringify({ ok: true, duplicate: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // UPSERT carrier_adjustments on source_event_id.
      // The .updated event reuses the ShipmentInvoice id and corrects the
      // prior amount — we want the LATEST amount, not the first.
      const { error: adjUpsertErr } = await supabase
        .from("carrier_adjustments")
        .upsert(
          {
            shipment_id: adjShipment.id,
            source: "easypost",
            source_event_id: sourceEventId,
            delta_cents: deltaCents,
            reason: adjustmentReason,
            claimed_weight_oz: claimedWeightOz,
            captured_weight_oz: capturedWeightOz,
            recovery_status: "pending",
          },
          { onConflict: "source_event_id" },
        );

      if (adjUpsertErr) {
        log({
          event_type: "webhook.carrier_adjustment_upsert_failed",
          severity: "error",
          source: "webhook",
          entity_type: "shipment",
          entity_id: adjShipment.id,
          properties: {
            error_message: adjUpsertErr.message,
            error_code: adjUpsertErr.code ?? null,
            source_event_id: sourceEventId,
          },
        });
        // Still return 200 — webhook retries are EP-driven and won't help if our DB rejected.
        return new Response(JSON.stringify({ ok: true, upsert_failed: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Read back the row to get the id (UPSERT didn't return it).
      const { data: adjRow } = await supabase
        .from("carrier_adjustments")
        .select("id")
        .eq("source_event_id", sourceEventId)
        .maybeSingle();

      const carrierAdjustmentId: string | null = (adjRow?.id as string) ?? null;

      if (!carrierAdjustmentId) {
        log({
          event_type: "webhook.carrier_adjustment_missing_after_upsert",
          severity: "error",
          source: "webhook",
          entity_type: "shipment",
          entity_id: adjShipment.id,
          properties: { source_event_id: sourceEventId },
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // INSERT transactions row type='carrier_adjustment' — the carrier
      // billed SendMo more, so amount_cents is NEGATIVE (SendMo loses).
      // Idempotency key keyed on the ShipmentInvoice id — same dedup
      // namespace as the carrier_adjustments row.
      const { error: txErr } = await supabase.from("transactions").insert({
        user_id: adjShipment.user_id,
        shipment_id: adjShipment.id,
        link_id: adjShipment.link_id ?? null,
        type: "carrier_adjustment",
        amount_cents: -Math.abs(deltaCents),
        mode: adjShipment.is_test ? "test" : "live",
        idempotency_key: `carrier_adjustment_${sourceEventId}`,
        description: `Carrier adjustment — ${adjustmentReason ?? "unknown reason"}`,
      });

      if (txErr && txErr.code !== "23505") {
        // 23505 = UNIQUE collision on idempotency_key (we already wrote it
        // for the .created event; the .updated arm hits this expectedly).
        // Anything else is a real DB error.
        log({
          event_type: "webhook.carrier_adjustment_tx_failed",
          severity: "error",
          source: "webhook",
          entity_type: "carrier_adjustment",
          entity_id: carrierAdjustmentId,
          properties: {
            error_message: txErr.message,
            error_code: txErr.code ?? null,
            source_event_id: sourceEventId,
          },
        });
      }

      log({
        event_type: "webhook.carrier_adjustment_recorded",
        severity: "info",
        source: "webhook",
        entity_type: "carrier_adjustment",
        entity_id: carrierAdjustmentId,
        properties: {
          event: description,
          source_event_id: sourceEventId,
          shipment_id: adjShipment.id,
          delta_cents: deltaCents,
          reason: adjustmentReason,
          claimed_weight_oz: claimedWeightOz,
          captured_weight_oz: capturedWeightOz,
        },
      });

      // Resolve the recovery decision. Need to look up the payment context
      // (saved PM + customer id) from stripe_intents joined back to the PI.
      let paymentContext: AdjustmentPaymentContext = {
        payment_method_id: null,
        user_id: adjShipment.user_id,
        customer_id: null,
      };
      let receiptEmail: string | null = null;

      if (adjShipment.stripe_payment_intent_id) {
        // Find the stripe_intents row to pull the payment_method_id + customer.
        const { data: piRow } = await supabase
          .from("stripe_intents")
          .select("payment_method_id")
          .eq("stripe_intent_id", adjShipment.stripe_payment_intent_id)
          .maybeSingle();
        const pmId = (piRow as { payment_method_id?: string | null } | null)?.payment_method_id ?? null;

        // Customer id lives on profiles (per mode).
        const customerCol = adjShipment.is_test
          ? "stripe_customer_id_test" : "stripe_customer_id_live";
        const { data: profile } = await supabase
          .from("profiles")
          .select(`${customerCol}, email`)
          .eq("id", adjShipment.user_id)
          .maybeSingle();
        const customerId = (profile as Record<string, string | null> | null)?.[customerCol] ?? null;
        receiptEmail = (profile as { email?: string | null } | null)?.email ?? null;

        paymentContext = {
          payment_method_id: pmId,
          user_id: adjShipment.user_id,
          customer_id: customerId,
        };
      }

      const adjustmentShipment: AdjustmentShipment = {
        id: adjShipment.id,
        public_code: adjShipment.public_code,
        user_id: adjShipment.user_id,
        carrier: adjShipment.carrier,
        is_test: adjShipment.is_test,
        stripe_payment_intent_id: adjShipment.stripe_payment_intent_id,
      };

      const resolution = await resolveRecovery({
        supabase,
        sessionId: invoiceEventId,
        shipment: adjustmentShipment,
        carrierAdjustmentId,
        deltaCents,
        paymentContext,
        reasonText: adjustmentReason ?? undefined,
        trackingUrl: `${APP_URL}/t/${adjShipment.public_code}`,
        receiptEmail,
      });

      log({
        event_type: "webhook.carrier_adjustment_resolved",
        severity: "info",
        source: "webhook",
        entity_type: "carrier_adjustment",
        entity_id: carrierAdjustmentId,
        properties: {
          decision: resolution.decision,
          amount_cents: resolution.amount_cents,
          reason: resolution.reason,
          ...(resolution.blocked_by_cap ? { blocked_by_cap: resolution.blocked_by_cap } : {}),
        },
      });

      return new Response(JSON.stringify({ ok: true, resolution }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── EasyPost refund.successful event (migration 030) ────────────────────
    //
    // EasyPost fires `refund.successful` when a non-instantaneous carrier
    // refund completes (e.g. USPS takes up to 15 days). The event's `result`
    // object is a Shipment — result.refund_status will be 'refunded'.
    // Confirmed via EasyPost docs: https://docs.easypost.com/docs/events
    //
    // This push path eliminates the page-view dependency of the tracking/
    // index.ts lazy-poll for anyone watching a voided label from the admin
    // dashboard. WISHLIST "Cron-poll for stale refund_status='submitted'"
    // remains a separate follow-up for orphaned shipments nobody visits.
    //
    // HMAC verification is already done above — the same shared secret covers
    // all EasyPost event types. If the secret is unset (skipped), we continue
    // (same behaviour as for tracker.updated — rollout-safe).
    if (description === "refund.successful") {
      const supabase = getSupabase();
      // EasyPost has historically shipped this event with two payload shapes
      // (verified against live webhook at 19:28 UTC 2026-05-24 on YPPY9AK):
      //   (a) result IS the Shipment    → result.id = shp_…, result.refunds = [{id: 'rfnd_…', ...}]
      //   (b) result IS the Refund      → result.id = rfnd_…, result.shipment_id = 'shp_…'
      // Detect shape (b) first by checking for shipment_id; fall back to
      // result.id (shape a). Without this, shape (b) deliveries log
      // 'webhook.easypost_refund_shipment_not_found' and the entire push
      // refund path is dead — exactly what we hit on the first live cancel.
      const epShipmentId: string | undefined =
        (result.shipment_id as string | undefined) ?? (result.id as string | undefined);
      if (!epShipmentId) {
        log({
          event_type: "webhook.easypost_refund_no_shipment_id",
          severity: "warn",
          source: "webhook",
          properties: { description, result_keys: Object.keys(result) },
        });
        return new Response(JSON.stringify({ ok: true, skipped: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Look up the shipment by EasyPost shipment ID.
      const { data: refundShipment, error: refundFetchErr } = await supabase
        .from("shipments")
        .select("id, public_code, refund_status, easypost_refund_status, stripe_payment_intent_id, is_test, rate_cents")
        .eq("easypost_shipment_id", epShipmentId)
        .maybeSingle();

      if (refundFetchErr || !refundShipment) {
        log({
          event_type: "webhook.easypost_refund_shipment_not_found",
          severity: "warn",
          source: "webhook",
          properties: { easypost_shipment_id: epShipmentId },
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Idempotency: store webhook event. Fallback id (body.id absent is
      // abnormal) is deterministic — a Date.now() suffix could never match a
      // prior insert, so dedup was structurally dead on that path.
      const refundEventId = body.id || `ep_refund_${epShipmentId}`;
      const { error: refundDupeErr } = await supabase.from("webhook_events").insert({
        source: "easypost",
        event_id: refundEventId,
        event_type: "refund.successful",
        payload: body,
      });
      if (refundDupeErr?.code === "23505") {
        return new Response(JSON.stringify({ ok: true, duplicate: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Persist easypost_refund_status = 'refunded' (migration 030).
      // This is the carrier confirmation that EasyPost has credited SendMo's
      // account — separate from the Stripe customer refund on refund_status.
      const refundUpdateFields: Record<string, unknown> = {
        easypost_refund_status: "refunded",
      };

      if (refundShipment.stripe_payment_intent_id) {
        // Stripe-paid shipment: fire the customer refund now (same shared
        // helper as tracking/index.ts lazy-poll and cron-refund-sweep —
        // idempotency key prevents double-refunds).
        //
        // initiateCancelRefund computes the remaining per-PI refundable
        // balance and SKIPS (never calls Stripe) when it is <= 0 — passing
        // undefined amount_cents here used to mean "refund ALL remaining"
        // on a zero-balance ledger. Throws on DB/Stripe error — caught below.
        try {
          const refundResult = await initiateCancelRefund({
            supabase,
            stripePaymentIntentId: refundShipment.stripe_payment_intent_id,
            easypostShipmentId: epShipmentId,
            shipmentId: refundShipment.id,
            publicCode: refundShipment.public_code,
            trigger: "easypost_refund_webhook",
            liveMode: !refundShipment.is_test,
          });
          // Leave refund_status='submitted' — stripe-webhook advances it to
          // 'refunded' when charge.refunded fires. Only update EP column here.
          if (!refundResult.skipped) {
            log({
              event_type: "cancel.stripe_refund_initiated",
              source: "webhook",
              severity: "info",
              entity_type: "shipment",
              entity_id: refundShipment.id,
              properties: {
                payment_intent_id: refundShipment.stripe_payment_intent_id,
                trigger: "easypost_refund_webhook",
              },
            });
          }
        } catch (stripeErr) {
          const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
          log({
            event_type: "cancel.stripe_refund_failed",
            source: "webhook",
            severity: "error",
            entity_type: "shipment",
            entity_id: refundShipment.id,
            properties: {
              error_message: msg,
              payment_intent_id: refundShipment.stripe_payment_intent_id,
              trigger: "easypost_refund_webhook",
            },
          });
          // Still persist easypost_refund_status. The Stripe retry will happen
          // on the next tracking page view (tracking/index.ts lazy-poll path).
        }
      } else {
        // Comp / pre-Stripe shipment: no money to move, just close out.
        refundUpdateFields.refund_status = "not_applicable";
      }

      await supabase
        .from("shipments")
        .update(refundUpdateFields)
        .eq("id", refundShipment.id);

      log({
        event_type: "webhook.easypost_refund_confirmed",
        severity: "info",
        source: "webhook",
        entity_type: "shipment",
        entity_id: refundShipment.id,
        properties: {
          easypost_shipment_id: epShipmentId,
          had_stripe_pi: !!refundShipment.stripe_payment_intent_id,
        },
      });

      // ── H1: easypost_refund ledger row ──────────────────────────────────
      // EasyPost ships this event with three observed payload shapes:
      //   (a) Shipment with refunds[] array — result.refunds = [{id:'rfnd_…', amount, ...}]
      //   (b) Shipment with refund singular — result.refund = {id:'rfnd_…', amount, ...}
      //   (c) Refund object directly        — result.id = 'rfnd_…', result.amount = ..., result.shipment_id = 'shp_…'
      // Detect (c) by presence of result.shipment_id — the top-level result
      // IS the Refund object. We already used this signal above to resolve
      // epShipmentId; here we also use it to source the refund object id +
      // amount.
      // Idempotency key = 'easypost_refund_<rfnd_id>' — same key the
      // tracking lazy-poll would use, so whichever writer lands first wins
      // and the second sees a safe UNIQUE collision no-op (B4 fix).
      {
        const refundObjects = (result.refunds as Array<{ id: string; amount: string | number }> | null) ?? [];
        const refundObj = refundObjects[0] ?? null;
        const refundObjFallback = !refundObj && result.refund
          ? (result.refund as { id: string; amount: string | number })
          : null;
        // Shape (c): result IS the Refund object. result.shipment_id is the
        // discriminator; if present, treat result.id + result.amount as the
        // refund-object identity.
        const refundObjFromTopLevel = (!refundObj && !refundObjFallback && result.shipment_id && result.id)
          ? { id: result.id as string, amount: (result.amount as string | number) ?? null }
          : null;
        const effectiveRefundObj = refundObj ?? refundObjFallback ?? refundObjFromTopLevel;
        const refundObjId: string = effectiveRefundObj?.id ?? `shp_fallback_${epShipmentId}`;

        // Awaited: ledger completeness matters more than one cheap DB write
        // of latency, and an un-awaited promise can be cut off when the edge
        // isolate is reclaimed after the response. writeEasypostRefund never
        // throws by design — it catches internally and logs on failure.
        // Amount sourcing (incl. the rate_cents fallback for the norm case
        // where the Refund object carries no amount) lives in the helper —
        // see SPEC.md §13.3 "Amount sourcing".
        await writeEasypostRefund({
          supabase,
          sessionId: body.id ?? "webhook",
          shipmentId: refundShipment.id,
          userId: "00000000-0000-0000-0000-000000000001", // system user — webhook context has no link join
          linkId: null,  // not available in refund webhook context without extra query
          easypostShipmentId: epShipmentId,
          easypostRefundObjectId: refundObjId,
          payloadAmount: effectiveRefundObj?.amount ?? null,
          rateCents: (refundShipment.rate_cents as number | null) ?? null,
          mode: refundShipment.is_test ? "test" : "live",
          isComp: !refundShipment.stripe_payment_intent_id,
          source: "webhook",
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only handle tracker.updated events (other events are silently acked).
    if (description !== "tracker.updated") {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const trackingCode = result.tracking_code;
    const easypostStatus = result.status;
    const shipmentStatus = STATUS_MAP[easypostStatus];

    if (!trackingCode || !shipmentStatus) {
      log({
        event_type: "webhook.easypost_unknown_status",
        severity: "warn",
        source: "webhook",
        properties: { tracking_code: trackingCode, status: easypostStatus },
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = getSupabase();

    // Find shipment by tracking number. EasyPost only sends the carrier
    // tracking code in webhooks, so we can't use the unambiguous public_code
    // for this lookup. tracking_number is NOT unique (EasyPost test-mode
    // fixtures + cross-mode shipments can produce duplicates), so if >1
    // row matches we log + bail rather than update an arbitrary row and
    // notify the wrong contacts.
    const { data: candidates, error: fetchErr } = await supabase
      .from("shipments")
      .select("id, status, tracking_number, public_code, carrier")
      .eq("tracking_number", trackingCode);

    if (fetchErr || !candidates || candidates.length === 0) {
      log({
        event_type: "webhook.easypost_shipment_not_found",
        severity: "warn",
        source: "webhook",
        properties: { tracking_code: trackingCode },
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (candidates.length > 1) {
      // Tracking number collision — safest behavior is to skip the update
      // and surface to admin via the event log, rather than update an
      // arbitrary shipment and notify the wrong contacts.
      log({
        event_type: "webhook.tracking_number_collision",
        severity: "error",
        source: "webhook",
        properties: {
          tracking_code: trackingCode,
          match_count: candidates.length,
          shipment_ids: candidates.map((c: { id: string }) => c.id),
        },
      });
      return new Response(JSON.stringify({ ok: true, collision: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const shipment = candidates[0];

    // Idempotency: store webhook event. Fallback id (body.id absent is
    // abnormal) is deterministic — a Date.now() suffix could never match a
    // prior insert, so dedup was structurally dead on that path.
    const eventId = body.id || `ep_${trackingCode}_${easypostStatus}`;
    const { error: dupeErr } = await supabase.from("webhook_events").insert({
      source: "easypost",
      event_id: eventId,
      event_type: `tracker.${easypostStatus}`,
      payload: body,
    });

    if (dupeErr?.code === "23505") {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update shipment status
    const updateFields: Record<string, unknown> = { status: shipmentStatus };
    if (shipmentStatus === "delivered") {
      updateFields.delivered_at = new Date().toISOString();
    }

    await supabase.from("shipments").update(updateFields).eq("id", shipment.id);

    // Link lifecycle: when this shipment hits a terminal carrier status
    // (delivered / returned) AND no other non-terminal shipment exists on
    // the same link, flip sendmo_links.status from 'in_use' → 'completed'.
    // Per decided proposal label-cancel-and-change (migration 020).
    if (shipmentStatus === "delivered" || shipmentStatus === "return_to_sender") {
      const { data: shipLink } = await supabase
        .from("shipments")
        .select("link_id")
        .eq("id", shipment.id)
        .single();
      const linkId = shipLink?.link_id;
      if (linkId) {
        const { data: others } = await supabase
          .from("shipments")
          .select("id")
          .eq("link_id", linkId)
          .neq("id", shipment.id)
          .in("status", ["label_created", "in_transit", "out_for_delivery"]);
        if (!others || others.length === 0) {
          await supabase
            .from("sendmo_links")
            .update({ status: "completed" })
            .eq("id", linkId)
            .eq("status", "in_use");  // idempotent
        }
      }
    }

    log({
      event_type: "webhook.easypost_status_updated",
      severity: "info",
      source: "webhook",
      entity_type: "shipment",
      entity_id: shipment.id,
      properties: {
        tracking_code: trackingCode,
        old_status: shipment.status,
        new_status: shipmentStatus,
        easypost_status: easypostStatus,
      },
    });

    // Dispatch notifications to all contacts (fire-and-forget)
    if (NOTIFY_STATUSES.has(easypostStatus)) {
      // Extract estimated delivery from EasyPost tracker data
      const estDelivery = result.est_delivery_date
        ? new Date(result.est_delivery_date).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })
        : undefined;

      // Fire-and-forget via runInBackground — EdgeRuntime.waitUntil keeps the
      // dispatch alive after the response instead of racing isolate reclamation.
      runInBackground(dispatchNotifications(supabase, shipment.id, easypostStatus, {
        tracking_number: trackingCode,
        public_code: shipment.public_code,
        carrier: shipment.carrier || "",
        estimated_delivery: estDelivery,
        tracking_url: `${APP_URL}/t/${shipment.public_code}`,
      }), "webhook_dispatch");
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook processing error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    log({
      event_type: "webhook.processing_error",
      severity: "error",
      source: "webhook",
      properties: { error_message: errorMessage },
    });
    // 500 so EasyPost retries — a 200 here permanently dropped the event.
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
