import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ShipmentLabelSection from "../../src/components/tracking/ShipmentLabelSection";

describe("ShipmentLabelSection", () => {
  const base = {
    labelUrl: "https://easypost-files.example.com/labels/abc.pdf",
    trackingNumber: "9405500208303118781601",
    carrier: "USPS",
  };

  it("renders the Print Label CTA as a link pointing at the PDF", () => {
    render(<ShipmentLabelSection {...base} />);
    // There are multiple links to the PDF (preview thumbnail, print, download);
    // assert the Print one specifically.
    const printLink = screen.getByRole("link", { name: /print label \(pdf\)/i });
    expect(printLink.getAttribute("href")).toBe(base.labelUrl);
    expect(printLink.getAttribute("target")).toBe("_blank");
  });

  it("renders the Download PDF secondary CTA with download attribute", () => {
    render(<ShipmentLabelSection {...base} />);
    const downloadLink = screen.getByRole("link", { name: /download pdf/i });
    expect(downloadLink.getAttribute("href")).toBe(base.labelUrl);
    expect(downloadLink.hasAttribute("download")).toBe(true);
  });

  it("displays the tracking number in the label preview header", () => {
    render(<ShipmentLabelSection {...base} />);
    expect(screen.getByText(base.trackingNumber)).toBeInTheDocument();
  });

  it("renders the privacy/single-use warning copy (per B2 option a)", () => {
    render(<ShipmentLabelSection {...base} />);
    // The note must mention the share-link privacy concern AND single-use.
    expect(screen.getByText(/anyone with this link can see the recipient's address/i)).toBeInTheDocument();
    expect(screen.getByText(/single shipment/i)).toBeInTheDocument();
  });

  it("renders carrier-specific drop-off copy keyed to the selected carrier", () => {
    render(<ShipmentLabelSection {...base} carrier="UPS" />);
    expect(screen.getByText(/UPS Store/i)).toBeInTheDocument();
  });

  it("falls back gracefully when the carrier is unknown", () => {
    render(<ShipmentLabelSection {...base} carrier="WeirdCo" />);
    expect(screen.getByText(/authorized WeirdCo location/i)).toBeInTheDocument();
  });
});
