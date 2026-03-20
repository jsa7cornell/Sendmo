import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Architecture rule: is_test is read from the DB — never from the client.
// The client cannot tell us whether a label is real or synthetic. That decision
// was made server-side at shipment creation time and is stored as shipments.is_test.
//
// Test labels (is_test = true) are synthetic — they have fake tracking numbers
// and no real carrier behind them. The carrier refund API rejects calls on them.
// We return a clear, honest error rather than silently simulating a void.
// ─────────────────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    try {
        // Only shipment_id from the client — nothing about test/live mode.
        const { shipment_id } = await req.json();

        if (!shipment_id) {
            return new Response(
                JSON.stringify({ error: "Missing required field: shipment_id" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Supabase client (service role to bypass RLS) ──────────────
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

        // ── Auth: verify caller identity + ownership ─────────────────
        // If a JWT is provided, verify it and enforce ownership.
        // If no JWT (admin/anon), allow through (legacy admin path).
        const authHeader = req.headers.get("Authorization");
        const token = authHeader?.replace("Bearer ", "");
        let callerId: string | null = null;

        if (token && token !== Deno.env.get("VITE_SUPABASE_ANON_KEY")) {
            const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("VITE_SUPABASE_ANON_KEY");
            if (anonKey && token !== anonKey) {
                // Looks like a real JWT — verify it
                const userClient = createClient(sbUrl, anonKey || sbKey, {
                    auth: { autoRefreshToken: false, persistSession: false },
                    global: { headers: { Authorization: `Bearer ${token}` } },
                });
                const { data: { user }, error: authError } = await userClient.auth.getUser(token);
                if (!authError && user) {
                    callerId = user.id;
                }
            }
        }

        // ── Fetch shipment with ownership join ───────────────────────
        const { data: shipment, error: fetchError } = await supabase
            .from("shipments")
            .select("id, easypost_shipment_id, status, refund_status, is_test, carrier, tracking_number, rate_cents, created_at, sendmo_links!inner(user_id)")
            .eq("id", shipment_id)
            .single();

        // ── Ownership check (authenticated users only) ───────────────
        if (callerId && shipment && (shipment as any).sendmo_links?.user_id !== callerId) {
            return new Response(
                JSON.stringify({ error: "You do not have permission to void this label." }),
                { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        if (fetchError || !shipment) {
            return new Response(
                JSON.stringify({ error: "Shipment not found" }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Guard: Test labels cannot be voided ────────────────────────
        // is_test is a DB attribute set at creation time. We don't accept this
        // from the client — we read it from the DB. This is not a mode; it is
        // a property of the shipment record.
        if (shipment.is_test) {
            return new Response(
                JSON.stringify({
                    error: "Test labels cannot be voided. Void is only available for live shipments.",
                    is_test: true,
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Guard: Shipment status must allow cancellation ─────────────
        if (shipment.status !== "label_created") {
            const statusMsg: Record<string, string> = {
                in_transit: "This label is already in transit and cannot be voided.",
                out_for_delivery: "This label is out for delivery and cannot be voided.",
                delivered: "This shipment has already been delivered.",
                return_to_sender: "This shipment is being returned to sender.",
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

        // ── Guard: No prior refund attempt ─────────────────────────────
        if (shipment.refund_status !== "none") {
            const refundMsg: Record<string, string> = {
                submitted: "A void request has already been submitted for this label.",
                refunded: "This label has already been voided and refunded.",
                rejected: "A void request was previously submitted but rejected by the carrier.",
                not_applicable: "This label type is not eligible for refunds.",
            };
            return new Response(
                JSON.stringify({
                    error: refundMsg[shipment.refund_status] || "Refund already in progress.",
                    refund_status: shipment.refund_status,
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Guard: Carrier reference must exist ────────────────────────
        if (!shipment.easypost_shipment_id) {
            return new Response(
                JSON.stringify({ error: "No carrier shipment reference found — label may not have been fully generated." }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Call carrier refund endpoint (live shipments only) ─────────
        // We use the live API key because is_test=false means this went through
        // the live key. There is no ambiguity — the DB is the source of truth.
        const liveApiKey = Deno.env.get("EASYPOST_API_KEY");

        if (!liveApiKey) {
            return new Response(
                JSON.stringify({ error: "Live carrier API key not configured" }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(liveApiKey + ":");

        const refundResponse = await fetch(
            `https://api.easypost.com/v2/shipments/${shipment.easypost_shipment_id}/refund`,
            {
                method: "POST",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                },
            }
        );

        const refundData = await refundResponse.json();

        // refund_status from EasyPost: "submitted" | "refunded" | "rejected" | "not_applicable"
        const epRefundStatus: string = refundData.refund_status || "submitted";
        const carrierId: string | null = refundData.id || null;

        if (!refundResponse.ok && refundData.error) {
            console.error("Carrier refund error:", refundData);
            return new Response(
                JSON.stringify({
                    error: "Label void request was rejected. The label may have already been scanned by the carrier.",
                    carrier_message: refundData.error?.message,
                }),
                { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Update DB ──────────────────────────────────────────────────
        const now = new Date().toISOString();
        const { error: updateError } = await supabase
            .from("shipments")
            .update({
                status: "cancelled",
                refund_status: epRefundStatus,
                refund_submitted_at: now,
                cancelled_at: now,
                carrier_refund_id: carrierId,
                updated_at: now,
            })
            .eq("id", shipment_id);

        if (updateError) {
            console.error("DB update error after successful carrier void:", updateError);
            return new Response(
                JSON.stringify({
                    success: true,
                    refund_status: epRefundStatus,
                    warning: "Label was voided with the carrier but DB update failed — please refresh the admin panel.",
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // ── Compose user-friendly message (no carrier branding) ────────
        const messages: Record<string, string> = {
            submitted: "Label void submitted. Your refund will be processed within 2–4 weeks and credited back to your SendMo account.",
            refunded: "Label voided and refunded successfully.",
            rejected: "The void request was rejected. The label may have already been scanned by the carrier.",
            not_applicable: "This label type is not eligible for a refund.",
        };

        return new Response(
            JSON.stringify({
                success: epRefundStatus === "submitted" || epRefundStatus === "refunded",
                refund_status: epRefundStatus,
                message: messages[epRefundStatus] || "Void request submitted.",
                shipment_id,
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
