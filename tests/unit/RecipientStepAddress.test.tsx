import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ─── Regression guard: OAuth auto-advance must respect validation ───────────
//
// RecipientStepAddress has a convenience auto-advance: when a user returns
// from Google OAuth (user transitions null→present) on a ready destination
// step, it shows "Continuing…" and 2s later calls onContinue().
//
// Bug (2026-05-19): the auto-advance guard checked a hand-picked subset of
// address fields (street/city/state/zip) instead of the real step-1
// validation. When the phone requirement landed, an OAuth return with no
// phone fired the auto-advance → tryAdvance(1) silently rejected → the
// "Continuing…" spinner spun forever.
//
// Fix: the guard gates on `errors.length === 0` — the same getValidationErrors
// output tryAdvance checks. These tests pin that behavior so the guard can't
// drift from validation again.

let mockUser: { email: string; user_metadata?: Record<string, unknown> } | null = null;

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
}));

// Supabase: the component's prefill effect queries addresses + profiles.
// Return null everywhere so prefill is an inert no-op.
vi.mock("@/lib/supabase", () => {
  const nullResult = Promise.resolve({ data: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => nullResult,
    single: () => nullResult,
  };
  return {
    supabase: {
      from: () => chain,
      auth: {
        signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: null }),
        signInWithOAuth: vi.fn().mockResolvedValue({ data: {}, error: null }),
      },
    },
  };
});

import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import { emptyAddress } from "@/lib/utils";

const completeAddress = {
  ...emptyAddress(),
  name: "Pat Smith",
  street: "1 Main St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
  phone: "4155550100",
  verified: true,
};

function renderStep(errors: string[], onContinue: () => void) {
  const props = {
    address: completeAddress,
    email: "pat@example.com",
    path: "flexible" as const,
    sender: null,
    errors,
    tried: false,
    onAddressChange: () => {},
    onEmailChange: () => {},
    onSenderResolved: () => {},
    onContinue,
    onBack: () => {},
  };
  // makeUi() must produce a FRESH element each call. Re-rendering with the
  // identical element reference makes React bail out of reconciliation, so
  // the component never re-reads useAuth() and the null→user transition is
  // never observed.
  const makeUi = () => (
    <MemoryRouter>
      <RecipientStepAddress {...props} />
    </MemoryRouter>
  );
  const utils = render(makeUi());
  return { ...utils, makeUi };
}

describe("RecipientStepAddress — OAuth auto-advance", () => {
  beforeEach(() => {
    mockUser = null;
    // 2026-08-18: "user was null at mount" stopped being the discriminator —
    // the /onboarding entry redirect mounts this step before auth settles, so
    // EVERY visitor matches it. Auto-advance is now authorized only by the
    // sendmo:oauth_pending flag set just before the Google redirect.
    try { window.sessionStorage.removeItem("sendmo:oauth_pending"); } catch { /* noop */ }
  });

  it("NEVER auto-advances, even on an OAuth return with the flag set", async () => {
    // Google moved to the Contact step (2026-08-19), so nothing here starts an
    // OAuth round trip and the flag this used to consume is never written by
    // this step. The auto-advance was removed rather than left unreachable —
    // which makes the guarantee stronger than the flag ever provided: this
    // step cannot auto-submit at all. The regression it guarded against
    // (LOG 2026-08-18: every signed-in visitor's form auto-submitting) is
    // therefore structurally impossible now, not merely gated.
    window.sessionStorage.setItem("sendmo:oauth_pending", "1");
    const onContinue = vi.fn();
    const { rerender, makeUi } = renderStep([], onContinue);

    mockUser = { email: "pat@example.com", user_metadata: {} };
    rerender(makeUi());

    await new Promise((r) => setTimeout(r, 2500));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("does NOT auto-advance without the flag, even on a null→present transition", async () => {
    // The Phase 2 regression: the entry redirect makes every signed-in
    // visitor's auth arrive after mount. Without the OAuth flag that must NOT
    // auto-submit the form.
    const onContinue = vi.fn();
    const { rerender, makeUi } = renderStep([], onContinue);

    mockUser = { email: "pat@example.com", user_metadata: {} };
    rerender(makeUi());

    expect(screen.queryByText(/Continuing…/i)).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 2500));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("does NOT auto-advance when validation fails — no 'Continuing…' spinner", async () => {
    // errors non-empty (e.g. missing phone). Before the fix this still fired
    // the auto-advance and left "Continuing…" spinning forever.
    window.sessionStorage.setItem("sendmo:oauth_pending", "1");
    const onContinue = vi.fn();
    const { rerender, makeUi } = renderStep(
      ["Add a phone number — the shipping carriers require it"],
      onContinue,
    );

    mockUser = { email: "pat@example.com", user_metadata: {} };
    rerender(makeUi());

    // The spinner must never appear, and onContinue must never be called.
    expect(screen.queryByText(/Continuing…/i)).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 2500));
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByText(/Continuing…/i)).not.toBeInTheDocument();
  });

  it("does not auto-advance for a user already signed in at mount (no flag)", async () => {
    const onContinue = vi.fn();
    mockUser = { email: "pat@example.com", user_metadata: {} };
    renderStep([], onContinue);

    await new Promise((r) => setTimeout(r, 2500));
    expect(onContinue).not.toHaveBeenCalled();
  });
});
