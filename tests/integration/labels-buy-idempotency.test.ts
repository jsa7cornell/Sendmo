import { describe, it, expect } from "vitest";

// PR1 (seller-link launch proposal, decided 2026-08-29): a replayed buy call
// must return the ORIGINAL label idempotently — no second shipments row, no
// EasyPost re-buy, and above all NO refund of a payment whose label stands.
//
// This exercises the deployed labels function end-to-end on the COMP leg,
// which is the one leg drivable without minting a Stripe PI. The payment-
// binding decision table (paid-leg match / mismatch / failed-stitch) is
// unit-tested in tests/unit/buyIdempotency.test.ts; what this adds is proof
// that the wiring returns the same row twice instead of hitting EasyPost.
//
// ⚠️ Hits a real DB + the EasyPost TEST API (TESTING.md layer 2 rules apply —
// verify the target before running). Requires an ADMIN test user:
//   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY   — .env.local
//   SENDMO_ADMIN_TEST_EMAIL / SENDMO_ADMIN_TEST_PASSWORD
// Absent those, the suite skips itself (house pattern: flex-link-api.test.ts).
//
// Run: npx vitest run tests/integration/labels-buy-idempotency.test.ts --config vitest.integration.config.ts

const BASE_URL = process.env.VITE_SUPABASE_URL || "";
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || "";
const ADMIN_EMAIL = process.env.SENDMO_ADMIN_TEST_EMAIL || "";
const ADMIN_PASSWORD = process.env.SENDMO_ADMIN_TEST_PASSWORD || "";

const hasEnv = !!(BASE_URL && ANON_KEY && ADMIN_EMAIL && ADMIN_PASSWORD);
const describeIfEnv = hasEnv ? describe : describe.skip;

async function signInAdmin(): Promise<string> {
    const res = await fetch(`${BASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: ANON_KEY },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (!res.ok) throw new Error(`admin signIn failed: ${res.status}`);
    return (await res.json()).access_token as string;
}

describeIfEnv("labels buy idempotency (comp leg, replay)", () => {
    it("replaying the exact buy body returns the original label, not a refund path", async () => {
        const jwt = await signInAdmin();
        const authed = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
            apikey: ANON_KEY,
        };

        // Step 1: quote (mints the EasyPost test shipment).
        const ratesRes = await fetch(`${BASE_URL}/functions/v1/rates`, {
            method: "POST",
            headers: authed,
            body: JSON.stringify({
                from: { street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107", name: "Idem Test Sender", phone: "4155550100" },
                to: { street1: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105", name: "Idem Test Recipient", phone: "4155550101" },
                parcel: { length: 10, width: 10, height: 10, weight: 80 },
            }),
        });
        expect(ratesRes.ok).toBe(true);
        const rate = (await ratesRes.json()).rates[0];

        const buyBody = JSON.stringify({
            easypost_shipment_id: rate.easypost_shipment_id,
            easypost_rate_id: rate.easypost_rate_id,
            comp: true,
            from_address: { street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107", name: "Idem Test Sender", phone: "4155550100" },
            to_address: { street1: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105", name: "Idem Test Recipient", phone: "4155550101" },
        });

        // Step 2: first buy — the real one.
        const firstRes = await fetch(`${BASE_URL}/functions/v1/labels`, {
            method: "POST", headers: authed, body: buyBody,
        });
        expect(firstRes.ok).toBe(true);
        const first = await firstRes.json();
        expect(first.tracking_number).toBeDefined();
        expect(first.shipment_id).toBeDefined();

        // Step 3: replay the byte-identical body. Must come back 200 with the
        // SAME shipment — flagged as a replay — never a refund or a 500.
        const replayRes = await fetch(`${BASE_URL}/functions/v1/labels`, {
            method: "POST", headers: authed, body: buyBody,
        });
        expect(replayRes.status).toBe(200);
        const replay = await replayRes.json();
        expect(replay.already_purchased).toBe(true);
        expect(replay.shipment_id).toBe(first.shipment_id);
        expect(replay.tracking_number).toBe(first.tracking_number);
        expect(replay.public_code).toBe(first.public_code);
    }, 120000);
});
