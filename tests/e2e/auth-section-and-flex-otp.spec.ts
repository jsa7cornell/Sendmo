/**
 * E2E spec — Auth section redesign (Option A) + flex step 21 Supabase OTP migration
 *
 * Variant axes covered:
 *   auth state   × {unauthenticated, returning-signed-in, post-oauth-with-address}
 *   path         × {full_label, flexible}
 *   flex-step-21 × {supabase-verify-ui, google-skip-via-email-verified}
 *
 * Per PLAYBOOK Rule 19: spec must fail on reverted fix and pass on current code.
 */

import { test, expect, type Page } from "@playwright/test";

const SUPABASE_URL = "https://fkxykvzsqdjzhurntgah.supabase.co";
const SUPABASE_STORAGE_KEY = "sb-fkxykvzsqdjzhurntgah-auth-token";
const FLOW_STORAGE_KEY = "sendmo:recipient_flow:v1";

// ─── Shared mocks ───────────────────────────────────────────

function buildMockSession(email = "john@example.com", fullName = "John Anderson") {
  return {
    access_token: "mock-jwt-access",
    refresh_token: "mock-refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: {
      id: "user-mock-id",
      email,
      user_metadata: { full_name: fullName },
      aud: "authenticated",
      role: "authenticated",
    },
  };
}

/** Intercept Supabase auth + REST endpoints to simulate a signed-in user. */
async function mockAuth(page: Page, session = buildMockSession()) {
  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
    if (route.request().method() === "GET" || route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    }
    return route.continue();
  });

  await page.route(`${SUPABASE_URL}/rest/v1/profiles**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        id: "user-mock-id",
        email: session.user.email,
        full_name: session.user.user_metadata.full_name,
        avatar_url: null,
        role: "user",
        admin_active_mode: "test",
      }]),
    })
  );

  await page.route(`${SUPABASE_URL}/rest/v1/addresses**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
}

/** Inject mock session into localStorage before page load. */
async function injectSession(page: Page, session = buildMockSession()) {
  await page.addInitScript(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: SUPABASE_STORAGE_KEY, value: session }
  );
}

/** Pre-populate recipient flow state in sessionStorage before page load. */
async function injectFlowState(page: Page, overrides: Record<string, unknown> = {}) {
  const base = {
    path: null,
    completedSteps: [0],
    currentStep: 1,
    destinationAddress: { name: "", street: "", city: "", state: "", zip: "", verified: false },
    email: "",
    email_verified: false,
    verification_email: "",
    tried: {},
  };
  await page.addInitScript(
    ({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)),
    { key: FLOW_STORAGE_KEY, value: { ...base, ...overrides } }
  );
}

