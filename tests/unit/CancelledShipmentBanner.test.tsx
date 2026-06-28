import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import CancelledShipmentBanner from "../../src/components/tracking/CancelledShipmentBanner";

describe("CancelledShipmentBanner", () => {
  const base = {
    cancelledAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    actor: "session_token" as const,
    viewerIsRecipient: false,
    refundStatus: "not_applicable" as const,
    amountPaidCents: null,
  };

  it("renders the void title + body", () => {
    render(<CancelledShipmentBanner {...base} />);
    expect(screen.getByText(/this label was voided/i)).toBeInTheDocument();
    expect(screen.getByText(/the shipment will not ship/i)).toBeInTheDocument();
  });

  it("shows relative + absolute timestamp", () => {
    render(<CancelledShipmentBanner {...base} />);
    expect(screen.getByText(/Cancelled 8 minutes ago ·/)).toBeInTheDocument();
  });

  it("maps actor='admin' to 'Cancelled by SendMo admin'", () => {
    render(<CancelledShipmentBanner {...base} actor="admin" />);
    expect(screen.getByText(/cancelled by sendmo admin/i)).toBeInTheDocument();
  });

  it("maps actor='link_owner' + viewerIsRecipient=true to 'Cancelled by you'", () => {
    render(<CancelledShipmentBanner {...base} actor="link_owner" viewerIsRecipient />);
    expect(screen.getByText(/cancelled by you/i)).toBeInTheDocument();
  });

  it("maps actor='link_owner' + viewerIsRecipient=false to 'Cancelled by the recipient'", () => {
    render(<CancelledShipmentBanner {...base} actor="link_owner" viewerIsRecipient={false} />);
    expect(screen.getByText(/cancelled by the recipient/i)).toBeInTheDocument();
  });

  it("maps actor='session_token' to 'Cancelled by the sender'", () => {
    render(<CancelledShipmentBanner {...base} actor="session_token" />);
    expect(screen.getByText(/cancelled by the sender/i)).toBeInTheDocument();
  });

  it("maps actor='email_token' to 'Cancelled by the sender'", () => {
    render(<CancelledShipmentBanner {...base} actor="email_token" />);
    expect(screen.getByText(/cancelled by the sender/i)).toBeInTheDocument();
  });

  it("renders refunded chip with dollar amount", () => {
    render(<CancelledShipmentBanner {...base} refundStatus="refunded" amountPaidCents={1234} />);
    expect(screen.getByText(/refund of \$12\.34 issued/i)).toBeInTheDocument();
  });

  it("renders submitted (in-progress) chip", () => {
    render(<CancelledShipmentBanner {...base} refundStatus="submitted" />);
    expect(screen.getByText(/cancellation in progress — refund pending/i)).toBeInTheDocument();
  });

  it("renders rejected chip", () => {
    render(<CancelledShipmentBanner {...base} refundStatus="rejected" />);
    expect(screen.getByText(/cancellation rejected — please contact support/i)).toBeInTheDocument();
  });

  it("renders not_applicable chip for comp shipments", () => {
    render(<CancelledShipmentBanner {...base} refundStatus="not_applicable" />);
    // Exact match targets the chip, not the body copy ("...No charge was made for this label.")
    expect(screen.getByText("No charge was made")).toBeInTheDocument();
  });

  it("gracefully renders with no timestamp + no actor", () => {
    render(<CancelledShipmentBanner {...base} cancelledAt={null} actor={null} />);
    expect(screen.getByText(/this label was voided/i)).toBeInTheDocument();
    expect(screen.queryByText(/cancelled by/i)).toBeNull();
  });
});
