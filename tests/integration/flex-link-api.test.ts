import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Integration tests for the flex link API contract (GET + POST /functions/v1/links).
//
// These are the tests that would have caught the 2026-05-15 regression where
// the links GET handler omitted `street1` from the Supabase select, causing
// `recipient_address_complete` to always be false and blocking every sender.
//
// Requires:
//   VITE_SUPABASE_URL        — set in .env.local
//   VITE_SUPABASE_ANON_KEY   — set in .env.local
//   SENDMO_TEST_EMAIL        — a real Supabase Auth user (magic-link or password)
//   SENDMO_TEST_PASSWORD     — password for the test user
//
// Run: npx vitest run tests/integration/flex-link-api.test.ts

const BASE_URL = process.env.VITE_SUPABASE_URL || "https://fkxykvzsqdjzhurntgah.supabase.co";
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || "";
const TEST_EMAIL = process.env.SENDMO_TEST_EMAIL || "";
const TEST_PASSWORD = process.env.SENDMO_TEST_PASSWORD || "";

const hasAuth = !!(ANON_KEY && TEST_EMAIL && TEST_PASSWORD);
const describeIfAuth = hasAuth ? describe : describe.skip;

// ─── Helpers ────────────────────────────────────────────────

function anonHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ANON_KEY}`,
    apikey: ANON_KEY,
  };
}

function authHeaders(jwt: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
    apikey: ANON_KEY,
  };
}

async function signIn(): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error(`signIn failed: ${res.status}`);
  const data = await res.json();
  return data.access_token as string;
}

// ─── Contract tests: GET /links?code= ───────────────────────
//
// This is the endpoint the SenderFlow calls on every page load.
// These tests assert the response shape — any field omitted from
// the Supabase SELECT will show up here as a test failure.

describe("GET /links?code= — response shape contract", () => {
  it("returns 404 for an unknown short code", async () => {
    if (!ANON_KEY) return;
    const res = await fetch(`${BASE_URL}/functions/v1/links?code=ZZZZ_NOTREAL`, {
      headers: anonHeaders(),
    });
    expect(res.status).toBe(404);
  }, 10000);
});

// ─── Full lifecycle: create → fetch → assert shape ──────────

describeIfAuth("flex link lifecycle (create → fetch)", () => {
  let jwt = "";
  let shortCode = "";

  beforeAll(async () => {
    jwt = await signIn();

    // Create a flex link with a complete address
    const res = await fetch(`${BASE_URL}/functions/v1/links`, {
      method: "POST",
      headers: authHeaders(jwt),
      body: JSON.stringify({
        recipient_address: {
          name: "Integration Test User",
          street1: "388 Townsend St",
          city: "San Francisco",
          state: "CA",
          zip: "94107",
          verified: true,
        },
        speed_preference: "standard",
        preferred_carrier: "any",
        price_cap_dollars: 50,
        size_hint: null,
      }),
    });

    expect(res.ok, `link creation failed: ${res.status}`).toBe(true);
    const data = await res.json();
    shortCode = data.short_code;
    expect(shortCode).toBeTruthy();
  }, 15000);

  // ── The test that would have caught the 2026-05-15 regression ──
  //
  // The bug: links GET selected (name, city, state, zip) but NOT street1.
  // recipient_address_complete checked addr?.street1 → always undefined → always false.
  // Every sender saw "This link's delivery address is incomplete".
  //
  // This test asserts recipient_address_complete === true for a link
  // that genuinely has a full address. It would have failed immediately.
  it("GET returns recipient_address_complete: true for a link with full address", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/links?code=${shortCode}`, {
      headers: anonHeaders(),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();

    // Core shape assertions — any omitted SELECT field surfaces here
    expect(data.short_code).toBe(shortCode);
    expect(data.link_type).toBe("flexible");
    expect(typeof data.max_price_cents).toBe("number");
    expect(typeof data.recipient_city).toBe("string");
    expect(typeof data.recipient_state).toBe("string");
    expect(typeof data.recipient_name).toBe("string");

    // THE REGRESSION CHECK: must be true when street1 is in the DB
    expect(data.recipient_address_complete).toBe(true);

    // Street must NOT be exposed to the sender (privacy)
    expect(data.street1).toBeUndefined();
    expect(data.recipient_street).toBeUndefined();
  }, 15000);

  it("GET returns sender-safe fields only — no full street address", async () => {
    const res = await fetch(`${BASE_URL}/functions/v1/links?code=${shortCode}`, {
      headers: anonHeaders(),
    });
    const data = await res.json();

    // City/state are shown to sender; full street is not
    expect(data.recipient_city).toBe("San Francisco");
    expect(data.recipient_state).toBe("CA");
    expect(data.recipient_name).toBe("Integration Test User");

    // Confirm no raw street in the payload (privacy guard)
    const json = JSON.stringify(data);
    expect(json).not.toContain("388 Townsend");
  }, 15000);

  it("GET returns 410 for a cancelled link", async () => {
    // Cancel the link we created
    await fetch(`${BASE_URL}/functions/v1/links/${shortCode}`, {
      method: "PATCH",
      headers: authHeaders(jwt),
      body: JSON.stringify({ status: "cancelled" }),
    });

    const res = await fetch(`${BASE_URL}/functions/v1/links?code=${shortCode}`, {
      headers: anonHeaders(),
    });
    expect(res.status).toBe(410);
  }, 15000);
});
