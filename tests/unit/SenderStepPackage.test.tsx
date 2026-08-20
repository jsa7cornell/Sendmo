import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ─── Regression guard: phone must gate the sender flow (audit finding, test gap) ─
//
// SenderStepPackage (the /s/<code> sender wizard, step "package") collects the
// SENDER's origin address — which also needs a phone (FedEx/UPS reject the
// label purchase without one). handleContinue already gates this, but the gate
// had zero test coverage — the exact exposure LinksEditor had before b1e6715.
// These tests pin it so the sender gate can't silently drift.

// SmartAddressInput + MagicGuestimator are exercised by their own tests; stub
// them so this test isolates SenderStepPackage's gating logic. The address
// (incl. phone) is supplied via the `senderAddress` prop.
vi.mock("@/components/ui/SmartAddressInput", () => ({
  default: () => <div>smart-address-input</div>,
}));
vi.mock("@/components/recipient/MagicGuestimator", () => ({
  default: () => <div>magic-guestimator</div>,
}));

import SenderStepPackage from "@/components/sender/SenderStepPackage";
import type { SenderParcel } from "@/components/sender/senderState";
import type { LinkData } from "@/lib/api";
import type { AddressInput } from "@/lib/types";
import { emptyAddress } from "@/lib/utils";

const linkData = {
  id: "link-1",
  short_code: "abc123",
  link_type: "flexible",
  status: "active",
  recipient_name: "Pat Smith",
  recipient_city: "Oakland",
  recipient_state: "CA",
} as unknown as LinkData;

// A complete, dimensioned parcel so the ONLY thing under test is the phone gate.
const validParcel: SenderParcel = {
  length: 10,
  width: 8,
  height: 6,
  weightOz: 32,
  description: "",
  packaging: "box",
};

function senderAddress(phone: string): AddressInput {
  return {
    ...emptyAddress(),
    name: "Sam Sender",
    street: "1 Origin St",
    city: "San Francisco",
    state: "CA",
    zip: "94107",
    phone,
    verified: true,
  };
}

function renderStep(phone: string, onSubmit: () => void) {
  return render(
    <SenderStepPackage
      linkData={linkData}
      senderAddress={senderAddress(phone)}
      onAddressChange={() => {}}
      initialParcel={validParcel}
      onSubmit={onSubmit}
      onBack={() => {}}
    />,
  );
}

describe("SenderStepPackage — phone gate", () => {
  it("does NOT submit when the sender phone is missing", () => {
    const onSubmit = vi.fn();
    renderStep("", onSubmit);

    fireEvent.click(screen.getByRole("button", { name: /see shipping options/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/phone number — the shipping carriers require it/i)).toBeInTheDocument();
  });

  it("does NOT submit when the sender phone is present but not plausible", () => {
    const onSubmit = vi.fn();
    renderStep("123", onSubmit);

    fireEvent.click(screen.getByRole("button", { name: /see shipping options/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/phone number — the shipping carriers require it/i)).toBeInTheDocument();
  });

  it("submits when address, phone, and dimensions are all valid", () => {
    const onSubmit = vi.fn();
    renderStep("(415) 555-0100", onSubmit);

    fireEvent.click(screen.getByRole("button", { name: /see shipping options/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
