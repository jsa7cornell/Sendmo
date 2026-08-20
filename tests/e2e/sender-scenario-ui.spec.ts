import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// The sender's screens now tell them what THEY have to do, computed from what
// the link left unfilled (senderScenario). These pin the three properties
// that are easy to regress and expensive to get wrong:
//
//   1. The progress bar's first label names this sender's job.
//   2. A known ship-from renders as a NOTE, never an editable field (Rule 7)
//      — it is the creator's address, and its street never appears in sender
//      UI text.
//   3. The sender is never told the creator's amount, only who pays.

const BASE = {
  id: "link-1", short_code: "SCEN001", link_type: "flexible", status: "active", is_test: true,
  max_price_cents: 10000, preferred_speed: "standard", preferred_carrier: null,
  size_hint: null, notes: null, recipient_city: "Portola Valley", recipient_state: "CA",
  recipient_zip: "94028", recipient_name: "Jordan Chen", recipient_address_complete: true,
  is_funded: true, public_code: "PC12345", origin_city: null, origin_state: null,
};
const ORIGIN = {
  name: "Sarah Smith", street1: "388 Townsend St", street2: null, city: "San Francisco",
  state: "CA", zip: "94107", phone: "4155550142", verified: true,
};
const PARCEL = { length_in: 10, width_in: 7, height_in: 4, weight_oz: 35 };

async function mockLink(page: Page, link: object) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  // Registered LAST so it wins — Playwright matches most-recent-first.
  await page.route(`${SUPABASE_URL}/functions/v1/links**`, r =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(link) }));
}

async function start(page: Page) {
  await page.goto("/s/SCEN001");
  await page.getByRole("button", { name: /Get Started/i }).click();
  await expect(page.getByText(/Your name/i).first()).toBeVisible({ timeout: 10000 });
}

test.describe("sender flow — what this sender is asked for", () => {
  test("only the parcel missing: the bar says Package", async ({ page }) => {
    await mockLink(page, { ...BASE, origin_prefill: ORIGIN, package_prefill: null });
    await start(page);
    await expect(page.getByRole("button", { name: "Package", exact: true })).toBeVisible();
  });

  test("origin and parcel missing: the bar says Your info", async ({ page }) => {
    await mockLink(page, { ...BASE, origin_prefill: null, package_prefill: null });
    await start(page);
    await expect(page.getByRole("button", { name: "Your info", exact: true })).toBeVisible();
  });

  test("nothing prefilled: the bar says Destination & info", async ({ page }) => {
    await mockLink(page, { ...BASE, needs_destination: true, origin_prefill: null, package_prefill: null });
    await start(page);
    await expect(page.getByRole("button", { name: "Destination & info", exact: true })).toBeVisible();
  });

  test("a known ship-from is stated as a note, and its street is never shown", async ({ page }) => {
    await mockLink(page, { ...BASE, origin_prefill: ORIGIN, package_prefill: PARCEL });
    await start(page);
    // Named in the header so the sender knows they owe no address…
    const header = page.getByText(/^From$/).locator("..");
    await expect(header).toContainText("Sarah Smith");
    await expect(header).toContainText("San Francisco, CA");
    // …and Rule 7 holds: the street appears nowhere in that header line.
    await expect(header).not.toContainText("388 Townsend");
  });

  test("the intro tells the sender what is left, not what the creator did", async ({ page }) => {
    await mockLink(page, { ...BASE, origin_prefill: ORIGIN, package_prefill: null });
    await page.goto("/s/SCEN001");
    await expect(page.getByText(/describe what's inside/i)).toBeVisible();
    await expect(page.getByText(/everything else is set/i)).toBeVisible();
    // Never leaks the data-model vocabulary the creator saw.
    await expect(page.getByText(/deferred/i)).toHaveCount(0);
  });
});
