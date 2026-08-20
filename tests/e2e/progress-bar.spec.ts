import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// The morph bar (2026-08-19, one step map): SIX fixed segments for every
// flow — Destination / Origin / Package / Shipping / Contact / Payment — and
// a skip turns ONE segment's state in place (aria-label gains "— the sender
// fills this in") while every label and position survives. These pin both the
// 2026-08-18 regression (origin and package must advance the bar separately)
// and the 2026-08-19 one (a skip must morph the bar, not swap segment sets).
// The active segment is asserted via aria-current="step".

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
  await expect(page).toHaveURL(/\/full-label\/origin$/);
}

test.describe("progress bar — one segment per question", () => {
  test.beforeEach(async ({ page }) => {
    await mockEdgeFunctions(page);
  });

  test("six fixed segments; Origin is active on the origin step", async ({ page }) => {
    await reachOriginStep(page);
    for (const label of ["Destination", "Origin", "Package", "Shipping", "Contact", "Payment"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Origin", exact: true }))
      .toHaveAttribute("aria-current", "step");
  });

  test("skipping the origin morphs its segment in place — the bar never swaps sets", async ({ page }) => {
    await reachOriginStep(page);
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    // Stale-DOM rule: the URL flips before the outgoing step unmounts — wait
    // for the origin step's field to be GONE before reading the bar.
    await expect(page.locator("#origin-name")).toHaveCount(0);
    // First skip rewrites the segment to flexible (§2.2).
    await expect(page).toHaveURL(/\/flexible\/package$/);
    await expect(page.getByRole("button", { name: "Package", exact: true }))
      .toHaveAttribute("aria-current", "step");
    // The origin segment reads SKIPPED — new aria-label, same position — and
    // stays clickable (skipping is an answer; clicking it is the way back).
    const skippedOrigin = page.getByRole("button", { name: "Origin — the sender fills this in" });
    await expect(skippedOrigin).toBeVisible();
    await expect(skippedOrigin).toBeEnabled();
    // Every other label survives untouched — nothing added, nothing removed.
    for (const label of ["Destination", "Shipping", "Contact", "Payment"]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
  });

  test("skipping everything: same six segments, two marked skipped, none falsely completed", async ({ page }) => {
    await reachOriginStep(page);
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    await expect(page.locator("#origin-name")).toHaveCount(0);
    // Defer the package too → the shared shipping step, flex mode.
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    await expect(page).toHaveURL(/\/flexible\/shipping$/);
    // The SAME six labels — the morph, not a swap (the 2026-08-19 regression:
    // the old bar rendered a different 4-segment set here).
    await expect(page.getByRole("button", { name: "Shipping", exact: true }))
      .toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("button", { name: "Origin — the sender fills this in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Package — the sender fills this in" })).toBeVisible();
    // Steps ahead are untouched: not completed, not skipped, not clickable.
    await expect(page.getByRole("button", { name: "Contact", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Payment", exact: true })).toBeDisabled();
  });
});
