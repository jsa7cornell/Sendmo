import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// The anonymous BUYER flow on a seller link (/s/<code> → BuyerFlow).
// First mocked spec for this surface (PR4 of the seller-link launch);
// later PRs (price band, print gating) extend it.
//
// Every Edge Function is intercepted — no real EasyPost/Stripe/Google/DB
// traffic. Autocomplete/place-details mocks follow phone-gate.spec.ts.

const SELLER_LINK = {
  id: "slink-1", short_code: "SELLE2E9", link_type: "seller_link", status: "active",
  is_test: true, max_price_cents: null, preferred_speed: null, preferred_carrier: null,
  size_hint: null, notes: "Vintage armchair", recipient_name: null, recipient_city: null,
  recipient_state: null, recipient_zip: null, recipient_address_complete: false,
  is_funded: true, public_code: null, origin_city: "San Francisco", origin_state: "CA",
  package_prefill: null, origin_prefill: null, length_in: 20, width_in: 20, height_in: 20,
  weight_hint_oz: 320,
};

async function mockBuyerFlow(page: Page, opts: { rates: unknown[] }, linkOverrides: Record<string, unknown> = {}) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/auth/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      predictions: [{
        description: "149 New Montgomery St, San Francisco, CA 94105, USA",
        place_id: "ChIJbuyer1",
        main_text: "149 New Montgomery St",
        secondary_text: "San Francisco, CA 94105, USA",
      }],
    }) }));
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      street: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105",
    }) }));
  await page.route(`${SUPABASE_URL}/functions/v1/rates**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rates: opts.rates }) }));
  // Registered last so it wins (Playwright checks most-recent-first).
  await page.route(`${SUPABASE_URL}/functions/v1/links**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...SELLER_LINK, ...linkOverrides }) }));
}

async function fillBuyerAddress(page: Page) {
  await page.locator("#destination-name").fill("Pat Buyer");
  await page.locator("#destination-address").fill("149 New Montgomery");
  const option = page.locator("button", { hasText: /New Montgomery/i }).first();
  await expect(option).toBeVisible({ timeout: 5000 });
  await option.click();
  // Wait for place-details to resolve before typing the phone: its async
  // onChange carries the address captured at click time (phone empty) and
  // would overwrite a phone typed in the gap (phone-gate.spec.ts pattern).
  await expect(page.getByText("Verified").first()).toBeVisible({ timeout: 5000 });
  await page.locator("#destination-phone").fill("4155550142");
  await page.locator("#buyer-email").fill("buyer@example.com");
}

test.describe("buyer flow — no shipping options", () => {
  // PR4: the empty-rates copy names the actual cause. The seller-preferences
  // clause renders only when the seller SET a preference; an unconstrained
  // link blames carrier coverage / the platform ceiling instead — never
  // "preferences" the seller never touched, and never only the address.
  test("unconstrained link: carriers/ceiling copy, no phantom seller preferences", async ({ page }) => {
    await mockBuyerFlow(page, { rates: [] });
    await page.goto("/s/SELLE2E9");

    await expect(page.getByRole("heading", { name: /Where should this ship\?/i })).toBeVisible({ timeout: 10000 });
    // The seller's item text is on the first screen.
    await expect(page.getByText("Vintage armchair")).toBeVisible();

    await fillBuyerAddress(page);
    await page.getByRole("button", { name: /See shipping options/i }).click();

    await expect(page.getByRole("heading", { name: /No options for this address/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/No carrier could quote this shipment/i)).toBeVisible();
    await expect(page.getByText(/seller's shipping preferences/i)).toHaveCount(0);
    // The old copy told the buyer to fix a possibly-correct address and
    // nothing else — that framing must not come back.
    await expect(page.getByText(/Double-check it and try again\./)).toHaveCount(0);
  });

  test("constrained link: the seller-preferences copy", async ({ page }) => {
    await mockBuyerFlow(page, { rates: [] }, { preferred_carrier: "USPS", preferred_speed: "standard" });
    await page.goto("/s/SELLE2E9");
    await expect(page.getByRole("heading", { name: /Where should this ship\?/i })).toBeVisible({ timeout: 10000 });
    await fillBuyerAddress(page);
    await page.getByRole("button", { name: /See shipping options/i }).click();

    await expect(page.getByRole("heading", { name: /No options for this address/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/seller's shipping preferences/i)).toBeVisible();
  });
});
