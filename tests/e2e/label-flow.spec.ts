import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// E2E: the /label-test internal tool's happy path — addresses → package →
// rates → rate selection → Payment step.
//
// /label-test is a public route. Every Supabase Edge Function it calls is
// intercepted and mocked; no real EasyPost/Google/DB traffic leaves the test.
// The phone-required gate on this same route is covered separately in
// phone-gate.spec.ts.
//
// Scope stops at the Payment step, deliberately. LabelTest.tsx gained STATE 4
// (Payment) between rate selection and "Label Ready!", and reaching STATE 5
// now requires a real Stripe Elements payment (`onSuccess(paymentIntentId)` →
// `purchaseLabel`). Stripe Elements cannot be driven from the mocked suite —
// CI sets no publishable key — so asserting "Label Ready!" here is asserting a
// state this spec can never reach. Post-payment is the real-service
// buy_label_debug.spec.ts's job (excluded from the default run via testIgnore).
//
// This spec previously asserted "Label Ready!" directly after rate selection
// and had been red since the Payment step landed.


async function mockEdgeFunctions(page: Page) {
  // Address verification — distinct from/to so the "same address" guard passes.
  await page.route(`${SUPABASE_URL}/functions/v1/addresses`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        verified: true,
        from_id: "adr_from",
        to_id: "adr_to",
        from_address: {
          name: "SendMo HQ",
          street1: "388 Townsend St",
          city: "San Francisco",
          state: "CA",
          zip: "94107",
          country: "US",
        },
        to_address: {
          name: "Jane Doe",
          street1: "149 New Montgomery St",
          city: "San Francisco",
          state: "CA",
          zip: "94105",
          country: "US",
        },
      }),
    }),
  );
  // Rates — two options so the cheapest-rate "Best Value" path renders too.
  await page.route(`${SUPABASE_URL}/functions/v1/rates`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rates: [
          {
            carrier: "USPS",
            service: "GroundAdvantage",
            display_price: 9.2,
            delivery_days: 5,
            easypost_shipment_id: "shp_mock123",
            easypost_rate_id: "rate_mock456",
          },
          {
            carrier: "USPS",
            service: "Priority",
            display_price: 12.5,
            delivery_days: 2,
            easypost_shipment_id: "shp_mock123",
            easypost_rate_id: "rate_mock789",
          },
        ],
      }),
    }),
  );
  // Label purchase — frontend-only stub (see file header note).
  await page.route(`${SUPABASE_URL}/functions/v1/labels`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tracking_number: "9400111899223456789012",
        carrier: "USPS",
        service: "GroundAdvantage",
        label_url: "https://easypost.com/labels/mock-label.pdf",
      }),
    }),
  );
  // Autocomplete / place-details — inert; Pre-fill Test Data sets verified
  // addresses directly, but mock them so nothing leaks if a field is touched.
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ predictions: [] }) }),
  );
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

test.describe("Label Test Flow", () => {
  test.beforeEach(async ({ page }) => {
    await mockEdgeFunctions(page);
    await page.goto("/label-test");
  });

  test("completes the mocked flow: addresses → package → rates → select → Payment", async ({ page }) => {
    // ── Step 1: Addresses ──────────────────────────────────────
    await expect(page.getByRole("heading", { name: "Label Test", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Addresses" })).toBeVisible();

    // Pre-fill populates both addresses with verified test data.
    await page.getByRole("button", { name: "Pre-fill Test Data" }).click();
    await expect(page.locator("#From-name")).toHaveValue("SendMo HQ");

    await page.getByRole("button", { name: "Get Rates" }).click();

    // ── Step 2: Package Details ────────────────────────────────
    await expect(page.getByRole("heading", { name: "Package Details" })).toBeVisible();
    await page.getByRole("button", { name: "Pre-fill Test Data" }).click();
    await expect(page.locator("#length")).toHaveValue("10");

    await page.getByRole("button", { name: "See Rates" }).click();

    // ── Step 3: Select a Rate ──────────────────────────────────
    await expect(page.getByRole("heading", { name: "Select a Rate" })).toBeVisible();
    const selectButtons = page.getByRole("button", { name: "Select", exact: true });
    await expect(selectButtons.first()).toBeVisible();
    expect(await selectButtons.count()).toBeGreaterThan(0);
    await selectButtons.first().click();

    // ── Step 4: Payment ────────────────────────────────────────
    // The selected rate ($9.20 Ground Advantage) carries into the payment step,
    // so this asserts the hand-off rather than just that a step rendered. The
    // summary line lives outside StripePaymentForm, so it renders with or
    // without a Stripe publishable key — the "Pay $X & generate label" button
    // does not, and asserting it would make this spec red in CI, which sets no
    // Stripe key.
    await expect(page.getByRole("heading", { name: "Payment", level: 2 })).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/USPS.*\$9\.20/s)).toBeVisible();
  });
});
