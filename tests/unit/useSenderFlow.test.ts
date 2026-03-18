import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useSenderFlow,
  getSenderValidationErrors,
  getSenderWeightOz,
  canSenderFetchRates,
  INITIAL_SENDER_STATE,
  type SenderFlowState,
} from "@/hooks/useSenderFlow";

// ─── Helper: create state with overrides ─────────────────────

function makeState(overrides: Partial<SenderFlowState> = {}): SenderFlowState {
  return { ...INITIAL_SENDER_STATE, ...overrides };
}

const VERIFIED_ADDRESS = {
  name: "Jane Doe",
  street: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
  verified: true as const,
};

// ─── getSenderValidationErrors ───────────────────────────────

describe("getSenderValidationErrors", () => {
  it("returns errors for empty step 1", () => {
    const errors = getSenderValidationErrors(INITIAL_SENDER_STATE, 1);
    expect(errors).toContain("Enter your name");
    expect(errors).toContain("Verify your address");
    expect(errors).toContain("Enter package length");
    expect(errors).toContain("Enter package width");
    expect(errors).toContain("Enter package height");
    expect(errors).toContain("Enter package weight");
  });

  it("skips height error for envelopes", () => {
    const state = makeState({ packagingType: "envelope" });
    const errors = getSenderValidationErrors(state, 1);
    expect(errors).not.toContain("Enter package height");
  });

  it("passes step 1 with valid data", () => {
    const state = makeState({
      fromAddress: VERIFIED_ADDRESS,
      dimensions: { length: "10", width: "10", height: "10" },
      weight: { lbs: "5", oz: "0" },
    });
    const errors = getSenderValidationErrors(state, 1);
    expect(errors).toHaveLength(0);
  });

  it("requires selected rate for step 2", () => {
    const errors = getSenderValidationErrors(INITIAL_SENDER_STATE, 2);
    expect(errors).toContain("Select a shipping method");
  });

  it("passes step 2 with selected rate", () => {
    const state = makeState({
      selectedRate: {
        id: "rate_123",
        carrier: "USPS",
        service: "Priority",
        rate_cents: 800,
        display_price_cents: 920,
        estimated_days: 2,
        currency: "USD",
      },
    });
    const errors = getSenderValidationErrors(state, 2);
    expect(errors).toHaveLength(0);
  });

  it("returns no errors for steps without validation (0, 3, 4)", () => {
    expect(getSenderValidationErrors(INITIAL_SENDER_STATE, 0)).toHaveLength(0);
    expect(getSenderValidationErrors(INITIAL_SENDER_STATE, 3)).toHaveLength(0);
    expect(getSenderValidationErrors(INITIAL_SENDER_STATE, 4)).toHaveLength(0);
  });
});

// ─── getSenderWeightOz ──────────────────────────────────────

describe("getSenderWeightOz", () => {
  it("converts lbs and oz to total oz", () => {
    const state = makeState({ weight: { lbs: "3", oz: "8" } });
    expect(getSenderWeightOz(state)).toBe(56); // 3*16 + 8
  });

  it("handles empty strings as 0", () => {
    const state = makeState({ weight: { lbs: "", oz: "" } });
    expect(getSenderWeightOz(state)).toBe(0);
  });

  it("handles oz only", () => {
    const state = makeState({ weight: { lbs: "0", oz: "12" } });
    expect(getSenderWeightOz(state)).toBe(12);
  });
});

// ─── canSenderFetchRates ────────────────────────────────────

describe("canSenderFetchRates", () => {
  it("returns false when fromAddress is unverified", () => {
    expect(canSenderFetchRates(INITIAL_SENDER_STATE)).toBe(false);
  });

  it("returns false when recipientAddress is null", () => {
    const state = makeState({ fromAddress: VERIFIED_ADDRESS });
    expect(canSenderFetchRates(state)).toBe(false);
  });

  it("returns false when dimensions are missing", () => {
    const state = makeState({
      fromAddress: VERIFIED_ADDRESS,
      recipientAddress: VERIFIED_ADDRESS,
      weight: { lbs: "5", oz: "0" },
    });
    expect(canSenderFetchRates(state)).toBe(false);
  });

  it("returns false when weight is zero", () => {
    const state = makeState({
      fromAddress: VERIFIED_ADDRESS,
      recipientAddress: VERIFIED_ADDRESS,
      dimensions: { length: "10", width: "10", height: "10" },
    });
    expect(canSenderFetchRates(state)).toBe(false);
  });

  it("returns true with complete data", () => {
    const state = makeState({
      fromAddress: VERIFIED_ADDRESS,
      recipientAddress: VERIFIED_ADDRESS,
      dimensions: { length: "10", width: "10", height: "10" },
      weight: { lbs: "5", oz: "0" },
    });
    expect(canSenderFetchRates(state)).toBe(true);
  });

  it("allows envelope without height", () => {
    const state = makeState({
      fromAddress: VERIFIED_ADDRESS,
      recipientAddress: VERIFIED_ADDRESS,
      packagingType: "envelope",
      dimensions: { length: "12", width: "9", height: "" },
      weight: { lbs: "0", oz: "8" },
    });
    expect(canSenderFetchRates(state)).toBe(true);
  });
});

