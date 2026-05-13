import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AdminAffordanceFooter from "../../src/components/tracking/AdminAffordanceFooter";

describe("AdminAffordanceFooter", () => {
  it("deep-links to /admin?shipment=<id> when shipmentId provided", () => {
    render(
      <MemoryRouter>
        <AdminAffordanceFooter shipmentId="8d3f1c2a-7e9b-4d11-9d4e-1cbe1f6a9e21" />
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: /admin debug/i });
    expect(link.getAttribute("href")).toBe("/admin?shipment=8d3f1c2a-7e9b-4d11-9d4e-1cbe1f6a9e21");
  });

  it("falls back to /admin when shipmentId is undefined (server-side gate dropped it)", () => {
    render(
      <MemoryRouter>
        <AdminAffordanceFooter shipmentId={undefined} />
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: /admin debug/i });
    expect(link.getAttribute("href")).toBe("/admin");
  });

  it("URL-encodes the shipment id", () => {
    render(
      <MemoryRouter>
        <AdminAffordanceFooter shipmentId="weird id with spaces" />
      </MemoryRouter>
    );
    const link = screen.getByRole("link", { name: /admin debug/i });
    expect(link.getAttribute("href")).toBe("/admin?shipment=weird%20id%20with%20spaces");
  });
});
