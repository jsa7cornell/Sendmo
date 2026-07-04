// Unit tests for the shared admin-alert helper
// (supabase/functions/_shared/alert.ts) — PRE-LAUNCH T1-3, code half.
//
// Extracted 2026-07-04 from the inline refund-failed alert in
// stripe-webhook/index.ts; fired from labels' label.buy_error /
// label.auto_refund_failed / label.flex_off_session_error paths.
//
// Pattern: same as tests/unit/adjustments.test.ts — vi.mock the
// side-effect modules (resend, logger) before importing, and stub the
// Deno global for the env read inside sendAdminAlert.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../supabase/functions/_shared/resend.ts", () => ({
    sendEmail: vi.fn().mockResolvedValue({ id: "test-email-id" }),
}));
vi.mock("../../supabase/functions/_shared/logger.ts", () => ({
    log: vi.fn(),
}));

import { sendAdminAlert } from "../../supabase/functions/_shared/alert.ts";
import { sendEmail } from "../../supabase/functions/_shared/resend.ts";
import { log } from "../../supabase/functions/_shared/logger.ts";

const mockSendEmail = vi.mocked(sendEmail);
const mockLog = vi.mocked(log);

// Deno global stub — alert.ts reads SENDMO_ADMIN_EMAIL at call time.
let envVars: Record<string, string | undefined> = {};
(globalThis as Record<string, unknown>).Deno = {
    env: { get: (k: string) => envVars[k] },
};

const BASE = {
    subject: "Refund failed",
    heading: "Refund Failed — Action Required",
    intro: "A refund could not be delivered.",
    source: "test-suite",
};

beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue({ id: "test-email-id" });
    envVars = {};
});

describe("sendAdminAlert", () => {
    it("sends to SENDMO_ADMIN_EMAIL when set", async () => {
        envVars.SENDMO_ADMIN_EMAIL = "alerts@sendmo.co";
        await sendAdminAlert(BASE);
        expect(mockSendEmail).toHaveBeenCalledOnce();
        expect(mockSendEmail.mock.calls[0][0].to).toBe("alerts@sendmo.co");
    });

    it("falls back to John's email when the env var is unset (parity with the inline original)", async () => {
        await sendAdminAlert(BASE);
        expect(mockSendEmail.mock.calls[0][0].to).toBe("jsa7cornell@gmail.com");
    });

    it("prefixes the subject with [SendMo ALERT] and renders heading/intro/source", async () => {
        await sendAdminAlert(BASE);
        const call = mockSendEmail.mock.calls[0][0];
        expect(call.subject).toBe("[SendMo ALERT] Refund failed");
        expect(call.html).toContain("Refund Failed — Action Required");
        expect(call.html).toContain("A refund could not be delivered.");
        expect(call.html).toContain("test-suite");
    });

    it("renders rows and the action link", async () => {
        await sendAdminAlert({
            ...BASE,
            rows: [{ label: "PaymentIntent", value: "pi_123" }],
            actionUrl: "https://dashboard.stripe.com/refunds/re_1",
            actionLabel: "View refund",
        });
        const html = mockSendEmail.mock.calls[0][0].html;
        expect(html).toContain("PaymentIntent");
        expect(html).toContain("pi_123");
        expect(html).toContain('href="https://dashboard.stripe.com/refunds/re_1"');
        expect(html).toContain("View refund");
    });

    it("HTML-escapes row values (error messages can carry markup)", async () => {
        await sendAdminAlert({
            ...BASE,
            rows: [{ label: "Error", value: '<script>alert("x")</script>' }],
        });
        const html = mockSendEmail.mock.calls[0][0].html;
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });

    it("never throws when the email send fails, and logs alert.email_failed by default", async () => {
        mockSendEmail.mockRejectedValueOnce(new Error("resend 500"));
        await expect(sendAdminAlert(BASE)).resolves.toBeUndefined();
        expect(mockLog).toHaveBeenCalledOnce();
        const logged = mockLog.mock.calls[0][0];
        expect(logged.event_type).toBe("alert.email_failed");
        expect(logged.severity).toBe("error");
        expect(logged.properties?.error_message).toBe("resend 500");
    });

    it("uses the failureLog override so documented event types survive the extraction", async () => {
        mockSendEmail.mockRejectedValueOnce(new Error("boom"));
        await sendAdminAlert({
            ...BASE,
            failureLog: {
                event_type: "refund.failed_alert_email_error",
                entity_type: "refund",
                entity_id: "re_9",
            },
        });
        const logged = mockLog.mock.calls[0][0];
        expect(logged.event_type).toBe("refund.failed_alert_email_error");
        expect(logged.entity_type).toBe("refund");
        expect(logged.entity_id).toBe("re_9");
    });
});
