// Unit tests for the carrier-adjustment recovery engine — H2 of the
// pre-launch P1 build.
//
// Helpers under test:
//   supabase/functions/_shared/adjustments.ts
//     - resolveRecovery (tiered policy + caps + recharge dispatch)
//
// Pattern: same as tests/unit/budget.test.ts / ledger-writes.test.ts
// (2026-05-23 LOG entries). `import type` in adjustments.ts erases the
// Deno-style URL so Vitest can import directly with a typed mock client.
//
// Cross-link:
//   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
//   §2.4 (tiered policy) + N2 (race) + N5 (email send-site) + Nits (retry counter).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the side-effect modules BEFORE importing adjustments.ts so the
// vi.mock hoisting catches the imports inside resolveRecovery.
vi.mock("../../supabase/functions/_shared/stripe.ts", () => ({
    createAdjustmentRecharge: vi.fn(),
}));
vi.mock("../../supabase/functions/_shared/resend.ts", () => ({
    sendEmail: vi.fn().mockResolvedValue({ id: "test-email-id" }),
}));
vi.mock("../../supabase/functions/_shared/logger.ts", () => ({
    log: vi.fn(),
}));

import {
    resolveRecovery,
    ABSORB_THRESHOLD_CENTS,
    RECHARGE_CEILING_CENTS,
    HANDLING_FEE_CENTS,
    CAP_PER_SHIPMENT_CENTS,
    CAP_PER_CARD_24H_CENTS,
    CAP_PER_USER_7D_CENTS,
    type AdjustmentShipment,
    type AdjustmentPaymentContext,
} from "../../supabase/functions/_shared/adjustments.ts";
import { createAdjustmentRecharge } from "../../supabase/functions/_shared/stripe.ts";

// ─── Mock helpers ─────────────────────────────────────────────────────────

interface MockSupabaseConfig {
    // resolve_recovery_lock RPC return
    rpcResult?: { shipment_lifetime: number; card_24h: number; user_7d: number };
    rpcError?: { code?: string; message: string };
    // carrier_adjustments UPDATE result
    updateError?: { message: string };
    // notifications_log inserts (capture all calls)
    notifLogInserts?: unknown[];
    // notifications_log existing check
    notifExisting?: Array<{ id: string }>;
    // unlocked-fallback transactions read result (for fallback path test)
    unlockedShipmentRows?: Array<{ amount_cents: number }>;
    unlockedUserRows?: Array<{ amount_cents: number }>;
}

function makeMockSupabase(cfg: MockSupabaseConfig = {}) {
    cfg.notifLogInserts = cfg.notifLogInserts ?? [];

    const carrierAdjustmentsChain = {
        update: () => ({
            eq: () =>
                Promise.resolve({ error: cfg.updateError ?? null }),
        }),
    };

    // notifications_log: select (idempotency check) + insert
    const notifLogChain = {
        select: () => ({
            eq: () => ({
                eq: () => ({
                    eq: () => ({
                        limit: () => Promise.resolve({
                            data: cfg.notifExisting ?? [],
                            error: null,
                        }),
                    }),
                }),
            }),
        }),
        insert: (row: unknown) => {
            cfg.notifLogInserts!.push(row);
            return Promise.resolve({ error: null }).then(() => ({}));
        },
    };

    // Add a `.then(...)` so insert chains can be awaited as-is.
    (notifLogChain.insert as unknown as { then: unknown }) = notifLogChain.insert;

    // Unlocked-fallback: transactions table select chains.
    const transactionsChain = {
        select: () => ({
            eq: (col: string) => {
                if (col === "type") {
                    // After type='charge': .eq('user_id').like().gte()
                    return {
                        eq: () => ({
                            like: () => ({
                                gte: () => Promise.resolve({
                                    data: cfg.unlockedUserRows ?? [],
                                    error: null,
                                }),
                            }),
                        }),
                        // .eq('shipment_id') path for per-shipment unlocked fallback
                        // The actual chain: .eq('type','carrier_adjustment').eq('shipment_id', id)
                    };
                }
                // shipment_id path
                return Promise.resolve({
                    data: cfg.unlockedShipmentRows ?? [],
                    error: null,
                });
            },
        }),
    };

    // Re-shape transactionsChain to support both:
    //   .from('transactions').select('amount_cents').eq('type', 'carrier_adjustment').eq('shipment_id', X)
    //   .from('transactions').select('amount_cents').eq('type', 'charge').eq('user_id', U).like(...).gte(...)
    const transactionsChainV2 = {
        select: () => {
            // Track which path via the sequence of .eq calls.
            const eqs: Array<{ col: string; val: unknown }> = [];
            const node: Record<string, unknown> = {
                eq(col: string, val: unknown) {
                    eqs.push({ col, val });
                    return node;
                },
                like() {
                    return node;
                },
                gte() {
                    // Only the user_7d path uses gte.
                    return Promise.resolve({
                        data: cfg.unlockedUserRows ?? [],
                        error: null,
                    });
                },
                then(onResolve: (v: { data: unknown; error: null }) => unknown) {
                    // Auto-resolve when awaited (per-shipment path lacks .like().gte()).
                    return Promise.resolve({
                        data: cfg.unlockedShipmentRows ?? [],
                        error: null,
                    }).then(onResolve);
                },
            };
            return node;
        },
    };

    return {
        from(table: string) {
            if (table === "carrier_adjustments") return carrierAdjustmentsChain;
            if (table === "notifications_log") return notifLogChain;
            if (table === "transactions") return transactionsChainV2;
            throw new Error(`makeMockSupabase: unexpected table '${table}'`);
        },
        rpc(_name: string, _args: unknown) {
            if (cfg.rpcResult) {
                return Promise.resolve({ data: cfg.rpcResult, error: null });
            }
            return Promise.resolve({
                data: null,
                error: cfg.rpcError ?? { code: "PGRST202", message: "Function not found" },
            });
        },
    } as unknown as Parameters<typeof resolveRecovery>[0]["supabase"];
}

