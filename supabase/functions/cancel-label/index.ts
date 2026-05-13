import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
// createRefund import retired 2026-05-13 — Stripe refund is now triggered
// by tracking/index.ts's lazy poll once EasyPost confirms the carrier
// refund (two-step refund safety). See the comment at the refund_status
// assignment below.

// ─────────────────────────────────────────────────────────────────────────────
// cancel-label — user-facing Cancel + Change endpoint
// Decided proposal:
//   proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md
//
// Three auth paths, in priority order:
//   1. JWT (admin OR link-owner) — preserves existing admin/owner flow.
//   2. X-Cancel-Token header — for the just-shipped sender (sessionStorage)
//      or returning sender (email-token captured to sessionStorage on landing).
//   3. ?cancel=<token> on the request body's optional `cancel_token` field —
//      same primitive, accepted as a body param for resilience to header
//      stripping by proxies. (The X-Cancel-Token header is preferred.)
//
// Refund branch:
//   - If shipments.stripe_payment_intent_id is set, fire Stripe createRefund
//     immediately and set refund_status='submitted'. The stripe-webhook
//     handler advances submitted→refunded on charge.refunded (per Stripe
//     Phase A's sole-ledger-writer rule — cancel-label never writes to
//     transactions).
//   - Else (comp shipment), refund_status='not_applicable'.
//
// Link revival:
//   - After successful carrier void, if no other non-terminal shipment exists
//     on this shipment's link, flip sendmo_links.status from 'in_use' → 'active'.
//
// Architecture note: is_test is read from the DB, never the client. The DB
// is the single source of truth for whether this shipment used the live or
// test EasyPost key.
// ─────────────────────────────────────────────────────────────────────────────

