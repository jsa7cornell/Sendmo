import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";

// ─── E2E: phone-required step gates ─────────────────────────────────────────
//
// Phone is a hard requirement (FedEx/UPS PHONENUMBEREMPTY). The regression
// class this guards: a step-transition gate that only renders an inline error
// but does NOT block advancement — twice shipped green because the gating
// logic was only unit-tested per-component (d2dde62, b1e6715). These are the
// browser-level proof that the gate actually blocks navigation.
// See proposals/2026-05-20_phone-required-flow-audit.md.
//
// Every Supabase Edge Function call is intercepted and mocked — no auth,
// EasyPost, Google, or Stripe traffic leaves the test.

const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";

// Authenticated storage state, written by tests/e2e/global-setup.ts when the
// E2E_TEST_USER_* credentials are configured. Absent it, the authed describe
// skips itself.
const AUTH_FILE = "playwright/.auth/user.json";
const hasAuthState = existsSync(AUTH_FILE);

async function mockEdgeFunctions(page: Page, opts: { mockAuth?: boolean } = {}) {
  // Address autocomplete — one prediction, enough to verify an address.
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        predictions: [{
          description: "388 Townsend St, San Francisco, CA 94107, USA",
          place_id: "ChIJtest123",
          main_text: "388 Townsend St",
          secondary_text: "San Francisco, CA 94107, USA",
        }],
      }),
    }),
  );
  // Place details — full structured address so the field flips to "Verified".
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ street: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107" }),
    }),
  );
  // Supabase REST — inert (profile / payment-method lookups return empty).
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  // Supabase auth — mocked inert for logged-out specs (the on-blur OTP prime
  // becomes a no-op, no real email sent). Authed specs pass mockAuth:false so
  // the real seeded session's token round-trips against real GoTrue.
  if (opts.mockAuth !== false) {
    await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
  }
}

// Fill a SmartAddressInput and select the first autocomplete result — but do
// NOT touch the phone field; each test controls that itself.
async function verifyAddressNoPhone(page: Page, label: string) {
  await page.locator(`#${label}-address`).fill("388 Townsend");
  const option = page.locator("button", { hasText: /Townsend/i }).first();
  await expect(option).toBeVisible({ timeout: 5000 });
  await option.click();
  await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 5000 });
}

test.describe("phone gate — onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await mockEdgeFunctions(page);
  });

  test("step 1: a blank destination phone blocks Continue; a valid one lets it through", async ({ page }) => {
    await page.goto("/onboarding");
    await page.getByText("Completed Prepaid Label").click();

    await expect(
      page.getByRole("heading", { name: /Where should the package be delivered/i }),
    ).toBeVisible();

    // Everything filled EXCEPT the phone.
    await page.locator("#destination-name").fill("Jane Doe");
    await verifyAddressNoPhone(page, "destination");
    await page.locator("#recipient-email").fill("e2e-phone-gate@example.com");

    // Continue with a blank phone → must be BLOCKED.
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();
    await expect(page.getByText(/Add a phone number/i).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Where should the package be delivered/i }),
    ).toBeVisible();
    // Step 10 must NOT have rendered.
    await expect(page.locator("#origin-name")).not.toBeVisible();

    // Provide a valid phone → Continue now advances to step 10.
    await page.locator("#destination-phone").fill("4155550100");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();
    await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });
  });

  test("step 10: the origin-phone gate controls whether rates are fetched (canFetchRates)", async ({ page }) => {
    // Count rate-fetch requests. canFetchRates must hold the fetch back until
    // BOTH addresses carry a usable phone — audit finding 2. Counting the
    // request is a precise signal: it tests the gate itself, independent of
    // how (or whether) any rate response renders.
    let ratesCalls = 0;
    await page.route(`${SUPABASE_URL}/functions/v1/rates`, (route) => {
      ratesCalls++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rates: [] }),
      });
    });

    await page.goto("/onboarding");
    await page.getByText("Completed Prepaid Label").click();

    // Step 1 — fully valid, including the phone.
    await page.locator("#destination-name").fill("Jane Doe");
    await verifyAddressNoPhone(page, "destination");
    await page.locator("#destination-phone").fill("4155550100");
    await page.locator("#recipient-email").fill("e2e-phone-gate@example.com");
    await page.getByRole("button", { name: /Continue to shipment details/i }).click();

    // Step 10 — fill the origin address + dimensions + weight, but NOT the
    // origin phone.
    await expect(page.locator("#origin-name")).toBeVisible({ timeout: 5000 });
    await page.locator("#origin-name").fill("John Smith");
    await verifyAddressNoPhone(page, "origin");
    await page.getByRole("textbox", { name: "L", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "W", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "H", exact: true }).fill("10");
    await page.getByRole("textbox", { name: "lbs" }).fill("5");

    // Everything is filled EXCEPT the origin phone → canFetchRates is false →
    // no rate fetch fires, even well past the debounce window.
    await page.waitForTimeout(1800);
    expect(ratesCalls, "rates must NOT be fetched without an origin phone").toBe(0);

    // Add the origin phone → canFetchRates passes → a rate fetch fires.
    await page.locator("#origin-phone").fill("4155550142");
    await expect
      .poll(() => ratesCalls, {
        message: "rates should be fetched once the origin phone is present",
        timeout: 8000,
      })
      .toBeGreaterThan(0);
  });
});

