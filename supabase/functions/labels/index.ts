import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { labelConfirmationEmail } from "../_shared/email-templates.ts";
import { retrievePaymentIntent, createRefund } from "../_shared/stripe.ts";

serve(async (req: Request) => {
    // Handle CORS preflight
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const sessionId = req.headers.get("x-session-id") || "unknown";

    try {
        const {
            easypost_shipment_id,
            easypost_rate_id,
            live_mode,
            from_address,
            to_address,
            parcel,
            display_price_cents,
            recipient_email,
            sender_email,
            payment_intent_id,
            comp,  // admin override — bypass payment requirement (live comp labels)
        } = await req.json();

        if (!easypost_shipment_id || !easypost_rate_id) {
            return new Response(
                JSON.stringify({ error: "Missing required fields: easypost_shipment_id, easypost_rate_id" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const isLive = live_mode === true;
        const isComp = comp === true;

        // ─── Payment authorization gate ─────────────────────────
        // Every label purchase must reference a captured Stripe PaymentIntent
        // bound to the same easypost_shipment_id. The lone exception is `comp`
        // (admin/internal flow) which records a comp payment after the fact.
        let verifiedPaymentIntent: { id: string; amount: number; status: string } | null = null;
        if (!isComp) {
            if (!payment_intent_id || typeof payment_intent_id !== "string") {
                return new Response(
                    JSON.stringify({ error: "Missing required field: payment_intent_id" }),
                    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
            try {
                const pi = await retrievePaymentIntent(payment_intent_id, isLive);
                if (pi.status !== "succeeded") {
                    return new Response(
                        JSON.stringify({ error: `Payment not captured (status=${pi.status})` }),
                        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                if (pi.metadata?.easypost_shipment_id !== easypost_shipment_id) {
                    // Hard refuse: prevents one paid PI from being replayed against
                    // a different shipment.
                    log({
                        event_type: "label.pi_shipment_mismatch",
                        session_id: sessionId,
                        severity: "error",
                        entity_type: "payment_intent",
                        entity_id: payment_intent_id,
                        properties: {
                            requested_shipment_id: easypost_shipment_id,
                            pi_metadata_shipment_id: pi.metadata?.easypost_shipment_id ?? null,
                        },
                    });
                    return new Response(
                        JSON.stringify({ error: "PaymentIntent does not match shipment" }),
                        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
                verifiedPaymentIntent = { id: pi.id, amount: pi.amount, status: pi.status };
            } catch (err) {
                const msg = err instanceof Error ? err.message : "PI verification failed";
                console.error(`[Session ${sessionId}] [labels] PI verify error:`, msg);
                return new Response(
                    JSON.stringify({ error: `Payment verification failed: ${msg}` }),
                    { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                );
            }
        }

        const apiKey = Deno.env.get(isLive ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: `EasyPost ${isLive ? 'Live' : 'Test'} API key not configured` }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(apiKey + ":");

        // Create EndShipper (required for USPS labels)
        const endShipperStart = Date.now();
        const endShipperResponse = await fetch(
            "https://api.easypost.com/v2/end_shippers",
            {
                method: "POST",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    address: {
                        name: Deno.env.get("SENDMO_COMPANY") || "SendMo",
                        company: Deno.env.get("SENDMO_COMPANY") || "SendMo",
                        street1: Deno.env.get("SENDMO_STREET") || "388 Townsend St",
                        city: Deno.env.get("SENDMO_CITY") || "San Francisco",
                        state: Deno.env.get("SENDMO_STATE") || "CA",
                        zip: Deno.env.get("SENDMO_ZIP") || "94107",
                        country: "US",
                        phone: Deno.env.get("SENDMO_PHONE") || "4155550100",
                        email: Deno.env.get("SENDMO_EMAIL") || "shipping@sendmo.co",
                    },
                }),
            }
        );

        const endShipperData = await endShipperResponse.json();
        const endShipperElapsed = Date.now() - endShipperStart;

        if (!endShipperResponse.ok || endShipperData.error) {
            const errorMsg = "Failed to create EndShipper: " + (endShipperData.error?.message || "Unknown error");
            console.error("EndShipper creation failed:", endShipperData);

            log({
                event_type: "label.endshipper_error",
                session_id: sessionId,
                severity: "error",
                entity_type: "label",
                entity_id: easypost_shipment_id,
                duration_ms: endShipperElapsed,
                properties: {
                    easypost_shipment_id,
                    error_message: endShipperData.error?.message ?? "Unknown error",
                    easypost_code: endShipperData.error?.code ?? null,
                    http_status: endShipperResponse.status,
                },
            });

            return new Response(
                JSON.stringify({ error: errorMsg }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Buy the label with EndShipper
        const buyStart = Date.now();
        const buyResponse = await fetch(
            `https://api.easypost.com/v2/shipments/${easypost_shipment_id}/buy`,
            {
                method: "POST",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    rate: { id: easypost_rate_id },
                    end_shipper_id: endShipperData.id,
                }),
            }
        );

        const buyData = await buyResponse.json();
        const buyElapsed = Date.now() - buyStart;

        if (!buyResponse.ok || buyData.error) {
            const errorMsg = buyData.error?.message || "Failed to purchase label";

            log({
                event_type: "label.buy_error",
                session_id: sessionId,
                severity: "error",
                entity_type: "label",
                entity_id: easypost_shipment_id,
                duration_ms: buyElapsed,
                properties: {
                    easypost_shipment_id,
                    easypost_rate_id,
                    error_message: errorMsg,
                    easypost_code: buyData.error?.code ?? null,
                    http_status: buyResponse.status,
                },
            });

            // Auto-refund the captured payment if EasyPost couldn't deliver
            // the label. The user has been charged but has nothing to ship,
            // so this is a hard failure mode we need to make right.
            if (verifiedPaymentIntent) {
                try {
                    const refund = await createRefund({
                        payment_intent_id: verifiedPaymentIntent.id,
                        reason: "requested_by_customer",
                        metadata: {
                            easypost_shipment_id,
                            failure_reason: "easypost_buy_failed",
                            easypost_error: String(buyData.error?.code ?? "unknown"),
                        },
                        idempotency_key: `refund_${easypost_shipment_id}_buy_failed`,
                        liveMode: isLive,
                    });
                    log({
                        event_type: "label.auto_refund_issued",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "payment_intent",
                        entity_id: verifiedPaymentIntent.id,
                        properties: { refund_id: refund.id, amount_cents: refund.amount, easypost_shipment_id },
                    });
                } catch (refundErr) {
                    // Refund failed — this is bad. The user was charged and
                    // we can't programmatically make it right. Log loud and
                    // surface in the response so the UI can tell the user
                    // to contact support.
                    const refundMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
                    console.error(`[Session ${sessionId}] [labels] AUTO-REFUND FAILED:`, refundMsg);
                    log({
                        event_type: "label.auto_refund_failed",
                        session_id: sessionId,
                        severity: "error",
                        entity_type: "payment_intent",
                        entity_id: verifiedPaymentIntent.id,
                        properties: { error_message: refundMsg, easypost_shipment_id },
                    });
                    return new Response(
                        JSON.stringify({
                            error: errorMsg,
                            payment_charged: true,
                            refund_failed: true,
                            payment_intent_id: verifiedPaymentIntent.id,
                            support_message: "Payment was charged but label generation failed and the automatic refund could not be processed. Please contact support@sendmo.co with this reference: " + verifiedPaymentIntent.id,
                        }),
                        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
                    );
                }
            }

            return new Response(
                JSON.stringify({ error: errorMsg, refunded: !!verifiedPaymentIntent }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const carrier = buyData.selected_rate?.carrier || "";
        const service = buyData.selected_rate?.service || "";
        const trackingNumber = buyData.tracking_code;

        // Log: successful label purchase
        log({
            event_type: "label.created",
            session_id: sessionId,
            severity: "info",
            entity_type: "label",
            entity_id: easypost_shipment_id,
            duration_ms: buyElapsed,
            properties: {
                easypost_shipment_id,
                easypost_rate_id,
                tracking_number: trackingNumber ?? null,
                carrier,
                service,
                rate_cost: buyData.selected_rate?.rate ?? null,
                label_url: buyData.postage_label?.label_url ?? null,
                live_mode: isLive,
            },
        });

        // Fire-and-forget DB Persistence
        if (from_address && to_address) {
            const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
            const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");

            if (sbUrl && sbKey) {
                const supabase = createClient(sbUrl, sbKey, {
                    auth: {
                        autoRefreshToken: false,
                        persistSession: false
                    }
                });

                // Fire and forget - do not await
                supabase.rpc('admin_insert_shipment', {
                    p_user_id: '00000000-0000-0000-0000-000000000001',
                    p_from_name: from_address.name,
                    p_from_street1: from_address.street1,
                    p_from_street2: from_address.street2 ?? null,
                    p_from_city: from_address.city,
                    p_from_state: from_address.state,
                    p_from_zip: from_address.zip,
                    p_from_country: from_address.country ?? 'US',
                    p_to_name: to_address.name,
                    p_to_street1: to_address.street1,
                    p_to_street2: to_address.street2 ?? null,
                    p_to_city: to_address.city,
                    p_to_state: to_address.state,
                    p_to_zip: to_address.zip,
                    p_to_country: to_address.country ?? 'US',
                    p_carrier: carrier,
                    p_service: service,
                    p_tracking_number: trackingNumber,
                    p_label_url: buyData.postage_label?.label_url || buyData.label_url,
                    p_easypost_shipment_id: easypost_shipment_id,
                    p_easypost_tracker_id: buyData.tracker?.id ?? null,
                    p_rate_cents: Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100),
                    p_display_price_cents: display_price_cents ?? Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100),
                    p_weight_oz: parcel?.weight_oz ?? 0,
                    p_length_in: parcel?.length_in ?? 0,
                    p_width_in: parcel?.width_in ?? 0,
                    p_height_in: parcel?.height_in ?? 0,
                    p_is_live: isLive,
                    p_promised_delivery_date: buyData.selected_rate?.delivery_date
                        ? new Date(buyData.selected_rate.delivery_date).toISOString().slice(0, 10)
                        : null
                }).then(async ({ data, error }) => {
                    if (error) {
                        console.error('admin_insert_shipment error:', error);
                        log({
                            event_type: "label.db_persist_error",
                            session_id: sessionId,
                            severity: "error",
                            entity_type: "label",
                            entity_id: easypost_shipment_id,
                            duration_ms: 0,
                            properties: {
                                error_message: error.message,
                                error_details: error.details,
                            }
                        });
                    } else {
                        // admin_insert_shipment now returns a TABLE(id, public_code).
                        // Supabase JS surfaces this as an array of rows.
                        const row = Array.isArray(data) ? data[0] : (data as { id: string; public_code: string } | null);
                        const shipmentId: string | undefined = row?.id;
                        const publicCode: string | undefined = row?.public_code;
                        log({
                            event_type: "label.db_persisted",
                            session_id: sessionId,
                            severity: "info",
                            entity_type: "label",
                            entity_id: easypost_shipment_id,
                            duration_ms: 0,
                            properties: {
                                shipment_id: shipmentId,
                                public_code: publicCode,
                            }
                        });

                        // Send label-confirmation email now that we have a public_code
                        // and the shipment row is persisted. Synchronizing email send
                        // with DB persist (instead of doing both as siblings) fixes a
                        // latent bug where the email could fire even when persist failed.
                        if (publicCode && recipient_email && typeof recipient_email === "string") {
                            const eta = buyData.selected_rate?.delivery_days
                                ? `${buyData.selected_rate.delivery_days} business days`
                                : "Estimated upon pickup";
                            const trackingUrl = `https://sendmo.co/t/${publicCode}`;
                            const template = labelConfirmationEmail(
                                publicCode,
                                trackingNumber || "Pending",
                                carrier || "Standard",
                                eta,
                                trackingUrl,
                            );
                            sendEmail({
                                to: recipient_email,
                                subject: template.subject,
                                html: template.html,
                            })
                                .then(({ id }) => {
                                    log({
                                        event_type: "email.label_confirmation_sent",
                                        session_id: sessionId,
                                        severity: "info",
                                        entity_type: "label",
                                        entity_id: easypost_shipment_id,
                                        properties: { resend_id: id, public_code: publicCode },
                                    });
                                })
                                .catch((err) => {
                                    console.error("Failed to send label confirmation email:", err);
                                    log({
                                        event_type: "email.label_confirmation_error",
                                        session_id: sessionId,
                                        severity: "error",
                                        entity_type: "label",
                                        entity_id: easypost_shipment_id,
                                        properties: { error_message: err instanceof Error ? err.message : String(err) },
                                    });
                                });
                        }

                        // Store notification contacts for this shipment
                        if (shipmentId) {
                            const contacts: Array<{ shipment_id: string; role: string; channel: string; address: string }> = [];
                            if (recipient_email && typeof recipient_email === "string") {
                                contacts.push({ shipment_id: shipmentId, role: "recipient", channel: "email", address: recipient_email });
                            }
                            if (sender_email && typeof sender_email === "string") {
                                contacts.push({ shipment_id: shipmentId, role: "sender", channel: "email", address: sender_email });
                            }
                            if (contacts.length > 0) {
                                const { error: ncErr } = await supabase.from("notification_contacts").insert(contacts);
                                if (ncErr) {
                                    console.error("notification_contacts insert error:", ncErr);
                                    log({
                                        event_type: "label.notification_contacts_error",
                                        session_id: sessionId,
                                        severity: "error",
                                        entity_type: "shipment",
                                        entity_id: shipmentId,
                                        duration_ms: 0,
                                        properties: { error_message: ncErr.message, count: contacts.length },
                                    });
                                } else {
                                    log({
                                        event_type: "label.notification_contacts_stored",
                                        session_id: sessionId,
                                        severity: "info",
                                        entity_type: "shipment",
                                        entity_id: shipmentId,
                                        duration_ms: 0,
                                        properties: { count: contacts.length },
                                    });
                                }
                            } else {
                                log({
                                    event_type: "label.notification_contacts_none",
                                    session_id: sessionId,
                                    severity: "warn",
                                    entity_type: "shipment",
                                    entity_id: shipmentId,
                                    duration_ms: 0,
                                    properties: { recipient_email_provided: !!recipient_email, sender_email_provided: !!sender_email },
                                });
                            }
                        }

                        // Record the payment row. Three cases:
                        //   1. Real Stripe-charged label → verifiedPaymentIntent present
                        //   2. Admin comp (free label, no card) → isComp
                        //   3. Pre-Stripe legacy live-mode flow → kept as fallback
                        //      until everything is on PI, then removable.
                        if (shipmentId && verifiedPaymentIntent) {
                            const rateCents = Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100);
                            supabase.from('payments').insert({
                                shipment_id: shipmentId,
                                user_id: '00000000-0000-0000-0000-000000000001',
                                stripe_payment_intent_id: verifiedPaymentIntent.id,
                                amount_cents: verifiedPaymentIntent.amount,
                                capture_method: 'automatic',
                                status: 'captured',
                                payment_method: 'card',
                            }).then(({ error: payErr }: { error: { message: string } | null }) => {
                                if (payErr) {
                                    console.error('Stripe payment insert error:', payErr);
                                    log({
                                        event_type: "label.stripe_payment_persist_error",
                                        session_id: sessionId,
                                        severity: "error",
                                        entity_type: "payment",
                                        entity_id: shipmentId,
                                        properties: { error_message: payErr.message, payment_intent_id: verifiedPaymentIntent!.id },
                                    });
                                } else {
                                    log({
                                        event_type: "label.stripe_payment_recorded",
                                        session_id: sessionId,
                                        severity: "info",
                                        entity_type: "payment",
                                        entity_id: shipmentId,
                                        properties: {
                                            amount_cents: verifiedPaymentIntent!.amount,
                                            payment_intent_id: verifiedPaymentIntent!.id,
                                            rate_cents: rateCents,
                                        },
                                    });
                                }
                            });
                        } else if (shipmentId && (isComp || isLive)) {
                            const rateCents = Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100);
                            supabase.from('payments').insert({
                                shipment_id: shipmentId,
                                user_id: '00000000-0000-0000-0000-000000000001',
                                stripe_payment_intent_id: null,
                                amount_cents: display_price_cents ?? rateCents,
                                capture_method: 'automatic',
                                status: 'captured',
                                payment_method: 'comp',
                            }).then(({ error: payErr }: { error: { message: string } | null }) => {
                                if (payErr) {
                                    console.error('Comp payment insert error:', payErr);
                                    log({
                                        event_type: "label.comp_payment_error",
                                        session_id: sessionId,
                                        severity: "error",
                                        entity_type: "payment",
                                        entity_id: shipmentId,
                                        properties: { error_message: payErr.message },
                                    });
                                } else {
                                    log({
                                        event_type: "label.comp_payment_recorded",
                                        session_id: sessionId,
                                        severity: "info",
                                        entity_type: "payment",
                                        entity_id: shipmentId,
                                        properties: { amount_cents: display_price_cents ?? rateCents },
                                    });
                                }
                            });
                        }
                    }
                }).catch((err) => {
                    console.error('Unhandled DB insertion error:', err);
                });
            } else {
                console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY for fire-and-forget save");
            }
        }

        // Label-confirmation email send was here; moved into the
        // admin_insert_shipment .then() callback above so it has access
        // to the generated public_code and only fires on successful DB persist.

        return new Response(
            JSON.stringify({
                tracking_number: trackingNumber,
                label_url: buyData.postage_label?.label_url || buyData.label_url,
                carrier,
                service,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    } catch (err) {
        console.error("Label purchase error:", err);
        return new Response(
            JSON.stringify({ error: "Internal server error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
