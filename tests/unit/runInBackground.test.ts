/**
 * Unit tests for _shared/background.ts runInBackground.
 *
 * Regression guard for the 2026-07-06 fee-write cutoff bug: the
 * payment_intent.succeeded arm wrapped the balance-transaction fetch +
 * writeStripeFee in an un-awaited async IIFE. The Supabase edge runtime may
 * reclaim the isolate as soon as the handler's response returns, silently
 * dropping fee_stripe ledger rows — same class as the 2026-06-27
 * label_created email bug. The fix routes the promise through
 * EdgeRuntime.waitUntil when available, with a detached catch fallback under
 * Vitest/Node (no EdgeRuntime global).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runInBackground } from "../../supabase/functions/_shared/background.ts";

type GlobalWithEdgeRuntime = typeof globalThis & {
  EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void };
};

afterEach(() => {
  delete (globalThis as GlobalWithEdgeRuntime).EdgeRuntime;
  vi.restoreAllMocks();
});

describe("runInBackground", () => {
  it("hands the task to EdgeRuntime.waitUntil when available — the fee-write cutoff fix", () => {
    const waitUntil = vi.fn();
    (globalThis as GlobalWithEdgeRuntime).EdgeRuntime = { waitUntil };

    runInBackground(Promise.resolve("ok"), "fee_stripe_write");

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("swallows rejections with a labeled console.error — never an unhandled rejection", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runInBackground(Promise.reject(new Error("bt fetch failed")), "fee_stripe_write");
    // Let the microtask queue drain so the .catch runs.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errSpy).toHaveBeenCalledWith("[background:fee_stripe_write]", "bt fetch failed");
  });

  it("no EdgeRuntime global (tests / local serve) → does not throw", () => {
    expect(() => runInBackground(Promise.resolve(), "fee_stripe_write")).not.toThrow();
  });

  it("waitUntil receives the guarded promise — a rejecting task never rejects into the runtime", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let handed: Promise<unknown> | null = null;
    (globalThis as GlobalWithEdgeRuntime).EdgeRuntime = {
      waitUntil: (p) => {
        handed = p;
      },
    };

    runInBackground(Promise.reject("boom"), "fee_stripe_write");

    expect(handed).not.toBeNull();
    await expect(handed).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith("[background:fee_stripe_write]", "boom");
  });
});
