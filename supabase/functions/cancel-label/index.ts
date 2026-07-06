import { createClient } from "jsr:@supabase/supabase-js@2.97.0";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { refundSubmittedEmail } from "../_shared/email-templates.ts";
import { checkRateLimit } from "../_shared/ratelimit.ts";
import { resolveRefundStatus } from "../_shared/refunds.ts";
import { sendAdminAlert } from "../_shared/alert.ts";
import { getPaidAmountCentsForShipment } from "../_shared/paid-amount.ts";
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

// ── Rate limit: 5 requests / 60s per (ip + public_code) — _shared/ratelimit.ts ──
const RATE_LIMIT = { max: 5, windowMs: 60_000 };

// Constant-time hex compare (32-byte tokens → 64-char hex). Returns false
// quickly on length mismatch; same-length compares run in constant time.
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return mismatch === 0;
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
        if (checkRateLimit(rateKey, RATE_LIMIT)) {
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
        // Decision table after a successful (non-rejected) EasyPost void:
        //   epRefundStatus='rejected'  → 'rejected'         (already-scanned label)
        //   no Stripe PI              → 'not_applicable'   (comp shipments OR pre-Stripe "card"
        //                                                   labels that predate Phase E — no
        //                                                   Stripe charge was made, so nothing to
        //                                                   Stripe-refund; final state regardless
        //                                                   of what EasyPost's epRefundStatus says)
        //   has Stripe PI             → 'submitted'        (Phase E happy path)
        // "has PI" ⇒ a real charge exists ⇒ refundable. Flex (Pattern D)
        // shipments now carry their off-session PI via the labels forward-stitch
        // (fixed 2026-07-05), so this correctly resolves 'submitted' for a paid
        // flex label instead of the old 'not_applicable' that skipped the refund.
        const refundOutcome = resolveRefundStatus(
            epRefundStatus, !!shipment.stripe_payment_intent_id,
        );
        const refundStatusToWrite: string = refundOutcome;

        // 2026-05-13 evening regression fix — the two-step refund refactor
        // removed the `const now` declaration above this block while leaving
        // the references intact. Every cancel was hitting ReferenceError →
        // 500 → tracking page rendered "now is not defined". Restored.
        const now = new Date().toISOString();

        // easypost_refund_status (migration 030) — EasyPost-side void status.
        // Snapshot the EP status at void time so the admin dashboard can show
        // the carrier ground truth immediately, without waiting for a page view
        // on /t/<code> or a refund.successful webhook push.
        // For comp / pre-Stripe labels (no PI, resolved to 'not_applicable'),
        // we write the same value to both columns for consistency.
        const epRefundStatusForDb: string =
            epRefundStatus === "rejected" ? "rejected"
            : !shipment.stripe_payment_intent_id ? "not_applicable"
            : epRefundStatus || "submitted";

        // refund_status guard + .select("id"): only the request that wins the
        // 'none' → write race proceeds to emails/link revival. A concurrent
        // cancel that passed the read-guards but lost the race sees 0 rows
        // affected and gets the same 422 as the read-guard above.
        const { data: updatedRows, error: updateError } = await supabase
            .from("shipments")
            .update({
                status: "cancelled",
                refund_status: refundStatusToWrite,
                easypost_refund_status: epRefundStatusForDb,
                refund_submitted_at: now,
                cancelled_at: now,
                carrier_refund_id: carrierRefundId,
                cancel_token: null,  // consume the token
                updated_at: now,
            })
            .eq("id", shipment.id)
            .eq("refund_status", "none")
            .select("id");

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
            // The carrier void SUCCEEDED but SendMo's state was not recorded:
            // the shipment stays status='label_created', refund_status='none',
            // and both refund pull-paths (tracking poll + cron sweep) key on
            // refund_status='submitted' — the customer's Stripe refund is NOT
            // armed. Alert the admin and tell the caller to retry (the
            // EasyPost /refund call is idempotent for an already-voided
            // shipment). Awaited: error path — reliability over latency.
            await sendAdminAlert({
                subject: "Cancel-label DB update FAILED after carrier void",
                heading: "Cancel-Label DB Update Failed",
                intro: "The EasyPost void succeeded at the carrier, but the shipments UPDATE failed — SendMo's state was not recorded and the refund flow is NOT armed. Retrying the cancel is safe (the carrier void is idempotent).",
                rows: [
                    { label: "Shipment", value: shipment.id },
                    { label: "Public code", value: shipment.public_code },
                    { label: "PaymentIntent", value: shipment.stripe_payment_intent_id ?? "none/comp" },
                    { label: "Intended refund_status", value: refundStatusToWrite },
                    { label: "DB error", value: updateError.message },
                    { label: "Mode", value: shipment.is_test ? "Test" : "LIVE" },
                ],
                source: "cancel-label post-void UPDATE (cancel.db_update_failed)",
            });
            return new Response(
                JSON.stringify({
                    success: false,
                    error: "The label was voided with the carrier, but we couldn't record it. Please try cancelling again — it's safe to retry.",
                    retry_safe: true,
                }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (!updatedRows || updatedRows.length === 0) {
            // Another concurrent cancel won the race between our read-guards
            // and this UPDATE. That request owns emails + link revival; this
            // one reports the same 422 as the refund_status read-guard.
            log({
                event_type: "cancel.concurrent_lost_race",
                session_id: sessionId,
                severity: "warn",
                source: "cancel-label",
                entity_type: "shipment",
                entity_id: shipment.id,
                properties: { public_code: shipment.public_code },
            });
            return new Response(
                JSON.stringify({
                    error: "A cancellation is already in progress for this label.",
                    refund_status: "submitted",
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Unwrap the embedded sendmo_links join for downstream use (Email A
        // payer lookup in Stage 3b + Stage 4 link revival). Declared once
        // here, used in both stages. (Previously declared at Stage 4 only,
        // which caused a TDZ ReferenceError on the Email A path — surfaced
        // 2026-05-24 during the first live cancel test on YPPY9AK.)
        const linkRow = (shipment as { sendmo_links?: { id?: string; status?: string; short_code?: string; user_id?: string } }).sendmo_links;

        // ── Stage 3b: Email A — refund submitted notification ──────────
        // Only sent when the refund is in 'submitted' state (has a Stripe PI
        // and EP void was accepted). Comp/not_applicable and rejected voids
        // don't get this email.
        // Dedup: notifications_log row keyed by (shipment_id, event_type,
        //   provider_id=stripe_payment_intent_id) via migration 035's
        //   idx_notifications_log_refund_dedup partial index.
        if (refundOutcome === "submitted" && shipment.stripe_payment_intent_id) {
            // Find the payer email to notify.
            // Full-label: payer is the link owner (recipient).
            // We join sendmo_links in the fetch above; profile email is accessed
            // via the user_id on the link.
            const linkOwnerUserId = linkRow?.user_id ?? null;
            let payerEmail: string | null = null;
            if (linkOwnerUserId) {
                const { data: profile } = await supabase
                    .from("profiles")
                    .select("email")
                    .eq("id", linkOwnerUserId)
                    .maybeSingle();
                payerEmail = (profile as { email?: string | null } | null)?.email ?? null;
            }

            if (payerEmail) {
                // Determine who cancelled for the canceller-aware copy.
                // actor is 'admin' | 'link_owner' | 'session_token' | 'email_token'
                const cancellerIsPayer =
                    actor === "link_owner" || actor === "session_token" || actor === "email_token";
                const cancellerType: "payer" | "link_user" | "admin" =
                    actor === "admin" ? "admin" :
                    cancellerIsPayer ? "payer" : "link_user";

                // Quote what the CUSTOMER paid (ledger +charge row), not
                // shipments.rate_cents (SendMo's EasyPost cost — ~15%+$1
                // lower than the display price the card was charged).
                const paidAmountCents = await getPaidAmountCentsForShipment(
                    supabase,
                    shipment.stripe_payment_intent_id,
                    shipment.rate_cents ?? 0,
                );

                const tpl = refundSubmittedEmail({
                    amount_cents: paidAmountCents,
                    carrier: shipment.carrier ?? "the carrier",
                    public_code: shipment.public_code,
                    tracking_url: `https://sendmo.co/t/${shipment.public_code}`,
                    canceller_is_payer: cancellerIsPayer,
                    canceller_type: cancellerType,
                });

                // Dedup check: INSERT into notifications_log; if the row already
                // exists (unique constraint), skip the send.
                const { error: logInsertErr } = await supabase
                    .from("notifications_log")
                    .insert({
                        shipment_id: shipment.id,
                        contact_id: null,
                        channel: "email",
                        event_type: "refund.submitted",
                        status: "sent",
                        provider_id: shipment.stripe_payment_intent_id,
                    });

                if (!logInsertErr) {
                    // Row inserted → first send for this event; fire the email.
                    try {
                        await sendEmail({ to: payerEmail, subject: tpl.subject, html: tpl.html });
                        log({
                            event_type: "refund.submitted_email_sent",
                            session_id: sessionId,
                            severity: "info",
                            source: "cancel-label",
                            entity_type: "shipment",
                            entity_id: shipment.id,
                            properties: { recipient: payerEmail, payment_intent_id: shipment.stripe_payment_intent_id },
                        });
                    } catch (emailErr) {
                        // Email failure must not block the cancel-label response.
                        const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
                        console.error("[cancel-label] Email A send failed:", msg);
                        // Update the log row to 'failed' so dedup doesn't prevent retry.
                        await supabase
                            .from("notifications_log")
                            .update({ status: "failed", error_message: msg })
                            .eq("shipment_id", shipment.id)
                            .eq("event_type", "refund.submitted")
                            .is("contact_id", null)
                            .eq("provider_id", shipment.stripe_payment_intent_id);
                        log({
                            event_type: "refund.submitted_email_error",
                            session_id: sessionId,
                            severity: "error",
                            source: "cancel-label",
                            entity_type: "shipment",
                            entity_id: shipment.id,
                            properties: { error_message: msg },
                        });
                    }
                } else if (/duplicate key|unique constraint/i.test(logInsertErr.message)) {
                    // Already sent — skip silently.
                    log({
                        event_type: "refund.submitted_email_deduped",
                        session_id: sessionId,
                        severity: "info",
                        source: "cancel-label",
                        entity_type: "shipment",
                        entity_id: shipment.id,
                        properties: { payment_intent_id: shipment.stripe_payment_intent_id },
                    });
                }
            }
        }

        // ── Stage 4: Link revival (in_use → active) ─────────────────
        // Only flip if no other non-terminal shipment exists on this link.
        // Optimistic — if the carrier later rejects (rare; we already passed
        // the EP refund call), the worst case is two real labels exist and
        // recipient gets charged twice. John accepted this tradeoff.
        let linkRevived = false;
        // linkRow declared at Stage 3b above; reused here.
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
