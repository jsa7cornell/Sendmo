// Lightweight Stripe REST client for Deno Edge Functions.
//
// We don't pull in the official `stripe` npm package because it bundles
// poorly under Deno's import-map setup. Our surface is small (create PI,
// retrieve PI, refund, signature verify) so raw fetch is cleaner.

const STRIPE_API = "https://api.stripe.com/v1";

// Pin all outgoing Stripe API calls to a known version. The test + live
// webhook event destinations are also configured to 2026-04-22.dahlia, so
// request and event payload shapes stay aligned. Without this header the
// server silently follows the account default and can drift if Stripe
// rolls out a new default. See 2026-05-14 LOG entry "Phase B webhook
// rebuild + Stripe-Version pin".
const STRIPE_API_VERSION = "2026-04-22.dahlia";

function getSecretKey(liveMode: boolean): string {
    const key = liveMode
        ? Deno.env.get("STRIPE_SECRET_KEY_LIVE") || Deno.env.get("STRIPE_SECRET_KEY")
        : Deno.env.get("STRIPE_SECRET_KEY_TEST");
    if (!key) {
        throw new Error(`Stripe ${liveMode ? "LIVE" : "TEST"} secret key not configured`);
    }
    return key;
}

function getWebhookSecret(liveMode: boolean): string {
    const key = liveMode
        ? Deno.env.get("STRIPE_WEBHOOK_SECRET_LIVE") || Deno.env.get("STRIPE_WEBHOOK_SECRET")
        : Deno.env.get("STRIPE_WEBHOOK_SECRET_TEST");
    if (!key) {
        throw new Error(`Stripe ${liveMode ? "LIVE" : "TEST"} webhook secret not configured`);
    }
    return key;
}

function formEncode(params: Record<string, unknown>, prefix = ""): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        const name = prefix ? `${prefix}[${key}]` : key;
        if (Array.isArray(value)) {
            // Stripe's form-encoding for arrays is `key[0]=v0&key[1]=v1`.
            // Critical for SetupIntent.payment_method_types and any other
            // array-shaped Stripe parameter. Bug fix 2026-05-13: prior code
            // String()'d arrays, producing scalar 'card' instead of the
            // 1-element array, which Stripe rejected with "Invalid array".
            value.forEach((item, i) => {
                const itemKey = `${name}[${i}]`;
                if (item !== undefined && item !== null) {
                    if (typeof item === "object") {
                        parts.push(formEncode(item as Record<string, unknown>, itemKey));
                    } else {
                        parts.push(`${encodeURIComponent(itemKey)}=${encodeURIComponent(String(item))}`);
                    }
                }
            });
        } else if (typeof value === "object") {
            parts.push(formEncode(value as Record<string, unknown>, name));
        } else {
            parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
        }
    }
    return parts.filter(Boolean).join("&");
}

interface StripeRequestOptions {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    liveMode: boolean;
}

async function stripeRequest<T = Record<string, unknown>>(
    path: string,
    opts: StripeRequestOptions,
): Promise<T> {
    const secret = getSecretKey(opts.liveMode);
    const headers: Record<string, string> = {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": STRIPE_API_VERSION,
    };
    if (opts.idempotencyKey) {
        headers["Idempotency-Key"] = opts.idempotencyKey;
    }
    const url = `${STRIPE_API}${path}`;
    const init: RequestInit = {
        method: opts.method || "POST",
        headers,
    };
    if (opts.method !== "GET" && opts.body) {
        init.body = formEncode(opts.body);
    }
    const res = await fetch(url, init);
    const data = await res.json();
    if (!res.ok) {
        const err = data?.error;
        const msg = err?.message || `Stripe ${path} ${res.status}`;
        const e = new Error(msg) as Error & {
            stripeCode?: string;
            stripeType?: string;
            stripeDeclineCode?: string;
        };
        e.stripeCode = err?.code;
        e.stripeType = err?.type;
        // Capture decline_code so callers can distinguish e.g. a Radar-block
        // fraud decline (decline_code='fraudulent') from a generic card decline.
        // The authoritative Radar-block signal is the charge's outcome.type
        // (see retrieveCharge); this is a synchronous hint for the Edge fn caller.
        e.stripeDeclineCode = err?.decline_code;
        throw e;
    }
    return data as T;
}

