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
import { SUPABASE_URL, SUPABASE_STORAGE_KEY } from "./supabase-env";

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

/**
 * Pre-populate recipient flow state before page load.
 *
 * localStorage since 2026-08-18 — the flow moved off sessionStorage so closing
 * the tab no longer destroys everything typed. The stored shape is an envelope
 * ({ data, savedAt }) so drafts can expire; `loadPersisted` still tolerates the
 * old bare shape, but seeding the envelope keeps these specs honest about what
 * the app actually writes.
 */
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
    ({ key, value }) =>
      localStorage.setItem(key, JSON.stringify({ data: value, savedAt: Date.now() })),
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

// ─── Contact step — unauthenticated ─────────────────────────
//
// The Google CTA and the email input lived on step 1 until 2026-08-22. They
// moved to the Contact step, which already existed to CONFIRM the email and
// now also collects it. Step 1 asks where the package goes and nothing else.

/** Flow state that has answered everything up to the Contact step. */
const REACHED_CONTACT = {
  completedSteps: [0, 1, 10, 14, 20],
  deferredDestination: true,
  deferredOrigin: true,
  deferredPackage: true,
};

test.describe("Contact step — unauthenticated", () => {
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

  for (const { path, slug } of [
    { path: "full_label", slug: "full-label" },
    { path: "flexible", slug: "flexible" },
  ]) {
    test(`${path}: Google leads, email input secondary`, async ({ page }) => {
      await injectFlowState(page, { ...REACHED_CONTACT, path });
      await page.goto(`/onboarding/${slug}/verify`);

      await expect(page.getByRole("button", { name: /Continue with Google/i })).toBeVisible();
      await expect(page.getByText(/or use your email/i)).toBeVisible();
      await expect(page.getByPlaceholder("Email address")).toBeVisible();
      await expect(page.getByRole("button", { name: /Send me a code/i })).toBeVisible();

      // The code panel is the SECOND phase — nothing to confirm yet.
      await expect(page.getByLabel("Digit 1")).toHaveCount(0);
    });
  }

  test("sending the code fires Supabase OTP and moves to the code panel", async ({ page }) => {
    // Replaces the old on-blur OTP priming, which fired a mail send for every
    // email the user tabbed past on step 1. The send is now an explicit press.
    let otpFired = false;
    await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) => {
      otpFired = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await injectFlowState(page, { ...REACHED_CONTACT, path: "full_label" });
    await page.goto("/onboarding/full-label/verify");

    await page.getByPlaceholder("Email address").fill("test@example.com");
    await page.getByRole("button", { name: /Send me a code/i }).click();

    await expect(page.getByLabel("Digit 1")).toBeVisible();
    expect(otpFired).toBe(true);
  });

  test("typing an email is not enough to send one", async ({ page }) => {
    let otpFired = false;
    await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) => {
      otpFired = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await injectFlowState(page, { ...REACHED_CONTACT, path: "full_label" });
    await page.goto("/onboarding/full-label/verify");

    const emailInput = page.getByPlaceholder("Email address");
    await emailInput.fill("test@example.com");
    await emailInput.blur();

    await page.waitForTimeout(300);
    expect(otpFired, "blur must not send mail — the button does").toBe(false);
  });
});

// ─── Step 1 collects no identity ────────────────────────────

test.describe("Destination step — no identity UI, signed in or out", () => {
  for (const { path, slug } of [
    { path: "full_label", slug: "full-label" },
    { path: "flexible", slug: "flexible" },
  ]) {
    test(`${path}: no Google button, no email input, no identity pill`, async ({ page }) => {
      const session = buildMockSession("john@example.com", "John Anderson");
      await injectSession(page, session);
      await mockAuth(page, session);
      await injectFlowState(page, { path, completedSteps: [0], email: "john@example.com" });

      await page.goto(`/onboarding/${slug}/destination`);

      // The question this step asks, and its one action.
      await expect(page.locator("#destination-name")).toBeVisible();
      await expect(page.getByRole("button", { name: /Sender will fill this in/i })).toBeVisible();

      // None of the identity UI that used to sit under the address fields.
      await expect(page.getByRole("button", { name: /Continue with Google/i })).not.toBeVisible();
      await expect(page.getByPlaceholder("Email address")).not.toBeVisible();
      await expect(page.getByText(/We'll send shipping updates to this address/i)).not.toBeVisible();
      await expect(page.getByLabel("Verified")).not.toBeVisible();
    });
  }
});

// ─── Flex verify (step 11 since the unified map) — Supabase OTP UI ───

test.describe("Flex verify — Supabase OTP (not bespoke email_verifications)", () => {
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
      completedSteps: [0, 1, 10, 14, 20],
      deferredOrigin: true,
      deferredPackage: true,
      email: "test@example.com",
      verification_email: "test@example.com",
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
      completedSteps: [0, 1, 10, 14, 20],
      deferredOrigin: true,
      deferredPackage: true,
      email: "test@example.com",
      verification_email: "test@example.com",
      email_verified: false,
      destinationAddress: filledAddress,
    });
    await page.goto("/onboarding/flexible/verify");

    await page.getByRole("button", { name: /Resend code/i }).click();
    await page.waitForTimeout(500);

    expect(supabaseOtpFired).toBe(true);
  });

  test("session arrival marks email_verified and auto-advances to the payment step", async ({ page }) => {
    // Simulate the email-link path: user arrives with ?confirmed=1 and a session
    const session = buildMockSession("test@example.com", "Test User");
    await injectSession(page, session);
    await mockAuth(page, session);

    await injectFlowState(page, {
      path: "flexible",
      completedSteps: [0, 1, 10, 14, 20],
      deferredOrigin: true,
      deferredPackage: true,
      email: "test@example.com",
      verification_email: "test@example.com",
      email_verified: false,
      destinationAddress: filledAddress,
    });

    // Arrive via email link confirmation
    await page.goto("/onboarding/flexible/verify?confirmed=1");

    // "Email verified" success state
    await expect(page.getByRole("heading", { name: /Email verified/i })).toBeVisible({ timeout: 5000 });

    // Auto-advances to step 22 (authorize) — the component arms a 1s timer.
    //
    // The budget is deliberately generous. The property under test is THAT it
    // advances, not that it advances inside four seconds, and 4000ms left only
    // ~3s of slack after the 1s timer — which this test spent under 4-way
    // parallel load, flaking three times on 2026-08-22 while passing in
    // isolation every time. Tightening it back tests the runner, not the app.
    await expect(page).toHaveURL(/\/onboarding\/flexible\/payment/, { timeout: 15_000 });
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
      completedSteps: [0, 1, 10, 14, 20],
      deferredOrigin: true,
      deferredPackage: true,
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

    // Start at step 20 (shipping — flex mode). The old `preferences` slug is
    // deliberately used here: it must redirect to `shipping` (retired-slug
    // table) and keep working.
    await page.goto("/onboarding/flexible/preferences");
    await expect(page).toHaveURL(/\/onboarding\/flexible\/shipping/, { timeout: 3000 });

    // Mock any Edge Function calls preferences might trigger
    await page.route(`${SUPABASE_URL}/functions/v1/**`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    // Click continue — RecipientFlowContext.tryAdvance should skip the verify
    // step (11) because the session email is already confirmed
    await page.getByRole("button", { name: /Continue/i }).first().click();

    // Should land on the payment step (12 — old flex `authorize`), NOT verify
    await expect(page).toHaveURL(/\/onboarding\/flexible\/payment/, { timeout: 3000 });
    await expect(page).not.toHaveURL(/\/onboarding\/flexible\/verify/);
  });
});