// ─── useSenderFlow hook ─────────────────────────────────────

describe("useSenderFlow", () => {
  it("starts at step 0", () => {
    const { result } = renderHook(() => useSenderFlow());
    expect(result.current.state.currentStep).toBe(0);
    expect(result.current.state.completedSteps).toEqual([]);
  });

  it("tryAdvance on step 0 advances to step 1 (no validation)", () => {
    const { result } = renderHook(() => useSenderFlow());
    let ok: boolean;
    act(() => {
      ok = result.current.tryAdvance(0);
    });
    expect(ok!).toBe(true);
    expect(result.current.state.currentStep).toBe(1);
    expect(result.current.state.completedSteps).toContain(0);
  });

  it("tryAdvance on step 1 fails without valid data and sets tried", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => { result.current.tryAdvance(0); }); // go to step 1

    let ok: boolean;
    act(() => {
      ok = result.current.tryAdvance(1);
    });
    expect(ok!).toBe(false);
    expect(result.current.state.tried[1]).toBe(true);
    expect(result.current.state.currentStep).toBe(1);
  });

  it("tryAdvance on step 1 succeeds with valid data", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => { result.current.tryAdvance(0); });
    act(() => {
      result.current.updateState({
        fromAddress: VERIFIED_ADDRESS,
        dimensions: { length: "10", width: "10", height: "10" },
        weight: { lbs: "5", oz: "0" },
      });
    });

    let ok: boolean;
    act(() => {
      ok = result.current.tryAdvance(1);
    });
    expect(ok!).toBe(true);
    expect(result.current.state.currentStep).toBe(2);
    expect(result.current.state.completedSteps).toContain(1);
  });

  it("goBack goes to previous step", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => { result.current.tryAdvance(0); }); // step 1
    act(() => { result.current.goBack(); });
    expect(result.current.state.currentStep).toBe(0);
  });

  it("goBack does nothing at step 0", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => { result.current.goBack(); });
    expect(result.current.state.currentStep).toBe(0);
  });

  it("goToStep only allows completed steps or current", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => { result.current.tryAdvance(0); }); // step 1

    // Trying to skip to step 3 should not work
    act(() => { result.current.goToStep(3); });
    expect(result.current.state.currentStep).toBe(1);

    // Going back to completed step 0 should work
    act(() => { result.current.goToStep(0); });
    expect(result.current.state.currentStep).toBe(0);
  });

  it("updateState clears rate selection when package details change", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => {
      result.current.updateState({
        selectedRate: {
          id: "rate_123",
          carrier: "USPS",
          service: "Priority",
          rate_cents: 800,
          display_price_cents: 920,
          estimated_days: 2,
          currency: "USD",
        },
        easypostShipmentId: "shp_123",
      });
    });
    expect(result.current.state.selectedRate).not.toBeNull();

    // Changing dimensions should clear rate
    act(() => {
      result.current.updateState({ dimensions: { length: "15", width: "10", height: "10" } });
    });
    expect(result.current.state.selectedRate).toBeNull();
    expect(result.current.state.easypostShipmentId).toBe("");
  });

  it("markComplete adds step to completedSteps", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => { result.current.markComplete(2); });
    expect(result.current.state.completedSteps).toContain(2);
  });

  it("markComplete is idempotent", () => {
    const { result } = renderHook(() => useSenderFlow());
    act(() => { result.current.markComplete(2); });
    act(() => { result.current.markComplete(2); });
    expect(result.current.state.completedSteps.filter((s) => s === 2)).toHaveLength(1);
  });

  it("getErrors delegates to validation", () => {
    const { result } = renderHook(() => useSenderFlow());
    const errors = result.current.getErrors(1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors).toContain("Enter your name");
  });
});
