// Lightweight Stripe REST client for Deno Edge Functions.
//
// We don't pull in the official `stripe` npm package because it bundles
// poorly under Deno's import-map setup. Our surface is small (create PI,
// retrieve PI, refund, signature verify) so raw fetch is cleaner.

const STRIPE_API = "https://api.stripe.com/v1";

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
        if (typeof value === "object" && !Array.isArray(value)) {
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
        const e = new Error(msg) as Error & { stripeCode?: string; stripeType?: string };
        e.stripeCode = err?.code;
        e.stripeType = err?.type;
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

export function createPaymentIntent(params: {
    amount_cents: number;
    currency?: string;
    capture_method?: "automatic" | "manual";
    metadata?: Record<string, string>;
    receipt_email?: string;
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
