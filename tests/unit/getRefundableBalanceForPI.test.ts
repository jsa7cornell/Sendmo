/**
 * Unit tests for _shared/refunds.ts getRefundableBalanceForPI.
 *
 * Uses the import type SupabaseClient pattern established 2026-05-23 (budget.test.ts).
 * The module uses a type-only import so Vitest's TS transform erases the Deno-
 * style remote URL, allowing direct import and a typed mock client.
 *
 * Cross-link: decided proposal
 *   proposals/2026-05-21_refund-system-implementation_reviewed-2026-05-21_
 *   decided-2026-05-22.md — B1 fix (per-PI scoping), nit (throw on error).
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRefundableBalanceForPI } from "../../supabase/functions/_shared/refunds.ts";

// ── Helper: build a typed mock supabase client ──────────────────────────────
type MockQueryResult = { data: Array<{ type: string; amount_cents: number }> | null; error: { message: string } | null };

function buildMockClient(result: MockQueryResult): SupabaseClient {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue(result),
  };
  return {
    from: vi.fn().mockReturnValue(chain),
  } as unknown as SupabaseClient;
}

const PI = "pi_test_abc123";

describe("getRefundableBalanceForPI", () => {
  it("full unrefunded charge — returns positive balance", async () => {
    const client = buildMockClient({
      data: [{ type: "charge", amount_cents: 2500 }],
      error: null,
    });
    expect(await getRefundableBalanceForPI(client, PI)).toBe(2500);
  });

  it("partial refund — returns remaining balance", async () => {
    const client = buildMockClient({
      data: [
        { type: "charge", amount_cents: 2500 },
        { type: "refund", amount_cents: -800 },
      ],
      error: null,
    });
    expect(await getRefundableBalanceForPI(client, PI)).toBe(1700);
  });

  it("fully refunded — returns 0", async () => {
    const client = buildMockClient({
      data: [
        { type: "charge", amount_cents: 2500 },
        { type: "refund", amount_cents: -2500 },
      ],
      error: null,
    });
    expect(await getRefundableBalanceForPI(client, PI)).toBe(0);
  });

  it("no charge rows (comp shipment, data=[]) — returns 0", async () => {
    const client = buildMockClient({ data: [], error: null });
    expect(await getRefundableBalanceForPI(client, PI)).toBe(0);
  });

  it("data is null — treats as empty, returns 0", async () => {
    const client = buildMockClient({ data: null, error: null });
    expect(await getRefundableBalanceForPI(client, PI)).toBe(0);
  });

  it("multiple charge rows summed correctly", async () => {
    // Can happen if re-charge after a failed first attempt created two rows.
    const client = buildMockClient({
      data: [
        { type: "charge", amount_cents: 1000 },
        { type: "charge", amount_cents: 500 },
        { type: "refund", amount_cents: -200 },
      ],
      error: null,
    });
    expect(await getRefundableBalanceForPI(client, PI)).toBe(1300);
  });

  it("over-balance scenario — returns value for caller to reject", async () => {
    // The helper just sums; the caller (/refunds endpoint) does the guard.
    const client = buildMockClient({
      data: [{ type: "charge", amount_cents: 1000 }],
      error: null,
    });
    const balance = await getRefundableBalanceForPI(client, PI);
    // Caller rejects if requested amount > balance.
    expect(balance).toBe(1000);
    expect(1500 > balance).toBe(true);
  });

  it("DB error — throws (never silently returns 0)", async () => {
    const client = buildMockClient({
      data: null,
      error: { message: "connection refused" },
    });
    await expect(getRefundableBalanceForPI(client, PI)).rejects.toThrow(
      "refundable-balance lookup failed: connection refused",
    );
  });
});