const BASE_SHIPMENT: AdjustmentShipment = {
    id: "ship-uuid-1234",
    public_code: "ABC123",
    user_id: "user-uuid-5678",
    carrier: "USPS",
    is_test: true,
    stripe_payment_intent_id: "pi_test_1234",
};

const BASE_PAYMENT_CTX: AdjustmentPaymentContext = {
    payment_method_id: "pm_test_card",
    user_id: "user-uuid-5678",
    customer_id: "cus_test_1234",
};

const BASE_PARAMS = {
    sessionId: "test-session",
    carrierAdjustmentId: "carradj-uuid-9999",
    reasonText: "reweigh",
    trackingUrl: "https://sendmo.co/t/ABC123",
    receiptEmail: "buyer@example.com",
};

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── Tier: absorb (≤ $1) ──────────────────────────────────────────────────

describe("resolveRecovery — absorb tier (≤ $1)", () => {
    it("absorbs delta of exactly $1.00 (100 cents)", async () => {
        const supabase = makeMockSupabase();
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: ABSORB_THRESHOLD_CENTS,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("absorb");
        expect(r.reason).toBe("below_floor");
        expect(r.amount_cents).toBe(0);
        expect(createAdjustmentRecharge).not.toHaveBeenCalled();
    });

    it("absorbs a tiny $0.25 delta", async () => {
        const supabase = makeMockSupabase();
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 25,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("absorb");
        expect(createAdjustmentRecharge).not.toHaveBeenCalled();
    });
});

// ─── Tier: negative delta (carrier credit) ────────────────────────────────

describe("resolveRecovery — negative delta (carrier credit)", () => {
    it("absorbs a negative delta with reason carrier_credit", async () => {
        const supabase = makeMockSupabase();
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: -150,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("absorb");
        expect(r.reason).toBe("carrier_credit");
        expect(createAdjustmentRecharge).not.toHaveBeenCalled();
    });
});

// ─── Tier: recharge ($1.01 – $10) ──────────────────────────────────────────

describe("resolveRecovery — recharge tier ($1.01 – $10)", () => {
    it("recharges delta + $1 fee on $3 delta with no prior caps consumed", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_recharge_xxx",
            status: "succeeded",
            amount: 400,
            currency: "usd",
            client_secret: "",
            capture_method: "automatic",
        });
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
        });

        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 300,
            paymentContext: BASE_PAYMENT_CTX,
        });

        expect(r.decision).toBe("recharge");
        expect(r.amount_cents).toBe(300 + HANDLING_FEE_CENTS);
        expect(createAdjustmentRecharge).toHaveBeenCalledTimes(1);
        const callArgs = (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(callArgs.deltaCents).toBe(300);
        expect(callArgs.attempt).toBe(1);
        expect(callArgs.shipmentId).toBe("ship-uuid-1234");
    });

    it("recharges at the ceiling boundary (exactly $10)", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_x", status: "succeeded", amount: 1100,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: RECHARGE_CEILING_CENTS,  // exactly $10.00
            paymentContext: BASE_PAYMENT_CTX,
        });
        // exactly $10 is the ceiling — still in recharge tier.
        // But per-shipment cap is also $10 — $10 + $1 fee = $11 > cap → blocked.
        // So the result should be flag for shipment_lifetime.
        expect(r.decision).toBe("flag");
        expect(r.blocked_by_cap).toBe("shipment_lifetime");
    });

    it("uses attempt counter in the idempotency key (Nit fix)", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_y", status: "succeeded", amount: 250,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
        });
        await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 150,
            paymentContext: BASE_PAYMENT_CTX,
            attempt: 3,
        });
        const args = (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(args.attempt).toBe(3);
    });

    it("recharge that returns non-succeeded → flag", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_3ds", status: "requires_action", amount: 200,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 200,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("flag");
        expect(r.reason).toContain("recharge_requires_action");
    });

    it("recharge throws (Stripe error) → flag with error reason", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("Stripe API error: card_declined"),
        );
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 500,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("flag");
        expect(r.reason).toContain("recharge_error");
    });
});

