import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";
import { otpEmail } from "../_shared/email-templates.ts";

/**
 * Email verification Edge Function.
 *
 * Routes:
 *   POST /email          — body: { action: "send", email }       → send OTP
 *   POST /email          — body: { action: "confirm", email, code } → verify OTP
 */

async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateOTP(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  // Generate 6-digit code (100000-999999)
  return String(100000 + (arr[0] % 900000));
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ─── Send OTP ──────────────────────────────────────────────

async function handleSend(email: string, sessionId: string): Promise<Response> {
  const supabase = getSupabase();
  const start = Date.now();

  // Rate limit: max 3 sends per email per 10 minutes
  const { count } = await supabase
    .from("email_verifications")
    .select("*", { count: "exact", head: true })
    .eq("email", email)
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  if ((count ?? 0) >= 3) {
    log({
      event_type: "email.otp_rate_limited",
      session_id: sessionId,
      severity: "warn",
      entity_type: "email",
      properties: { reason: "too_many_sends" },
    });
    return new Response(
      JSON.stringify({ error: "Too many verification attempts. Please wait 10 minutes." }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Generate OTP and hash it
  const code = generateOTP();
  const codeHash = await hashCode(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Store in DB
  const { error: insertErr } = await supabase.from("email_verifications").insert({
    email,
    code_hash: codeHash,
    expires_at: expiresAt,
  });

  if (insertErr) {
    console.error("Failed to store OTP:", insertErr);
    return new Response(
      JSON.stringify({ error: "Failed to generate verification code" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Send via Resend
  try {
    const template = otpEmail(code);
    const { id: emailId } = await sendEmail({
      to: email,
      subject: template.subject,
      html: template.html,
    });

    const elapsed = Date.now() - start;
    log({
      event_type: "email.otp_sent",
      session_id: sessionId,
      severity: "info",
      entity_type: "email",
      duration_ms: elapsed,
      properties: { resend_id: emailId },
    });

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const elapsed = Date.now() - start;
    console.error("Resend error:", err);
    log({
      event_type: "email.otp_send_error",
      session_id: sessionId,
      severity: "error",
      entity_type: "email",
      duration_ms: elapsed,
      properties: { error_message: err instanceof Error ? err.message : String(err) },
    });
    return new Response(
      JSON.stringify({ error: "Failed to send verification email" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
}

// ─── Confirm OTP ───────────────────────────────────────────

async function handleConfirm(email: string, code: string, sessionId: string): Promise<Response> {
  const supabase = getSupabase();
  const codeHash = await hashCode(code);

  // Find the most recent non-verified, non-expired code for this email
  const { data: rows, error: fetchErr } = await supabase
    .from("email_verifications")
    .select("id, code_hash, attempts")
    .eq("email", email)
    .eq("verified", false)
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  if (fetchErr || !rows || rows.length === 0) {
    log({
      event_type: "email.otp_confirm_no_code",
      session_id: sessionId,
      severity: "warn",
      entity_type: "email",
    });
    return new Response(
      JSON.stringify({ error: "No active verification code found. Please request a new one." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const row = rows[0];

  // Rate limit: max 5 attempts per code
  if (row.attempts >= 5) {
    log({
      event_type: "email.otp_too_many_attempts",
      session_id: sessionId,
      severity: "warn",
      entity_type: "email",
    });
    return new Response(
      JSON.stringify({ error: "Too many attempts. Please request a new code." }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Increment attempts
  await supabase
    .from("email_verifications")
    .update({ attempts: row.attempts + 1 })
    .eq("id", row.id);

  // Check hash
  if (row.code_hash !== codeHash) {
    log({
      event_type: "email.otp_invalid",
      session_id: sessionId,
      severity: "warn",
      entity_type: "email",
      properties: { attempt: row.attempts + 1 },
    });
    return new Response(
      JSON.stringify({ error: "Invalid code. Please try again." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Mark verified
  await supabase
    .from("email_verifications")
    .update({ verified: true })
    .eq("id", row.id);

  log({
    event_type: "email.otp_verified",
    session_id: sessionId,
    severity: "info",
    entity_type: "email",
  });

  return new Response(
    JSON.stringify({ ok: true, verified: true }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// ─── Main Handler ──────────────────────────────────────────

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
    const { action, email, code } = body;

    if (!email || typeof email !== "string") {
      return new Response(
        JSON.stringify({ error: "Email is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (action === "send") {
      return await handleSend(normalizedEmail, sessionId);
    }

    if (action === "confirm") {
      if (!code || typeof code !== "string" || code.length !== 6) {
        return new Response(
          JSON.stringify({ error: "A 6-digit code is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return await handleConfirm(normalizedEmail, code, sessionId);
    }

    return new Response(
      JSON.stringify({ error: 'Invalid action. Use "send" or "confirm".' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Email function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
