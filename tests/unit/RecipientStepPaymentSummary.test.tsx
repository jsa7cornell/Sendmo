import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import RecipientStepPaymentSummary from "@/components/recipient/RecipientStepPaymentSummary";
import { INITIAL_DATA } from "@/lib/recipientFlowStorage";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// The last screen a creator reads before their card is charged. Three things
// here were explicit decisions by John on 2026-08-19, so they get pinned:
//
//   - Total is a ROW IN THE LIST, not a separate emphasised block.
//   - It renders on BOTH paths. The handoff specced it only for the link path;
//     the label path is where every dollar to date came from and had no
//     pre-charge summary at all.
//   - The charge note never claims a lifetime cap (see senderTodo.test.ts).

function state(over: Partial<RecipientFlowState> = {}): RecipientFlowState {
  return {
    ...INITIAL_DATA,
    currentStep: 12,
    destinationAddress: { ...INITIAL_DATA.destinationAddress, name: "Jane Doe", street: "1 A St", city: "Oakland", state: "CA", zip: "94607" },
    originAddress: { ...INITIAL_DATA.originAddress, name: "Sam Smith", street: "2 B St", city: "Reno", state: "NV", zip: "89501" },
    itemDescription: "hardcover cookbook",
    ...over,
  } as RecipientFlowState;
}

describe("RecipientStepPaymentSummary", () => {
  it("shows an exact total on the label path", () => {
    render(<RecipientStepPaymentSummary state={state({ path: "full_label" })} totalCents={1234} />);

    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("$12.34")).toBeInTheDocument();
    expect(screen.getByText("Prepaid label")).toBeInTheDocument();
  });

  it("scopes the cap to one shipment on the link path", () => {
    render(<RecipientStepPaymentSummary state={state({ path: "flexible", price_cap: 100 })} />);

    // "per shipment" is load-bearing: a flexible link sets neither expires_at
    // nor max_shipments, so a bare "Up to $100" next to "Total" would read as
    // a lifetime ceiling that does not exist.
    expect(screen.getByText(/Up to \$100 per shipment/)).toBeInTheDocument();
  });

  it("names the deferred slots as the sender's job rather than as blanks", () => {
    render(
      <RecipientStepPaymentSummary
        state={state({ path: "flexible", deferredDestination: true, deferredPackage: true })}
      />,
    );

    expect(screen.getAllByText("Sender fills this in")).toHaveLength(2);
    // Origin was NOT deferred, so it still shows.
    expect(screen.getByText(/Sam/)).toBeInTheDocument();
    expect(
      screen.getByText(/The person printing the label will add the delivery address and describe the package\./),
    ).toBeInTheDocument();
  });

  it("omits the charge note on a prepaid label, where the charge is NOW", () => {
    render(<RecipientStepPaymentSummary state={state({ path: "full_label" })} totalCents={900} />);

    expect(screen.queryByText("Sender fills this in")).not.toBeInTheDocument();
    // "We'll charge your card once they ship" is true of a link and false of a
    // prepaid label — that card is charged on this screen, for the exact
    // amount shown. Showing it on both paths would be the more consistent
    // layout and the wrong statement. (full_label implies no deferrals:
    // pathForFlags routes any deferred field to "flexible".)
    expect(screen.queryByText(/We'll charge your card once they ship/)).not.toBeInTheDocument();
  });
});