// ─── Tier: flag (> $10) ────────────────────────────────────────────────────

describe("resolveRecovery — flag tier (> $10)", () => {
    it("flags any delta over $10", async () => {
        const supabase = makeMockSupabase();
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 1500,                       // $15
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("flag");
        expect(r.reason).toBe("above_ceiling");
        expect(r.amount_cents).toBe(0);
        expect(createAdjustmentRecharge).not.toHaveBeenCalled();
    });
});

// ─── Tier: comp shipment (no PI) → absorb ─────────────────────────────────

describe("resolveRecovery — comp shipment", () => {
    it("absorbs adjustment on a comp shipment regardless of amount", async () => {
        const supabase = makeMockSupabase();
        const compShipment: AdjustmentShipment = {
            ...BASE_SHIPMENT,
            stripe_payment_intent_id: null,
        };
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: compShipment,
            deltaCents: 500,                        // mid-tier, but no PI
            paymentContext: { ...BASE_PAYMENT_CTX, customer_id: null, payment_method_id: null },
        });
        expect(r.decision).toBe("absorb");
        expect(r.reason).toBe("comp_shipment");
        expect(createAdjustmentRecharge).not.toHaveBeenCalled();
    });
});

// ─── Tier: no saved PM → flag ─────────────────────────────────────────────

describe("resolveRecovery — no saved PM", () => {
    it("flags when payment_method_id is null", async () => {
        const supabase = makeMockSupabase();
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 500,
            paymentContext: { ...BASE_PAYMENT_CTX, payment_method_id: null },
        });
        expect(r.decision).toBe("flag");
        expect(r.reason).toBe("no_saved_pm");
        expect(createAdjustmentRecharge).not.toHaveBeenCalled();
    });

    it("flags when customer_id is null", async () => {
        const supabase = makeMockSupabase();
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 500,
            paymentContext: { ...BASE_PAYMENT_CTX, customer_id: null },
        });
        expect(r.decision).toBe("flag");
        expect(r.reason).toBe("no_saved_pm");
    });
});

// ─── Caps: per-shipment lifetime ──────────────────────────────────────────

describe("resolveRecovery — per-shipment $10 cap", () => {
    it("blocks recharge when shipment_lifetime + new amount > $10", async () => {
        // Already $8 recharged, adding $3+$1 fee = $4 would push us to $12 → blocked.
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 800, card_24h: 800, user_7d: 800 },
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 300,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("flag");
        expect(r.blocked_by_cap).toBe("shipment_lifetime");
        expect(createAdjustmentRecharge).not.toHaveBeenCalled();
    });

    it("allows recharge when sums are within cap", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_ok", status: "succeeded", amount: 250,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });
        // $5 prior + $3 + $1 fee = $9 ≤ $10 cap.
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 500, card_24h: 500, user_7d: 500 },
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 300,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("recharge");
    });
});

// ─── Caps: per-card 24h ───────────────────────────────────────────────────

describe("resolveRecovery — per-card 24h $20 cap", () => {
    it("blocks recharge when card_24h sum + new amount > $20", async () => {
        // $19 prior on this card in 24h + $2 + $1 fee = $22 → blocked.
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 1900, user_7d: 1900 },
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 200,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("flag");
        expect(r.blocked_by_cap).toBe("24h_card");
    });
});

// ─── Caps: per-user 7d ────────────────────────────────────────────────────

describe("resolveRecovery — per-user 7d $50 cap", () => {
    it("blocks recharge when user_7d sum + new amount > $50", async () => {
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 4900 },
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 200,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("flag");
        expect(r.blocked_by_cap).toBe("7d_user");
    });
});

// ─── Race-condition guard (N2) ────────────────────────────────────────────
//
// Two concurrent resolveRecovery calls on the same shipment, both arriving
// just under the per-shipment cap. With the RPC lock in place, the second
// call sees the post-first-call sum (returned by the mocked RPC). Without
// the lock (RPC fallback), both calls would see "$0 prior" and both succeed
// in recharging.
//
// In the unit test we simulate the post-lock state where the second call
// sees the first call's recharge in the sum.

