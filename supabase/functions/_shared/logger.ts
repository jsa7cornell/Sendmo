/**
 * Structured logger for SendMo Edge Functions.
 *
 * Usage:
 *   import { log } from "../_shared/logger.ts";
 *
 *   await log({
 *     event_type: "address.verified",
 *     session_id: sessionId,
 *     severity: "info",
 *     entity_type: "address",
 *     entity_id: result.easypost_id,
 *     duration_ms: elapsed,
 *     properties: { is_po_box: false, has_warning: true, ... }
 *   });
 *
 * Fire-and-forget: this function NEVER throws. A logging failure
 * is silently swallowed so it cannot disrupt the main request path.
 */

export interface LogEvent {
    event_type: string;
    session_id?: string | null;
    actor_id?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    severity?: "info" | "warn" | "error";
    source?: "edge_fn" | "webhook" | "frontend";
    duration_ms?: number | null;
    properties?: Record<string, unknown>;
}

/**
 * Write a structured log event to the event_logs table via the ingest function.
 * Uses the Supabase service role URL — works from any Edge Function.
 */
export async function log(event: LogEvent): Promise<void> {
    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL");
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
            Deno.env.get("SB_SERVICE_ROLE_KEY");

        if (!supabaseUrl || !serviceRoleKey) {
            // Log to console as fallback when env vars are missing (local dev without keys)
            console.warn("[logger] Missing SUPABASE_URL or service role key — writing to console only");
            console.log("[event_log]", JSON.stringify({ ...event, created_at: new Date().toISOString() }));
            return;
        }

        const endpoint = `${supabaseUrl}/functions/v1/ingest`;

        // Fire-and-forget: we don't await or check the response
        fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${serviceRoleKey}`,
            },
            body: JSON.stringify({
                ...event,
                source: event.source ?? "edge_fn",
                severity: event.severity ?? "info",
                properties: event.properties ?? {},
            }),
        }).catch((err) => {
            // Swallow silently — never let logging break the main request
            console.warn("[logger] ingest call failed (non-fatal):", err?.message ?? err);
        });
    } catch (err) {
        // Belt-and-suspenders: catch any synchronous error too
        console.warn("[logger] unexpected error (non-fatal):", err);
    }
}

/**
 * Convenience helper: time an async operation and emit a log event.
 *
 * Usage:
 *   const result = await timed("easypost.rate_fetch", async () => {
 *     return await fetch(...);
 *   }, { session_id });
 */
export async function timed<T>(
    event_type: string,
    fn: () => Promise<T>,
    base: Omit<LogEvent, "event_type" | "duration_ms">,
): Promise<T> {
    const start = Date.now();
    try {
        const result = await fn();
        await log({ ...base, event_type, duration_ms: Date.now() - start });
        return result;
    } catch (err) {
        await log({
            ...base,
            event_type,
            severity: "error",
            duration_ms: Date.now() - start,
            properties: {
                ...(base.properties ?? {}),
                error: err instanceof Error ? err.message : String(err),
            },
        });
        throw err;
    }
}
