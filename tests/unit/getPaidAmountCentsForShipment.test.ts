/**
 * Unit tests for _shared/paid-amount.ts getPaidAmountCentsForShipment.
 *
 * Regression pinned (Rule 12): refund emails (Email B/C in tracking/index.ts
 * and cron-refund-sweep/index.ts) used to render shipment.rate_cents — that's
 * SendMo's EasyPost cost, ~15%+$1 lower than what the customer actually paid
 * (and receives back). The helper sources the +charge ledger row instead and
 * falls back to rate_cents only when no charge row exists (comp labels,
 * webhook-lag window).
 *
 * Same typed-fake supabase client pattern as getRefundableBalanceForPI.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPaidAmountCentsForShipment } from "../../supabase/functions/_shared/paid-amount.ts";

type MockRowResult = { data: { amount_cents?: number } | null; error: { message: string } | null };

function buildMockClient(result: MockRowResult): SupabaseClient {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  return {
    from: vi.fn().mockReturnValue(chain),
  } as unknown as SupabaseClient;
}

function buildThrowingClient(): SupabaseClient {
  return {
    from: vi.fn().mockImplementation(() => {
      throw new Error("connection refused");
    }),
  } as unknown as SupabaseClient;
}

const PI = "pi_test_abc123";

describe("getPaidAmountCentsForShipment", () => {
  it("charge row found — returns the ledger amount, not the fallback", async () => {
    const client = buildMockClient({ data: { amount_cents: 1595 }, error: null });
    // fallback (rate_cents) is deliberately lower — the exact bug shape:
    // $15.95 paid, $13.02 EasyPost cost.
    expect(await getPaidAmountCentsForShipment(client, PI, 1302)).toBe(1595);
  });

  it("no charge row (webhook-lag window) — returns fallback", async () => {
    const client = buildMockClient({ data: null, error: null });
    expect(await getPaidAmountCentsForShipment(client, PI, 1302)).toBe(1302);
  });

  it("null PI (comp label) — returns fallback without querying", async () => {
    const client = buildMockClient({ data: { amount_cents: 9999 }, error: null });
    expect(await getPaidAmountCentsForShipment(client, null, 1302)).toBe(1302);
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it("query throws — returns fallback (email must still send)", async () => {
    const client = buildThrowingClient();
    expect(await getPaidAmountCentsForShipment(client, PI, 1302)).toBe(1302);
  });

  it("zero/invalid amount on the row — returns fallback", async () => {
    const client = buildMockClient({ data: { amount_cents: 0 }, error: null });
    expect(await getPaidAmountCentsForShipment(client, PI, 1302)).toBe(1302);
  });
});