/** Mock Supabase OTP endpoint (silently accepts any email). */
async function mockOtp(page: Page) {
  await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
  await page.route(`${SUPABASE_URL}/auth/v1/verify**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
}

// ─── Auth section — unauthenticated variants ────────────────

test.describe("Step 1 auth section — unauthenticated", () => {
  test.beforeEach(async ({ page }) => {
    // No auth mocks — user is signed out
    await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: null, session: null }),
      })
    );
    await mockOtp(page);
  });

  test("full_label destination — Google button leads, email input secondary, no 'Your email' label", async ({ page }) => {
    await injectFlowState(page, { path: "full_label", completedSteps: [0] });
    await page.goto("/onboarding/full-label/destination");

    // Google button is present and primary (before the email input in DOM order)
    await expect(page.getByRole("button", { name: /Continue with Google/i })).toBeVisible();

    // "or use your email" divider (not "or type your email" — previous copy)
    await expect(page.getByText(/or use your email/i)).toBeVisible();

    // Email input with new placeholder
    await expect(page.getByPlaceholder("Email address")).toBeVisible();

    // NO old-style "Your email" section heading
    await expect(page.getByText(/^Your email$/i)).not.toBeVisible();

    // No identity pill (not signed in)
    await expect(page.getByText(/We'll send shipping updates to this address/i)).not.toBeVisible();
  });

  test("flexible destination — Google button ALSO present (was previously hidden for flex)", async ({ page }) => {
    await injectFlowState(page, { path: "flexible", completedSteps: [0] });
    await page.goto("/onboarding/flexible/destination");

    // Google button must be visible for flex too — this is the fix
    await expect(page.getByRole("button", { name: /Continue with Google/i })).toBeVisible();
    await expect(page.getByText(/or use your email/i)).toBeVisible();
    await expect(page.getByPlaceholder("Email address")).toBeVisible();
  });

  test("email blur primes OTP for full_label path", async ({ page }) => {
    let otpFired = false;
    await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) => {
      otpFired = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await injectFlowState(page, { path: "full_label", completedSteps: [0] });
    await page.goto("/onboarding/full-label/destination");

    const emailInput = page.getByPlaceholder("Email address");
    await emailInput.fill("test@example.com");
    await emailInput.blur();

    await page.waitForTimeout(300);
    expect(otpFired).toBe(true);
  });

  test("email blur primes OTP for flexible path (was previously skipped)", async ({ page }) => {
    let otpFired = false;
    await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) => {
      otpFired = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await injectFlowState(page, { path: "flexible", completedSteps: [0] });
    await page.goto("/onboarding/flexible/destination");

    const emailInput = page.getByPlaceholder("Email address");
    await emailInput.fill("test@example.com");
    await emailInput.blur();

    await page.waitForTimeout(300);
    expect(otpFired).toBe(true);
  });
});

// ─── Auth section — returning signed-in user ────────────────

test.describe("Step 1 auth section — returning signed-in user", () => {
  test("full_label: identity pill shown, no Google button, no email input", async ({ page }) => {
    const session = buildMockSession("john@example.com", "John Anderson");
    await injectSession(page, session);
    await mockAuth(page, session);
    await injectFlowState(page, { path: "full_label", completedSteps: [0], email: "john@example.com" });

    await page.goto("/onboarding/full-label/destination");

    // Identity pill: avatar initial visible
    await expect(page.getByText("J")).toBeVisible();
    // Name visible
    await expect(page.getByText("John Anderson")).toBeVisible();
    // Email visible
    await expect(page.getByText("john@example.com")).toBeVisible();
    // Checkmark aria-label
    await expect(page.getByLabel("Verified")).toBeVisible();
    // Helper text from pill
    await expect(page.getByText(/We'll send shipping updates to this address/i)).toBeVisible();

    // Google button hidden when signed in
    await expect(page.getByRole("button", { name: /Continue with Google/i })).not.toBeVisible();
    // Email input hidden when signed in
    await expect(page.getByPlaceholder("Email address")).not.toBeVisible();
  });

  test("flexible: identity pill shown, no Google button", async ({ page }) => {
    const session = buildMockSession("john@example.com", "John Anderson");
    await injectSession(page, session);
    await mockAuth(page, session);
    await injectFlowState(page, { path: "flexible", completedSteps: [0], email: "john@example.com" });

    await page.goto("/onboarding/flexible/destination");

    await expect(page.getByText("John Anderson")).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with Google/i })).not.toBeVisible();
    await expect(page.getByPlaceholder("Email address")).not.toBeVisible();
  });
});

// ─── Flex step 21 — Supabase OTP UI ────────────────────────

test.describe("Flex step 21 — Supabase OTP verify (not bespoke email_verifications)", () => {
  const filledAddress = {
    name: "Jane Doe",
    street: "149 New Montgomery St",
    city: "San Francisco",
    state: "CA",
    zip: "94105",
    verified: true,
  };

  test.beforeEach(async ({ page }) => {
    await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: null, session: null }),
      })
    );
    await mockOtp(page);
  });

  test("renders Supabase-style confirm-your-email UI with 6-digit input boxes", async ({ page }) => {
    await injectFlowState(page, {
      path: "flexible",
      completedSteps: [0, 1, 20],
      email: "test@example.com",
      email_verified: false,
      destinationAddress: filledAddress,
    });
    await page.goto("/onboarding/flexible/verify");

    // "Confirm your email" heading — Supabase-style (not "Verify your email" from old bespoke)
    await expect(page.getByRole("heading", { name: /Confirm your email/i })).toBeVisible();

    // Shows the email being confirmed
    await expect(page.getByText("test@example.com")).toBeVisible();

    // 6 individual digit boxes (aria-label pattern "Digit N")
    for (let i = 1; i <= 6; i++) {
      await expect(page.getByLabel(`Digit ${i}`)).toBeVisible();
    }

    // "Verify and continue" button (not old bespoke "Verify" or "Send verification code")
    await expect(page.getByRole("button", { name: /Verify and continue/i })).toBeVisible();

    // OLD bespoke UI elements must NOT be present
    await expect(page.getByRole("button", { name: /^Send verification code$/i })).not.toBeVisible();
  });

  test("resend fires against Supabase OTP endpoint, not bespoke email_verifications", async ({ page }) => {
    let supabaseOtpFired = false;
    await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) => {
      supabaseOtpFired = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    // Ensure no requests go to the Edge Function email action
    await page.route(`${SUPABASE_URL}/functions/v1/email**`, () => {
      throw new Error("Bespoke email_verifications endpoint was called — migration not complete");
    });

    await injectFlowState(page, {
      path: "flexible",
      completedSteps: [0, 1, 20],
      email: "test@example.com",
      email_verified: false,
      destinationAddress: filledAddress,
    });
    await page.goto("/onboarding/flexible/verify");

    await page.getByRole("button", { name: /Resend code/i }).click();
    await page.waitForTimeout(500);

    expect(supabaseOtpFired).toBe(true);
  });

  test("session arrival marks email_verified and auto-advances to step 22", async ({ page }) => {
    // Simulate the email-link path: user arrives with ?confirmed=1 and a session
    const session = buildMockSession("test@example.com", "Test User");
    await injectSession(page, session);
    await mockAuth(page, session);

    await injectFlowState(page, {
      path: "flexible",
      completedSteps: [0, 1, 20],
      email: "test@example.com",
      email_verified: false,
      destinationAddress: filledAddress,
    });

    // Arrive via email link confirmation
    await page.goto("/onboarding/flexible/verify?confirmed=1");

    // "Email verified" success state
    await expect(page.getByRole("heading", { name: /Email verified/i })).toBeVisible({ timeout: 5000 });

    // Auto-advances to step 22 (authorize) within ~2s
    await expect(page).toHaveURL(/\/onboarding\/flexible\/authorize/, { timeout: 4000 });
  });
});

// ─── Flex step 21 skip — Google user ───────────────────────

test.describe("Flex step 21 skip — Google-authed user skips verify", () => {
  test("advancing from step 20 with email_verified=true goes to step 22, not step 21", async ({ page }) => {
    const session = buildMockSession("john@example.com", "John Anderson");
    await injectSession(page, session);
    await mockAuth(page, session);

    // email_verified is true (user picked Google at step 1)
    await injectFlowState(page, {
      path: "flexible",
      completedSteps: [0, 1, 20],
      email: "john@example.com",
      email_verified: true,
      destinationAddress: {
        name: "Jane Doe",
        street: "149 New Montgomery St",
        city: "San Francisco",
        state: "CA",
        zip: "94105",
        verified: true,
      },
    });

    // Start at step 20 (preferences) — already complete, navigate forward
    await page.goto("/onboarding/flexible/preferences");

    // Mock any Edge Function calls preferences might trigger
    await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    // Click continue — RecipientFlowContext.tryAdvance should skip step 21
    await page.getByRole("button", { name: /Continue/i }).first().click();

    // Should land on step 22 (authorize), NOT step 21 (verify)
    await expect(page).toHaveURL(/\/onboarding\/flexible\/authorize/, { timeout: 3000 });
    await expect(page).not.toHaveURL(/\/onboarding\/flexible\/verify/);
  });
});
