import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PrintAnotherLabelCTA from "../../src/components/tracking/PrintAnotherLabelCTA";

function renderWith(props: { linkShortCode: string | null; status: string }) {
  return render(
    <MemoryRouter>
      <PrintAnotherLabelCTA {...props} />
    </MemoryRouter>
  );
}

describe("PrintAnotherLabelCTA", () => {
  it("renders 'Print another label' when status='cancelled' with link_short_code", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled" });
    expect(screen.getByText(/print another label/i)).toBeInTheDocument();
    expect(screen.getByText(/uses your existing sendmo link/i)).toBeInTheDocument();
  });

  it("links to /s/<short_code>", () => {
    renderWith({ linkShortCode: "mUgagu3HrS", status: "cancelled" });
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/s/mUgagu3HrS");
  });

  it("falls back to 'Start a new shipment' when no link_short_code (admin cancel etc.)", () => {
    renderWith({ linkShortCode: null, status: "cancelled" });
    expect(screen.getByText(/start a new shipment/i)).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/");
  });

  it("does NOT render for return_to_sender (printing a new label doesn't fix a returning package)", () => {
    const { container } = renderWith({ linkShortCode: "mUgagu3HrS", status: "return_to_sender" });
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