// ─── PaymentIntents ─────────────────────────────────────────

export interface PaymentIntent {
    id: string;
    object: "payment_intent";
    amount: number;
    currency: string;
    status:
        | "requires_payment_method"
        | "requires_confirmation"
        | "requires_action"
        | "processing"
        | "requires_capture"
        | "canceled"
        | "succeeded";
    client_secret: string;
    metadata?: Record<string, string>;
    latest_charge?: string;
    capture_method: "automatic" | "manual";
}

// Stripe `shipping` block — fed to PaymentIntents as a fraud signal for
// Radar (proposal 2026-05-21 payments-risk-intelligence, B2). Optional.
export interface ShippingDetails {
    name: string;
    phone?: string;
    address: {
        line1: string;
        line2?: string;
        city?: string;
        state?: string;
        postal_code?: string;
        country?: string;
    };
}

export function createPaymentIntent(params: {
    amount_cents: number;
    currency?: string;
    capture_method?: "automatic" | "manual";
    metadata?: Record<string, string>;
    receipt_email?: string;
    customer?: string;
    // 'off_session' attaches the PM to the customer for later off-session
    // charges. Used by flex_hold so we can charge overage carrier adjustments
    // (master proposal §3.7) without a re-prompt.
    setup_future_usage?: "off_session" | "on_session";
    shipping?: ShippingDetails;
    idempotency_key: string;
    liveMode: boolean;
}): Promise<PaymentIntent> {
    return stripeRequest<PaymentIntent>("/payment_intents", {
        method: "POST",
        body: {
            amount: params.amount_cents,
            currency: params.currency || "usd",
            capture_method: params.capture_method || "automatic",
            // Allow PaymentElement to negotiate methods (default cards in our case)
            automatic_payment_methods: { enabled: true, allow_redirects: "never" },
            metadata: params.metadata,
            receipt_email: params.receipt_email,
            ...(params.shipping ? { shipping: params.shipping } : {}),
            // When set, PaymentElement renders saved PMs for this Customer as
            // the top option (with an inline "use a different card" fallback).
            // Omitted → bare new-card form, current behavior.
            ...(params.customer ? { customer: params.customer } : {}),
            ...(params.setup_future_usage
                ? { setup_future_usage: params.setup_future_usage }
                : {}),
        },
        idempotencyKey: params.idempotency_key,
        liveMode: params.liveMode,
    });
}

export function retrievePaymentIntent(
    id: string,
    liveMode: boolean,
): Promise<PaymentIntent> {
    return stripeRequest<PaymentIntent>(`/payment_intents/${encodeURIComponent(id)}`, {
        method: "GET",
        liveMode,
    });
}

// ─── Charges (B4 — used to read outcome.type for Radar-block detection) ─

export interface ChargeOutcome {
    // 'blocked' = Stripe Radar (or your custom rules) blocked the charge.
    // 'issuer_declined' = the cardholder's bank declined.
    // Other values: 'authorized', 'manual_review', 'invalid'.
    type?: "authorized" | "manual_review" | "issuer_declined" | "blocked" | "invalid";
    network_status?: string;
    reason?: string | null;
    risk_level?: string;
    risk_score?: number;
    seller_message?: string | null;
}

export interface Charge {
    id: string;
    object: "charge";
    status: "pending" | "succeeded" | "failed";
    outcome?: ChargeOutcome | null;
    payment_intent?: string | null;
    metadata?: Record<string, string>;
}

export function retrieveCharge(
    id: string,
    liveMode: boolean,
): Promise<Charge> {
    return stripeRequest<Charge>(`/charges/${encodeURIComponent(id)}`, {
        method: "GET",
        liveMode,
    });
}

export function capturePaymentIntent(
    id: string,
    liveMode: boolean,
    amount_to_capture?: number,
): Promise<PaymentIntent> {
    return stripeRequest<PaymentIntent>(`/payment_intents/${encodeURIComponent(id)}/capture`, {
        method: "POST",
        body: amount_to_capture ? { amount_to_capture } : {},
        liveMode,
    });
}

