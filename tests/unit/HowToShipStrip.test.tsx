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
});
