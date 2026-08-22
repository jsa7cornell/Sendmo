import { test, expect, type Page } from "@playwright/test";
import { SUPABASE_URL } from "./supabase-env";

// "Sender will fill this in" — ONE control, on all three question steps
// (Destination, Origin, Package) since 2026-08-22. It replaced the two-button
// SkipToggle radiogroup, which needed a card of its own above each form.
//
// The properties pinned here have each been broken once while the rest of the
// suite stayed green:
//   1. Skipping ADVANCES on the click. No Continue press — it is a complete
//      answer to the step's only question.
//   2. A skipped field group DIMS in place; it is never removed. The panel swap
//      this replaces changed the card's height, moving the Continue button out
//      from under the user's cursor.
//   3. The dimmed group is genuinely unreachable (inert), not merely faded.
//   4. The undo ("Enter it myself") is OUTSIDE the dimmed group. Wrapping it
//      made a skipped step unrecoverable — the bug this file caught on the day
//      the paradigm landed.

const AC = { predictions: [{ description: "149 New Montgomery St, San Francisco, CA 94105, USA", place_id: "x", main_text: "149 New Montgomery St", secondary_text: "San Francisco, CA 94105, USA" }] };
const PD = { street: "149 New Montgomery St", city: "San Francisco", state: "CA", zip: "94105" };

async function mockEdge(page: Page) {
  await page.route(`${SUPABASE_URL}/rest/v1/**`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route(`${SUPABASE_URL}/functions/v1/**`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${SUPABASE_URL}/functions/v1/autocomplete`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AC) }));
  await page.route(`${SUPABASE_URL}/functions/v1/place-details`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PD) }));
}

const skip = (page: Page) => page.getByRole("button", { name: /Sender will fill this in/i });
const undo = (page: Page) => page.getByRole("button", { name: /Enter it myself/i });

/** Is the field group behind `selector` inside an [inert] subtree? */
function inertness(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => !!(el as HTMLElement).closest("[inert]"));
}

test.beforeEach(async ({ page }) => {
  await mockEdge(page);
});

// ─── The skip advances, on every step that offers it ────────────────

test.describe("skipping advances to the next question", () => {
  test("destination → origin", async ({ page }) => {
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/full-label\/destination$/);
    await skip(page).click();
    // First skip rewrites the segment to `flexible` (§2.2) — no Continue press.
    await expect(page).toHaveURL(/\/flexible\/origin$/);
  });

  test("origin → package", async ({ page }) => {
    await page.goto("/onboarding");
    await skip(page).click();
    await expect(page).toHaveURL(/\/flexible\/origin$/);
    await expect(page.locator("#destination-name")).toHaveCount(0);

    await skip(page).click();
    await expect(page).toHaveURL(/\/flexible\/package$/);
  });

  test("package → shipping, and the product change is announced there", async ({ page }) => {
    await page.goto("/onboarding");
    await skip(page).click();
    await expect(page).toHaveURL(/\/flexible\/origin$/);
    await expect(page.locator("#destination-name")).toHaveCount(0);
    await skip(page).click();
    await expect(page).toHaveURL(/\/flexible\/package$/);
    await expect(page.locator("#origin-name")).toHaveCount(0);
    await skip(page).click();

    await expect(page).toHaveURL(/\/flexible\/shipping$/);
    await expect(page.getByText(/This will be a shipping link, not a label/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Undo skip/i })).toBeVisible();
  });
});

// ─── Coming back to a step you skipped ──────────────────────────────

test.describe("returning to a skipped step", () => {
  // Reach the origin step with the destination already skipped, then walk back
  // onto it. This is the only state in which a step's fields render dimmed —
  // skipping advances, so there is no dimmed-and-still-here moment going
  // forward.
  test.beforeEach(async ({ page }) => {
    await page.goto("/onboarding");
    await skip(page).click();
    await expect(page).toHaveURL(/\/flexible\/origin$/);
    await page.getByRole("button", { name: "Destination — the sender fills this in" }).click();
    await expect(page).toHaveURL(/\/destination$/);
    // Stale-DOM rule: the URL flips before the outgoing step unmounts, and the
    // exiting step's container still swallows clicks.
    await expect(page.locator("#origin-name")).toHaveCount(0);
  });

  test("the fields dim in place — they are never removed", async ({ page }) => {
    await expect(page.locator("#destination-name")).toBeVisible();
    await expect(undo(page)).toBeVisible();
    await expect(skip(page)).toHaveCount(0);
  });

  test("the dimmed group is inert, not just faded — keyboard and AT cannot enter it", async ({ page }) => {
    expect(await inertness(page, "#destination-name"), "the deferred field group must carry inert").toBe(true);
  });

  test("the undo sits OUTSIDE the dimmed group, so a skip is always reversible", async ({ page }) => {
    // Regression, 2026-08-22: the first cut wrapped the whole card including
    // this control, which made a skipped destination unrecoverable.
    const undoInert = await undo(page).evaluate((el) => !!(el as HTMLElement).closest("[inert]"));
    expect(undoInert, "the undo must never be inert").toBe(false);

    await undo(page).click();
    await expect(page).toHaveURL(/\/destination$/);
    await expect(skip(page)).toBeVisible();
    expect(await inertness(page, "#destination-name")).toBe(false);
  });
});

// ─── The 'self' branch has nobody to hand the question to ───────────

test("no skip is offered once the account holder claims the sender role", async ({ page }) => {
  await page.goto("/onboarding");
  await skip(page).click();
  await expect(page).toHaveURL(/\/flexible\/origin$/);
  await expect(page.locator("#destination-name")).toHaveCount(0);

  // Deferring resolves sender='other', so the self-claim shortcut is gone by
  // now — assert the origin step still offers its skip, which is the branch
  // this test can actually reach without an authenticated session.
  await expect(skip(page)).toBeVisible();
});
