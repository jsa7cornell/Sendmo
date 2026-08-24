import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// ─── Regression guard: phone must gate the sender flow (audit finding) ───
//
// The gate lived in SenderStepPackage until 2026-08-24, when the sender's
// ship-from address became its own step. Same gate, same reason: FedEx/UPS
// reject the label purchase without a phone on the from-address. The other
// half of the guard is planSenderSteps — a link whose prefilled origin has no
// usable phone must still ASK, or the gate is bypassed by a skipped step.
// That half is pinned in senderPlan.test.ts.

vi.mock("@/components/ui/SmartAddressInput", () => ({
  default: () => <div>smart-address-input</div>,
}));

import SenderStepOrigin, { originErrors } from "@/components/sender/SenderStepOrigin";
import type { AddressInput } from "@/lib/types";
import { emptyAddress } from "@/lib/utils";

function address(phone: string): AddressInput {
  return {
    ...emptyAddress(),
    name: "Sam Sender", street: "1 Origin St", city: "San Francisco",
    state: "CA", zip: "94107", phone, verified: true,
  };
}

function renderStep(phone: string, onContinue: () => void) {
  const value = address(phone);
  return render(
    <SenderStepOrigin
      value={value}
      onChange={() => {}}
      tried={originErrors(value).length > 0}
      continueLabel="See shipping options"
      onContinue={() => { if (originErrors(value).length === 0) onContinue(); }}
    />,
  );
}

describe("SenderStepOrigin — phone gate", () => {
  it("does NOT continue when the phone is missing", () => {
    const onContinue = vi.fn();
    renderStep("", onContinue);
    fireEvent.click(screen.getByRole("button", { name: /see shipping options/i }));
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getAllByText(/phone number — the carriers require one/i).length).toBeGreaterThan(0);
  });

  it("does NOT continue when the phone is present but not plausible", () => {
    const onContinue = vi.fn();
    renderStep("123", onContinue);
    fireEvent.click(screen.getByRole("button", { name: /see shipping options/i }));
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("continues when the address and phone are valid", () => {
    const onContinue = vi.fn();
    renderStep("(415) 555-0100", onContinue);
    fireEvent.click(screen.getByRole("button", { name: /see shipping options/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
