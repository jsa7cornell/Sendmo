import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// A flexible link may now carry the ship-from address its creator already knew
// (2026-08-18), so the sender isn't asked to retype their own address and the
// creator's typing isn't discarded. Seller links deliberately do NOT carry it.
const LINK = {
  id: "link-1", short_code: "PREFIL1", link_type: "flexible", status: "active", is_test: true,
  max_price_cents: 10000, preferred_speed: "standard", preferred_carrier: null,
  size_hint: null, notes: null, recipient_city: "Portola Valley", recipient_state: "CA",
  recipient_zip: "94028", recipient_name: "John Anderson", recipient_address_complete: true,
  is_funded: true, public_code: "PC12345", origin_city: null, origin_state: null,
  package_prefill: null,
};
const ORIGIN = {
  name: "Sarah Smith", street1: "388 Townsend St", street2: null, city: "San Francisco",
  state: "CA", zip: "94107", phone: "4155550142", verified: true,
};

async function mockLink(page: Page, link: object) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // Registered LAST so it wins — Playwright checks routes most-recent-first.
  // With the catch-all winning instead, linkData is {} and a prefill assertion
  // passes vacuously against an empty form.
  await page.route(`${SUPABASE_URL}/functions/v1/links**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(link) }));
}

async function openPackageStep(page: Page) {
  await page.goto("/s/PREFIL1");
  await page.getByRole("button", { name: /Get Started/i }).click();
  // Landmark that exists in BOTH states: a carried address arrives already
  // verified, so SmartAddressInput renders it as a confirmed row rather than an
  // editable field — asserting on the input alone fails for the case that
  // matters most.
  await expect(page.getByText(/Your name/i).first()).toBeVisible({ timeout: 10000 });
}

test.describe("sender ship-from prefill", () => {
  test("uses the address the link creator already knew", async ({ page }) => {
    await mockLink(page, { ...LINK, origin_prefill: ORIGIN });
    await openPackageStep(page);
    // Present either as a confirmed row or a filled field — what matters is
    // that the sender is not asked to retype an address the creator supplied.
    await expect(page.getByText(/388 Townsend St/).first()).toBeVisible();
    await expect(page.getByLabel(/Your name/i)).toHaveValue("Sarah Smith");
  });

  test("leaves the form blank when the link carries nothing", async ({ page }) => {
    await mockLink(page, { ...LINK, origin_prefill: null });
    await openPackageStep(page);
    await expect(page.getByLabel(/Origin address/i)).toHaveValue("");
    await expect(page.getByText(/388 Townsend St/)).toHaveCount(0);
  });
});
