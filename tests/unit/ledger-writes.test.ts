// Unit tests for the bidirectional ledger writers — H1 of the pre-launch
// P1 build.
//
// Helpers under test:
//   supabase/functions/_shared/ledger.ts
//     - writeLabelCost      (labels function writer, type='label_cost')
//     - writeEasypostRefund (webhooks + tracking writers, type='easypost_refund')
//
// Pattern: same as tests/unit/budget.test.ts (2026-05-23 LOG entry).
// The helpers use `import type { SupabaseClient }` so Vitest's TS transform
// erases the Deno-style remote URL and we can import them directly and feed
// typed mock clients. No real DB or network calls.
//
// Cross-link:
//   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md
//   — §2.1 writer map, B3/B4 blocking fixes, D2 decision list.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    writeLabelCost,
    writeEasypostRefund,
    resolveEasypostRefundAmountCents,
    type LabelCostParams,
    type EasypostRefundParams,
} from "../../supabase/functions/_shared/ledger.ts";

// ─── Mock Supabase client factory ─────────────────────────────────────────
//
// The helpers call exactly one chain: .from('transactions').insert(row).
// The mock returns { error: null } by default (success) or a configurable
// error object to simulate constraint violations and DB errors.

interface InsertResult {
    error: { code?: string; message: string } | null;
}

function mockSupabase(insertResult: InsertResult): Parameters<typeof writeLabelCost>[0]["supabase"] {
    return {
        from: (_table: string) => ({
            insert: (_row: unknown) => Promise.resolve(insertResult),
        }),
    } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];
}

// ─── Shared fixture data ───────────────────────────────────────────────────

const BASE_LABEL_COST_PARAMS: Omit<LabelCostParams, "supabase"> = {
    sessionId: "test-session",
    shipmentId: "shp-uuid-1234",
    userId: "user-uuid-5678",
    linkId: null,
    easypostShipmentId: "shp_abc123",
    rateCents: 850,
    mode: "test",
    isComp: false,
};

const BASE_EP_REFUND_PARAMS: Omit<EasypostRefundParams, "supabase"> = {
    sessionId: "test-session",
    shipmentId: "shp-uuid-1234",
    userId: "user-uuid-5678",
    linkId: null,
    easypostShipmentId: "shp_abc123",
    easypostRefundObjectId: "rfnd_xyz789",
    payloadAmount: 8.50,     // dollar float — parsed to 850¢ (preferred over rateCents when present)
    rateCents: 599,          // distinct from the payload-derived 850 so tests prove which source won
    mode: "test",
    isComp: false,
    source: "tracking_poll",
};

// ─── writeLabelCost tests ──────────────────────────────────────────────────

describe("writeLabelCost", () => {
    it("inserts a row with correct shape and returns ok:true on success", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: (_table: string) => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        const result = await writeLabelCost({ ...BASE_LABEL_COST_PARAMS, supabase });

        expect(result.ok).toBe(true);
        expect(insertedRows).toHaveLength(1);
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.type).toBe("label_cost");
        // amount_cents must be NEGATIVE (SendMo paid EasyPost)
        expect(row.amount_cents).toBe(-850);
        expect(row.idempotency_key).toBe("label_cost_shp_abc123");
        expect(row.shipment_id).toBe("shp-uuid-1234");
        expect(row.mode).toBe("test");
        expect(row.funding_source).toBeNull();
    });

    it("sets funding_source='comp' when isComp=true", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        await writeLabelCost({ ...BASE_LABEL_COST_PARAMS, supabase, isComp: true });

        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.funding_source).toBe("comp");
    });

    it("amount_cents is always negative regardless of input sign", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        // Pass a positive rateCents; should still produce negative amount_cents
        await writeLabelCost({ ...BASE_LABEL_COST_PARAMS, supabase, rateCents: 1200 });
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.amount_cents).toBe(-1200);
        expect((row.amount_cents as number) < 0).toBe(true);
    });

    it("returns ok:true on UNIQUE collision (23505) — idempotency no-op", async () => {
        const supabase = mockSupabase({
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
        });

        const result = await writeLabelCost({ ...BASE_LABEL_COST_PARAMS, supabase });
        // UNIQUE collision = expected safe no-op, not an error
        expect(result.ok).toBe(true);
    });

    it("returns ok:false (but does not throw) on real DB error", async () => {
        const supabase = mockSupabase({
            error: { code: "23502", message: "null value in column violates not-null constraint" },
        });

        const result = await writeLabelCost({ ...BASE_LABEL_COST_PARAMS, supabase });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("not-null");
    });

    it("does not throw when insert rejects (unexpected async error)", async () => {
        const supabase = {
            from: () => ({
                insert: () => Promise.reject(new Error("network error")),
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        // Must not throw — wrapper catches all errors
        const result = await writeLabelCost({ ...BASE_LABEL_COST_PARAMS, supabase });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("network error");
    });

    it("uses live mode when mode='live'", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        await writeLabelCost({ ...BASE_LABEL_COST_PARAMS, supabase, mode: "live" });
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.mode).toBe("live");
    });
});