export function cancelPaymentIntent(
    id: string,
    liveMode: boolean,
): Promise<PaymentIntent> {
    return stripeRequest<PaymentIntent>(`/payment_intents/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        liveMode,
    });
}

// ─── Off_session shipment PI (Pattern D, Phase F) ───────────
//
// Sibling helper to createPaymentIntent (NOT a wrapper). The two diverge
// on one critical field: createPaymentIntent sends
// `automatic_payment_methods: { enabled: true }` so that PaymentElement
// can negotiate PM types on the client. Stripe REJECTS that combination
// when an explicit `payment_method` is also provided with `confirm: true`
// (validation error: parameter_unknown / parameter_invalid_combination).
// The off_session/MIT path needs the explicit-PM shape — so it gets its
// own request body without `automatic_payment_methods`.
//
// Used by labels/index.ts on every flex sender confirm to charge the
// recipient's saved PM for the actual shipment rate. The PI is created
// pre-confirmed and auto-captures synchronously. The returned status is
// one of:
//   'succeeded'         — captured; proceed with EasyPost label buy
//   'requires_action'   — SCA/3DS required; treat as decline in v1 (US-only)
//   'requires_payment_method' / 'canceled' — declined; bail
//
// Stripe documents the off_session shape at:
//   https://docs.stripe.com/payments/save-and-reuse
//   https://docs.stripe.com/payments/cits-and-mits
export function createOffSessionShipmentPI(params: {
    amount_cents: number;
    currency?: string;
    customer: string;
    payment_method: string;
    metadata: Record<string, string>;
    shipping?: ShippingDetails;
    idempotency_key: string;
    liveMode: boolean;
}): Promise<PaymentIntent> {
    return stripeRequest<PaymentIntent>("/payment_intents", {
        method: "POST",
        body: {
            amount: params.amount_cents,
            currency: params.currency || "usd",
            capture_method: "automatic",
            customer: params.customer,
            payment_method: params.payment_method,
            off_session: true,
            confirm: true,
            // NB: no automatic_payment_methods. See helper-level comment.
            metadata: params.metadata,
            ...(params.shipping ? { shipping: params.shipping } : {}),
        },
        idempotencyKey: params.idempotency_key,
        liveMode: params.liveMode,
    });
}

// ─── Carrier-adjustment off_session recharge (H2) ───────────
//
// Wraps createOffSessionShipmentPI with the carrier-adjustment-specific
// amount math ($1 handling fee), metadata, and the per-attempt-namespaced
// idempotency key so a failed first PI's "failed" result doesn't dedup
// the retry (Nit fix from the decided proposal review).
//
// Idempotency key shape: `adjustment_<shipment_id>_<carrier_adjustment_id>_<attempt>`
// - shipment_id namespaces against label-buy keys (`pi_create_…`,
//   `pi_offsess_…`, `label_cost_…`).
// - carrier_adjustment_id namespaces against multiple adjustment events on
//   the same shipment (a reweigh + an address correction = 2 distinct rows).
// - attempt counter lets the recharge retry without colliding with the
//   prior failure's PI.
//
// Decided proposal:
//   2026-05-22_reconciliation-and-carrier-adjustments §2.4 + Nits.
export function createAdjustmentRecharge(params: {
    shipmentId: string;                  // SendMo shipment UUID
    publicCode: string;                  // for metadata + reason text
    carrierAdjustmentId: string;         // anchors the idempotency key
    deltaCents: number;                  // carrier overcharge; +$1 handling fee added
    attempt: number;                     // 1 on first try; bump on retry
    paymentMethodId: string;             // pre-attached saved PM
    customerId: string;                  // Stripe Customer (owner of the PM)
    reason?: string;                     // EasyPost adjustment_reason
    liveMode: boolean;
}): Promise<PaymentIntent> {
    const totalCents = params.deltaCents + 100;  // delta + $1 handling fee
    const idempotencyKey =
        `adjustment_${params.shipmentId}_${params.carrierAdjustmentId}_${params.attempt}`;

    return createOffSessionShipmentPI({
        amount_cents: totalCents,
        customer: params.customerId,
        payment_method: params.paymentMethodId,
        metadata: {
            source: "carrier_adjustment_recharge",
            intent_role: "carrier_adjustment",
            // txn_kind — Radar/Fraud-Teams discriminator (B2 from risk-intel).
            txn_kind: "mit_adjustment",
            shipment_id: params.shipmentId,
            public_code: params.publicCode,
            carrier_adjustment_id: params.carrierAdjustmentId,
            delta_cents: String(params.deltaCents),
            fee_cents: "100",
            attempt: String(params.attempt),
            ...(params.reason ? { reason: params.reason } : {}),
        },
        idempotency_key: idempotencyKey,
        liveMode: params.liveMode,
    });
}

// ─── Customers ──────────────────────────────────────────────

export interface Customer {
    id: string;
    object: "customer";
    email?: string;
    metadata?: Record<string, string>;
}

export function createCustomer(params: {
    email?: string;
    metadata?: Record<string, string>;
    liveMode: boolean;
}): Promise<Customer> {
    return stripeRequest<Customer>("/customers", {
        method: "POST",
        body: {
            email: params.email,
            metadata: params.metadata,
        },
        liveMode: params.liveMode,
    });
}

// ─── Customer Sessions (Dahlia required for saved-PM display) ─

export interface CustomerSession {
    object: "customer_session";
    client_secret: string;
    customer: string;
    expires_at: number;
}

// Required by PaymentElement to render saved PMs on the sender-flow
// checkout (2026-04-22.dahlia onward). Just setting `customer` on the
// PaymentIntent isn't enough — you also need a Customer Session client
// secret on the Elements provider.
//
// payment_method_save/remove are intentionally 'disabled': saving still
// happens through the dedicated /payment-methods Add Card flow, and we
// don't want users deleting cards from inside the checkout sheet.
export function createCustomerSession(params: {
    customer: string;
    liveMode: boolean;
}): Promise<CustomerSession> {
    return stripeRequest<CustomerSession>("/customer_sessions", {
        method: "POST",
        body: {
            customer: params.customer,
            components: {
                payment_element: {
                    enabled: true,
                    features: {
                        payment_method_redisplay: "enabled",
                        // Include cards saved before allow_redisplay='always'
                        // was set (they default to 'unspecified'). Without this,
                        // Customer Session filters them out of the picker.
                        payment_method_allow_redisplay_filters: ["always", "unspecified"],
                        payment_method_save: "disabled",
                        payment_method_remove: "disabled",
                    },
                },
            },
        },
        liveMode: params.liveMode,
    });
}

// ─── SetupIntents (Phase B saved cards) ─────────────────────

export interface SetupIntent {
    id: string;
    object: "setup_intent";
    client_secret: string;
    customer: string | null;
    payment_method?: string | null;
    status:
        | "requires_payment_method"
        | "requires_confirmation"
        | "requires_action"
        | "processing"
        | "canceled"
        | "succeeded";
    usage?: string;
    metadata?: Record<string, string>;
}

export function createSetupIntent(params: {
    customer: string;
    metadata?: Record<string, string>;
    idempotency_key: string;
    liveMode: boolean;
}): Promise<SetupIntent> {
    return stripeRequest<SetupIntent>("/setup_intents", {
        method: "POST",
        body: {
            customer: params.customer,
            payment_method_types: ["card"],
            usage: "off_session",
            // Saved-PM redisplay (allow_redisplay='always') needs to be set
            // somewhere other than SetupIntent — both top-level and nested
            // under payment_method_options[card] were rejected by Stripe
            // 2026-05-14. Likely belongs on payment_method_data via the
            // client-side confirmSetup call, or via a follow-up
            // PaymentMethod update in the webhook handler. TODO: research
            // + implement separately. For now, PMs save with default
            // allow_redisplay='unspecified' and won't surface in the
            // sender-flow PaymentElement saved-card picker — but Add Card
            // itself works.
            metadata: params.metadata,
        },
        idempotencyKey: params.idempotency_key,
        liveMode: params.liveMode,
    });
}

// ─── PaymentMethods ─────────────────────────────────────────

export interface PaymentMethodCard {
    brand?: string;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
}

export interface PaymentMethod {
    id: string;
    object: "payment_method";
    type: string;
    customer?: string | null;
    card?: PaymentMethodCard;
    metadata?: Record<string, string>;
}

export function detachPaymentMethod(
    paymentMethodId: string,
    liveMode: boolean,
): Promise<PaymentMethod> {
    return stripeRequest<PaymentMethod>(
        `/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`,
        { method: "POST", liveMode },
    );
}

export function retrievePaymentMethod(
    paymentMethodId: string,
    liveMode: boolean,
): Promise<PaymentMethod> {
    return stripeRequest<PaymentMethod>(
        `/payment_methods/${encodeURIComponent(paymentMethodId)}`,
        { method: "GET", liveMode },
    );
}

// ─── Refunds ────────────────────────────────────────────────

export interface Refund {
    id: string;
    object: "refund";
    amount: number;
    status: "pending" | "succeeded" | "failed" | "canceled";
    payment_intent: string;
}

export function createRefund(params: {
    payment_intent_id: string;
    amount_cents?: number;
    reason?: "duplicate" | "fraudulent" | "requested_by_customer";
    metadata?: Record<string, string>;
    idempotency_key: string;
    liveMode: boolean;
}): Promise<Refund> {
    return stripeRequest<Refund>("/refunds", {
        method: "POST",
        body: {
            payment_intent: params.payment_intent_id,
            amount: params.amount_cents,
            reason: params.reason,
            metadata: params.metadata,
        },
        idempotencyKey: params.idempotency_key,
        liveMode: params.liveMode,
    });
}

// ─── Webhook Signature Verification ─────────────────────────

// Stripe signs webhooks with HMAC-SHA256 over `{timestamp}.{payload}` using
// the webhook signing secret. The signature header looks like:
//   `t=1234567890,v1=abc...,v0=def...`
// We accept v1. Tolerate a 5-minute clock skew (Stripe's recommended window).

async function hmacSha256(key: string, payload: string): Promise<string> {
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        enc.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(payload));
    return Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

/**
 * Verifies a Stripe webhook signature against the raw payload. Returns the
 * parsed event on success, throws on failure. Tries the test secret first,
 * then live, so the same endpoint can serve both environments.
 */
export async function verifyAndParseWebhook(
    rawPayload: string,
    signatureHeader: string | null,
    toleranceSeconds = 300,
): Promise<{ event: Record<string, unknown>; liveMode: boolean }> {
    if (!signatureHeader) throw new Error("Missing Stripe-Signature header");

    const parts = signatureHeader.split(",").map((p) => p.trim());
    const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
    const v1Signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
    if (!timestamp || v1Signatures.length === 0) {
        throw new Error("Malformed Stripe-Signature header");
    }

    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) throw new Error("Invalid Stripe-Signature timestamp");
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > toleranceSeconds) {
        throw new Error("Stripe webhook timestamp outside tolerance");
    }

    const signedPayload = `${timestamp}.${rawPayload}`;

    // Try test secret first, then live. Whichever matches tells us which
    // environment fired this webhook.
    for (const liveMode of [false, true]) {
        let secret: string;
        try {
            secret = getWebhookSecret(liveMode);
        } catch {
            continue;
        }
        const expected = await hmacSha256(secret, signedPayload);
        if (v1Signatures.some((sig) => timingSafeEqualHex(sig, expected))) {
            const event = JSON.parse(rawPayload) as Record<string, unknown>;
            // Cross-check: event.livemode should match the secret we matched
            const eventLive = (event as { livemode?: boolean }).livemode === true;
            if (eventLive !== liveMode) {
                throw new Error(
                    `Signature matched ${liveMode ? "LIVE" : "TEST"} secret but event.livemode=${eventLive}`,
                );
            }
            return { event, liveMode };
        }
    }

    throw new Error("No valid Stripe webhook signature");
}
