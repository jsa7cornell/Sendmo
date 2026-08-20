import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import HowToShipStrip from "../../src/components/tracking/HowToShipStrip";

describe("HowToShipStrip", () => {
  it("renders all three steps (print, tape, drop off)", () => {
    render(<HowToShipStrip carrier="USPS" />);
    expect(screen.getByText("How to ship")).toBeInTheDocument();
    // Steps are bold-labeled "Print" / "Tape securely" / "Drop off" within
    // <span class="font-medium">; assert via role-position rather than text
    // since the body uses "print" in other components.
    expect(screen.getByText("Print")).toBeInTheDocument();
    expect(screen.getByText("Tape securely")).toBeInTheDocument();
    expect(screen.getByText("Drop off")).toBeInTheDocument();
  });

  it("renders the tracking-activation note with the carrier name", () => {
    render(<HowToShipStrip carrier="USPS" />);
    expect(screen.getByText(/tracking activates once usps/i)).toBeInTheDocument();
  });

  it("renders a generic 'the carrier' fallback when carrier is null", () => {
    render(<HowToShipStrip carrier={null} />);
    expect(screen.getByText(/tracking activates once the carrier/i)).toBeInTheDocument();
  });

  it("renders carrier-specific drop-off copy (UPS → UPS Store)", () => {
    render(<HowToShipStrip carrier="UPS" />);
    expect(screen.getByText(/UPS Store/i)).toBeInTheDocument();
  });

  it("falls back gracefully when the carrier is unknown", () => {
    render(<HowToShipStrip carrier="WeirdCo" />);
    expect(screen.getByText(/authorized WeirdCo location/i)).toBeInTheDocument();
  });

  it("renders the 'Find a location' deep-link when dropOffCopy returns a URL (USPS)", () => {
    render(<HowToShipStrip carrier="USPS" />);
    const link = screen.getByRole("link", { name: /find a location/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
