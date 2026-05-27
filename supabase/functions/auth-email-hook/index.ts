// Supabase Auth Send Email Hook — wires custom branded OTP emails into the
// Supabase Auth signup / login / magiclink / recovery flows.
//
// Without this hook, Supabase Auth sends a default "Supabase project"
// email with zero SendMo branding. With it, every OTP / verification /
// magic-link email goes through our existing `otpEmail` template + Resend.
//
// Spec: https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook
// Standard Webhooks: https://www.standardwebhooks.com/
//
// Registration:
//   1. Generate a base64 secret (32+ random bytes) and store the
//      `v1,whsec_<base64>` form in 1Password.
//   2. Set as Supabase function secret: `SEND_EMAIL_HOOK_SECRET` = the
//      full `v1,whsec_<base64>` value.
//   3. Supabase Dashboard → Authentication → Hooks → "Send Email Hook":
//        URI: https://<project>.supabase.co/functions/v1/auth-email-hook
//        Secret: paste the same `v1,whsec_<base64>` value
//        Enable
//
// HMAC verification (Standard Webhooks spec):
//   - Headers: webhook-id, webhook-timestamp, webhook-signature
//   - Signed payload string: `${id}.${timestamp}.${body}`
//   - Algorithm: HMAC-SHA256
//   - Signature header format: `v1,<base64-hmac>` (may include multiple
//     space-separated versions; we accept any v1 that matches).
//
// Email-action-types Supabase Auth sends:
//   - signup                    — new user email-verify OTP
//   - login                     — OTP login (email-otp flow)
//   - magiclink                 — magic-link login
//   - recovery                  — password reset (we don't use today)
//   - email_change_current      — confirm email change (old address)
//   - email_change_new          — confirm email change (new address)
//   - invite                    — admin invite (we don't use today)
//
// For all of these we send the same `otpEmail(code)` template since
// every action carries a 6-digit `token` and we treat them uniformly.
// The `token_hash` + `redirect_to` are available for future "click a link"
// flows if we ever stop sending OTPs and switch to magic-link-only.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { otpEmail } from "../_shared/email-templates.ts";
import { sendEmail } from "../_shared/resend.ts";

interface EmailHookPayload {
    user: {
        id: string;
        email?: string;
        aud?: string;
        role?: string;
    };
    email_data: {
        token: string;
        token_hash?: string;
        redirect_to?: string;
        email_action_type:
            | "signup"
            | "login"
            | "magiclink"
            | "recovery"
            | "email_change_current"
            | "email_change_new"
            | "invite";
        site_url?: string;
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

// Decode `v1,whsec_<base64>` → raw bytes for HMAC.
function decodeSecret(secret: string): Uint8Array | null {
    // Strip optional `v1,` prefix + `whsec_` prefix.
    const stripped = secret.replace(/^v1,/, "").replace(/^whsec_/, "");
    try {
        const binary = atob(stripped);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

async function verifySignature(
    secret: Uint8Array,
    webhookId: string,
    webhookTimestamp: string,
    rawBody: string,
    signatureHeader: string,
): Promise<boolean> {
    // Signed payload: `${id}.${timestamp}.${body}`
    const signedPayload = `${webhookId}.${webhookTimestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
        "raw",
        secret as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const enc = new TextEncoder();
    const sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

    // Signature header format: `v1,<base64> v1,<another>` — accept any v1 match.
    const parts = signatureHeader.split(/\s+/).filter(Boolean);
    for (const part of parts) {
        const cleaned = part.replace(/^v1,/, "");
        if (cleaned === expected) return true;
    }
    return false;
}

serve(async (req: Request) => {
    if (req.method !== "POST") {
        return jsonResponse({ error: "method not allowed" }, 405);
    }

    const secretConfig = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
    if (!secretConfig) {
        console.error("[auth-email-hook] SEND_EMAIL_HOOK_SECRET not set");
        // Return 500 — Supabase Auth retries on 5xx, which is the right
        // behavior while we're misconfigured (vs swallowing).
        return jsonResponse({ error: { http_code: 500, message: "Hook misconfigured" } }, 500);
    }

    const secret = decodeSecret(secretConfig);
    if (!secret) {
        console.error("[auth-email-hook] secret decode failed — bad base64 in SEND_EMAIL_HOOK_SECRET");
        return jsonResponse({ error: { http_code: 500, message: "Hook misconfigured" } }, 500);
    }

    const webhookId = req.headers.get("webhook-id") || "";
    const webhookTimestamp = req.headers.get("webhook-timestamp") || "";
    const signatureHeader = req.headers.get("webhook-signature") || "";
    const rawBody = await req.text();

    if (!webhookId || !webhookTimestamp || !signatureHeader) {
        console.error("[auth-email-hook] missing webhook headers");
        return jsonResponse({ error: { http_code: 400, message: "Missing webhook headers" } }, 400);
    }

    const ok = await verifySignature(secret, webhookId, webhookTimestamp, rawBody, signatureHeader);
    if (!ok) {
        console.error("[auth-email-hook] signature verification failed", { webhookId });
        return jsonResponse({ error: { http_code: 401, message: "Invalid signature" } }, 401);
    }

    let payload: EmailHookPayload;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return jsonResponse({ error: { http_code: 400, message: "Invalid JSON body" } }, 400);
    }

    const { user, email_data } = payload;
    if (!user?.email || !email_data?.token) {
        console.error("[auth-email-hook] missing user.email or email_data.token", {
            has_email: !!user?.email,
            has_token: !!email_data?.token,
            action: email_data?.email_action_type,
        });
        return jsonResponse({ error: { http_code: 400, message: "Incomplete payload" } }, 400);
    }

    try {
        // All action types use the same OTP-code template — every action
        // carries a 6-digit `token` we surface. (Future: branch on
        // email_action_type for invite/recovery copy variations.)
        const tpl = otpEmail(email_data.token);
        const result = await sendEmail({
            to: user.email,
            subject: tpl.subject,
            html: tpl.html,
        });

        console.log("[auth-email-hook] sent", {
            action: email_data.email_action_type,
            user_id: user.id,
            resend_id: result.id,
        });

        return jsonResponse({}, 200);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[auth-email-hook] send failed:", msg);
        // Supabase Auth treats non-2xx as retryable for transient errors.
        // Returning a structured error body per the spec.
        return jsonResponse(
            {
                error: {
                    http_code: 500,
                    message: `Email send failed: ${msg}`,
                },
            },
            500,
        );
    }
});
