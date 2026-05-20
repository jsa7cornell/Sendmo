import { test, expect } from "@playwright/test";

// The hardcoded "2026" PIN gate was removed 2026-05-11 (PLAYBOOK → "Admin
// Mode"). /admin is now gated by requireAdmin() server-side + useAuth().isAdmin
// client-side: signed-out users bounce to /login, signed-in non-admins see an
// "Admin access required" screen.
//
// This mocked spec covers only the signed-out gate — the one branch reachable
// without a real session. Exercising the reporting page itself needs an
// admin-role session (global-setup mints a generic test user, not an admin),
// so that remains a tracked coverage gap (PLAYBOOK → "E2e Testing").

test.describe("Admin page — auth gate", () => {
  test.beforeEach(async ({ page }) => {
    // Keep admin-report inert in case anything reaches it.
    await page.route("**/functions/v1/admin-report**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      }),
    );
  });

  test("signed-out users are redirected from /admin to /login", async ({ page }) => {
    await page.goto("/admin");

    // Admin.tsx renders <Navigate to="/login?redirectTo=/admin" /> when there
    // is no session.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: /Sign in/i })).toBeVisible();
  });
});
