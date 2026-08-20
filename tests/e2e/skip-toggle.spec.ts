import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// The shared skip control (2026-08-19 PR 2, design brief points 1 and 9).
// These pin the three properties that are easy to regress silently, each of
// which was already broken once while the rest of the suite stayed green:
//   1. Neither option is pre-selected on arrival — prominence moved, the
//      default did not. A boolean-backed control renders "I have it" chosen.
//   2. Deferring DIMS the fields in place; it never removes them. The panel
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

test.describe("skip toggle", () => {
  test.beforeEach(async ({ page }) => {
    await mockEdge(page);
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/full-label\/destination$/);
  });

  test("neither option is pre-selected — the label path gains no click", async ({ page }) => {
    await expect(page.getByRole("radio", { name: "I have it" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("radio", { name: "Sender fills this in" })).toHaveAttribute("aria-checked", "false");
    // …and the form is live and reachable, so typing answers the question
    // without touching the control at all.
    await page.locator("#destination-name").fill("Jane Doe");
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

  test("deferring dims the fields in place — they are never removed", async ({ page }) => {
    const name = page.locator("#destination-name");
    await expect(name).toBeVisible();
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    // Still mounted and visible: the layout must not shift.
    await expect(name).toBeVisible();
    await expect(page.getByRole("radio", { name: "Sender fills this in" })).toHaveAttribute("aria-checked", "true");
  });

  test("the dimmed group is inert, not just faded — keyboard and AT cannot enter it", async ({ page }) => {
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    const inert = await page.locator("#destination-name").evaluate(
      (el) => !!(el as HTMLElement).closest("[inert]"),
    );
    expect(inert, "the deferred field group must carry inert").toBe(true);
  });

  test("the one-time explainer appears on the first skip, then a quiet undo after", async ({ page }) => {
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    await expect(page.getByText(/This is a shipping link now/i)).toBeVisible();

    // Undo, then skip again: the bubble has been seen, so only the link shows.
    await page.getByRole("button", { name: /Undo — answer it yourself/i }).click();
    await expect(page.getByText(/This is a shipping link now/i)).toHaveCount(0);
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    await expect(page.getByText(/This is a shipping link now/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Undo — answer it yourself/i })).toBeVisible();
  });

  test("undo restores the fields without leaving the step", async ({ page }) => {
    await page.locator("#destination-name").fill("Jane Doe");
    await page.getByRole("radio", { name: "Sender fills this in" }).click();
    await page.getByRole("button", { name: /Undo — answer it yourself/i }).click();
    await expect(page).toHaveURL(/\/full-label\/destination$/);
    await expect(page.locator("#destination-name")).toHaveValue("Jane Doe");
    const inert = await page.locator("#destination-name").evaluate(
      (el) => !!(el as HTMLElement).closest("[inert]"),
    );
    expect(inert).toBe(false);
  });
});
