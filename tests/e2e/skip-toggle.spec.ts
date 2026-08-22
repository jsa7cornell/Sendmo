import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// The skip controls (2026-08-19 PR 2, design brief points 1 and 9).
//
// There are TWO of them since 2026-08-22. The destination step moved to the
// card-header link — the skip lives on the field group it skips — while the
// origin and package steps still use the shared two-button SkipToggle. This
// file covers both, because every property below was already broken once while
// the rest of the suite stayed green:
//   1. Neither SkipToggle option is pre-selected on arrival — prominence
//      moved, the default did not. A boolean-backed control renders "I have
//      it" chosen.
//   2. A skipped field group DIMS in place; it is never removed. The panel
//      swap this replaces changed the card's height, moving the Continue
//      button out from under the user's cursor.
//   3. The dimmed group is genuinely unreachable (inert), not merely visually
//      faded — otherwise a keyboard or screen-reader user still lands in it.

const AC = { predictions: [{ description: "149 New Montgomery St, San Francisco, CA 94105, USA", place_id: "x", main_text: "149 New Montgomery St", secondary_text: "San Francisco, CA 94105, USA" }] };
const PD = { street: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105" };

async function mockEdge(page: Page) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AC) }));
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PD) }));
}

/**
 * Reach the origin step the cheap way — by skipping the destination. That is
 * itself the fastest assertion that the destination skip advances without a
 * Continue press; every test in the SkipToggle block depends on it.
 */
async function gotoOrigin(page: Page) {
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/full-label\/destination$/);
  await page.getByRole("button", { name: /Sender will fill this in/i }).click();
  await expect(page).toHaveURL(/\/flexible\/origin$/);
}

test.describe("skip toggle — origin and package steps", () => {
  test.beforeEach(async ({ page }) => {
    await mockEdge(page);
    await gotoOrigin(page);
  });

  test("neither option is pre-selected — the label path gains no click", async ({ page }) => {
    await expect(page.getByRole("radio", { name: "I have it" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("radio", { name: "Sender fills this in" })).toHaveAttribute("aria-checked", "false");
    // …and the form is live and reachable, so typing answers the question
    // without touching the control at all.
    await page.locator("#origin-name").fill("John Smith");
    await expect(page.getByRole("radio", { name: "I have it" })).toHaveAttribute("aria-checked", "true");
  });

  test("the link is named by the option itself, and by the caption once chosen", async ({ page }) => {
    // John's decision, 2026-08-19: the handoff's tighter copy. The resting
    // caption does NOT name the shipping link; the option label carries it,
    // and the caption states it the moment the option is taken. This replaces
    // the 2026-08-18 property that the product be named before the user
    // commits — narrowed deliberately, not dropped by drift.
    await expect(page.getByRole("radio", { name: "Sender fills this in" })).toBeVisible();
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    await expect(page.getByText(/shipping link/i).first()).toBeVisible();
  });

  test("skipping announces the product change on the step it lands on", async ({ page }) => {
    // The one-time dark explainer bubble is gone (2026-08-22). It only ever
    // rendered on the destination step, whose skip did not navigate; the
    // origin and package skips always moved the user, so the bubble unmounted
    // before it could be read. The page-level banner does this job instead,
    // and carries the same undo.
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    await expect(page).toHaveURL(/\/flexible\/package$/);
    await expect(page.getByText(/This will be a shipping link, not a label/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Undo skip/i })).toBeVisible();
    await expect(page.getByText(/This is a shipping link now/i)).toHaveCount(0);
  });
});

test.describe("skip link — destination step", () => {
  test.beforeEach(async ({ page }) => {
    await mockEdge(page);
    await gotoOrigin(page);
    // Back to the step we just skipped. This is the only state in which the
    // destination's fields render dimmed — skipping now advances, so there is
    // no dimmed-and-still-here moment on the way forward.
    await page.getByRole("button", { name: "Destination — the sender fills this in" }).click();
    await expect(page).toHaveURL(/\/destination$/);
    // Stale-DOM rule: the URL flips before the outgoing step unmounts, and the
    // exiting step's container still swallows clicks. Wait for it to go.
    await expect(page.locator("#origin-name")).toHaveCount(0);
  });

  test("a skipped destination dims its fields in place — they are never removed", async ({ page }) => {
    await expect(page.locator("#destination-name")).toBeVisible();
    await expect(page.getByRole("button", { name: /Enter it myself/i })).toBeVisible();
  });

  test("the dimmed group is inert, not just faded — keyboard and AT cannot enter it", async ({ page }) => {
    const inert = await page.locator("#destination-name").evaluate(
      (el) => !!(el as HTMLElement).closest("[inert]"),
    );
    expect(inert, "the deferred field group must carry inert").toBe(true);
  });

  test("taking it back restores the fields without leaving the step", async ({ page }) => {
    await page.getByRole("button", { name: /Enter it myself/i }).click();
    await expect(page).toHaveURL(/\/destination$/);
    await expect(page.getByRole("button", { name: /Sender will fill this in/i })).toBeVisible();
    const inert = await page.locator("#destination-name").evaluate(
      (el) => !!(el as HTMLElement).closest("[inert]"),
    );
    expect(inert).toBe(false);
  });
});