test.describe("phone gate — /label-test internal tool", () => {
  // /label-test is a public route (no auth). Mock the Edge Functions its flow
  // hits so no real EasyPost/DB traffic happens.
  test.beforeEach(async ({ page }) => {
    await page.route(`${SUPABASE_URL}/functions/v1/addresses`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          verified: true,
          from_id: "adr_from",
          to_id: "adr_to",
          from_address: { name: "SendMo HQ", street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107", country: "US" },
          to_address: { name: "Jane Doe", street1: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105", country: "US" },
        }),
      }),
    );
    await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
  });

  test("a blank phone is blocked, and a valid phone is threaded into the /rates request", async ({ page }) => {
    // Capture the /rates request body — proves phone is threaded through
    // (audit finding 3: LabelTest used to drop it from getRates/purchaseLabel).
    let ratesBody: { from_address?: { phone?: string }; to_address?: { phone?: string } } | null = null;
    await page.route(`${SUPABASE_URL}/functions/v1/rates`, (route) => {
      ratesBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rates: [] }) });
    });

    await page.goto("/label-test");

    // Pre-fill both addresses (verified, distinct, each seeded with a phone).
    await page.getByRole("button", { name: "Pre-fill Test Data" }).click();

    // ── Gate: clear the From phone → "Get Rates" must be blocked. ──
    await page.locator("#From-phone").fill("");
    await page.getByRole("button", { name: "Get Rates" }).click();
    await expect(page.getByText(/From address needs a phone number/i)).toBeVisible();
    // Must NOT have advanced to the package step.
    await expect(page.getByRole("heading", { name: "Package Details" })).not.toBeVisible();

    // ── Restore the phone → verification proceeds to the package step. ──
    await page.locator("#From-phone").fill("4155550100");
    await page.getByRole("button", { name: "Get Rates" }).click();
    await expect(page.getByRole("heading", { name: "Package Details" })).toBeVisible({ timeout: 5000 });

    // Fill the parcel and request rates.
    await page.getByRole("button", { name: "Pre-fill Test Data" }).click();
    await page.getByRole("button", { name: "See Rates" }).click();

    // The /rates request must carry a phone on BOTH addresses.
    await expect.poll(() => ratesBody, { timeout: 8000 }).not.toBeNull();
    expect(ratesBody!.from_address?.phone, "from_address.phone present in /rates body").toBeTruthy();
    expect(ratesBody!.to_address?.phone, "to_address.phone present in /rates body").toBeTruthy();
  });
});

test.describe("phone gate — dashboard /links/new (authed)", () => {
  // Needs the authenticated storage state from global-setup. Without it (no
  // E2E_TEST_USER_* configured) the whole block skips — see global-setup.ts.
  test.skip(!hasAuthState, "no e2e auth state — set E2E_TEST_USER_EMAIL/PASSWORD (see tests/e2e/global-setup.ts)");
  test.use({ storageState: hasAuthState ? AUTH_FILE : undefined });

  test.beforeEach(async ({ page }) => {
    // mockAuth:false — the seeded session is real; let its token round-trip
    // against real GoTrue so the app stays authenticated.
    await mockEdgeFunctions(page, { mockAuth: false });
    // FlexPaymentStep (the payment step) creates a draft link + a SetupIntent.
    // Keep both inert so merely *reaching* the step has no real side effects.
    await page.route(`${SUPABASE_URL}/functions/v1/links`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "lnk_e2e", short_code: "e2eDRAFT01", status: "draft" }),
      }),
    );
    await page.route(`${SUPABASE_URL}/functions/v1/payment-methods**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ client_secret: "seti_e2e_secret", setup_intent_id: "seti_e2e" }),
      }),
    );
  });

  test("a blank phone blocks 'Continue to payment'; a valid phone reaches the card step", async ({ page }) => {
    await page.goto("/links/new");

    // The editor heading confirms the seeded session worked — ProtectedRoute
    // did NOT bounce us to the login screen.
    await expect(
      page.getByRole("heading", { name: /Create your shipping link/i }),
    ).toBeVisible({ timeout: 10000 });

    // Fill the destination, leaving the phone blank.
    await page.locator("#destination-name").fill("Jane Doe");
    await verifyAddressNoPhone(page, "destination");

    // Blank phone → "Continue to payment" must be blocked.
    await page.getByRole("button", { name: /Continue to payment/i }).click();
    await expect(
      page.getByText(/Add a phone number for the delivery address/i).first(),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: /Add your card/i })).not.toBeVisible();

    // Valid phone → advances to the payment step.
    await page.locator("#destination-phone").fill("4155550100");
    await page.getByRole("button", { name: /Continue to payment/i }).click();
    await expect(page.getByRole("heading", { name: /Add your card/i })).toBeVisible({ timeout: 8000 });
  });
});
