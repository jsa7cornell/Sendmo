import { test, expect } from "@playwright/test";

test.describe("Auth flow", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept the Supabase OTP (magic link / code) endpoint so no real
    // email is sent. signIn() calls supabase.auth.signInWithOtp → /auth/v1/otp.
    await page.route("**/auth/v1/otp**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      }),
    );
  });

  test("login page renders the sign-in form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /Sign in/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Continue with Google/i }),
    ).toBeVisible();
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Email me a link/i }),
    ).toBeVisible();
  });

  test("shows validation error for empty email", async ({ page }) => {
    await page.goto("/login");

    await page.getByRole("button", { name: /Email me a link/i }).click();
    await expect(
      page.getByText("Please enter a valid email address"),
    ).toBeVisible();
  });

  test("shows confirmation after entering valid email", async ({ page }) => {
    await page.goto("/login");

    await page.getByPlaceholder("you@example.com").fill("test@example.com");
    await page.getByRole("button", { name: /Email me a link/i }).click();

    // Success / check-email state, with the address echoed back.
    await expect(
      page.getByRole("heading", { name: /Check your email/i }),
    ).toBeVisible();
    await expect(page.getByText("test@example.com")).toBeVisible();
  });
});

test.describe("Dashboard requires auth", () => {
  test("redirects unauthenticated users to /login", async ({ page }) => {
    await page.goto("/dashboard");

    // AuthProvider's getSession returns no session → ProtectedRoute redirects.
    await expect(page).toHaveURL(/\/login/);
  });
});