// ─── writeEasypostRefund tests — tracking poll source ─────────────────────

describe("writeEasypostRefund (tracking poll source)", () => {
    it("inserts a row with correct shape and returns ok:true on success", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        const result = await writeEasypostRefund({ ...BASE_EP_REFUND_PARAMS, supabase });

        expect(result.ok).toBe(true);
        expect(insertedRows).toHaveLength(1);
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.type).toBe("easypost_refund");
        // amount_cents must be POSITIVE (SendMo gains back the label cost)
        expect(row.amount_cents).toBe(850);
        // Idempotency key MUST be keyed on the Refund object id, NOT shipment id
        // (B4 fix from the decided proposal — prevents stale-key re-void gaps)
        expect(row.idempotency_key).toBe("easypost_refund_rfnd_xyz789");
        expect(row.shipment_id).toBe("shp-uuid-1234");
        expect(row.mode).toBe("test");
        expect(row.funding_source).toBeNull();
    });

    it("amount_cents is always positive regardless of input sign", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        // Negative payload amount (shouldn't happen) is rejected by the >0
        // guard and falls back to rateCents; a negative rateCents (also
        // shouldn't happen) is Math.abs'd. Either way: positive cash-in.
        await writeEasypostRefund({ ...BASE_EP_REFUND_PARAMS, supabase, payloadAmount: -8.50, rateCents: -850 });
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.amount_cents).toBe(850);
        expect((row.amount_cents as number) > 0).toBe(true);
    });

    it("idempotency key is anchored on refund object id (not shipment id)", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        const refundId = "rfnd_different_event_456";
        await writeEasypostRefund({
            ...BASE_EP_REFUND_PARAMS,
            supabase,
            easypostRefundObjectId: refundId,
        });
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.idempotency_key).toBe(`easypost_refund_${refundId}`);
        // Must NOT contain the shipment id as the key anchor
        expect(row.idempotency_key).not.toContain("shp-uuid-1234");
    });

    it("returns ok:true on UNIQUE collision (23505) — safe webhook/poll race no-op", async () => {
        const supabase = mockSupabase({
            error: { code: "23505", message: "duplicate key value" },
        });

        const result = await writeEasypostRefund({ ...BASE_EP_REFUND_PARAMS, supabase });
        expect(result.ok).toBe(true);
    });

    it("returns ok:false (but does not throw) on real DB error", async () => {
        const supabase = mockSupabase({
            error: { code: "42P01", message: "relation does not exist" },
        });

        const result = await writeEasypostRefund({ ...BASE_EP_REFUND_PARAMS, supabase });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("does not exist");
    });

    it("sets funding_source='comp' when isComp=true (comp shipment refund)", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        await writeEasypostRefund({ ...BASE_EP_REFUND_PARAMS, supabase, isComp: true });
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.funding_source).toBe("comp");
    });
});

// ─── writeEasypostRefund tests — webhook push source ──────────────────────

