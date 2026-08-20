import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";

// Pins the saved-address prefill rule John stated on 2026-08-19: "only fill it
// in if nothing's been filled in yet."
//
// The rule has two halves and the second one is the regression risk. Filling an
// empty slot is the visible, obviously-desirable half. NOT clobbering a slot
// the user already typed into is invisible when it works and destructive when
// it breaks — a saved address landing on top of a hand-typed one looks like the
// app losing the user's input. The guard is `if (targetTouched) return;` plus a
// second check inside setData for the race where typing lands mid-request; both
// halves are exercised below.
//
// This file carries its own Supabase mock rather than joining
// recipientFlowContext.test.tsx, whose module-level mock returns a null session
// specifically so the prefill effect never runs.

const SAVED = {
  name: "Saved Name",
  street1: "1 Saved St",
  street2: null,
  city: "Oakland",
  state: "CA",
  zip: "94607",
  phone: "5105550100",
  is_verified: true,
};

const USER = { id: "user-1", email: "saved@example.com" };

const mockOnAuthStateChange = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { user: USER, access_token: "t" } } }),
      onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
      signInWithOtp: vi.fn().mockResolvedValue({ data: {}, error: null }),
      signInWithOAuth: vi.fn().mockResolvedValue({ data: {}, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: { email: USER.email, full_name: "Saved Name", phone: SAVED.phone },
            }),
          order: () => ({
            limit: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: table === "addresses" ? SAVED : null }),
            }),
          }),
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

const TYPED_STREET = "999 Typed Ave";

function Harness() {
  const { data, updateData } = useRecipientFlowContext();

  return (
    <div>
      <div data-testid="origin-street">{data.originAddress.street || "empty"}</div>
      <div data-testid="origin-name">{data.originAddress.name || "empty"}</div>
      <button onClick={() => updateData({ sender: "self" })}>Resolve Self</button>
      <button
        onClick={() =>
          updateData({
            originAddress: {
              name: "Typed Name",
              street: TYPED_STREET,
              city: "Reno",
              state: "NV",
              zip: "89501",
              phone: "7755550100",
              verified: false,
            },
          })
        }
      >
        Type Origin
      </button>
    </div>
  );
}

function renderFlow() {
  return render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/onboarding"
            element={
              <RecipientFlowProvider>
                <Outlet />
              </RecipientFlowProvider>
            }
          >
            <Route index element={<Harness />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // AuthContext deliberately uses ONLY onAuthStateChange to establish the
  // session — it does not call getSession (see the "Supabase footgun" comment
  // there). A mock that resolves getSession but never fires this callback
  // leaves `user` null, which would make BOTH tests below pass vacuously.
  mockOnAuthStateChange.mockImplementation(
    (cb: (event: string, session: unknown) => void) => {
      cb("SIGNED_IN", { user: USER, access_token: "t" });
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
  );
  for (const store of ["localStorage", "sessionStorage"] as const) {
    try {
      window[store].removeItem("sendmo:recipient_flow:v1");
    } catch {
      /* jsdom may not expose this store in all environments */
    }
  }
});

describe("saved-address prefill", () => {
  it("fills the origin when the user has typed nothing there", async () => {
    const user = userEvent.setup();
    renderFlow();

    // Nothing happens until `sender` resolves — an unresolved sender means we
    // do not know which slot the account holder owns.
    expect(screen.getByTestId("origin-street")).toHaveTextContent("empty");

    await user.click(screen.getByText("Resolve Self"));

    await waitFor(() =>
      expect(screen.getByTestId("origin-street")).toHaveTextContent(SAVED.street1),
    );
  });

  it("does NOT overwrite an origin the user already typed", async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(screen.getByText("Type Origin"));
    await user.click(screen.getByText("Resolve Self"));

    // Give the effect every chance to fire and resolve its two queries; the
    // assertion is that after all of it the typed value is still there.
    await waitFor(() =>
      expect(screen.getByTestId("origin-name")).toHaveTextContent("Typed Name"),
    );
    expect(screen.getByTestId("origin-street")).toHaveTextContent(TYPED_STREET);
    expect(screen.getByTestId("origin-street")).not.toHaveTextContent(SAVED.street1);
  });
});
