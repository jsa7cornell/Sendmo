// Unit tests for the shared post-response background wrapper
// (supabase/functions/_shared/background.ts).
//
// Added 2026-07-06 with the fire-and-forget-cutoff fix: promises still
// pending when a labels handler returns could be cut off when the isolate
// is reclaimed (the 2026-06-27 label_created email bug class). The wrapper
// hands the promise to EdgeRuntime.waitUntil when available and always
// attaches a catch so a rejection never becomes an unhandled rejection.

import { describe, it, expect, vi, afterEach } from "vitest";
import { runInBackground } from "../../supabase/functions/_shared/background.ts";

type WaitUntilRuntime = { waitUntil: (p: Promise<unknown>) => void };
const g = globalThis as { EdgeRuntime?: WaitUntilRuntime };

afterEach(() => {
    delete g.EdgeRuntime;
    vi.restoreAllMocks();
});

describe("runInBackground", () => {
    it("hands the (guarded) promise to EdgeRuntime.waitUntil when available", () => {
        const waitUntil = vi.fn();
        g.EdgeRuntime = { waitUntil };
        runInBackground(Promise.resolve("ok"), "test_task");
        expect(waitUntil).toHaveBeenCalledTimes(1);
        expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    });

    it("without EdgeRuntime (tests / local serve): does not throw", () => {
        expect(() => runInBackground(Promise.resolve("ok"), "test_task")).not.toThrow();
    });

    it("a rejecting task is caught and logged — never an unhandled rejection", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        runInBackground(Promise.reject(new Error("boom")), "failing_task");
        // Let the microtask queue drain so the catch runs.
        await new Promise((r) => setTimeout(r, 0));
        expect(errSpy).toHaveBeenCalledWith("[background:failing_task]", "boom");
    });

    it("waitUntil receives a promise that resolves even when the task rejects", async () => {
        let captured: Promise<unknown> | null = null;
        g.EdgeRuntime = { waitUntil: (p) => { captured = p; } };
        vi.spyOn(console, "error").mockImplementation(() => {});
        runInBackground(Promise.reject(new Error("boom")), "failing_task");
        await expect(captured).resolves.toBeUndefined();
    });
});
