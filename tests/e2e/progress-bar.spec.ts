import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// One segment per question (2026-08-18). The regression these pin: origin (10)
// and package (14) shared a "Shipment Details" segment, so completing the
// origin step advanced the bar by NOTHING — the exact complaint that produced
// the change. The bar's active segment is asserted via aria-current="step".

const MOCK_AUTOCOMPLETE = {
  predictions: [
    {
      description: "149 New Montgomery St, San Francisco, CA 94105, USA",
      place_id: "ChIJtest456",
      main_text: "149 New Montgomery St",
      secondary_text: "San Francisco, CA 94105, USA",
    },
  ],
};

const MOCK_PLACE_DETAILS = {
  street: "149 New Montgomery St",
  city: "San Francisco",
  state: "CA",
  zip: "94105",
};

async function mockEdgeFunctions(page: Page) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // Specific routes registered last — Playwright matches most-recent-first;
  // a catch-all registered after them would win and the assertions would pass
  // vacuously (see sender-origin-prefill.spec.ts).
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_AUTOCOMPLETE) }));
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_PLACE_DETAILS) }));
}

async function reachOriginStep(page: Page) {
  await page.goto("/onboarding");
  // /onboarding resolves straight to the destination step (no picker, 2026-08-18)
  await expect(page).toHaveURL(/\/full-label\/destination$/);
  await page.locator("#destination-name").fill("Jane Doe");
  const input = page.locator("#destination-address");
  await input.fill("149 New Montgomery");
  await page.locator("button", { hasText: /Montgomery/i }).first().click();
  await expect(page.getByText("Verified").nth(0)).toBeVisible({ timeout: 5000 });
  await page.locator("#destination-phone").fill("4155551234");
  await page.locator("#recipient-email").fill("test@example.com");
  await page.getByRole("button", { name: /Continue to shipment details/i }).click();
  await expect(page).toHaveURL(/\/full-label\/shipping$/);
}

test.describe("progress bar — one segment per question", () => {
  test.beforeEach(async ({ page }) => {
    await mockEdgeFunctions(page);
  });

  test("full-label shows 5 segments and Origin is active on the shipping step", async ({ page }) => {
    await reachOriginStep(page);
    for (const label of ["Destination", "Origin", "Package & Shipping", "Payment", "Label"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Origin", exact: true }))
      .toHaveAttribute("aria-current", "step");
  });

  test("advancing origin → package advances the bar — the regression", async ({ page }) => {
    await reachOriginStep(page);
    await page.getByRole("button", { name: /The sender will fill this in/ }).click();
    // Stale-DOM rule: the URL flips before the outgoing step unmounts — wait
    // for the origin step's field to be GONE before reading the bar.
    await expect(page.locator("#origin-name")).toHaveCount(0);
    await expect(page).toHaveURL(/\/full-label\/package$/);
    await expect(page.getByRole("button", { name: "Package & Shipping", exact: true }))
      .toHaveAttribute("aria-current", "step");
    // And the origin segment now reads completed (clickable to go back).
    await expect(page.getByRole("button", { name: "Origin", exact: true })).toBeEnabled();
  });

  test("flex path shows its own 4 segments, none falsely completed after deferrals", async ({ page }) => {
    await reachOriginStep(page);
    await page.getByRole("button", { name: /The sender will fill this in/ }).click();
    await expect(page.locator("#origin-name")).toHaveCount(0);
    // Defer the package too → flexible path, preferences step.
    await page.getByRole("button", { name: /The sender will fill this in/ }).click();
    await expect(page).toHaveURL(/\/flexible\/preferences$/);
    for (const label of ["Destination", "Preferences", "Save Card", "Share Link"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Preferences", exact: true }))
      .toHaveAttribute("aria-current", "step");
    // Steps 10 + 14 are complete in flow state, but they are NOT flex steps —
    // their indexes must not light flex segments the user has never seen.
    await expect(page.getByRole("button", { name: "Save Card", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Share Link", exact: true })).toBeDisabled();
  });
});
