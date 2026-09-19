import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LinksTab from "@/components/dashboard/LinksTab";

// PR5 (seller-link launch): the seller's off switch. With no inventory
// counting, closing the listing is the only way "sold out" happens — so the
// control must exist exactly where the proposal says (the listing card),
// only for ACTIVE seller links, and behind a confirm dialog.

const baseLink = {
  id: "l1", short_code: "SELLCODE1", created_at: "2026-08-29T00:00:00Z",
  recipient_address: null, shipments: [], total_shipments: 0,
};

function renderTab(link: Record<string, unknown>, onCloseLink = vi.fn(() => Promise.resolve())) {
  render(
    <MemoryRouter>
      <LinksTab links={[{ ...baseLink, ...link } as never]} loading={false} onCloseLink={onCloseLink} />
    </MemoryRouter>,
  );
  return onCloseLink;
}

describe("LinksTab — Close link", () => {
  it("shows the control only on an ACTIVE checkout link — chipped 'Buyer pays' (dashboard scrub)", () => {
    renderTab({ link_type: "seller_link", status: "active" });
    expect(screen.getByRole("button", { name: /Close link/i })).toBeInTheDocument();
    // The who-pays chip replaced the schema-taxonomy badge (PR6's guarantee
    // holds one level up: userLinkTypeLabel can't silently mislabel a type).
    expect(screen.getByText("Buyer pays")).toBeInTheDocument();
    expect(screen.getByText(/Checkout link/)).toBeInTheDocument();
    expect(screen.queryByText("Flexible")).toBeNull();
    // And no Manage — seller listings are immutable (close-and-recreate).
    expect(screen.queryByRole("link", { name: /Manage/i })).toBeNull();
  });

  it("titles the seller card by its item text (PR12 + dashboard scrub)", () => {
    renderTab({ link_type: "seller_link", status: "active", notes: "Vintage armchair" });
    expect(screen.getByText("Vintage armchair")).toBeInTheDocument();
  });

  it("hides it on flex links and non-active seller links", () => {
    renderTab({ link_type: "flexible", status: "active" });
    expect(screen.queryByRole("button", { name: /Close link/i })).toBeNull();
  });

  it("hides it on a closed seller link, and labels the status Closed", () => {
    renderTab({ link_type: "seller_link", status: "closed" });
    expect(screen.queryByRole("button", { name: /Close link/i })).toBeNull();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("closes only after the confirm dialog, then resolves", async () => {
    const onCloseLink = renderTab({ link_type: "seller_link", status: "active" });
    fireEvent.click(screen.getByRole("button", { name: /Close link/i }));
    // Nothing called yet — the dialog is the gate. (Radix marks the page
    // behind the portal aria-hidden, so queries now resolve inside it.)
    expect(onCloseLink).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: /Close this link\?/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /Close link/i }));
    await waitFor(() => expect(onCloseLink).toHaveBeenCalledWith("l1"));
  });

  it("surfaces a rejection in the dialog instead of closing it", async () => {
    const failing = vi.fn(() => Promise.reject(new Error("The link changed state while closing")));
    renderTab({ link_type: "seller_link", status: "active" }, failing);
    fireEvent.click(screen.getByRole("button", { name: /Close link/i }));
    const dialog = screen.getByRole("dialog", { name: /Close this link\?/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /Close link/i }));
    await waitFor(() =>
      expect(screen.getByText(/changed state while closing/i)).toBeInTheDocument());
  });
});
