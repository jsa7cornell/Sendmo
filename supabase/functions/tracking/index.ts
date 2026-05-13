import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { dispatchNotifications } from "../_shared/notifications.ts";
import { createRefund } from "../_shared/stripe.ts";
import { log } from "../_shared/logger.ts";

const APP_URL = "https://sendmo.co";
const NOTIFY_STATUSES = new Set(["in_transit", "out_for_delivery", "delivered"]);

/**
 * Public tracking lookup — no auth required.
 *
 *   GET /tracking?code=H7K2P9        ← canonical (SendMo public_code, UNIQUE)
 *   GET /tracking?number=<carrier>   ← legacy alias for old `/track/<carrier_number>`
 *                                       URLs already out in users' inboxes. Ordered
 *                                       created_at DESC limit 1 to handle test-mode
 *                                       fixture collisions deterministically (most
 *                                       recent shipment wins — defensible default
 *                                       since users clicking old links care about
 *                                       the most recent shipment with that number).
 *
 * Always fetches live from EasyPost when a tracker exists and the
 * shipment isn't in a terminal state. Syncs DB and dispatches
 * notifications when status advances.
 */

// Statuses that will never change — serve from DB, skip EasyPost
const TERMINAL_STATUSES = new Set(["delivered", "return_to_sender", "cancelled"]);

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const url = new URL(req.url);
  const publicCode = url.searchParams.get("code");
  const trackingNumber = url.searchParams.get("number");

  if (!publicCode && !trackingNumber) {
    return new Response(
      JSON.stringify({ error: "Either 'code' or 'number' query parameter is required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sbUrl = Deno.env.get("SUPABASE_URL");
  const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
  if (!sbUrl || !sbKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(sbUrl, sbKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Look up shipment in our DB.
  // `public_code` is UNIQUE post-migration 015 → .single() is correct.
  // `tracking_number` legacy path may match multiple rows (EasyPost test-mode
  // fixture collisions); order by created_at DESC and take the first.
  // Joins sendmo_links to derive link_short_code (for the Ship-Again CTA) and
  // user_id (server-side viewer_is_recipient determination — link.user_id is
  // never exposed in the response).
  // tracking-page-ia-polish (decided 2026-05-13): addresses are embedded via
  // PostgREST FK relations (not denormalized columns — reviewer caught B2).
  // item_description added in migration 021. The from/to selects pull city +
  // state only, never street1 (PLAYBOOK Rule 7).
  const selectFields = "id, tracking_number, public_code, carrier, service, status, refund_status, easypost_tracker_id, easypost_shipment_id, is_test, created_at, updated_at, promised_delivery_date, delivered_at, label_url, link_id, stripe_payment_intent_id, cancelled_at, item_description, sender_address:addresses!sender_address_id(city,state), recipient_address:addresses!recipient_address_id(city,state), sendmo_links!inner(short_code, user_id)";
  const baseQuery = supabase.from("shipments").select(selectFields);
  const lookup = publicCode
    ? baseQuery.eq("public_code", publicCode).single()
    : baseQuery.eq("tracking_number", trackingNumber!).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: shipment, error } = await lookup;

  if (error || !shipment) {
    return new Response(
      JSON.stringify({ error: publicCode ? "Tracking code not found" : "Tracking number not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let liveStatus = shipment.status;
  let estDelivery: string | null = null;
  let trackingEvents: Array<{ message: string; status: string; datetime: string; location: string | null }> = [];

  // Always fetch from EasyPost unless shipment is in a terminal status
  const isTerminal = TERMINAL_STATUSES.has(shipment.status);
  const shouldFetchLive = shipment.easypost_tracker_id && !isTerminal;

  if (shouldFetchLive) {
    const apiKey = Deno.env.get(shipment.is_test ? "EASYPOST_TEST_API_KEY" : "EASYPOST_API_KEY");
    if (apiKey) {
      try {
        const epResponse = await fetch(
          `https://api.easypost.com/v2/trackers/${shipment.easypost_tracker_id}`,
          { headers: { Authorization: "Basic " + btoa(apiKey + ":") } },
        );
        if (epResponse.ok) {
          const tracker = await epResponse.json();
          liveStatus = tracker.status === "pre_transit" ? "label_created" : tracker.status;
          estDelivery = tracker.est_delivery_date || null;

          trackingEvents = (tracker.tracking_details || [])
            .map((d: any) => ({
              message: d.message || "",
              status: d.status || "",
              datetime: d.datetime || "",
              location: [d.tracking_location?.city, d.tracking_location?.state]
                .filter(Boolean).join(", ") || null,
            }))
            .reverse();

          // Sync DB: update status + updated_at
          const statusChanged = liveStatus !== shipment.status;
          const updateFields: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
          };
          if (statusChanged) {
            updateFields.status = liveStatus;
          }
          if (liveStatus === "delivered") {
            updateFields.delivered_at = new Date().toISOString();
          }
          // Update by the unambiguous shipment id — never tracking_number,
          // which may collide (EasyPost test-mode fixtures).
          await supabase
            .from("shipments")
            .update(updateFields)
            .eq("id", shipment.id);

          // Dispatch notifications if status advanced (idempotent — safe if webhook also fires)
          if (statusChanged && NOTIFY_STATUSES.has(liveStatus)) {
            const estDeliveryFmt = estDelivery
              ? new Date(estDelivery).toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })
              : undefined;
            dispatchNotifications(supabase, shipment.id, liveStatus, {
              tracking_number: shipment.tracking_number,
              public_code: shipment.public_code,
              carrier: shipment.carrier || "",
              estimated_delivery: estDeliveryFmt,
              tracking_url: `${APP_URL}/t/${shipment.public_code}`,
            });
          }
        }
      } catch {
        // EasyPost fetch failed — fall back to DB data
      }
    }
  }

  // ── Lazy refund poll (decided 2026-05-13 — two-step refund) ────────────
  //
  // When a shipment is in refund_status='submitted', EasyPost has queued the
  // void with the carrier (USPS / UPS / etc.) but the carrier hasn't yet
  // confirmed the credit. cancel-label deliberately does NOT call Stripe
  // createRefund anymore — it waits for carrier confirmation so SendMo
  // doesn't eat the loss when a scanned label later gets the EP void
  // rejected.
  //
  // This block runs on every /t/<code> page view for a cancelled-with-
  // submitted-refund shipment. Polls GET /v2/shipments/<id> to read the
  // latest refund_status. When EasyPost flips to 'refunded' or 'rejected',
  // sync the state and (in the 'refunded' + Stripe-paid case) fire
  // createRefund. Stripe-webhook then advances refund_status='submitted' →
  // 'refunded' when charge.refunded lands.
  //
  // EP refund_status values: 'submitted' | 'refunded' | 'rejected' | 'not_applicable'
  // Our refund_status values: 'none' | 'submitted' | 'refunded' | 'rejected' | 'not_applicable'
  //
  // Trade-off: extra EP API call (~200ms) per page view for cancelled
  // shipments. Comp shipments are the only callers today (zero Stripe-paid
  // exist), so the Stripe-refund branch is dormant until Phase E lands.
  if (shipment.refund_status === "submitted" && shipment.easypost_shipment_id) {
    const apiKey = Deno.env.get(shipment.is_test ? "EASYPOST_TEST_API_KEY" : "EASYPOST_API_KEY");
    if (apiKey) {
      try {
        const epShipResp = await fetch(
          `https://api.easypost.com/v2/shipments/${shipment.easypost_shipment_id}`,
          { headers: { Authorization: "Basic " + btoa(apiKey + ":") } },
        );
        if (epShipResp.ok) {
          const epShip = await epShipResp.json();
          const epRefundStatus: string | null = epShip?.refund_status ?? null;

          if (epRefundStatus === "refunded") {
            // Carrier confirmed the void. Two branches depending on whether
            // this shipment had a Stripe charge.
            if (shipment.stripe_payment_intent_id) {
              // Phase E (real money) — fire the Stripe refund now. Idempotency
              // key is shared with what cancel-label would have used pre-2026-
              // 05-13; Stripe dedupes on key so repeated polls in the window
              // before charge.refunded lands are no-ops.
              try {
                await createRefund({
                  payment_intent_id: shipment.stripe_payment_intent_id,
                  reason: "requested_by_customer",
                  metadata: {
                    shipment_id: shipment.id,
                    public_code: shipment.public_code,
                    trigger: "tracking_poll",
                  },
                  idempotency_key: `refund_${shipment.easypost_shipment_id}_user_cancel`,
                  liveMode: !shipment.is_test,
                });
                log({
                  event_type: "cancel.stripe_refund_initiated",
                  source: "tracking",
                  severity: "info",
                  entity_type: "shipment",
                  entity_id: shipment.id,
                  properties: {
                    payment_intent_id: shipment.stripe_payment_intent_id,
                    trigger: "tracking_poll",
                  },
                });
                // Leave refund_status='submitted' — stripe-webhook will
                // advance to 'refunded' when charge.refunded fires.
              } catch (refundErr) {
                const msg = refundErr instanceof Error ? refundErr.message : String(refundErr);
                console.error("[tracking] Stripe refund initiation failed:", msg);
                log({
                  event_type: "cancel.stripe_refund_failed",
                  source: "tracking",
                  severity: "error",
                  entity_type: "shipment",
                  entity_id: shipment.id,
                  properties: {
                    error_message: msg,
                    payment_intent_id: shipment.stripe_payment_intent_id,
                    trigger: "tracking_poll",
                  },
                });
                // Don't update DB — next page view will retry. The idempotency
                // key prevents double-refunds.
              }
            } else {
              // Comp shipment — no Stripe call. Just close out.
              await supabase
                .from("shipments")
                .update({ refund_status: "not_applicable" })
                .eq("id", shipment.id);
              shipment.refund_status = "not_applicable";
              log({
                event_type: "cancel.ep_refund_confirmed",
                source: "tracking",
                severity: "info",
                entity_type: "shipment",
                entity_id: shipment.id,
                properties: { resolution: "not_applicable", trigger: "tracking_poll" },
              });
            }
          } else if (epRefundStatus === "rejected") {
            // Carrier rejected the void (label was scanned). Terminal state.
            await supabase
              .from("shipments")
              .update({ refund_status: "rejected" })
              .eq("id", shipment.id);
            shipment.refund_status = "rejected";
            log({
              event_type: "cancel.ep_refund_rejected",
              source: "tracking",
              severity: "warn",
              entity_type: "shipment",
              entity_id: shipment.id,
              properties: { trigger: "tracking_poll" },
            });
          }
          // epRefundStatus === 'submitted' → still waiting; no action
          // epRefundStatus === 'not_applicable' → EP says no refund needed;
          //   leave our state as-is (we'd only have hit this path if our DB
          //   says 'submitted', which is internally inconsistent with EP's
          //   'not_applicable' — log but don't auto-mutate).
        }
      } catch {
        // EP fetch failed (network, key missing, etc.) — silent fallback.
        // Next page view retries.
      }
    }
  }

  // tracking-page-ia-polish (decided 2026-05-13) N2: parallelise the
  // event_logs sub-queries — cancelled-actor + print-count + last-printed all
  // key off shipment.id and don't depend on each other. Replaces 2-3
  // sequential round-trips with 1.
  //
  // - Cancelled-actor lookup only when status='cancelled' (round-1 polish).
  // - Print-count + last-printed always — tracks `label.printed` event_logs
  //   rows for the print-count chip + Phase 2.1 last-actor enrichment.
  //
  // is_test=true shipments still write 0 prints (label-print returns early
  // without inserting), so the count is correct for them by construction.
  const cancelEventP = liveStatus === "cancelled"
    ? supabase
        .from("event_logs")
        .select("properties")
        .eq("event_type", "shipment.cancelled")
        .eq("entity_type", "shipment")
        .eq("entity_id", shipment.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const printCountP = supabase
    .from("event_logs")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "label.printed")
    .eq("entity_type", "shipment")
    .eq("entity_id", shipment.id);

  const lastPrintP = supabase
    .from("event_logs")
    .select("created_at")
    .eq("event_type", "label.printed")
    .eq("entity_type", "shipment")
    .eq("entity_id", shipment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const [cancelEventRes, printCountRes, lastPrintRes] = await Promise.all([
    cancelEventP, printCountP, lastPrintP,
  ]);

  let cancelledByActor: string | null = null;
  const cancelProps = (cancelEventRes as { data?: { properties?: { actor?: string } } | null })?.data?.properties;
  const a = cancelProps?.actor;
  if (a === "admin" || a === "link_owner" || a === "session_token" || a === "email_token") {
    cancelledByActor = a;
  }
  const printCount = (printCountRes as { count?: number | null }).count ?? 0;
  const lastPrintedAt = (lastPrintRes as { data?: { created_at?: string } | null }).data?.created_at ?? null;

  // Derive viewer_is_recipient + isAdmin server-side. When the request carries
  // a valid JWT and the user is the link owner, the client knows to hide the
  // Ship-Again CTA. Admin derivation gates the shipment_id field per B4 —
  // shipment UUID is admin-only to keep the public response slim.
  // link.user_id is NEVER returned — only the boolean.
  const linkJoin = shipment.sendmo_links as unknown as { short_code: string; user_id: string } | null;
  let viewerIsRecipient = false;
  let isAdmin = false;
  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("VITE_SUPABASE_ANON_KEY") || "";
  if (token && token !== anonKey) {
    const { data: userResp } = await supabase.auth.getUser(token);
    if (userResp?.user) {
      if (linkJoin?.user_id && userResp.user.id === linkJoin.user_id) viewerIsRecipient = true;
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userResp.user.id)
        .single();
      if (profile?.role === "admin") isAdmin = true;
    }
  }

  // Per B2: addresses are embedded — never denormalized on shipments.
  const senderAddr = (shipment as { sender_address?: { city?: string; state?: string } | null }).sender_address ?? null;
  const recipientAddr = (shipment as { recipient_address?: { city?: string; state?: string } | null }).recipient_address ?? null;

  return new Response(
    JSON.stringify({
      tracking_number: shipment.tracking_number,
      public_code: shipment.public_code,
      carrier: shipment.carrier,
      service: shipment.service,
      status: liveStatus,
      estimated_delivery: estDelivery,
      events: trackingEvents,
      created_at: shipment.created_at,
      updated_at: shipment.updated_at,
      promised_delivery_date: shipment.promised_delivery_date,
      delivered_at: shipment.delivered_at,
      label_url: shipment.label_url ?? null,
      link_short_code: linkJoin?.short_code ?? null,
      viewer_is_recipient: viewerIsRecipient,
      refund_status: shipment.refund_status ?? "none",
      // `paid` is true when there's a Stripe PI on the shipment (Phase A
      // forward-compat slot; comp shipments have NULL). amount_paid_cents
      // is derived from the transactions ledger (type='charge') in Phase E
      // when real money starts flowing. For the cancel UI today (comp-only),
      // `paid` will be false everywhere and the refund-amount copy
      // gracefully degrades to "no charge was made".
      paid: shipment.stripe_payment_intent_id != null,
      amount_paid_cents: null as number | null,
      // EasyPost test-mode shipments use synthetic tracking numbers that look
      // real (USPS format) but never hit the actual carrier. Surfacing this
      // flag lets the UI render a TEST banner and hide things that would
      // mislead the viewer (e.g. "View on USPS site" link).
      is_test: shipment.is_test === true,
      cancelled_at: shipment.cancelled_at ?? null,
      cancelled_by_actor: cancelledByActor,
      // tracking-page-ia-polish (decided 2026-05-13)
      item_description: shipment.item_description ?? null,
      from_city: senderAddr?.city ?? null,
      from_state: senderAddr?.state ?? null,
      to_city: recipientAddr?.city ?? null,
      to_state: recipientAddr?.state ?? null,
      print_count: printCount,
      last_printed_at: lastPrintedAt,
      // B4: shipment.id surfaced only to admin callers — keeps public
      // response slim and prevents accidental UUID leakage.
      shipment_id: isAdmin ? shipment.id : undefined,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
