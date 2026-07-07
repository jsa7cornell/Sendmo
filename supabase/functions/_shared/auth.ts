// Shared auth helpers for Edge Functions.
//
// Used by admin-gated functions (admin-report, cancel-label, future Stripe
// Live-Charge admin endpoints) to enforce server-side that the caller is an
// admin. Replaces the client-side PIN gate that was theater — anyone who
// knew the function URL could call it directly.
//
// Architectural choice: we use the service-role key to query profiles.role
// rather than RLS-scoped read. RLS would require the user's JWT to be on
// the supabase client, but then the function couldn''t bypass RLS for the
// actual workload (admin-report reads all users' data). One client per
// function, role check up front.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.97.0";

export interface AdminContext {
    user: { id: string; email: string };
    supabase: SupabaseClient;
}

/**
 * Validates the request's Bearer token, resolves the user, confirms
 * profiles.role = 'admin'. Returns the resolved user + a service-role
 * Supabase client. Throws a Response on auth failure — callers should
 * `try { ... } catch (r) { if (r instanceof Response) return r; throw r; }`.
 *
 * Failure codes:
 *   401 — missing/invalid Authorization header, or the token doesn't resolve
 *         to a user (expired session, revoked token).
 *   403 — valid user, but profiles.role != 'admin'.
 *   500 — server misconfig (missing env vars).
 */
export async function requireAdmin(
    req: Request,
    corsHeaders: Record<string, string>
): Promise<AdminContext> {
    const sbUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SB_SERVICE_ROLE_KEY");
    if (!sbUrl || !serviceKey) {
        throw new Response(
            JSON.stringify({ error: "Server configuration error" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "");
    if (!token) {
        throw new Response(
            JSON.stringify({ error: "Missing Authorization header" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    const supabase = createClient(sbUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    // Resolve the user from the JWT. supabase.auth.getUser(token) validates
    // signature + expiry against the project's JWT secret.
    const { data: userResp, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userResp?.user) {
        throw new Response(
            JSON.stringify({ error: "Invalid or expired token" }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
    const user = userResp.user;

    const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

    if (profileErr || !profile) {
        throw new Response(
            JSON.stringify({ error: "Profile not found" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    if (profile.role !== "admin") {
        throw new Response(
            JSON.stringify({ error: "Admin access required" }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return {
        user: { id: user.id, email: user.email || "" },
        supabase,
    };
}
