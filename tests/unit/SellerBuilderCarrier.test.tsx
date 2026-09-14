import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ─── The seller's carrier constraint ────────────────────────────────────────
//
// Restores the carrier half of the decided 2026-08-28 seller-link spec (§245:
// "the cap control leaves the seller builder entirely — carrier and speed
// stay"). PR #131 removed all three "for now" while only the cap removal was
// authorised, and SendMo's first real seller asked for it back twelve days
// later: "i could set only usps or ups".
//
// Two things these tests exist to pin, both of which the proposal's first draft
// got wrong:
//
//  1. The picker must reach handleCreate. The original file plan pointed at a
//     <LinkShareCard> display prop on the step-4 ready screen, which renders
//     AFTER the link exists — a control wired there would have written nothing.
//     Prod agreed: all 7 seller links are preferred_carrier NULL.
//  2. "USPS or UPS" needs a multi-select. A single-value control can express
//     one carrier or none, which is not what was asked for.

// @/lib/api reaches @/lib/supabase, which calls createClient at module scope —
// no env in a test run, so stub it the way App.test.tsx does.
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockImplementation((cb: (e: string, s: null) => void) => {
        cb("INITIAL_SESSION", null);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
  },
}));

vi.mock("@/lib/featureFlags", () => ({
  SELLER_LINK_LIVE: true,
  SELLER_LINK_VISIBLE: true,
  SELLER_LINK_MODE: "live",
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    session: { access_token: "test-token" },
    loading: false,
    isAdmin: false,
  }),
}));

const mockCreateSellerLink = vi.fn();
vi.mock("@/lib/api", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, createSellerLink: (...a: unknown[]) => mockCreateSellerLink(...a) };
});

import SellerBuilder from "@/pages/SellerBuilder";

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={["/sell"]}>
      <SellerBuilder />
    </MemoryRouter>,
  );
}

/** The collapsed disclosure that holds the carrier chips. */
function openCarrierPicker() {
  const toggle = screen.getByRole("button", { name: /which carriers can you drop off at/i });
  fireEvent.click(toggle);
  return toggle;
}

function carrierChip(label: string) {
  return screen.getByRole("button", { name: new RegExp(`^${label}$`, "i") });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSellerLink.mockResolvedValue({ short_code: "abc123" });
});

describe("SellerBuilder — carrier constraint", () => {
  it("keeps the control collapsed, so step 1 stays as short as the 2026-08-29 trim left it", () => {
    renderBuilder();
    const toggle = screen.getByRole("button", { name: /which carriers can you drop off at/i });
    expect(toggle).toBeTruthy();
    // Chips are not rendered until the seller opens it.
    expect(screen.queryByRole("button", { name: /^fedex$/i })).toBeNull();
  });

  it("defaults to all three carriers and summarises that as 'Any'", () => {
    renderBuilder();
    const toggle = screen.getByRole("button", { name: /which carriers can you drop off at/i });
    expect(within(toggle).getByText(/^Any$/)).toBeTruthy();

    openCarrierPicker();
    for (const name of ["USPS", "UPS", "FedEx"]) {
      expect(carrierChip(name).getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("lets the seller pick USPS or UPS together — the thing that was actually asked for", () => {
    renderBuilder();
    const toggle = openCarrierPicker();

    fireEvent.click(carrierChip("FedEx")); // drop the one they can't reach

    expect(carrierChip("USPS").getAttribute("aria-pressed")).toBe("true");
    expect(carrierChip("UPS").getAttribute("aria-pressed")).toBe("true");
    expect(carrierChip("FedEx").getAttribute("aria-pressed")).toBe("false");
    expect(within(toggle).getByText(/USPS, UPS/)).toBeTruthy();
  });

  it("never lets the last carrier be cleared — zero carriers would quote nothing", () => {
    renderBuilder();
    openCarrierPicker();

    fireEvent.click(carrierChip("FedEx"));
    fireEvent.click(carrierChip("UPS"));
    expect(carrierChip("USPS").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(carrierChip("USPS")); // the last one — must be refused
    expect(carrierChip("USPS").getAttribute("aria-pressed")).toBe("true");
  });

  it("re-selecting every carrier returns to the unconstrained summary", () => {
    renderBuilder();
    const toggle = openCarrierPicker();

    fireEvent.click(carrierChip("FedEx"));
    expect(within(toggle).queryByText(/^Any$/)).toBeNull();

    fireEvent.click(carrierChip("FedEx"));
    expect(within(toggle).getByText(/^Any$/)).toBeTruthy();
  });
});