// ── In-memory rate limit: 5 requests / 60s per (ip + public_code) ──
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBucket = new Map<string, number[]>();
function isRateLimited(key: string, now: number): boolean {
    const arr = (rateBucket.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (arr.length >= RATE_LIMIT_MAX) {
        rateBucket.set(key, arr);
        return true;
    }
    arr.push(now);
    rateBucket.set(key, arr);
    return false;
}

// Constant-time hex compare (32-byte tokens → 64-char hex). Returns false
// quickly on length mismatch; same-length compares run in constant time.
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return mismatch === 0;
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

    const sessionId = req.headers.get("x-session-id") || crypto.randomUUID();

    try {
        const body = await req.json();
        const {
            public_code,
            shipment_id: bodyShipmentId,
            reason,
            cancel_token: bodyCancelToken,
        } = body as {
            public_code?: string;
            shipment_id?: string;
            reason?: string;
            cancel_token?: string;
        };

        if (!public_code && !bodyShipmentId) {
            return new Response(
                JSON.stringify({ error: "Missing required field: public_code or shipment_id" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const cancelReason: "user_cancel" | "user_change" | "admin" =
            reason === "user_change" ? "user_change" :
            reason === "admin" ? "admin" :
            "user_cancel";

        // ── Supabase client (service role) ───────────────────────────
        const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
        const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
        if (!sbUrl || !sbKey) {
            return new Response(
                JSON.stringify({ error: "Server configuration error" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }
        const supabase = createClient(sbUrl, sbKey, {
            auth: { autoRefreshToken: false, persistSession: false },
        });

        // ── Rate limit: keyed on IP + identifier ─────────────────────
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
        const rateKey = `${ip}:${public_code ?? bodyShipmentId}`;
        if (isRateLimited(rateKey, Date.now())) {
            return new Response(
                JSON.stringify({ error: "Too many requests. Try again in a moment." }),
                { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Fetch shipment (with ownership join + cancel_token) ─────
        // public_code is UNIQUE; shipment_id is UUID PK. Either resolves
        // a single row.
        const selectCols = "id, easypost_shipment_id, status, refund_status, is_test, carrier, tracking_number, rate_cents, created_at, link_id, cancel_token, stripe_payment_intent_id, public_code, sendmo_links!inner(id, short_code, user_id, status, link_type)";
        let shipmentQuery = supabase.from("shipments").select(selectCols);
        if (public_code) shipmentQuery = shipmentQuery.eq("public_code", public_code);
        else shipmentQuery = shipmentQuery.eq("id", bodyShipmentId);
        const { data: shipment, error: fetchError } = await shipmentQuery.maybeSingle();

        if (fetchError || !shipment) {
            return new Response(
                JSON.stringify({ error: "Shipment not found" }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Auth (three paths) ──────────────────────────────────────
        const jwtHeader = req.headers.get("Authorization") || req.headers.get("authorization");
        const jwtToken = jwtHeader?.replace(/^Bearer\s+/i, "");
        const headerCancelToken = req.headers.get("X-Cancel-Token") || req.headers.get("x-cancel-token");
        const presentedCancelToken = headerCancelToken || bodyCancelToken || null;

        let actor: "admin" | "link_owner" | "session_token" | "email_token" | null = null;
        let callerId: string | null = null;

        if (jwtToken) {
            const { data: userResp, error: userErr } = await supabase.auth.getUser(jwtToken);
            if (!userErr && userResp?.user) {
                callerId = userResp.user.id;
                const { data: callerProfile } = await supabase
                    .from("profiles")
                    .select("role")
                    .eq("id", callerId)
                    .single();
                const isAdmin = callerProfile?.role === "admin";
                const linkOwnerId = (shipment as { sendmo_links?: { user_id?: string } }).sendmo_links?.user_id;
                if (isAdmin) actor = "admin";
                else if (linkOwnerId && linkOwnerId === callerId) actor = "link_owner";
            }
        }

        if (!actor && presentedCancelToken && shipment.cancel_token) {
            if (timingSafeEqual(presentedCancelToken, shipment.cancel_token)) {
                // No way to distinguish session vs email transport server-side —
                // both flow through the same header. UI semantics differ; server
                // treats them the same.
                actor = headerCancelToken ? "session_token" : "email_token";
            }
        }

        if (!actor) {
            log({
                event_type: "cancel.auth_rejected",
                session_id: sessionId,
                severity: "warn",
                source: "cancel-label",
                entity_type: "shipment",
                entity_id: shipment.id,
                properties: {
                    has_jwt: !!jwtToken,
                    has_cancel_token: !!presentedCancelToken,
                    public_code: shipment.public_code,
                },
            });
            return new Response(
                JSON.stringify({ error: "Not authorized to cancel this label." }),
                { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Guard: Test labels cannot be voided ─────────────────────
        if (shipment.is_test) {
            return new Response(
                JSON.stringify({
                    error: "Test labels cannot be voided. Void is only available for live shipments.",
                    is_test: true,
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Guard: Shipment status must allow cancellation ──────────
        if (shipment.status !== "label_created") {
            const statusMsg: Record<string, string> = {
                in_transit: "This label is already in transit and cannot be voided.",
                out_for_delivery: "This label is out for delivery and cannot be voided.",
                delivered: "This shipment has already been delivered.",
                returned: "This shipment was returned.",
                cancelled: "This label has already been cancelled.",
            };
            return new Response(
                JSON.stringify({
                    error: statusMsg[shipment.status] || `Cannot cancel shipment with status: ${shipment.status}`,
                    shipment_status: shipment.status,
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Guard: No prior refund attempt ──────────────────────────
        if (shipment.refund_status !== "none") {
            const refundMsg: Record<string, string> = {
                submitted: "A cancellation is already in progress for this label.",
                refunded: "This label has already been voided and refunded.",
                rejected: "A void request was previously submitted but rejected by the carrier.",
                not_applicable: "This label has already been cancelled.",
            };
            return new Response(
                JSON.stringify({
                    error: refundMsg[shipment.refund_status] || "Refund already in progress.",
                    refund_status: shipment.refund_status,
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Guard: Carrier reference must exist ─────────────────────
        if (!shipment.easypost_shipment_id) {
            return new Response(
                JSON.stringify({ error: "No carrier shipment reference found — label may not have been fully generated." }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Stage 1: Carrier void (EasyPost) ────────────────────────
        // Live key — is_test=false on the shipment means it was created with
        // the live key; we never refund test-mode labels (guard above).
        const easypostApiKey = Deno.env.get("EASYPOST_API_KEY");
        if (!easypostApiKey) {
            return new Response(
                JSON.stringify({ error: "Live carrier API key not configured" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const refundResponse = await fetch(
            `https://api.easypost.com/v2/shipments/${shipment.easypost_shipment_id}/refund`,
            {
                method: "POST",
                headers: {
                    Authorization: "Basic " + btoa(easypostApiKey + ":"),
                    "Content-Type": "application/json",
                },
            }
        );
        const refundData = await refundResponse.json();
        const epRefundStatus: string = refundData.refund_status || "submitted";
        const carrierRefundId: string | null = refundData.id || null;

        if (!refundResponse.ok && refundData.error) {
            console.error("Carrier refund error:", refundData);
            log({
                event_type: "cancel.carrier_rejected",
                session_id: sessionId,
                severity: "warn",
                source: "cancel-label",
                entity_type: "shipment",
                entity_id: shipment.id,
                properties: {
                    actor,
                    reason: cancelReason,
                    carrier_message: refundData.error?.message,
                },
            });
            return new Response(
                JSON.stringify({
                    error: "Label void request was rejected. The label may have already been scanned by the carrier.",
                    carrier_message: refundData.error?.message,
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Stage 2: refund_status assignment (two-step refund) ─────────
        //
        // Two-step refund (decided 2026-05-13 in dogfood follow-up): we no
        // longer fire Stripe createRefund here. EasyPost's "submitted" means
        // the void was queued with the carrier — USPS/UPS take 1–2 weeks to
        // actually verify the label wasn't scanned and credit the cost back
        // to our EasyPost account. Issuing the customer refund BEFORE that
        // confirmation means SendMo eats the loss if the carrier later
        // rejects the void.
        //
        // New flow:
        //   1. cancel-label (here): EasyPost void submitted, refund_status='submitted'
        //   2. tracking/index.ts poll: when the user visits /t/<code>, GET the
        //      EasyPost shipment and check refund_status. When EP flips to
        //      'refunded' (carrier confirmed) AND we have a Stripe PI, that
        //      function fires createRefund.
        //   3. stripe-webhook on charge.refunded: writes the −refund ledger row
        //      and advances refund_status='submitted' → 'refunded'.
        //
        // For comp shipments (no Stripe PI), step 2 just sets refund_status
        // to 'not_applicable' once EP confirms — no money to move.
        //
        // The Stripe import is kept for completeness (createRefund still
        // imported below) even though this function no longer calls it; the
        // intent is to keep the dependency graph visible during the Phase E
        // transition.
        //
        // Decision table after a successful (non-rejected) EasyPost void:
        //   epRefundStatus='rejected'  → 'rejected'         (already-scanned label)
        //   no Stripe PI              → 'not_applicable'   (comp; final state)
        //   has Stripe PI             → 'submitted'        (Phase E happy path)
        let refundStatusToWrite: string;
        if (epRefundStatus === "rejected") {
            refundStatusToWrite = "rejected";
        } else if (!shipment.stripe_payment_intent_id) {
            refundStatusToWrite = "not_applicable";
        } else {
            refundStatusToWrite = "submitted";
        }
        const refundOutcome = refundStatusToWrite as "submitted" | "not_applicable" | "rejected";

        const { error: updateError } = await supabase
            .from("shipments")
            .update({
                status: "cancelled",
                refund_status: refundStatusToWrite,
                refund_submitted_at: now,
                cancelled_at: now,
                carrier_refund_id: carrierRefundId,
                cancel_token: null,  // consume the token
                updated_at: now,
            })
            .eq("id", shipment.id);

        if (updateError) {
            console.error("DB update error after successful carrier void:", updateError);
            log({
                event_type: "cancel.db_update_failed",
                session_id: sessionId,
                severity: "error",
                source: "cancel-label",
                entity_type: "shipment",
                entity_id: shipment.id,
                properties: { error_message: updateError.message },
            });
            return new Response(
                JSON.stringify({
                    success: true,
                    refund_status: refundStatusToWrite,
                    warning: "Label was voided with the carrier but DB update failed — please refresh.",
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Stage 4: Link revival (in_use → active) ─────────────────
        // Only flip if no other non-terminal shipment exists on this link.
        // Optimistic — if the carrier later rejects (rare; we already passed
        // the EP refund call), the worst case is two real labels exist and
        // recipient gets charged twice. John accepted this tradeoff.
        let linkRevived = false;
        const linkRow = (shipment as { sendmo_links?: { id?: string; status?: string; short_code?: string; user_id?: string } }).sendmo_links;
        if (linkRow?.id) {
            const { data: otherActive } = await supabase
                .from("shipments")
                .select("id")
                .eq("link_id", linkRow.id)
                .neq("id", shipment.id)
                .in("status", ["label_created", "in_transit", "out_for_delivery"]);
            if (!otherActive || otherActive.length === 0) {
                const { error: linkErr } = await supabase
                    .from("sendmo_links")
                    .update({ status: "active" })
                    .eq("id", linkRow.id)
                    .eq("status", "in_use");
                if (!linkErr) linkRevived = true;
                else console.error("Link revival error:", linkErr);
            }
        }

        // ── Audit log ───────────────────────────────────────────────
        log({
            event_type: "shipment.cancelled",
            session_id: sessionId,
            severity: "info",
            source: "cancel-label",
            entity_type: "shipment",
            entity_id: shipment.id,
            properties: {
                reason: cancelReason,
                actor,
                // Capture the auth user_id when present (admin / link_owner)
                // so future agents can resolve a display name. Anonymous
                // session/email-token cancellations have no user_id.
                user_id: callerId,
                refund_outcome: refundOutcome,
                previous_status: "label_created",
                link_revived: linkRevived,
                public_code: shipment.public_code,
                ep_refund_status: epRefundStatus,
            },
        });

        // ── User-facing message (no carrier branding) ───────────────
        const messages: Record<string, string> = {
            submitted: "Cancellation in progress. The carrier typically confirms within 1–2 weeks; once confirmed, your refund will be issued automatically to the original card.",
            refunded: "Label voided and refunded.",
            rejected: "The void was processed but the refund failed. We'll follow up — please contact support.",
            not_applicable: "Label voided. No charge was made, so no refund is needed.",
        };

        return new Response(
            JSON.stringify({
                success: true,
                refund_status: refundStatusToWrite,
                link_revived: linkRevived,
                link_short_code: linkRow?.short_code ?? null,
                message: messages[refundStatusToWrite] || "Label cancelled.",
                shipment_id: shipment.id,
                public_code: shipment.public_code,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Internal server error";
        console.error("cancel-label error:", msg);
        return new Response(
            JSON.stringify({ error: msg }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
