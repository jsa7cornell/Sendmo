/**
 * Unit tests for _shared/background.ts runInBackground.
 *
 * Pins the FIX-5 contract: post-response async work is handed to
 * EdgeRuntime.waitUntil when the global exists (Supabase edge runtime), and
 * rejections are always caught (no unhandled-rejection crash) whether or not
 * waitUntil is available (Vitest/Node has no EdgeRuntime global).
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
  it("hands the guarded promise to EdgeRuntime.waitUntil when available", () => {
    const waitUntil = vi.fn();
    (globalThis as GlobalWithEdgeRuntime).EdgeRuntime = { waitUntil };

    runInBackground(Promise.resolve("ok"), "test_label");

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("catches rejections with the label (no unhandled rejection), without EdgeRuntime", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    runInBackground(Promise.reject(new Error("boom")), "email_send");
    // Let the microtask queue drain so the .catch runs.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErr).toHaveBeenCalledWith("[background:email_send]", "boom");
  });

  it("catches rejections even when handed to waitUntil (guard is attached first)", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const waitUntil = vi.fn();
    (globalThis as GlobalWithEdgeRuntime).EdgeRuntime = { waitUntil };

    runInBackground(Promise.reject(new Error("late failure")), "dispatch");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErr).toHaveBeenCalledWith("[background:dispatch]", "late failure");
    // The promise given to waitUntil is the guarded one — awaiting it must not throw.
    await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it("stringifies non-Error rejection values", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    runInBackground(Promise.reject("plain string failure"), "misc");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErr).toHaveBeenCalledWith("[background:misc]", "plain string failure");
  });
});
