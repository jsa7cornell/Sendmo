import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminDebugPanel from "../../src/components/tracking/AdminDebugPanel";

// Stub the supabase + api modules — AdminDebugPanel is purely lazy; without
// expand, it never calls either. These tests cover the collapsed-state
// rendering + the visibility contract.
vi.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));
vi.mock("../../src/lib/api", () => ({
  fetchTrackingAdmin: vi.fn(),
}));

describe("AdminDebugPanel", () => {
  it("renders collapsed by default with the 'Admin debug' summary", () => {
    render(<AdminDebugPanel publicCode="NEC7J3E" />);
    // Summary copy + admin-only badge
    expect(screen.getByText(/admin debug/i)).toBeInTheDocument();
    expect(screen.getByText(/only visible to admins/i)).toBeInTheDocument();
  });

  it("does not render inner sections until expanded", () => {
    render(<AdminDebugPanel publicCode="NEC7J3E" />);
    expect(screen.queryByText(/^Identifiers$/i)).toBeNull();
    expect(screen.queryByText(/^Timeline$/i)).toBeNull();
  });

  it("does not fire the network fetch on mount (lazy load contract)", async () => {
    const { fetchTrackingAdmin } = await import("../../src/lib/api");
    (fetchTrackingAdmin as ReturnType<typeof vi.fn>).mockClear();
    render(<AdminDebugPanel publicCode="NEC7J3E" />);
    expect(fetchTrackingAdmin).not.toHaveBeenCalled();
  });
});
