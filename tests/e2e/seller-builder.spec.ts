import { test, expect, type Page } from "@playwright/test";
import { mockAdminAuth, ADMIN_USER_ID } from "./mock-admin-auth";
import { SUPABASE_URL } from "./supabase-env";

// ─── /sell builder — 2026-08-29 stepped rework (John's second pass) ──────────
//
// Under test:
//   1. the intro is ONE compact line (no hero icon, no "How it works" card),
//   2. step 1 is quantity + ship-from origin (with <SavedAddressPicker>),
//   3. step 2 is its own screen: the sender flow's <SenderStepPackage>
//      (Guestimator + parcel fields) reused as-is,
//   4. review follows, carrying both steps' answers.
//
// Runs under full mocks with the admin session harness: in dev the
// VITE_ENABLE_SELLER_LINK flag is off, and admins are the one audience the
// coming-soon gate lets through (SellerBuilder.tsx gate comment).

const INTRO = /Your buyer picks the shipping speed and pays for it/;

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
  await expect(page.getByRole("heading", { name: "Checkout Link" })).toBeVisible({ timeout: 15_000 });
}

/** Step 1 → step 2 via the saved-address shortcut. */
async function completeSetupStep(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Use a saved address/ }).click();
  await page.getByRole("button", { name: /Mum/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: /What are you shipping\?/ })).toBeVisible();
}

test.describe("Seller builder — stepped rework", () => {
  test("compact intro: one line, no hero, no How-it-works card", async ({ page }) => {
    await openBuilder(page);

    await expect(page.getByText(INTRO)).toBeVisible();
    await expect(page.getByRole("heading", { name: "How it works" })).toHaveCount(0);
    // The old hero subtitle and the "Buyer pays" chip are gone too.
    await expect(page.getByText(/your buyer does the rest/)).toHaveCount(0);
    await expect(page.getByText("Buyer pays")).toHaveCount(0);
  });

  test("step 1 is quantity + origin; the parcel question is NOT on it", async ({ page }) => {
    await openBuilder(page);

    // Link-type copy is John's exact wording (2026-08-29 third pass).
    await expect(page.getByText("I'm shipping just one item")).toBeVisible();
    await expect(page.getByText("Shipping multiple identical items")).toBeVisible();
    await expect(page.getByText("Where does it ship from?")).toBeVisible();
    // The shipping-limit control is removed for now.
    await expect(page.getByText("Set a shipping limit")).toHaveCount(0);
    // Link type renders above the origin card.
    const yQty = (await page.getByRole("button", { name: /Single use/ }).boundingBox())?.y ?? NaN;
    const yOrigin = (await page.getByText("Where does it ship from?").boundingBox())?.y ?? NaN;
    expect(yQty).toBeLessThan(yOrigin);
    // The item step lives on its own screen.
    await expect(page.getByText("Describe it in plain words")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /What are you shipping\?/ })).toHaveCount(0);
  });

  test("step 1 validates the address before advancing", async ({ page }) => {
    await openBuilder(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Please fix these before continuing:")).toBeVisible();
    await expect(page.getByText("Complete ship-from address")).toBeVisible();
    await expect(page.getByRole("heading", { name: /What are you shipping\?/ })).toHaveCount(0);
  });

  test("saved-address shortcut fills the ship-from form", async ({ page }) => {
    await openBuilder(page);

    const trigger = page.getByRole("button", { name: /Use a saved address/ });
    await expect(trigger).toContainText("(2)");
    await trigger.click();
    await page.getByRole("button", { name: /Mum/ }).click();

    await expect(page.getByLabel(/Your name/)).toHaveValue("Mum");
    await expect(page.getByText(/9 Elm Ave/).first()).toBeVisible();
    await expect(page.getByText("Verified").first()).toBeVisible();
  });

  test("step 2 is the sender flow's package step, and review carries both steps", async ({ page }) => {
    await openBuilder(page);
    await completeSetupStep(page);

    // The shared step's signature: describe-first, manual reveal, lbs+oz.
    await expect(page.getByText("Describe it in plain words")).toBeVisible();
    await page.getByRole("button", { name: "or fill in manually" }).click();
    await expect(page.getByText("Packaging type")).toBeVisible();

    await page.getByPlaceholder("L", { exact: true }).fill("12");
    await page.getByPlaceholder("W", { exact: true }).fill("9");
    await page.getByPlaceholder("H", { exact: true }).fill("4");
    await page.getByPlaceholder("lbs").fill("2");
    await page.getByLabel(/Item description/).fill("Vintage armchair");
    await page.getByRole("button", { name: /Review your link/ }).click();

    // Review shows the origin from step 1 and the parcel from step 2.
    await expect(page.getByRole("heading", { name: /Everything look right\?/ })).toBeVisible();
    await expect(page.getByText(/9 Elm Ave/)).toBeVisible();
    await expect(page.getByText(/12″ × 9″ × 4″ · 2 lb/)).toBeVisible();
    await expect(page.getByText("Vintage armchair")).toBeVisible();

    // Back from step 2 returns to step 1 with state intact. The title and
    // intro line render ONLY on step 1 (third-pass feedback).
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("heading", { name: /What are you shipping\?/ })).toBeVisible();
    await expect(page.getByText(INTRO)).toHaveCount(0);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText("I'm shipping just one item")).toBeVisible();
    await expect(page.getByText(INTRO)).toBeVisible();
    await expect(page.getByLabel(/Your name/)).toHaveValue("Mum");
  });
});
