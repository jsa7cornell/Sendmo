import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => mockNavigate,
}));

// Step 1 asks ONE question: where is the package going. The creator's email,
// the Google CTA and the signed-in identity pill moved to the Contact step on
// 2026-08-22 — an account question on the "where's it going?" screen was the
// usability complaint that prompted the move. These tests pin that split so
// identity UI can't drift back onto this step.

let mockUser: { email: string; user_metadata?: Record<string, unknown> } | null = null;

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
}));

// The prefill effect reads the user's most recent address; it backs the
// "Use my saved address" shortcut under the fields.
let mockSavedAddress: Record<string, unknown> | null = null;

vi.mock("@/lib/supabase", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: mockSavedAddress }),
    single: () => Promise.resolve({ data: null }),
  };
  return { supabase: { from: () => chain, auth: {} } };
});

import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import { emptyAddress } from "@/lib/utils";
import type { SenderKind } from "@/lib/types";

const savedRow = {
  name: "Pat Smith",
  street1: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
  phone: "4155550100",
  is_verified: true,
};

function renderStep(overrides: {
  sender?: SenderKind | null;
  deferredDestination?: boolean;
  onAddressChange?: (a: unknown) => void;
  onSenderResolved?: (s: SenderKind) => void;
  onDeferDestination?: () => void;
  onUndoDeferDestination?: () => void;
} = {}) {
  return render(
    <MemoryRouter initialEntries={["/onboarding/flexible/destination"]}>
      <RecipientStepAddress
        address={emptyAddress()}
        path="flexible"
        sender={overrides.sender ?? null}
        errors={[]}
        tried={false}
        onAddressChange={overrides.onAddressChange ?? (() => {})}
        onSenderResolved={overrides.onSenderResolved ?? (() => {})}
        deferredDestination={overrides.deferredDestination ?? false}
        onDeferDestination={overrides.onDeferDestination ?? (() => {})}
        onUndoDeferDestination={overrides.onUndoDeferDestination ?? (() => {})}
        onContinue={() => {}}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = null;
  mockSavedAddress = null;
});

describe("RecipientStepAddress", () => {
  it("collects no identity — no email field, no Google CTA, no signed-in pill", () => {
    mockUser = { email: "pat@example.com", user_metadata: { full_name: "Pat Smith" } };
    renderStep();

    expect(screen.queryByLabelText(/Email address/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue with Google/i })).toBeNull();
    expect(screen.queryByText("pat@example.com")).toBeNull();
  });

  it("offers the saved address, named, when the sender is unresolved", async () => {
    mockUser = { email: "pat@example.com" };
    mockSavedAddress = savedRow;
    const onAddressChange = vi.fn();
    const onSenderResolved = vi.fn();
    const user = userEvent.setup();
    renderStep({ onAddressChange, onSenderResolved });

    const link = await screen.findByRole("button", { name: /Use my saved address/i });
    // The street is in the label so the user knows which address they'd get.
    expect(link).toHaveTextContent("388 Townsend St");
    await user.click(link);

    // Claiming the destination as your own IS the answer the deleted
    // who's-sending step used to ask for.
    expect(onSenderResolved).toHaveBeenCalledWith("other");
    expect(onAddressChange).toHaveBeenCalledWith(
      expect.objectContaining({ street: "388 Townsend St", verified: true }),
    );
  });

  it("offers a login that returns to this step when signed out", async () => {
    const user = userEvent.setup();
    renderStep();

    const link = screen.getByRole("button", { name: /Log in to use your saved address/i });
    await user.click(link);

    // Without ?next the user would land on the dashboard and lose the draft.
    expect(mockNavigate).toHaveBeenCalledWith(
      "/login?next=%2Fonboarding%2Fflexible%2Fdestination",
    );
  });

  it("skips straight to the next question — no Continue press needed", async () => {
    const onDeferDestination = vi.fn();
    const user = userEvent.setup();
    renderStep({ onDeferDestination });

    await user.click(screen.getByRole("button", { name: /Sender will fill this in/i }));
    expect(onDeferDestination).toHaveBeenCalledTimes(1);
  });

  it("offers the reverse when returning to a skipped destination", async () => {
    const onUndoDeferDestination = vi.fn();
    const user = userEvent.setup();
    renderStep({ deferredDestination: true, onUndoDeferDestination });

    expect(screen.queryByRole("button", { name: /Sender will fill this in/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Enter it myself/i }));
    expect(onUndoDeferDestination).toHaveBeenCalledTimes(1);
  });

  it("hides the skip when the account holder is the one shipping out", () => {
    renderStep({ sender: "self" });
    expect(screen.queryByRole("button", { name: /Sender will fill this in/i })).toBeNull();
  });

  it("prefills silently instead of offering the shortcut once sender='other'", async () => {
    mockUser = { email: "pat@example.com" };
    mockSavedAddress = savedRow;
    const onAddressChange = vi.fn();
    renderStep({ sender: "other", onAddressChange });

    await waitFor(() =>
      expect(onAddressChange).toHaveBeenCalledWith(
        expect.objectContaining({ street: "388 Townsend St" }),
      ),
    );
    expect(screen.queryByRole("button", { name: /Use my saved address/i })).toBeNull();
  });

  it("never touches the destination with the account holder's address when sender='self'", async () => {
    // This screen is the OTHER party's address on that branch — prefilling it
    // is how a user ends up mailing a package to themselves.
    mockUser = { email: "pat@example.com" };
    mockSavedAddress = savedRow;
    const onAddressChange = vi.fn();
    renderStep({ sender: "self", onAddressChange });

    await waitFor(() => expect(screen.getByText(/Where's it going\?/i)).toBeInTheDocument());
    expect(onAddressChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Use my saved address/i })).toBeNull();
  });
});
