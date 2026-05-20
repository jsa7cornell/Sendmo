import { test, expect, type Page } from "@playwright/test";

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

async function mockEdgeFunctions(page: Page) {
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
  // Supabase auth + REST — inert so the app boots with no session and the
  // on-blur OTP prime is a no-op (no real email sent).
  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
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
