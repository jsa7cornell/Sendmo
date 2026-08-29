import { test, expect, type Page } from "@playwright/test";
import { mockAdminAuth, ADMIN_USER_ID } from "./mock-admin-auth";
import { SUPABASE_URL } from "./supabase-env";

// ─── /sell builder — 2026-08-29 UI rework ────────────────────────────────────
//
// Four changes under test, all requested by John after launch day:
//   1. a "How it works" strip at the top of the page,
//   2. single vs multiple moved above the form,
//   3. the Guestimator and the package fields combined into the shared
//      <ParcelQuestion> (the same one the sender/creator flows use),
//   4. a saved-address shortcut on the ship-from card (<SavedAddressPicker>).
//
// Runs under full mocks with the admin session harness: in dev the
// VITE_ENABLE_SELLER_LINK flag is off, and admins are the one audience the
// coming-soon gate lets through (SellerBuilder.tsx gate comment).

async function openBuilder(page: Page): Promise<void> {
  await mockAdminAuth(page);
  // SavedAddressPicker queries the addresses table on mount; without a mock the
  // request 401s against the real backend and the shortcut hides itself.
  await page.route(`${SUPABASE_URL}/rest/v1/addresses*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "addr-1", name: "E2E Admin", street1: "417 Mission St",
          street2: null, city: "San Francisco", state: "CA", zip: "94105",
          phone: "4155550123", is_verified: true,
          created_at: "2026-08-01T00:00:00.000Z",
          user_id: ADMIN_USER_ID,
        },
        {
          id: "addr-2", name: "Mum", street1: "9 Elm Ave",
          street2: null, city: "Ithaca", state: "NY", zip: "14850",
          phone: "6075550188", is_verified: true,
          created_at: "2026-07-01T00:00:00.000Z",
          user_id: ADMIN_USER_ID,
        },
      ]),
    }),
  );
  await page.goto("/sell");
  // First-paint-under-load convention (onboarding.spec.ts): 15s.
  await expect(page.getByRole("heading", { name: "Sell & Ship" })).toBeVisible({ timeout: 15_000 });
}

test.describe("Seller builder — 2026-08-29 rework", () => {
  test("How it works renders up top, above the availability choice, above the parcel question", async ({ page }) => {
    await openBuilder(page);

    await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
    await expect(page.getByText("Post your link")).toBeVisible();

    // Order on the page: How it works → availability → parcel question →
    // ship-from. Assert by vertical position rather than DOM heuristics.
    const yHow = (await page.getByRole("heading", { name: "How it works" }).boundingBox())?.y ?? NaN;
    const yAvail = (await page.getByText("How many can sell through this link?").boundingBox())?.y ?? NaN;
    const yParcel = (await page.getByText("Describe the product").boundingBox())?.y ?? NaN;
    const yShipFrom = (await page.getByText("Where does it ship from?").boundingBox())?.y ?? NaN;
    expect(yHow).toBeLessThan(yAvail);
    expect(yAvail).toBeLessThan(yParcel);
    expect(yParcel).toBeLessThan(yShipFrom);
  });

  test("parcel question is the shared one: fields collapsed behind the Guestimator until revealed", async ({ page }) => {
    await openBuilder(page);

    // The shared <ParcelQuestion> signature: describe-first, manual reveal.
    await expect(page.getByText("Describe the product")).toBeVisible();
    const reveal = page.getByRole("button", { name: "or fill in manually" });
    await expect(reveal).toBeVisible();
    await expect(page.getByText("Packaging type")).toHaveCount(0);

    await reveal.click();
    await expect(page.getByText("Packaging type")).toBeVisible();
    // The shared component splits weight into pounds + ounces — the old
    // seller-only card had a single lbs field.
    await expect(page.getByText("Pounds")).toBeVisible();
    await expect(page.getByText("Ounces")).toBeVisible();
  });

  test("validation reveals the parcel fields and names what's missing", async ({ page }) => {
    await openBuilder(page);

    await page.getByRole("button", { name: /Review your link/ }).click();
    await expect(page.getByText("Please fix these before continuing:")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: /^Length$/ })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: /^Weight$/ })).toBeVisible();
    // showErrors must reveal the collapsed fields it points at (ParcelQuestion contract).
    await expect(page.getByText("Packaging type")).toBeVisible();
  });

  test("saved-address shortcut lists saved addresses and fills the ship-from form", async ({ page }) => {
    await openBuilder(page);

    const trigger = page.getByRole("button", { name: /Use a saved address/ });
    await expect(trigger).toBeVisible();
    await expect(trigger).toContainText("(2)");

    await trigger.click();
    await page.getByRole("button", { name: /Mum/ }).click();

    // The picker fills the SmartAddressInput with the chosen address: the name
    // field carries the value, and the address renders as the Verified summary.
    await expect(page.getByLabel(/Your name/)).toHaveValue("Mum");
    await expect(page.getByText(/9 Elm Ave/).first()).toBeVisible();
    await expect(page.getByText("Verified").first()).toBeVisible();
  });
});
