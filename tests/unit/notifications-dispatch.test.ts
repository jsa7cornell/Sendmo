// Executing tests for _shared/notifications.ts dispatchNotifications — unlike
// notifications.test.ts (logic-level assertions over local literals), these
// import and RUN the real function against a mock client.
//
// Regression anchor (2026-08-23, found by the lint-PR code review): the
// failed-send path called `.catch()` on the notifications_log insert builder.
// PostgrestBuilder is a THENABLE, not a Promise — it has no `.catch` — so
// logging a failed send threw TypeError before the insert ran: no
// `status: 'failed'` row, no `notification.email_failed` event. The mock
// insert builder below is deliberately builder-faithful (`then` only, NO
// `catch` property), so reverting the fix fails these tests exactly the way
// production failed. Fix shape: `.then(() => {}, () => {})` (adjustments.ts
// idiom). See LOG 2026-08-23 "Lint debt cleared" entry.
//
// Pattern: same vi.mock-before-import approach as adjustments.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../supabase/functions/_shared/resend.ts", () => ({
    sendEmail: vi.fn(),
}));
vi.mock("../../supabase/functions/_shared/email-templates.ts", () => ({
    trackingUpdateEmail: vi.fn().mockReturnValue({ subject: "s", html: "<p>h</p>" }),
    labelConfirmationEmail: vi.fn().mockReturnValue({ subject: "s", html: "<p>h</p>" }),
    senderLabelReadyEmail: vi.fn().mockReturnValue({ subject: "s", html: "<p>h</p>" }),
}));
vi.mock("../../supabase/functions/_shared/logger.ts", () => ({
    log: vi.fn(),
}));

import { dispatchNotifications } from "../../supabase/functions/_shared/notifications.ts";
import { sendEmail } from "../../supabase/functions/_shared/resend.ts";
import { log } from "../../supabase/functions/_shared/logger.ts";

type InsertedRow = Record<string, unknown>;

function makeMockSupabase(inserts: InsertedRow[]) {
    // Builder-faithful insert: a thenable with NO .catch — matching
    // PostgrestBuilder. The insert only "executes" (row recorded) when the
    // thenable is consumed, mirroring postgrest's lazy fetch-on-then.
    const notifLogChain = {
        select: () => ({
            eq: () => ({
                eq: () => ({
                    eq: () => ({
                        eq: () => ({
                            limit: () => Promise.resolve({ data: [], error: null }),
                        }),
                    }),
                }),
            }),
        }),
        insert: (row: InsertedRow) => ({
            then(
                onResolve?: (v: { error: null }) => unknown,
                onReject?: (e: unknown) => unknown,
            ) {
                inserts.push(row);
                return Promise.resolve({ error: null }).then(onResolve, onReject);
            },
            // NO catch property — do not add one; its absence IS the regression pin.
        }),
    };

    const contactsChain = {
        select: () => ({
            eq: () =>
                Promise.resolve({
                    data: [{ id: "contact-1", role: "recipient", channel: "email", address: "r@example.com" }],
                    error: null,
                }),
        }),
    };

    return {
        from(table: string) {
            if (table === "notification_contacts") return contactsChain;
            if (table === "notifications_log") return notifLogChain;
            throw new Error(`makeMockSupabase: unexpected table '${table}'`);
        },
    } as unknown as Parameters<typeof dispatchNotifications>[0];
}

const CTX = {
    tracking_number: "9400100000000000000000",
    public_code: "ABC123",
    carrier: "USPS",
    tracking_url: "https://sendmo.co/t/ABC123",
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe("dispatchNotifications — failed-send audit trail (the .catch regression pin)", () => {
    it("when the email send throws, writes the status:'failed' row and the email_failed event — and never throws", async () => {
        vi.mocked(sendEmail).mockRejectedValueOnce(new Error("Resend 500"));
        const inserts: InsertedRow[] = [];

        await expect(
            dispatchNotifications(makeMockSupabase(inserts), "ship-1", "in_transit", CTX),
        ).resolves.toBeUndefined();

        const failedRow = inserts.find((r) => r.status === "failed");
        expect(failedRow).toBeDefined();
        expect(failedRow).toMatchObject({
            shipment_id: "ship-1",
            contact_id: "contact-1",
            channel: "email",
            event_type: "in_transit",
            error_message: "Resend 500",
        });
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ event_type: "notification.email_failed", severity: "error" }),
        );
    });

    it("happy path still writes the status:'sent' row", async () => {
        vi.mocked(sendEmail).mockResolvedValueOnce({ id: "email-provider-id" } as never);
        const inserts: InsertedRow[] = [];

        await dispatchNotifications(makeMockSupabase(inserts), "ship-1", "in_transit", CTX);

        expect(inserts.some((r) => r.status === "sent" && r.provider_id === "email-provider-id")).toBe(true);
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ event_type: "notification.email_sent" }),
        );
    });
});
