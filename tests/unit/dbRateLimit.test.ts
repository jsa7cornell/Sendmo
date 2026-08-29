import { describe, it, expect } from "vitest";
import { checkDbRateLimit, type RpcClient } from "../../supabase/functions/_shared/dbratelimit";

// PR2: the DB-backed money-path limiter wrapper. The counting itself lives in
// the rate_limit_hit RPC (migration 046); what this layer owes callers is the
// fail-open contract — a limiter must never take down the buy path.

const clientReturning = (result: { data: unknown; error: { message: string } | null }): RpcClient => ({
    rpc: () => Promise.resolve(result),
});

describe("checkDbRateLimit", () => {
    it("rejects when the RPC says the window is over budget", async () => {
        const r = await checkDbRateLimit(clientReturning({ data: true, error: null }), "ip:1.2.3.4", { max: 5, windowSeconds: 60 });
        expect(r).toEqual({ rejected: true, failedOpen: false, error: null });
    });

    it("allows when the RPC says the window has room", async () => {
        const r = await checkDbRateLimit(clientReturning({ data: false, error: null }), "ip:1.2.3.4", { max: 5, windowSeconds: 60 });
        expect(r).toEqual({ rejected: false, failedOpen: false, error: null });
    });

    it("fails OPEN on an RPC error, and says so", async () => {
        const r = await checkDbRateLimit(clientReturning({ data: null, error: { message: "connection refused" } }), "k", { max: 5, windowSeconds: 60 });
        expect(r.rejected).toBe(false);
        expect(r.failedOpen).toBe(true);
        expect(r.error).toBe("connection refused");
    });

    it("fails OPEN on a thrown RPC, and says so", async () => {
        const throwing: RpcClient = { rpc: () => Promise.reject(new Error("socket hang up")) };
        const r = await checkDbRateLimit(throwing, "k", { max: 5, windowSeconds: 60 });
        expect(r.rejected).toBe(false);
        expect(r.failedOpen).toBe(true);
        expect(r.error).toBe("socket hang up");
    });

    it("treats a non-boolean RPC payload as allow (fail-open shape guard)", async () => {
        const r = await checkDbRateLimit(clientReturning({ data: "yes", error: null }), "k", { max: 5, windowSeconds: 60 });
        expect(r.rejected).toBe(false);
    });
});
