import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { dispatchNotifications } from "../_shared/notifications.ts";

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

const STATUS_MAP: Record<string, string> = {
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  delivered: "delivered",
  return_to_sender: "returned",
};

// EasyPost statuses that trigger notifications
const NOTIFY_STATUSES = new Set(["in_transit", "out_for_delivery", "delivered"]);

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
  if (!secret) return { ok: true, skipped: true };

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

serve(async (req: Request) => {
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
    // TEMP DIAGNOSTIC: capture enough to diagnose HMAC mismatch without
    // logging the secret. The signature header is itself a digest — safe
    // to log. Body preview is bounded; only carrier tracking metadata, no PII.
    const secret = Deno.env.get("EASYPOST_WEBHOOK_HMAC_SECRET");
    let computedHex: string | null = null;
    let computedB64: string | null = null;
    if (secret && sigHeader) {
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
        const arr = new Uint8Array(sigBytes);
        let hex = "";
        for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
        computedHex = hex;
        computedB64 = btoa(String.fromCharCode(...arr));
      } catch {
        // already logged via primary path
      }
    }
    // List all incoming headers (names only, no values that could be secrets)
    const headerNames: string[] = [];
    for (const [name] of req.headers) headerNames.push(name);

    log({
      event_type: "webhook.hmac_invalid",
      severity: "error",
      source: "webhook",
      properties: {
        reason: hmacResult.reason,
        has_header: !!sigHeader,
        body_len: rawBody.length,
        // Diagnostics
        secret_configured: !!secret,
        secret_len: secret ? secret.length : 0,
        provided_sig: sigHeader ?? null,
        provided_sig_len: sigHeader?.length ?? 0,
        computed_hex: computedHex,
        computed_b64: computedB64,
        header_names: headerNames,
        body_preview: rawBody.slice(0, 200),
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

  // Always respond 200 to webhooks to prevent retries (after auth)
  try {
    const body = JSON.parse(rawBody);
    const description = body.description || "";
    const result = body.result || {};

    // Only handle tracker.updated events
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

    // Idempotency: store webhook event
    const eventId = body.id || `ep_${trackingCode}_${easypostStatus}_${Date.now()}`;
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

      // Don't await — fire and forget
      dispatchNotifications(supabase, shipment.id, easypostStatus, {
        tracking_number: trackingCode,
        public_code: shipment.public_code,
        carrier: shipment.carrier || "",
        estimated_delivery: estDelivery,
        tracking_url: `${APP_URL}/t/${shipment.public_code}`,
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook processing error:", err);
    log({
      event_type: "webhook.processing_error",
      severity: "error",
      source: "webhook",
      properties: { error_message: err instanceof Error ? err.message : String(err) },
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
