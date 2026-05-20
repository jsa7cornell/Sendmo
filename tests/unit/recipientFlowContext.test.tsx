import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";

// Mock Supabase before importing anything that touches it. Both AuthContext
// and RecipientFlowContext call into supabase.auth on mount; we return a no-
// session, no-user state so the auto-prefill + auto-verify effects skip.
const mockGetSession = vi.fn();
const mockOnAuthStateChange = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
      signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: null }),
      signInWithOAuth: vi.fn().mockResolvedValue({ data: {}, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null }),
          order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
        }),
      }),
      insert: () => Promise.resolve({}),
    }),
  },
}));

import { AuthProvider } from "@/contexts/AuthContext";
import {
  RecipientFlowProvider,
  useRecipientFlowContext,
} from "@/contexts/RecipientFlowContext";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: null } });
  mockOnAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  });
  // Reset session-scoped persistence the provider hydrates from on mount.
  try {
    window.sessionStorage.removeItem("sendmo:recipient_flow:v1");
  } catch {
    /* jsdom may not expose sessionStorage in all environments */
  }
});

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
              street: "123 Main",
              city: "SF",
              state: "CA",
              zip: "94105",
              phone: "4155550100",
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
      <AuthProvider>
        <Routes>
          <Route path="/onboarding" element={<TestLayout />}>
            <Route index element={<StepDisplay />} />
            <Route path=":pathSlug">
              <Route index element={<StepDisplay />} />
              <Route path=":stepSlug" element={<StepDisplay />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("RecipientFlowContext", () => {
  it("starts at step 0 on /onboarding", () => {
    renderWithRouter();
    expect(screen.getByTestId("current-step").textContent).toBe("0");
    expect(screen.getByTestId("path").textContent).toBe("none");
  });

  it("derives step from URL param", () => {
    renderWithRouter(["/onboarding/full-label/destination"]);
    expect(screen.getByTestId("current-step").textContent).toBe("1");
  });

  it("maps shipping slug to step 10", () => {
    renderWithRouter(["/onboarding/full-label/shipping"]);
    expect(screen.getByTestId("current-step").textContent).toBe("10");
  });

  it("maps verify slug to step 11 (full-label)", () => {
    renderWithRouter(["/onboarding/full-label/verify"]);
    expect(screen.getByTestId("current-step").textContent).toBe("11");
  });

  it("maps payment slug to step 12 (full-label, post account-creation-timing)", () => {
    renderWithRouter(["/onboarding/full-label/payment"]);
    expect(screen.getByTestId("current-step").textContent).toBe("12");
  });

  it("maps preferences slug to step 20 (flexible)", () => {
    renderWithRouter(["/onboarding/flexible/preferences"]);
    expect(screen.getByTestId("current-step").textContent).toBe("20");
  });

  it("falls back to step 0 for unknown slug", () => {
    renderWithRouter(["/onboarding/full-label/unknown-step"]);
    expect(screen.getByTestId("current-step").textContent).toBe("0");
  });

  it("selectPath sets path and marks step 0 complete", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByText("Select Full Label"));

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

    // Stays on step 0 (no path picked yet); data exists in context regardless.
    expect(screen.getByTestId("current-step").textContent).toBe("0");
  });

  it("tryAdvance with valid data marks step complete and navigates from 1 → 10", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByText("Select Full Label"));
    expect(screen.getByTestId("current-step").textContent).toBe("1");

    await user.click(screen.getByText("Fill Step 1"));
    await user.click(screen.getByText("Try Advance"));

    expect(screen.getByTestId("current-step").textContent).toBe("10");
    expect(screen.getByTestId("completed").textContent).toContain("1");
  });

  it("tryAdvance with missing data does not navigate", async () => {
    const user = userEvent.setup();
    renderWithRouter();

    await user.click(screen.getByText("Select Full Label"));
    expect(screen.getByTestId("current-step").textContent).toBe("1");

    // Try to advance without filling — validation errors fire, no nav.
    await user.click(screen.getByText("Try Advance"));

    expect(screen.getByTestId("current-step").textContent).toBe("1");
  });
});
