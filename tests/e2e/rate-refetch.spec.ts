import { test, expect } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// The rate fetch moved to its own step (20) when the step maps unified on
// 2026-08-19, which means this step now UNMOUNTS while the user edits the
// parcel upstream. An "already have rates, skip the fetch" short-circuit is
// therefore a wrong-price bug, not an optimisation: the user edits
// 10x10x10 5lb into 30x10x10 40lb, returns, and is quoted — and charged —
// the small-package price. This counts the calls, because the mocked rate
// response is identical either way and only the request proves the refetch.

const AC = { predictions: [{ description: "149 New Montgomery St, San Francisco, CA 94105, USA", place_id: "x", main_text: "149 New Montgomery St", secondary_text: "San Francisco, CA 94105, USA" }] };
const PD = { street: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105" };

test("editing the parcel then returning re-fetches rates", async ({ page }) => {
  let rateCalls = 0;
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AC) }));
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PD) }));
  await page.route(`${SUPABASE_URL}/functions/v1/rates`, (r) => {
    rateCalls++;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rates: [{ carrier: "USPS", service: "Ground Advantage", display_price: 9.2, delivery_days: 5, easypost_shipment_id: "shp_1", easypost_rate_id: "rate_1" }] }) });
  });

  await page.goto("/onboarding");
  await page.locator("#destination-name").fill("Jane Doe");
  await page.locator("#destination-address").fill("149 New Montgomery");
  await page.locator("button", { hasText: /Montgomery/i }).first().click();
  await expect(page.getByText("Verified").nth(0)).toBeVisible({ timeout: 5000 });
  await page.locator("#destination-phone").fill("4155551234");
  await page.getByRole("button", { name: /Continue to shipment details/i }).click();

  await page.locator("#origin-name").fill("John Smith");
  await page.locator("#origin-address").fill("149 New Montgomery");
  await page.locator("button", { hasText: /Montgomery/i }).first().click();
  await page.waitForTimeout(600);
  await page.locator("#origin-phone").fill("4155550142");
  await page.getByRole("button", { name: /Continue to package details/i }).click();

  await page.getByRole("textbox", { name: "L", exact: true }).fill("10");
  await page.getByRole("textbox", { name: "W", exact: true }).fill("10");
  await page.getByRole("textbox", { name: "H", exact: true }).fill("10");
  await page.getByRole("textbox", { name: "lbs" }).fill("5");
  await page.getByRole("button", { name: /Continue to shipping/i }).click();
  await expect(page.getByText("$9.20").first()).toBeVisible({ timeout: 8000 });
  const afterFirst = rateCalls;
  console.log("RATE_CALLS_AFTER_FIRST:", afterFirst);

  // Go back and change the parcel materially.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/full-label\/package$/);
  await page.getByRole("textbox", { name: "L", exact: true }).fill("30");
  await page.getByRole("textbox", { name: "lbs" }).fill("40");
  await page.getByRole("button", { name: /Continue to shipping/i }).click();
  await expect(page).toHaveURL(/\/full-label\/shipping$/);
  await page.waitForTimeout(2500);
  console.log("RATE_CALLS_AFTER_EDIT:", rateCalls);
  expect(rateCalls, "rates must be re-fetched for the edited parcel").toBeGreaterThan(afterFirst);
});
