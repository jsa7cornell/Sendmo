import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ─── Regression guard: phone must gate the dashboard /links/new flow ────────
//
// Bug (2026-05-20): LinksEditor (the dashboard create/edit flow) validated
// only address-verified + address-complete before advancing to the payment
// step. Phone — a hard requirement the links Edge Function enforces (FedEx/UPS
// PHONENUMBEREMPTY) — was never checked. A user with a missing/incomplete
// phone sailed to Step 2, createFlexLink 400'd server-side, and the failure
// surfaced as an ugly "We need a phone number…" server error on the "Add your
// card" step instead of an inline field error on the details step.
//
// The onboarding flow already gates phone (useRecipientFlow.getValidationErrors
// step 1). Fix: LinksEditor gates phone too — handleContinueToPayment and
// handleEditSubmit both check isUsablePhone. These tests pin that behavior.

let mockUpdateFlexLink: ReturnType<typeof vi.fn>;

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { email: "pat@example.com" },
    session: { access_token: "test-token" },
  }),
}));

// FlexPaymentStep is the Step 2 surface. Replace it with a sentinel so we can
// assert purely on whether LinksEditor advanced past the details step.
vi.mock("@/components/flex/FlexPaymentStep", () => ({
  default: () => <div>PAYMENT STEP SENTINEL</div>,
}));

// The three sub-forms are exercised by their own tests; stub them out so this
// test isolates LinksEditor's gating logic. The address/phone come straight
// from the `initialValue` prop, so the stubs need no behavior.
vi.mock("@/components/forms/AddressForm", () => ({
  default: () => <div>address-form</div>,
}));
vi.mock("@/components/forms/NotificationEmailField", () => ({
  default: () => <div>notification-email-field</div>,
}));
vi.mock("@/components/forms/FlexPreferencesForm", () => ({
  default: () => <div>flex-preferences-form</div>,
}));

vi.mock("@/lib/api", () => ({
  updateFlexLink: (...args: unknown[]) => mockUpdateFlexLink(...args),
}));

import LinksEditor, { type FlexFormValue } from "@/components/links/LinksEditor";
import { emptyAddress } from "@/lib/utils";

function makeValue(phone: string): FlexFormValue {
  return {
    address: {
      ...emptyAddress(),
      name: "Pat Smith",
      street: "1 Main St",
      city: "San Francisco",
      state: "CA",
      zip: "94107",
      phone,
      verified: true,
    },
    email: "pat@example.com",
    speed_preference: "standard",
    preferred_carrier: "any",
    price_cap: 100,
    size_hint: null,
  };
}

function renderEditor(mode: "create" | "edit", value: FlexFormValue) {
  return render(
    <MemoryRouter>
      <LinksEditor
        mode={mode}
        initialValue={value}
        linkId={mode === "edit" ? "link-123" : null}
      />
    </MemoryRouter>,
  );
}

describe("LinksEditor — phone gate (create flow)", () => {
  beforeEach(() => {
    mockUpdateFlexLink = vi.fn().mockResolvedValue({});
  });

  it("does NOT advance to the payment step when the phone is missing", () => {
    renderEditor("create", makeValue(""));

    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    // Still on the details step — the payment sentinel must not appear.
    expect(screen.queryByText("PAYMENT STEP SENTINEL")).not.toBeInTheDocument();
    // And the phone error is surfaced inline.
    expect(screen.getByText(/add a phone number for the delivery address/i)).toBeInTheDocument();
  });

  it("does NOT advance when the phone is present but incomplete", () => {
    renderEditor("create", makeValue("(415) 555")); // too short for isPossiblePhoneNumber

    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    expect(screen.queryByText("PAYMENT STEP SENTINEL")).not.toBeInTheDocument();
    expect(screen.getByText(/add a phone number for the delivery address/i)).toBeInTheDocument();
  });

  it("advances to the payment step when address + phone are both valid", () => {
    renderEditor("create", makeValue("(415) 555-0100"));

    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    expect(screen.getByText("PAYMENT STEP SENTINEL")).toBeInTheDocument();
  });
});

describe("LinksEditor — phone gate (edit flow)", () => {
  beforeEach(() => {
    mockUpdateFlexLink = vi.fn().mockResolvedValue({});
  });

  it("does NOT call updateFlexLink when the phone is missing", () => {
    renderEditor("edit", makeValue(""));

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(mockUpdateFlexLink).not.toHaveBeenCalled();
    expect(screen.getByText(/add a phone number for the delivery address/i)).toBeInTheDocument();
  });

  it("calls updateFlexLink when address + phone are both valid", async () => {
    renderEditor("edit", makeValue("(415) 555-0100"));

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    // handleEditSubmit is async (sets submitting, awaits the API, navigates);
    // waitFor lets those state updates settle inside act().
    await waitFor(() => expect(mockUpdateFlexLink).toHaveBeenCalledTimes(1));
  });
});