describe("resolveRecovery — race-condition guard (N2)", () => {
    it("serializes via the RPC: second call sees the first's recharge in sums", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_first", status: "succeeded", amount: 700,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });

        // First call: clean slate.
        const supabase1 = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
        });
        const r1 = await resolveRecovery({
            supabase: supabase1,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            carrierAdjustmentId: "carradj-1",
            deltaCents: 600,                            // $6 + $1 fee = $7 charged
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r1.decision).toBe("recharge");

        // Second call (post-lock): RPC returns the first recharge's $7 in sums.
        // $7 prior + $5 + $1 fee = $13 → exceeds the $10 per-shipment cap.
        const supabase2 = makeMockSupabase({
            rpcResult: { shipment_lifetime: 700, card_24h: 700, user_7d: 700 },
        });
        const r2 = await resolveRecovery({
            supabase: supabase2,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            carrierAdjustmentId: "carradj-2",
            deltaCents: 500,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r2.decision).toBe("flag");
        expect(r2.blocked_by_cap).toBe("shipment_lifetime");
    });

    it("falls back to unlocked per-shipment path when RPC is missing", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_fb", status: "succeeded", amount: 250,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });
        // RPC unavailable, but per-shipment is $0 (no prior rows) → allowed.
        const supabase = makeMockSupabase({
            rpcError: { code: "PGRST202", message: "Function not found" },
            unlockedShipmentRows: [],
            unlockedUserRows: [],
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 200,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("recharge");
    });

    it("unlocked fallback STILL blocks when per-shipment cap is breached", async () => {
        // Per-shipment is $9 (sum from unlocked transactions read); +$2+$1 = $12 → blocked.
        const supabase = makeMockSupabase({
            rpcError: { code: "PGRST202", message: "n/a" },
            unlockedShipmentRows: [{ amount_cents: -900 }],   // signed; abs(900) = $9
            unlockedUserRows: [],
        });
        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 200,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("flag");
        expect(r.blocked_by_cap).toBe("shipment_lifetime");
    });
});

// ─── Email send (N5) ──────────────────────────────────────────────────────

describe("resolveRecovery — customer email (N5)", () => {
    it("sends carrierAdjustmentEmail after a successful recharge", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_emailtest", status: "succeeded", amount: 300,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
            notifLogInserts: [],
        });

        const r = await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 200,
            paymentContext: BASE_PAYMENT_CTX,
        });
        expect(r.decision).toBe("recharge");
        const { sendEmail } = await import("../../supabase/functions/_shared/resend.ts");
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("does NOT send email if recharge fails", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error("Card declined"),
        );
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
        });
        await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 300,
            paymentContext: BASE_PAYMENT_CTX,
        });
        const { sendEmail } = await import("../../supabase/functions/_shared/resend.ts");
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it("does NOT send email for absorb decisions", async () => {
        const supabase = makeMockSupabase();
        await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 50,                             // absorb
            paymentContext: BASE_PAYMENT_CTX,
        });
        const { sendEmail } = await import("../../supabase/functions/_shared/resend.ts");
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it("dedups emails per carrier_adjustment_id (notifications_log existing)", async () => {
        (createAdjustmentRecharge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: "pi_dup", status: "succeeded", amount: 250,
            currency: "usd", client_secret: "", capture_method: "automatic",
        });
        const supabase = makeMockSupabase({
            rpcResult: { shipment_lifetime: 0, card_24h: 0, user_7d: 0 },
            notifExisting: [{ id: "already-sent" }],
        });
        await resolveRecovery({
            supabase,
            ...BASE_PARAMS,
            shipment: BASE_SHIPMENT,
            deltaCents: 150,
            paymentContext: BASE_PAYMENT_CTX,
        });
        const { sendEmail } = await import("../../supabase/functions/_shared/resend.ts");
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

// ─── Cap thresholds — sanity ──────────────────────────────────────────────

describe("resolveRecovery — cap constants are sane", () => {
    it("CAP_PER_SHIPMENT_CENTS = $10", () => {
        expect(CAP_PER_SHIPMENT_CENTS).toBe(1000);
    });
    it("CAP_PER_CARD_24H_CENTS = $20", () => {
        expect(CAP_PER_CARD_24H_CENTS).toBe(2000);
    });
    it("CAP_PER_USER_7D_CENTS = $50", () => {
        expect(CAP_PER_USER_7D_CENTS).toBe(5000);
    });
    it("HANDLING_FEE_CENTS = $1.00", () => {
        expect(HANDLING_FEE_CENTS).toBe(100);
    });
});
