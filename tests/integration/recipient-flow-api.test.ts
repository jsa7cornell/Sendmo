import { describe, it, expect } from "vitest";

// Integration test: calls real Supabase Edge Functions with EasyPost test mode
// Requires: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local
// These tests hit the production Edge Functions with test API keys

const BASE_URL = process.env.VITE_SUPABASE_URL || "https://fkxykvzsqdjzhurntgah.supabase.co";
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || "";

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ANON_KEY}`,
  };
}

// Skip if no anon key available
const describeIfKey = ANON_KEY ? describe : describe.skip;

describeIfKey("Recipient Flow API Integration", () => {
  it("verifies a valid test address", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/addresses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        street1: "388 Townsend St",
        city: "San Francisco",
        state: "CA",
        zip: "94107",
        name: "Test User",
      }),
    });

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.verified).toBe(true);
  }, 15000);

  it("rejects a clearly invalid address", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/addresses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        street1: "000 Fake Street",
        city: "Nowhere",
        state: "ZZ",
        zip: "00000",
        name: "Bad Address",
      }),
    });

    // Should either return ok:false with verified:false, or a 4xx error
    const data = await res.json();
    // Either the response is not ok, or verified is false
    expect(!res.ok || data.verified === false).toBe(true);
  }, 15000);

  it("fetches rates for a test package", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/rates`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        from: { street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107" },
        to: { street1: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105" },
        parcel: { length: 10, width: 10, height: 10, weight: 80 }, // 80oz = 5lbs
      }),
    });

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.rates).toBeDefined();
    expect(data.rates.length).toBeGreaterThan(0);

    // Each rate should have required fields
    const rate = data.rates[0];
    expect(rate.carrier).toBeDefined();
    expect(rate.service).toBeDefined();
    expect(typeof rate.rate).toBe("number");
    expect(rate.easypost_shipment_id).toBeDefined();
    expect(rate.easypost_rate_id).toBeDefined();
  }, 30000);

  it("returns error for rates with missing fields", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/rates`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        from: { street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107" },
        // Missing "to" and "parcel"
      }),
    });

    // Should not be successful
    expect(res.ok).toBe(false);
  }, 15000);

  // Note: Label purchase test is expensive even in test mode (creates a real test label)
  // Only run this in CI or when explicitly testing the full pipeline
  it.skip("buys a label with a test rate (full pipeline)", async () => {
    // Step 1: Get rates
    const ratesRes = await fetch(`${BASE_URL}/functions/v1/rates`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        from: { street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107", name: "Sender" },
        to: { street1: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105", name: "Recipient" },
        parcel: { length: 10, width: 10, height: 10, weight: 80 },
      }),
    });

    const ratesData = await ratesRes.json();
    const rate = ratesData.rates[0];

    // Step 2: Buy label
    const labelRes = await fetch(`${BASE_URL}/functions/v1/labels`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        easypost_shipment_id: rate.easypost_shipment_id,
        easypost_rate_id: rate.easypost_rate_id,
        from: { street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107", name: "Sender" },
        to: { street1: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105", name: "Recipient" },
      }),
    });

    expect(labelRes.ok).toBe(true);
    const labelData = await labelRes.json();
    expect(labelData.tracking_number).toBeDefined();
    expect(labelData.label_url).toBeDefined();
    expect(labelData.label_url).toContain("http");
  }, 60000);
});
