import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PrintAnotherLabelCTA from "../../src/components/tracking/PrintAnotherLabelCTA";

function renderWith(props: { linkShortCode: string | null; status: string; linkStatus?: string | null }) {
  return render(
    <MemoryRouter>
      <PrintAnotherLabelCTA {...props} />
    </MemoryRouter>
  );
}

describe("PrintAnotherLabelCTA", () => {
  it("renders 'Print another label' when status='cancelled' with active link", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled", linkStatus: "active" });
    expect(screen.getByText(/print another label/i)).toBeInTheDocument();
    expect(screen.getByText(/uses your existing sendmo link/i)).toBeInTheDocument();
  });

  it("links the Print-another button to /s/<short_code> when link is active", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled", linkStatus: "active" });
    const link = screen.getByRole("link", { name: /print another label/i });
    expect(link.getAttribute("href")).toBe("/s/mUgagu3HrS");
  });

  it("falls back to 'Start a new shipment' when no link_short_code (admin cancel etc.)", () => {
    renderWith({ linkShortCode: null, status: "cancelled" });
    expect(screen.getByText(/start a new shipment/i)).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/");
  });

  it("surfaces the parent link short_code on cancelled state", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled", linkStatus: "active" });
    expect(screen.getByText("mUgagu3HrS")).toBeInTheDocument();
    expect(screen.getByText(/from link/i)).toBeInTheDocument();
  });

  it("shows 'Active — you can reuse it' badge for active links", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled", linkStatus: "active" });
    expect(screen.getByText(/active — you can reuse it/i)).toBeInTheDocument();
  });

  it("shows 'In use on another label' badge when parent link is in_use", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled", linkStatus: "in_use" });
    expect(screen.getByText(/in use on another label/i)).toBeInTheDocument();
    // Button downgrades to 'Start a new shipment' since the link isn't reusable
    expect(screen.getByText(/start a new shipment/i)).toBeInTheDocument();
    expect(screen.queryByText(/print another label/i)).toBeNull();
  });

  it("shows 'Used up' badge when parent link is completed", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled", linkStatus: "completed" });
    // Badge text is "Used up — start a new shipment"; button text just
    // "Start a new shipment". Assert the badge phrasing, then the button
    // by role to disambiguate.
    expect(screen.getByText(/used up — start a new shipment/i)).toBeInTheDocument();
    const button = screen.getByRole("link", { name: /^start a new shipment/i });
    expect(button.getAttribute("href")).toBe("/");
  });

  it("does NOT render for return_to_sender (printing a new label doesn't fix a returning package)", () => {
    const { container } = renderWith({ linkShortCode: "mUgagu3HrS", status: "return_to_sender", linkStatus: "active" });
    expect(container.firstChild).toBeNull();
  });

  it("does NOT render for label_created", () => {
    const { container } = renderWith({ linkShortCode: "mUgagu3HrS", status: "label_created" });
    expect(container.firstChild).toBeNull();
  });

  it("does NOT render for in_transit / delivered", () => {
    const { container } = renderWith({ linkShortCode: "mUgagu3HrS", status: "delivered" });
    expect(container.firstChild).toBeNull();
  });
});
