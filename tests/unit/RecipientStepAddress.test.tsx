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

// SavedAddressPicker reads the whole address book and dedupes it. The query
// is awaited directly (no .single()), so the chain has to be thenable.
let mockSavedRows: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    then: (resolve: (v: { data: unknown }) => unknown) => resolve({ data: mockSavedRows }),
    maybeSingle: () => Promise.resolve({ data: mockSavedRows[0] ?? null }),
    single: () => Promise.resolve({ data: null }),
  };
  return { supabase: { from: () => chain, auth: {} } };
});

import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import { emptyAddress } from "@/lib/utils";
import type { SenderKind } from "@/lib/types";

const savedRow = {
  id: "a1",
  name: "Pat Smith",
  street1: "388 Townsend St",
  street2: null,
  city: "San Francisco",
  state: "CA",
  zip: "94107",
  phone: "4155550100",
  is_verified: true,
  created_at: "2026-08-01T00:00:00Z",
};

const secondRow = {
  ...savedRow,
  id: "a2",
  name: "Mum",
  street1: "22 Elm Road",
  city: "Portland",
  state: "OR",
  zip: "97201",
  created_at: "2026-07-01T00:00:00Z",
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
  mockSavedRows = [];
});

describe("RecipientStepAddress", () => {
  it("collects no identity — no email field, no Google CTA, no signed-in pill", () => {
    mockUser = { email: "pat@example.com", user_metadata: { full_name: "Pat Smith" } };
    renderStep();

    expect(screen.queryByLabelText(/Email address/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in with Google/i })).toBeNull();
    expect(screen.queryByText("pat@example.com")).toBeNull();
  });

  it("lets a user with two saved addresses see and choose", async () => {
    // The bug this fixes: the old shortcut silently took the most recent row,
    // so someone with a home address and their mum's got whichever they typed
    // last with no way to see or change it.
    mockUser = { email: "pat@example.com" };
    mockSavedRows = [savedRow, secondRow];
    const onAddressChange = vi.fn();
    const user = userEvent.setup();
    renderStep({ onAddressChange });

    // The count is what signals a choice exists at all.
    const trigger = await screen.findByRole("button", { name: /Use a saved address/i });
    expect(trigger).toHaveTextContent("2");

    await user.click(trigger);
    expect(screen.getByText("Pat Smith")).toBeInTheDocument();
    expect(screen.getByText("Mum")).toBeInTheDocument();

    await user.click(screen.getByText("Mum"));
    expect(onAddressChange).toHaveBeenCalledWith(
      expect.objectContaining({ street: "22 Elm Road", city: "Portland" }),
    );
  });

  it("collapses the append-only log to one entry per address", async () => {
    // Every link creation inserts a new row, so the same address recurs once
    // per shipment. Listing the table raw shows it repeatedly.
    mockUser = { email: "pat@example.com" };
    mockSavedRows = [
      { ...savedRow, id: "a3", created_at: "2026-08-10T00:00:00Z" },
      { ...savedRow, id: "a2", name: "P. Smith", created_at: "2026-08-05T00:00:00Z" },
      savedRow,
    ];
    const user = userEvent.setup();
    renderStep();

    const trigger = await screen.findByRole("button", { name: /Use a saved address/i });
    // One address, so no count — three rows collapsed to one entry.
    expect(trigger).not.toHaveTextContent("3");
    await user.click(trigger);
    expect(screen.getAllByText(/388 Townsend St/)).toHaveLength(1);
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

  it("never fills the form without being asked", async () => {
    // The silent prefill went with the picker (2026-08-23). Dropping the most
    // recent row into the form unannounced is indistinguishable from a picker
    // that guessed, and wrong as soon as a user has two saved addresses.
    mockUser = { email: "pat@example.com" };
    mockSavedRows = [savedRow, secondRow];
    const onAddressChange = vi.fn();
    renderStep({ sender: "other", onAddressChange });

    await screen.findByRole("button", { name: /Use a saved address/i });
    expect(onAddressChange).not.toHaveBeenCalled();
  });

  it("never touches the destination with the account holder's address when sender='self'", async () => {
    // This screen is the OTHER party's address on that branch — prefilling it
    // is how a user ends up mailing a package to themselves. The picker is
    // still offered (choosing is explicit, so it cannot mis-fill on its own),
    // but nothing may be written without a click.
    mockUser = { email: "pat@example.com" };
    mockSavedRows = [savedRow, secondRow];
    const onAddressChange = vi.fn();
    renderStep({ sender: "self", onAddressChange });

    await waitFor(() => expect(screen.getByText(/Where's it going\?/i)).toBeInTheDocument());
    expect(onAddressChange).not.toHaveBeenCalled();
  });
});
