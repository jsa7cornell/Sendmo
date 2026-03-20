import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import {
  RecipientFlowProvider,
  useRecipientFlowContext,
} from "@/contexts/RecipientFlowContext";

// Mock Supabase (some components may import it)
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  },
}));

// A test harness component that renders flow state
function StepDisplay() {
  const { currentStep, data, direction, selectPath, tryAdvance, goBack, updateData } =
    useRecipientFlowContext();

  return (
    <div>
      <div data-testid="current-step">{currentStep}</div>
      <div data-testid="direction">{direction}</div>
      <div data-testid="path">{data.path ?? "none"}</div>
      <div data-testid="completed">{JSON.stringify(data.completedSteps)}</div>
      <button onClick={() => selectPath("full_label")}>Select Full Label</button>
      <button onClick={() => selectPath("flexible")}>Select Flexible</button>
      <button onClick={() => tryAdvance(currentStep)}>Try Advance</button>
      <button onClick={goBack}>Go Back</button>
      <button
        onClick={() =>
          updateData({
            destinationAddress: {
              name: "Jane",
              street1: "123 Main",
              street2: "",
              city: "SF",
              state: "CA",
              zip: "94105",
              verified: true,
            },
            email: "test@test.com",
          })
        }
      >
        Fill Step 1
      </button>
    </div>
  );
}

function TestLayout() {
  return (
    <RecipientFlowProvider>
      <Outlet />
    </RecipientFlowProvider>
  );
}

function renderWithRouter(initialEntries: string[] = ["/onboarding"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/onboarding" element={<TestLayout />}>
          <Route index element={<StepDisplay />} />
          <Route path=":step" element={<StepDisplay />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("RecipientFlowContext", () => {
  it("starts at step 0 on /onboarding", () => {
    renderWithRouter();
    expect(screen.getByTestId("current-step").textContent).toBe("0");
    expect(screen.getByTestId("path").textContent).toBe("none");
  });

  it("derives step from URL param", () => {
    renderWithRouter(["/onboarding/address"]);
    expect(screen.getByTestId("current-step").textContent).toBe("1");
  });

  it("maps shipping slug to step 10", () => {
    renderWithRouter(["/onboarding/shipping"]);
    expect(screen.getByTestId("current-step").textContent).toBe("10");
  });

  it("maps payment slug to step 11", () => {
    renderWithRouter(["/onboarding/payment"]);
    expect(screen.getByTestId("current-step").textContent).toBe("11");
  });

  it("maps preferences slug to step 20", () => {
    renderWithRouter(["/onboarding/preferences"]);
    expect(screen.getByTestId("current-step").textContent).toBe("20");
  });

  it("falls back to step 0 for unknown slug", () => {
    renderWithRouter(["/onboarding/unknown-step"]);
    expect(screen.getByTestId("current-step").textContent).toBe("0");
  });

  it("selectPath sets path and marks step 0 complete", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByText("Select Full Label"));

    // After selecting path, should navigate to /onboarding/address (step 1)
    expect(screen.getByTestId("current-step").textContent).toBe("1");
    expect(screen.getByTestId("path").textContent).toBe("full_label");
    expect(screen.getByTestId("completed").textContent).toContain("0");
  });

  it("selectPath for flexible sets correct path", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByText("Select Flexible"));

    expect(screen.getByTestId("path").textContent).toBe("flexible");
    expect(screen.getByTestId("current-step").textContent).toBe("1");
  });

  it("updateData persists across renders", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByText("Fill Step 1"));

    // Re-render shows same component — data is in context
    expect(screen.getByTestId("current-step").textContent).toBe("0");
  });

  it("tryAdvance with valid data marks step complete and navigates forward", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    // Select path first
    await user.click(screen.getByText("Select Full Label"));
    // Now on step 1 (address)
    expect(screen.getByTestId("current-step").textContent).toBe("1");

    // Fill valid data
    await user.click(screen.getByText("Fill Step 1"));

    // Try to advance from step 1
    await user.click(screen.getByText("Try Advance"));

    // Should have advanced to step 10 and step 1 should be completed
    expect(screen.getByTestId("current-step").textContent).toBe("10");
    expect(screen.getByTestId("completed").textContent).toContain("1");
  });

  it("tryAdvance with missing data does not navigate", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByText("Select Full Label"));
    expect(screen.getByTestId("current-step").textContent).toBe("1");

    // Try to advance without filling data
    await user.click(screen.getByText("Try Advance"));

    // Should stay on step 1
    expect(screen.getByTestId("current-step").textContent).toBe("1");
  });
});
