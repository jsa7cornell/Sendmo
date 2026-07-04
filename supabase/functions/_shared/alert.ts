// Shared admin-alert email helper (PRE-LAUNCH T1-3, code half).
//
// Extracted from the inline refund-failed alert in stripe-webhook/index.ts
// so every severity:"error" money path can notify the admin instead of
// only writing event_logs (Rule 6 — one definition, many call sites).
//
// Contract:
//   - NEVER throws. An alert failure must never mask or block the original
//     handler (mirrors the refund.failed_alert_email_error fallback).
//   - Recipient comes from SENDMO_ADMIN_EMAIL, falling back to John's
//     email — parity with the original inline implementation.
//   - On send failure: console.error + an event_logs row. Callers that need
//     the documented `refund.failed_alert_email_error` event type (PLAYBOOK
//     taxonomy) pass `failureLog`; everything else gets `alert.email_failed`.

import { sendEmail } from "./resend.ts";
import { log } from "./logger.ts";

export interface AdminAlertRow {
    label: string;
    value: string;
}

export interface AdminAlertOptions {
    /** Subject line — "[SendMo ALERT] " is prefixed automatically. */
    subject: string;
    /** Red heading inside the email body. */
    heading: string;
    /** 1–2 plain sentences: what happened, why it needs a human. */
    intro: string;
    /** Key/value details table. Values are HTML-escaped. */
    rows?: AdminAlertRow[];
    /** Optional deep link (Stripe dashboard, admin page, …). */
    actionUrl?: string;
    actionLabel?: string;
    /** Where the alert came from, e.g. "labels label.buy_error handler". */
    source: string;
    /** Override the failure event_logs row (defaults to alert.email_failed). */
    failureLog?: {
        event_type: string;
        entity_type?: string;
        entity_id?: string;
    };
}

function escapeHtml(s: string): string {
    return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

/**
 * Sends an alert email to the SendMo admin. Fire-and-forget safe: catches
 * everything internally and resolves either way.
 */
export async function sendAdminAlert(opts: AdminAlertOptions): Promise<void> {
    const adminEmail = Deno.env.get("SENDMO_ADMIN_EMAIL") || "jsa7cornell@gmail.com";
    const rowsHtml = (opts.rows ?? [])
        .map(
            (r) =>
                `  <tr><td style="padding:6px 0;color:#6B7280;width:180px;">${escapeHtml(r.label)}</td>` +
                `<td style="padding:6px 0;font-family:monospace;">${escapeHtml(r.value)}</td></tr>`,
        )
        .join("\n");
    const actionHtml = opts.actionUrl
        ? `<p><a href="${escapeHtml(opts.actionUrl)}" style="color:#2563EB;">${escapeHtml(opts.actionLabel ?? "View details")}</a></p>`
        : "";
    try {
        await sendEmail({
            to: adminEmail,
            subject: `[SendMo ALERT] ${opts.subject}`,
            html: `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;">
<h2 style="color:#DC2626;">&#x26A0;&#xFE0F; ${escapeHtml(opts.heading)}</h2>
<p>${opts.intro}</p>
<table style="border-collapse:collapse;width:100%;max-width:480px;">
${rowsHtml}
</table>
${actionHtml}
<p style="font-size:13px;color:#9CA3AF;margin-top:24px;">SendMo automated alert — ${escapeHtml(opts.source)}</p>
</body></html>`,
        });
    } catch (emailErr) {
        const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
        console.error(`[alert] admin alert email failed (${opts.source}):`, msg);
        log({
            event_type: opts.failureLog?.event_type ?? "alert.email_failed",
            severity: "error",
            entity_type: opts.failureLog?.entity_type ?? "alert",
            entity_id: opts.failureLog?.entity_id,
            properties: { error_message: msg, subject: opts.subject, source: opts.source },
        });
    }
}
