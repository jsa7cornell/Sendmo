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
  street: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
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

  it("errors when email is empty", () => {
    const errors = getValidationErrors(makeState({ destinationAddress: verifiedAddr() }), 1);
    expect(errors).toContain("Email is required");
  });

  it("errors when email is invalid", () => {
    const errors = getValidationErrors(
      makeState({ destinationAddress: verifiedAddr(), email: "notanemail" }),
      1,
    );
    expect(errors).toContain("Enter a valid email address");
  });

  it("passes when address verified and email valid", () => {
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
    expect(errors).toContain("Ship from address is required");
  });

  it("errors when dimensions missing", () => {
    const errors = getValidationErrors(makeState({ originAddress: verifiedAddr() }), 10);
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
      10,
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
      10,
    );
    expect(errors).toContain("Weight is required");
  });

  it("errors when no rate selected", () => {
    const errors = getValidationErrors(
      makeState({
        originAddress: verifiedAddr(),
        dimensions: { length: "10", width: "10", height: "10" },
        weight: { lbs: "5", oz: "0" },
      }),
      10,
    );
    expect(errors).toContain("Select a shipping method");
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
