import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

// ─── Address classification helpers ──────────────────────────

/** PO Box patterns: "PO Box 123", "P.O. Box", "POB", "Box 12", etc. */
const PO_BOX_RE = /^\s*(P\.?\s*O\.?\s*Box|Post\s+Office\s+Box|POB|Box)\s+\d+/i;

/** Street-addressed PO Box: "123 Main St #PO Box 456" (competitive/CMRA) */
const STREET_PO_BOX_RE = /#?\s*(PO\s*Box|Box)\s+\d+/i;

/** APO/FPO/DPO military mail city names */
const MILITARY_CITY_RE = /^\s*(APO|FPO|DPO)\s*$/i;
const MILITARY_STATE_RE = /^\s*(AE|AP|AA)\s*$/i;

/**
 * Returns address classification flags for use by rates and UI layers.
 */
function classifyAddress(addr: Record<string, unknown>): {
    is_po_box: boolean;
    is_street_addressed_po_box: boolean;
    is_military: boolean;
    usps_only: boolean;
} {
    const street1 = String(addr.street1 || "").trim();
    const city = String(addr.city || "").trim();
    const state = String(addr.state || "").trim();

    const is_military = MILITARY_CITY_RE.test(city) || MILITARY_STATE_RE.test(state);
    const is_po_box = PO_BOX_RE.test(street1);
    const is_street_addressed_po_box = !is_po_box && STREET_PO_BOX_RE.test(street1);

    return {
        is_po_box,
        is_street_addressed_po_box,
        is_military,
        // USPS-only when it's a true PO Box or military address
        usps_only: is_po_box || is_military,
    };
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

    const sessionId = req.headers.get("x-session-id") || "unknown";

    try {
        const body = await req.json();
        const isLive = body?.live_mode === true;

        const apiKey = Deno.env.get(isLive ? "EASYPOST_API_KEY" : "EASYPOST_TEST_API_KEY");
        if (!apiKey) {
            return new Response(
                JSON.stringify({ error: `EasyPost ${isLive ? 'Live' : 'Test'} API key not configured` }),
                { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const authHeader = "Basic " + btoa(apiKey + ":");

        // ─────────────────────────────────────────────────────────
        // Google Address Validation fallback
        // If the frontend sends google_verified: false (or absent),
        // we run the address through Google's Address Validation API
        // to standardize it before passing to EasyPost.
        // ─────────────────────────────────────────────────────────

        const googleKey = Deno.env.get("GOOGLE_ADDRESS_VALIDATION_KEY");

        async function validateWithGoogle(addr: Record<string, unknown>): Promise<{
            ok: boolean;
            standardized?: Record<string, string>;
            error?: string;
        }> {
            if (!googleKey) return { ok: true }; // no key → skip, let EasyPost handle it

            const body = {
                address: {
                    addressLines: [addr.street1, addr.street2].filter(Boolean),
                    administrativeArea: String(addr.state || ""),
                    locality: String(addr.city || ""),
                    postalCode: String(addr.zip || ""),
                    regionCode: String(addr.country || "US"),
                }
            };

            const res = await fetch(
                `https://addressvalidation.googleapis.com/v1:validateAddress?key=${googleKey}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                }
            );

            if (!res.ok) {
                console.error(`[Session ${sessionId}] Google validation HTTP error:`, res.status);
                return { ok: true }; // non-fatal: fall through to EasyPost
            }

            const data = await res.json();
            const verdict = data.result?.verdict;
            const usps = data.result?.uspsData?.standardizedAddress;
            const granularity = verdict?.validationGranularity;

            // Consider the address good if Google confirms at PREMISE level or better
            const isValid = granularity === "PREMISE" || granularity === "SUB_PREMISE";

            if (!isValid) {
                return {
                    ok: false,
                    error: "Address not found — please check for typos or select an address from the dropdown",
                };
            }

            // Build standardized components from USPS data if available
            if (usps) {
                const street1 = [usps.firstAddressLine].filter(Boolean).join(" ").trim();
                return {
                    ok: true,
                    standardized: {
                        street1: street1 || String(addr.street1 || ""),
                        city: usps.city || String(addr.city || ""),
                        state: usps.state || String(addr.state || ""),
                        zip: (usps.zipCode || String(addr.zip || "")) + (usps.zipCodeExtension ? `-${usps.zipCodeExtension}` : ""),
                        country: String(addr.country || "US"),
                    }
                };
            }

            return { ok: true };
        }

        async function verifyOne(addr: Record<string, unknown>, type: "from" | "to" | "single") {
            const start = Date.now();

            // ── Classify address type before verification ─────────
            const classification = classifyAddress(addr);

            // ── Google pre-check for non-verified submissions ─────
            const googleVerified = addr.google_verified === true || addr.google_verified === "true";
            if (!googleVerified) {
                const googleResult = await validateWithGoogle(addr);
                if (!googleResult.ok) {
                    // Log: Google rejected the address before EasyPost
                    log({
                        event_type: "address.hard_error",
                        session_id: sessionId,
                        severity: "error",
                        entity_type: "address",
                        duration_ms: Date.now() - start,
                        properties: {
                            address_type: type,
                            error_source: "google",
                            error_message: googleResult.error ?? "Address not found",
                            input_street1: String(addr.street1 ?? ""),
                            input_city: String(addr.city ?? ""),
                            input_state: String(addr.state ?? ""),
                            input_zip: String(addr.zip ?? ""),
                            ...classification,
                        },
                    });
                    throw new Error(JSON.stringify({
                        message: googleResult.error || "Address could not be verified",
                        type,
                        errors: [{ field: "address", message: googleResult.error || "Address not found" }]
                    }));
                }
                // Merge standardized address if Google improved it
                if (googleResult.standardized) {
                    addr = { ...addr, ...googleResult.standardized };
                }
            }

            // ── EasyPost verification (carrier-level) ─────────────
            const res = await fetch("https://api.easypost.com/v2/addresses/create_and_verify", {
                method: "POST",
                headers: { Authorization: authHeader, "Content-Type": "application/json" },
                body: JSON.stringify({ address: addr }),
            });
            const data = await res.json();
            const elapsed = Date.now() - start;

            // Hard EasyPost error path
            if (!res.ok || data.error) {
                const msg =
                    data.error?.message ||
                    data.address?.verifications?.delivery?.errors?.[0]?.message ||
                    "Address verification failed";
                console.warn(`[Session ${sessionId}] EasyPost hard error (${type}): ${msg}`);

                // If the address was already confirmed by Google Places, don't block the user —
                // EasyPost's carrier DB has gaps (rural, new construction, ski communities, etc.).
                // Fall back to using the Google-provided components with a warning.
                if (googleVerified) {
                    console.warn(`[Session ${sessionId}] Google-verified fallback applied for (${type})`);

                    // Log: Google fallback used (EasyPost rejected but we accepted)
                    log({
                        event_type: "address.google_fallback",
                        session_id: sessionId,
                        severity: "warn",
                        entity_type: "address",
                        duration_ms: elapsed,
                        properties: {
                            address_type: type,
                            easypost_error: msg,
                            easypost_status: res.status,
                            input_street1: String(addr.street1 ?? ""),
                            input_city: String(addr.city ?? ""),
                            input_state: String(addr.state ?? ""),
                            input_zip: String(addr.zip ?? ""),
                            ...classification,
                        },
                    });

                    return {
                        id: null,
                        street1: String(addr.street1 || ""),
                        street2: String(addr.street2 || ""),
                        city: String(addr.city || ""),
                        state: String(addr.state || ""),
                        zip: String(addr.zip || ""),
                        country: String(addr.country || "US"),
                        is_po_box: classification.is_po_box,
                        is_street_addressed_po_box: classification.is_street_addressed_po_box,
                        is_military: classification.is_military,
                        usps_only: classification.usps_only,
                        residential: null,
                        verification_warning: `Carrier database could not confirm this address (${msg}). Double-check before shipping.`,
                    };
                }

                // Not Google-verified → hard block
                const fieldErrors = data.error?.errors || data.address?.verifications?.delivery?.errors || [];

                // Log: hard EasyPost rejection
                log({
                    event_type: "address.hard_error",
                    session_id: sessionId,
                    severity: "error",
                    entity_type: "address",
                    duration_ms: elapsed,
                    properties: {
                        address_type: type,
                        error_source: "easypost",
                        error_message: msg,
                        field_errors: fieldErrors,
                        easypost_status: res.status,
                        input_street1: String(addr.street1 ?? ""),
                        input_city: String(addr.city ?? ""),
                        input_state: String(addr.state ?? ""),
                        input_zip: String(addr.zip ?? ""),
                        ...classification,
                    },
                });

                throw new Error(JSON.stringify({ message: msg, type, errors: fieldErrors }));
            }

            const a = data.address || data;
            const verifications = a.verifications?.delivery;

            // Soft verification failure: EasyPost created the address (HTTP 200)
            // but its carrier database couldn't positively confirm delivery.
            // This is common for rural, remote, or new-construction addresses.
            // We treat it as a non-blocking warning rather than a hard error.
            let verification_warning: string | null = null;
            if (verifications && !verifications.success) {
                const warnMsg = verifications.errors?.[0]?.message || "Address could not be fully verified by carrier";
                console.warn(`[Session ${sessionId}] Soft verification warning (${type}):`, warnMsg);
                verification_warning = warnMsg;

                // Log: soft warning (accepted but questionable)
                log({
                    event_type: "address.soft_warning",
                    session_id: sessionId,
                    severity: "warn",
                    entity_type: "address",
                    entity_id: a.id ?? null,
                    duration_ms: elapsed,
                    properties: {
                        address_type: type,
                        warning_message: warnMsg,
                        easypost_id: a.id ?? null,
                        input_street1: String(addr.street1 ?? ""),
                        input_city: String(addr.city ?? ""),
                        input_state: String(addr.state ?? ""),
                        input_zip: String(addr.zip ?? ""),
                        ...classification,
                    },
                });
            } else {
                // Log: successful verification
                log({
                    event_type: "address.verified",
                    session_id: sessionId,
                    severity: "info",
                    entity_type: "address",
                    entity_id: a.id ?? null,
                    duration_ms: elapsed,
                    properties: {
                        address_type: type,
                        easypost_id: a.id ?? null,
                        residential: a.residential ?? null,
                        google_verified: googleVerified,
                        ...classification,
                    },
                });
            }

            return {
                id: a.id,
                street1: a.street1,
                street2: a.street2 || "",
                city: a.city,
                state: a.state,
                zip: a.zip,
                country: a.country,
                // Carrier restriction metadata
                is_po_box: classification.is_po_box,
                is_street_addressed_po_box: classification.is_street_addressed_po_box,
                is_military: classification.is_military,
                usps_only: classification.usps_only,
                residential: a.residential ?? null,
                // Non-null when carrier DB couldn't confirm but address was accepted
                verification_warning,
            };
        }

        // Dual-address mode: { from: {...}, to: {...} }
        if (body.from && body.to) {
            const [fromResult, toResult] = await Promise.all([
                verifyOne(body.from, "from"),
                verifyOne(body.to, "to"),
            ]);
            return new Response(
                JSON.stringify({
                    from_id: fromResult.id,
                    to_id: toResult.id,
                    // Carrier restriction warnings
                    warnings: [
                        toResult.is_po_box ? "TO address is a PO Box — only USPS can deliver here" : null,
                        toResult.is_military ? "TO address is a military address (APO/FPO/DPO) — only USPS accepted" : null,
                        toResult.is_street_addressed_po_box ? "TO address appears to be a street-addressed PO Box (CMRA) — UPS/FedEx may be able to deliver" : null,
                    ].filter(Boolean),
                    from_address: fromResult,
                    to_address: toResult,
                }),
                { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        // Single-address mode: { street1, city, state, zip, ... }
        const { street1, street2, city, state, zip, country } = body;
        if (!street1 || !city || !state || !zip) {
            return new Response(
                JSON.stringify({ error: "Missing required fields: street1, city, state, zip" }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
        }

        const result = await verifyOne({ street1, street2: street2 || "", city, state, zip, country: country || "US" }, "single");
        return new Response(
            JSON.stringify({ verified: true, normalizedAddress: result, easypost_id: result.id }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

    } catch (err: unknown) {
        let msg = "Internal server error";
        let type = "unknown";
        let fieldErrors: unknown[] = [];

        if (err instanceof Error) {
            try {
                const parsed = JSON.parse(err.message);
                msg = parsed.message;
                type = parsed.type;
                fieldErrors = parsed.errors;
            } catch {
                msg = err.message;
            }
        }

        console.error(`[Session ${sessionId}] Address verification error (${type}):`, msg);
        return new Response(
            JSON.stringify({ error: msg, type, fieldErrors }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
});
