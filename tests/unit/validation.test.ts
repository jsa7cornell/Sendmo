import { describe, it, expect } from "vitest";
import { getValidationErrors } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import { emptyAddress } from "@/lib/utils";

function makeState(overrides: Partial<RecipientFlowState> = {}): RecipientFlowState {
  return {
    currentStep: 0,
    path: "full_label",
    completedSteps: [],
    destinationAddress: emptyAddress(),
    email: "",
    originAddress: emptyAddress(),
    itemDescription: "",
    packagingType: "box",
    dimensions: { length: "", width: "", height: "" },
    weight: { lbs: "", oz: "" },
    selectedRate: null,
    availableRates: [],
    easypostShipmentId: "",
    insurance: false,
    paymentStatus: "idle",
    labelResult: null,
    tried: {},
    ...overrides,
  };
}

const verifiedAddr = () => ({
  ...emptyAddress(),
  name: "Pat Smith",
  street: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
  phone: "4155550100",
  verified: true,
});

const mockRate = {
  id: "rate_1",
  carrier: "USPS",
  service: "GroundAdvantage",
  rate_cents: 800,
  display_price_cents: 920,
  estimated_days: 3,
  currency: "USD",
};

describe("Step 1 validation", () => {
  it("errors when address is not verified", () => {
    const errors = getValidationErrors(makeState(), 1);
    expect(errors).toContain("Destination address is required");
  });

  it("does NOT ask for an email — capture moved to the Contact step (2026-08-19)", () => {
    const errors = getValidationErrors(makeState({ destinationAddress: verifiedAddr() }), 1);
    expect(errors).not.toContain("Email is required");
    expect(errors).toEqual([]);
  });

  it("the Contact step now owns email capture as well as verification", () => {
    const empty = getValidationErrors(makeState({}), 11);
    expect(empty).toContain("Email is required");
    const bad = getValidationErrors(makeState({ email: "notanemail" }), 11);
    expect(bad).toContain("Enter a valid email address");
    const good = getValidationErrors(makeState({ email: "pat@example.com", email_verified: true }), 11);
    expect(good).toEqual([]);
  });

  it("rejects an invalid email at the Contact step", () => {
    const errors = getValidationErrors(
      makeState({ destinationAddress: verifiedAddr(), email: "notanemail" }),
      11,
    );
    expect(errors).toContain("Enter a valid email address");
  });

  it("errors when phone is missing", () => {
    // FedEx/UPS reject labels without a phone — step 1 must require it.
    const errors = getValidationErrors(
      makeState({
        destinationAddress: { ...verifiedAddr(), phone: "" },
        email: "test@example.com",
      }),
      1,
    );
    expect(errors.some((e) => /phone number/i.test(e))).toBe(true);
  });

  it("errors when phone is too short to be a real number", () => {
    const errors = getValidationErrors(
      makeState({
        destinationAddress: { ...verifiedAddr(), phone: "12345" },
        email: "test@example.com",
      }),
      1,
    );
    expect(errors.some((e) => /phone number/i.test(e))).toBe(true);
  });

  it("passes when address verified, phone present, and email valid", () => {
    const errors = getValidationErrors(
      makeState({ destinationAddress: verifiedAddr(), email: "test@example.com" }),
      1,
    );
    expect(errors).toHaveLength(0);
  });
});

describe("Step 10 validation", () => {
  it("errors when origin not verified", () => {
    const errors = getValidationErrors(makeState(), 10);
    expect(errors).toContain("Origin address is required");
  });

  // Parcel + carrier moved to step 14 on 2026-08-18 (split from 10 so the
  // address and the package can be deferred independently).
  it("errors when dimensions missing", () => {
    const errors = getValidationErrors(makeState({ originAddress: verifiedAddr() }), 14);
    expect(errors).toContain("Length is required");
    expect(errors).toContain("Width is required");
    expect(errors).toContain("Height is required");
  });

  it("does not require height for envelopes", () => {
    const errors = getValidationErrors(
      makeState({
        originAddress: verifiedAddr(),
        packagingType: "envelope",
        dimensions: { length: "10", width: "7", height: "" },
        weight: { lbs: "1", oz: "0" },
        selectedRate: mockRate,
      }),
      14,
    );
    expect(errors).not.toContain("Height is required");
  });

  it("errors when weight is zero", () => {
    const errors = getValidationErrors(
      makeState({
        originAddress: verifiedAddr(),
        dimensions: { length: "10", width: "10", height: "10" },
        weight: { lbs: "0", oz: "0" },
      }),
      14,
    );
    expect(errors).toContain("Weight is required");
  });

  it("does NOT require a rate at step 14 — the carrier choice moved to step 20 (2026-08-19)", () => {
    const errors = getValidationErrors(
      makeState({
        originAddress: verifiedAddr(),
        dimensions: { length: "10", width: "10", height: "10" },
        weight: { lbs: "5", oz: "0" },
      }),
      14,
    );
    expect(errors).not.toContain("Select a shipping method");
    expect(errors).toEqual([]);
  });

  it("errors when no rate selected at step 20 on the label path", () => {
    const errors = getValidationErrors(
      makeState({
        path: "full_label",
        originAddress: verifiedAddr(),
        dimensions: { length: "10", width: "10", height: "10" },
        weight: { lbs: "5", oz: "0" },
      }),
      20,
    );
    expect(errors).toContain("Select a shipping method");
  });

  it("step 20 on the link path validates the cap, never the rate", () => {
    const errors = getValidationErrors(
      makeState({ path: "flexible", price_cap: 0 }),
      20,
    );
    expect(errors).toContain("Price cap must be greater than $0");
    expect(errors).not.toContain("Select a shipping method");
  });

  it("errors when origin phone is missing", () => {
    // FedEx/UPS require a phone on the shipper address too, not just recipient.
    const errors = getValidationErrors(
      makeState({
        originAddress: { ...verifiedAddr(), phone: "" },
        dimensions: { length: "10", width: "10", height: "10" },
        weight: { lbs: "5", oz: "0" },
        selectedRate: mockRate,
      }),
      10,
    );
    expect(errors.some((e) => /phone number/i.test(e))).toBe(true);
  });

  it("passes when all fields valid", () => {
    const errors = getValidationErrors(
      makeState({
        originAddress: verifiedAddr(),
        dimensions: { length: "10", width: "10", height: "10" },
        weight: { lbs: "5", oz: "0" },
        selectedRate: mockRate,
      }),
      10,
    );
    expect(errors).toHaveLength(0);
  });
});

describe("step 1 — deferred destination (Phase 3)", () => {
  // Decision B (2026-08-18): every question is skippable, including the
  // destination. Deferring it answers the ADDRESS half only — email (and its
  // verification downstream) is how the creator gets an account and a card,
  // so it must still gate the step.
  it("drops the address requirements but keeps the email ones", () => {
    const errors = getValidationErrors(
      makeState({ deferredDestination: true, email: "pat@example.com" }),
      1,
    );
    expect(errors).toEqual([]);
  });

  it("a deferred destination clears step 1 entirely — the email gate is at step 11 now", () => {
    const errors = getValidationErrors(makeState({ deferredDestination: true }), 1);
    expect(errors).toEqual([]);
    // The gate still exists; it moved. A flow cannot reach payment without one.
    expect(getValidationErrors(makeState({ deferredDestination: true }), 11))
      .toContain("Email is required");
  });

  it("unchanged when not deferred: empty address still fails", () => {
    const errors = getValidationErrors(makeState({ email: "pat@example.com" }), 1);
    expect(errors).toContain("Destination address is required");
  });
});
