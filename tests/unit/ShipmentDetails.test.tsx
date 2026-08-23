import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ShipmentDetails from "@/components/recipient/ShipmentDetails";
import { INITIAL_DATA } from "@/lib/recipientFlowStorage";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// The only summary in the flow since 2026-08-23, and — because the progress
// bar went with the rest of the progress UI — the only way back to an earlier
// question from the payment step. Both halves are pinned here.

const ADDR = {
  name: "Jane Doe", street: "149 New Montgomery St", city: "San Francisco",
  state: "CA", zip: "94105", phone: "4155551234", verified: true,
};
const ORIGIN = { ...ADDR, name: "John Smith", street: "388 Townsend St", zip: "94107" };

function makeState(over: Partial<RecipientFlowState> = {}): RecipientFlowState {
  return {
    ...INITIAL_DATA,
    currentStep: 12,
    destinationAddress: ADDR,
    originAddress: ORIGIN,
    dimensions: { length: "10", width: "10", height: "10" },
    weight: { lbs: "5", oz: "0" },
    ...over,
  } as RecipientFlowState;
}

describe("ShipmentDetails", () => {
  it("reads from → to, in the direction a shipment travels", () => {
    render(<ShipmentDetails state={makeState()} onEdit={() => {}} />);
    const keys = screen.getAllByText(/^(from|to|parcel|via)$/i).map((e) => e.textContent);
    expect(keys).toEqual(["from", "to", "parcel", "via"]);
  });

  it("every cell edits back into the step that set it", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(<ShipmentDetails state={makeState()} onEdit={onEdit} />);

    // Steps per stepRouting: origin 10, destination 1, package 14, shipping 20.
    await user.click(screen.getByRole("button", { name: "Edit from" }));
    expect(onEdit).toHaveBeenLastCalledWith(10);
    await user.click(screen.getByRole("button", { name: "Edit to" }));
    expect(onEdit).toHaveBeenLastCalledWith(1);
    await user.click(screen.getByRole("button", { name: "Edit parcel" }));
    expect(onEdit).toHaveBeenLastCalledWith(14);
    await user.click(screen.getByRole("button", { name: "Edit via" }));
    expect(onEdit).toHaveBeenLastCalledWith(20);
  });

  it("names which product is being paid for", () => {
    // The chip, bar, banner and row icons all went; this heading is the last
    // thing that distinguishes a label from a link.
    const { rerender } = render(
      <ShipmentDetails state={makeState({ path: "full_label" })} onEdit={() => {}} />,
    );
    expect(screen.getByText("Shipment Details")).toBeInTheDocument();

    rerender(<ShipmentDetails state={makeState({ path: "flexible" })} onEdit={() => {}} />);
    expect(screen.getByText("Shipping Link Details")).toBeInTheDocument();
  });

  it("says who fills in each question the creator handed over", () => {
    render(
      <ShipmentDetails
        state={makeState({
          path: "flexible",
          deferredDestination: true,
          deferredOrigin: true,
          deferredPackage: true,
        })}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByText("Sender fills in")).toBeInTheDocument();
    expect(screen.getByText("Sender chooses")).toBeInTheDocument();
    expect(screen.getByText("Sender describes")).toBeInTheDocument();
    // Still editable — a handed-off question is the one most likely to be
    // taken back at the last moment.
    expect(screen.getByRole("button", { name: "Edit to" })).toBeEnabled();
  });

  it("carries no price on the link path", () => {
    // The cap belongs to the Estimated shipping cost panel, which bounds its
    // own range by it. Stating it here too produced two numbers that
    // disagreed — "Up to $25" above a $9–$38 range.
    render(
      <ShipmentDetails
        state={makeState({ path: "flexible", price_cap: 25, speed_preference: "no_rush" })}
        totalCents={null}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByText(/No rush/)).toBeInTheDocument();
    expect(screen.queryByText(/\$25/)).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();
  });

  it("shows the total on the label path, where it is the price", () => {
    render(
      <ShipmentDetails
        state={makeState({ path: "full_label" })}
        totalCents={920}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("$9.20")).toBeInTheDocument();
  });
});
