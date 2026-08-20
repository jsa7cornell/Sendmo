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

// ─── Step 1 carries no identity ─────────────────────────────
//
// This block replaces two describes that asserted the OPPOSITE — a Google
// button, an email field, an identity pill, and an OTP primed on email blur,
// all on the destination step. All of it moved to the Contact step (11) on
// 2026-08-19. These tests are the Rule 19 inverse: they fail if step 1 ever
// grows an identity affordance back.
//
// The reason it matters beyond tidiness: step 1's OAuth return path used to
// auto-advance the flow. A user who signed in mid-address found themselves a
// step further along than they left. Step 1 is now structurally unable to do
// that — it has no auth surface to return from.

test.describe("Step 1 — identity lives at the Contact step, not here", () => {
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

  for (const path of ["full_label", "flexible"] as const) {
    const slug = path === "full_label" ? "full-label" : "flexible";

    test(`${path}: no Google button, no email field, and no OTP is spent`, async ({ page }) => {
      let otpFired = false;
      await page.route(`${SUPABASE_URL}/auth/v1/otp**`, (route) => {
        otpFired = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });

      await injectFlowState(page, { path, completedSteps: [0] });
      await page.goto(`/onboarding/${slug}/destination`);

      await expect(page.locator("#destination-name")).toBeVisible();
      await expect(page.getByRole("button", { name: /Continue with Google/i })).toHaveCount(0);
      await expect(page.getByPlaceholder("Email address")).toHaveCount(0);
      await expect(page.getByText(/or use your email/i)).toHaveCount(0);

      // Filling the address must not send a verification email. Priming an OTP
      // from step 1 burned a send on an address the user might still be
      // editing, and on a flow most users abandon before step 11.
      await page.locator("#destination-name").fill("Jane Doe");
      await page.locator("#destination-name").blur();
      await page.waitForTimeout(300);
      expect(otpFired).toBe(false);
    });
  }

  test("a signed-in user is offered a sign-in prompt, not an identity pill", async ({ page }) => {
    await injectFlowState(page, { path: "full_label", completedSteps: [0] });
    await page.goto("/onboarding/full-label/destination");

    // Signed out: one quiet line, no pill, no avatar, no verified badge.
    await expect(page.getByText(/Returning\?/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /Sign in/i })).toBeVisible();
    await expect(
      page.getByText(/We'll send shipping updates to this address/i),
    ).toHaveCount(0);
  });
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
      email_verified: false,
      destinationAddress: filledAddress,
    });
    await page.goto("/onboarding/flexible/verify");

    // The step opens on the email field since 2026-08-19 — it owns capture as
    // well as verification. The address is prefilled from the draft; sending
    // the code is what reveals the digit grid.
    await expect(page.getByLabel("Email")).toHaveValue("test@example.com");
    await page.getByRole("button", { name: /Send code/i }).click();

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
      email_verified: false,
      destinationAddress: filledAddress,
    });
    await page.goto("/onboarding/flexible/verify");

    // Reach the code phase, then clear the flag so the assertion is about
    // Resend specifically and not about the initial send.
    await page.getByRole("button", { name: /Send code/i }).click();
    await expect(page.getByLabel("Digit 1")).toBeVisible();
    supabaseOtpFired = false;

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
      email_verified: false,
      destinationAddress: filledAddress,
    });

    // Arrive via email link confirmation
    await page.goto("/onboarding/flexible/verify?confirmed=1");

    // The claim is that arriving with a session verifies the email and moves
    // the user on. The "Email verified" panel is a TRANSIENT on the way — it
    // holds for about a second and then auto-advances — so asserting it
    // directly is a race the test loses whenever the step renders quickly.
    // (It did, once the Contact step stopped rendering the OTP grid on this
    // path.) The durable assertion is where the user ends up.
    await expect(page).toHaveURL(/\/onboarding\/flexible\/payment/, { timeout: 6000 });

    // …and that it got there BY verifying, not by skipping the step: the
    // payment screen only renders once step 11 is complete.
    await expect(page.getByRole("heading", { name: /Add your card/i })).toBeVisible();
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
