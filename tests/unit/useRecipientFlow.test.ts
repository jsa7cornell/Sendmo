import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRecipientFlow } from "@/hooks/useRecipientFlow";

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
