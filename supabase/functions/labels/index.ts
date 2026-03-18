import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { labelConfirmationEmail } from "../_shared/email-templates.ts";

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
        } = await req.json();

        if (!easypost_shipment_id || !easypost_rate_id) {
            return new Response(
                JSON.stringify({ error: "Missing required fields: easypost_shipment_id, easypost_rate_id" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const isLive = live_mode === true;
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

            return new Response(
                JSON.stringify({ error: errorMsg }),
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
                    p_is_live: isLive
                }).then(({ data, error }) => {
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
                        const shipmentId = data;
                        log({
                            event_type: "label.db_persisted",
                            session_id: sessionId,
                            severity: "info",
                            entity_type: "label",
                            entity_id: easypost_shipment_id,
                            duration_ms: 0,
                            properties: {
                                shipment_id: shipmentId
                            }
                        });

                        // Insert comp payment record for live comp labels
                        if (isLive && shipmentId) {
                            const rateCents = Math.round(parseFloat(buyData.selected_rate?.rate || "0") * 100);
                            supabase.from('payments').insert({
                                shipment_id: shipmentId,
                                user_id: '00000000-0000-0000-0000-000000000001',
                                stripe_payment_intent_id: null,
                                amount_cents: display_price_cents ?? rateCents,
                                capture_method: 'automatic',
                                status: 'captured',
                                payment_method: 'comp',
                            }).then(({ error: payErr }) => {
                                if (payErr) {
                                    console.error('Comp payment insert error:', payErr);
                                    log({
                                        event_type: "label.comp_payment_error",
                                        session_id: sessionId,
                                        severity: "error",
                                        entity_type: "payment",
                                        entity_id: shipmentId,
                                        duration_ms: 0,
                                        properties: { error_message: payErr.message },
                                    });
                                } else {
                                    log({
                                        event_type: "label.comp_payment_recorded",
                                        session_id: sessionId,
                                        severity: "info",
                                        entity_type: "payment",
                                        entity_id: shipmentId,
                                        duration_ms: 0,
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

        // Send label confirmation email (fire-and-forget)
        if (recipient_email && typeof recipient_email === "string") {
            const eta = buyData.selected_rate?.delivery_days
                ? `${buyData.selected_rate.delivery_days} business days`
                : "Estimated upon pickup";
            const template = labelConfirmationEmail(
                trackingNumber || "Pending",
                carrier || "Standard",
                eta,
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
                        properties: { resend_id: id },
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
