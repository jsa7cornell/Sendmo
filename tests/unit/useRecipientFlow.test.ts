import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useRecipientFlow,
  canFetchRates,
  type RecipientFlowState,
} from "@/hooks/useRecipientFlow";
import { emptyAddress } from "@/lib/utils";

describe("useRecipientFlow", () => {
  it("starts at step 0 with no path", () => {
    const { result } = renderHook(() => useRecipientFlow());
    expect(result.current.state.currentStep).toBe(0);
    expect(result.current.state.path).toBeNull();
  });

  it("selectPath sets path and advances to step 1", () => {
    const { result } = renderHook(() => useRecipientFlow());
    act(() => result.current.selectPath("full_label"));

    expect(result.current.state.path).toBe("full_label");
    expect(result.current.state.currentStep).toBe(1);
    expect(result.current.state.completedSteps).toContain(0);
  });

  it("tryAdvance fails step 1 without valid data and sets tried flag", () => {
    const { result } = renderHook(() => useRecipientFlow());
    act(() => result.current.selectPath("full_label"));

    let advanced: boolean;
    act(() => {
      advanced = result.current.tryAdvance(1);
    });
    expect(advanced!).toBe(false);
    expect(result.current.state.tried[1]).toBe(true);
    expect(result.current.state.currentStep).toBe(1);
  });

  it("tryAdvance succeeds step 1 with valid data", () => {
    const { result } = renderHook(() => useRecipientFlow());
    act(() => result.current.selectPath("full_label"));
    act(() =>
      result.current.updateState({
        destinationAddress: {
          name: "Test",
          street: "123 Main",
          city: "SF",
          state: "CA",
          zip: "94107",
          phone: "4155550100",
          verified: true,
        },
        email: "test@example.com",
      }),
    );

    let advanced: boolean;
    act(() => {
      advanced = result.current.tryAdvance(1);
    });
    expect(advanced!).toBe(true);
    expect(result.current.state.currentStep).toBe(10);
    expect(result.current.state.completedSteps).toContain(1);
  });

  it("goBack from step 10 returns to step 1", () => {
    const { result } = renderHook(() => useRecipientFlow());
    act(() => result.current.selectPath("full_label"));
    act(() =>
      result.current.updateState({
        destinationAddress: {
          name: "Test",
          street: "123 Main",
          city: "SF",
          state: "CA",
          zip: "94107",
          phone: "4155550100",
          verified: true,
        },
        email: "test@example.com",
      }),
    );
    act(() => result.current.tryAdvance(1));
    expect(result.current.state.currentStep).toBe(10);

    act(() => result.current.goBack());
    expect(result.current.state.currentStep).toBe(1);
  });

  it("goToStep only allows navigation to completed steps", () => {
    const { result } = renderHook(() => useRecipientFlow());
    act(() => result.current.selectPath("full_label"));

    // Try to jump to step 10 (not completed) — should not move
    act(() => result.current.goToStep(10));
    expect(result.current.state.currentStep).toBe(1);

    // Step 0 is completed, should be able to go back
    act(() => result.current.goToStep(0));
    expect(result.current.state.currentStep).toBe(0);
  });

  it("getErrors returns empty array for valid state", () => {
    const { result } = renderHook(() => useRecipientFlow());
    act(() =>
      result.current.updateState({
        destinationAddress: {
          name: "Test",
          street: "123 Main",
          city: "SF",
          state: "CA",
          zip: "94107",
          phone: "4155550100",
          verified: true,
        },
        email: "test@example.com",
      }),
    );
    expect(result.current.getErrors(1)).toHaveLength(0);
  });

  it("updateState merges partial state", () => {
    const { result } = renderHook(() => useRecipientFlow());
    act(() => result.current.updateState({ email: "hello@test.com", insurance: true }));
    expect(result.current.state.email).toBe("hello@test.com");
    expect(result.current.state.insurance).toBe(true);
    expect(result.current.state.packagingType).toBe("box"); // untouched
  });
});

// ─── canFetchRates — phone gate (audit finding 2) ───────────────────────────
//
// canFetchRates is the predicate that gates the debounced full-label rate
// fetch. Before the fix it checked verified/street/dims/weight but NOT phone —
// so a phone-less verified address let fetchRates run, addressToApi threw, and
// the user saw the raw "addressToApi: incomplete address (...)" string. These
// pin that canFetchRates now refuses to fetch until BOTH addresses have a
// usable phone, matching getValidationErrors steps 1 + 10.

describe("canFetchRates — phone gate", () => {
  const ready = (originPhone: string, destPhone: string): RecipientFlowState =>
    ({
      originAddress: {
        ...emptyAddress(),
        street: "1 Origin St",
        city: "San Francisco",
        state: "CA",
        zip: "94107",
        phone: originPhone,
        verified: true,
      },
      destinationAddress: {
        ...emptyAddress(),
        street: "2 Dest Ave",
        city: "Oakland",
        state: "CA",
        zip: "94612",
        phone: destPhone,
        verified: true,
      },
      dimensions: { length: "10", width: "8", height: "6" },
      weight: { lbs: "2", oz: "0" },
      packagingType: "box",
    } as RecipientFlowState);

  it("returns true when both addresses have a usable phone", () => {
    expect(canFetchRates(ready("4155550100", "4155550142"))).toBe(true);
  });

  it("returns false when the origin phone is missing", () => {
    expect(canFetchRates(ready("", "4155550142"))).toBe(false);
  });

  it("returns false when the destination phone is missing", () => {
    expect(canFetchRates(ready("4155550100", ""))).toBe(false);
  });

  it("returns false when a phone is present but not plausible", () => {
    expect(canFetchRates(ready("123", "4155550142"))).toBe(false);
  });
});
