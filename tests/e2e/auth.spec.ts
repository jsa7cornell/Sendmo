import { test, expect } from "@playwright/test";

// Helper: mock Supabase auth endpoints so the app doesn't hit real Supabase
function mockSupabaseAuth(page: import("@playwright/test").Page) {
  const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";

  // Mock getSession — return no session (unauthenticated)
  return page.route(`${SUPABASE_URL}/auth/v1/token**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "",
        token_type: "bearer",
        expires_in: 0,
        refresh_token: "",
        user: null,
      }),
    })
  );
}

test.describe("Auth flow", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept the Supabase OTP (magic link) endpoint
    await page.route(
      "**/auth/v1/otp**",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({}),
        })
    );
  });

  test("login page renders magic link form", async ({ page }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("heading", { name: /Sign in/i })
    ).toBeVisible();
    await expect(
      page.getByText("We'll send a magic link to your email")
    ).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Send magic link/i })
    ).toBeVisible();
  });

  test("shows validation error for empty email", async ({ page }) => {
    await page.goto("/login");

    await page.getByRole("button", { name: /Send magic link/i }).click();
    await expect(
      page.getByText("Please enter a valid email address")
    ).toBeVisible();
  });

  test("shows confirmation after entering valid email", async ({ page }) => {
    await page.goto("/login");

    await page.getByPlaceholder("you@example.com").fill("test@example.com");
    await page.getByRole("button", { name: /Send magic link/i }).click();

    // Should show the success / check email state
    await expect(
      page.getByRole("heading", { name: /Check your email/i })
    ).toBeVisible();
    await expect(page.getByText("test@example.com")).toBeVisible();
  });
});

test.describe("Dashboard requires auth", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/dashboard");

    // AuthProvider calls getSession which returns no session,
    // ProtectedRoute should redirect to /login
    await expect(page).toHaveURL(/\/login/);
  });
});