describe("writeEasypostRefund (webhook push source)", () => {
    it("uses same idempotency key shape regardless of source", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        await writeEasypostRefund({
            ...BASE_EP_REFUND_PARAMS,
            supabase,
            source: "webhook",
        });
        const row = insertedRows[0] as Record<string, unknown>;
        // Same key shape as the tracking_poll path — this is the whole point of B4:
        // two writers with ONE shared key = exactly one row, whoever lands first.
        expect(row.idempotency_key).toBe("easypost_refund_rfnd_xyz789");
        expect(row.type).toBe("easypost_refund");
        expect(row.amount_cents).toBe(850);
    });

    it("webhook and poll writer for same refund event = UNIQUE collision = no duplicate", async () => {
        // Simulate: webhook writer lands first (success), poll writer lands second
        // (23505 collision). Both calls return ok:true; no second row.
        let insertCount = 0;
        let callCount = 0;
        const supabase = {
            from: () => ({
                insert: (_row: unknown) => {
                    callCount++;
                    if (callCount === 1) {
                        insertCount++;
                        return Promise.resolve({ error: null });
                    }
                    // Second call → collision
                    return Promise.resolve({
                        error: { code: "23505", message: "duplicate key" },
                    });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        // First writer (webhook)
        const r1 = await writeEasypostRefund({
            ...BASE_EP_REFUND_PARAMS,
            supabase,
            source: "webhook",
        });
        // Second writer (tracking_poll, same event)
        const r2 = await writeEasypostRefund({
            ...BASE_EP_REFUND_PARAMS,
            supabase,
            source: "tracking_poll",
        });

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);         // collision is ok — not an error
        expect(insertCount).toBe(1);       // only ONE actual row was inserted
        expect(callCount).toBe(2);         // both tried
    });
});

// ─── resolveEasypostRefundAmountCents — amount-sourcing regressions ────────
//
// Regression tests for the 2026-07-06 0¢-ledger-row incident (YPPY9AK):
// EasyPost Refund objects carry NO amount field, so the fallback path is the
// NORM. The webhook writer used to fall back to 0¢ instead of rate_cents,
// silently under-stating EasyPost credits in the append-only ledger; the
// tracking writer's rate_cents fallback was dead code (column not selected).
// Sourcing now lives here, in the shared helper, under this coverage.

describe("resolveEasypostRefundAmountCents", () => {
    it("uses rate_cents when payload amount is absent — the norm case (YPPY9AK regression)", () => {
        expect(resolveEasypostRefundAmountCents(null, 711)).toBe(711);
        expect(resolveEasypostRefundAmountCents(undefined, 711)).toBe(711);
    });

    it("prefers a positive payload amount over rate_cents, converting dollars to cents", () => {
        expect(resolveEasypostRefundAmountCents(8.5, 599)).toBe(850);
        expect(resolveEasypostRefundAmountCents("8.50", 599)).toBe(850);
    });

    it("treats a zero payload amount as absent — string or number ('0.00' is truthy!)", () => {
        expect(resolveEasypostRefundAmountCents("0.00", 711)).toBe(711);
        expect(resolveEasypostRefundAmountCents("0", 711)).toBe(711);
        expect(resolveEasypostRefundAmountCents(0, 711)).toBe(711);
    });

    it("treats a non-numeric payload amount as absent — NaN must never reach amount_cents", () => {
        expect(resolveEasypostRefundAmountCents("USD 8.50", 711)).toBe(711);
        expect(Number.isFinite(resolveEasypostRefundAmountCents("garbage", null))).toBe(true);
    });

    it("resolves to 0 only when payload amount AND rate_cents are both missing", () => {
        expect(resolveEasypostRefundAmountCents(null, null)).toBe(0);
        expect(resolveEasypostRefundAmountCents(null, undefined)).toBe(0);
    });
});

describe("writeEasypostRefund amount sourcing (via resolve helper)", () => {
    it("inserts rate_cents when the payload has no amount — the webhook 0¢ regression", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        const result = await writeEasypostRefund({
            ...BASE_EP_REFUND_PARAMS,
            supabase,
            payloadAmount: null,   // EasyPost Refund objects carry no amount — every real event
            rateCents: 711,
        });

        expect(result.ok).toBe(true);
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.amount_cents).toBe(711);   // NOT 0 — the old webhook fallback
    });

    it("still writes the row (0¢, ledger completeness) when rate_cents is also missing", async () => {
        const insertedRows: unknown[] = [];
        const supabase = {
            from: () => ({
                insert: (row: unknown) => {
                    insertedRows.push(row);
                    return Promise.resolve({ error: null });
                },
            }),
        } as unknown as Parameters<typeof writeLabelCost>[0]["supabase"];

        const result = await writeEasypostRefund({
            ...BASE_EP_REFUND_PARAMS,
            supabase,
            payloadAmount: null,
            rateCents: null,
        });

        // Row is written (the reconciliation sweep flags live 0¢ rows) and the
        // helper logs a ledger.easypost_refund_zero_amount warn internally.
        expect(result.ok).toBe(true);
        const row = insertedRows[0] as Record<string, unknown>;
        expect(row.amount_cents).toBe(0);
    });
});
