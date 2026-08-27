import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import SenderStepIntro from "../../src/components/sender/SenderStepIntro";
import type { LinkData } from "../../src/lib/api";

// 2026-08-26: the intro renders the shared ShipmentDetailsCard instead of a
// numbered list of upcoming questions. What used to be "Tell us where it's
// shipping from" is now a FROM cell reading "You'll add this" — same fact,
// stated as a blank in the shipment rather than a step in a wizard. These
// tests moved with it.

const ORIGIN: NonNullable<LinkData["origin_prefill"]> = {
  name: "maya torres", street1: "1200 Market St", street2: null,
  city: "San Francisco", state: "CA", zip: "94102", phone: "4155550142", verified: true,
};
const PARCEL: NonNullable<LinkData["package_prefill"]> = {
  length_in: 12, width_in: 9, height_in: 4, weight_oz: 32,
};

function makeLink(overrides: Partial<LinkData> = {}): LinkData {
  return {
    id: "x",
    short_code: "abc",
    link_type: "flexible",
    status: "active",
    max_price_cents: 10000,
    preferred_speed: "standard",
    preferred_carrier: null,
    size_hint: null,
    notes: null,
    recipient_city: "Seattle",
    recipient_state: "WA",
    recipient_zip: "98101",
    recipient_name: "Alex",
    recipient_address_complete: true,
    ...overrides,
  };
}

describe("SenderStepIntro", () => {
  it("names the person who paid, in the headline", () => {
    render(<SenderStepIntro linkData={makeLink()} questions={["package"]} onContinue={() => {}} />);
    expect(screen.getByText(/Alex shared a prepaid shipping label with you/i)).toBeInTheDocument();
  });

  it("falls back to a nameless headline when recipient_name is missing", () => {
    render(<SenderStepIntro linkData={makeLink({ recipient_name: null })} questions={["package"]} onContinue={() => {}} />);
    expect(screen.getByText(/You've been sent a prepaid shipping label/i)).toBeInTheDocument();
  });

  it("shows city/state but NEVER street/zip (Rule 7)", () => {
    render(<SenderStepIntro linkData={makeLink()} questions={["package"]} onContinue={() => {}} />);
    expect(screen.getByText(/Seattle, WA/)).toBeInTheDocument();
    // street/zip must not appear in the sender UI text per PLAYBOOK rule 7.
    expect(screen.queryByText(/98101/)).not.toBeInTheDocument();
  });

  it("calls onContinue when the CTA is clicked", () => {
    const onContinue = vi.fn();
    render(<SenderStepIntro linkData={makeLink()} questions={["package"]} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  // The blanks ARE the questions: a cell reads "You'll …" exactly when this
  // link leaves that question open, and shows the creator's answer otherwise.
  it("blanks only the cells this link leaves open", () => {
    render(
      <SenderStepIntro
        linkData={makeLink({ needs_destination: true, origin_prefill: ORIGIN, package_prefill: PARCEL })}
        questions={["destination"]}
        onContinue={() => {}}
      />,
    );
    expect(screen.getByText("You choose")).toBeInTheDocument();
    expect(screen.queryByText("You'll add this")).not.toBeInTheDocument();
    expect(screen.queryByText("You'll describe it")).not.toBeInTheDocument();
    // …and the answers the creator did supply are on screen.
    expect(screen.getByText("Maya Torres")).toBeInTheDocument();
    expect(screen.getByText("12×9×4 in")).toBeInTheDocument();
    expect(screen.getByText("2 lb")).toBeInTheDocument();
    // Carried over from the 2026-08-24 cleanup: neither device may come back.
    expect(screen.queryByText("SendMo Label Link")).not.toBeInTheDocument();
    expect(screen.queryByText(/already set/i)).not.toBeInTheDocument();
  });

  it("blanks everything the link left open", () => {
    render(<SenderStepIntro linkData={makeLink()} questions={["origin", "package"]} onContinue={() => {}} />);
    expect(screen.getByText("You'll add this")).toBeInTheDocument();
    expect(screen.getByText("You'll describe it")).toBeInTheDocument();
    // The destination is the creator's own and was never a question.
    expect(screen.queryByText("You choose")).not.toBeInTheDocument();
  });

  // The cap is the one number a sender may see. Rates never are.
  it("states the prepaid cap when the link carries one", () => {
    render(<SenderStepIntro linkData={makeLink({ max_price_cents: 2500 })} questions={["package"]} onContinue={() => {}} />);
    expect(screen.getByText("prepaid up to")).toBeInTheDocument();
    expect(screen.getByText("$25.00")).toBeInTheDocument();
  });

  // max_price_cents is a ceiling the recipient chose ONLY on a flex link. On a
  // full_label link it is the exact amount already charged, so printing it
  // would disclose the shipment's real price under a "prepaid up to" label.
  // Such a link normally redirects to /t/<code>, but that guard needs a
  // public_code and a full_label link with no shipment row resolves it null.
  it("never states a cap on a full_label link, where it is the exact amount paid", () => {
    render(
      <SenderStepIntro
        linkData={makeLink({ link_type: "full_label", max_price_cents: 703 })}
        questions={["package"]}
        onContinue={() => {}}
      />,
    );
    expect(screen.queryByText("prepaid up to")).not.toBeInTheDocument();
    expect(screen.queryByText("$7.03")).not.toBeInTheDocument();
  });

  // The intro and the review step describe one parcel; a prefill with no
  // height used to render "12×9 in" here and "12×9×1 in" two screens later,
  // because SenderFlow seeds the flow's parcel with `height_in ?? 1`.
  it("prints the height the flow will actually use when the prefill has none", () => {
    render(
      <SenderStepIntro
        linkData={makeLink({ package_prefill: { ...PARCEL, height_in: null } })}
        questions={[]}
        onContinue={() => {}}
      />,
    );
    expect(screen.getByText("12×9×1 in")).toBeInTheDocument();
  });

  it("omits the cap cell entirely when there is no cap", () => {
    render(<SenderStepIntro linkData={makeLink({ max_price_cents: 0 })} questions={["package"]} onContinue={() => {}} />);
    expect(screen.queryByText("prepaid up to")).not.toBeInTheDocument();
    // The reassurance still has to land without it.
    expect(screen.getByText(/prepaid by Alex — you're not charged/i)).toBeInTheDocument();
  });

  // "or faster" is literal: the rates endpoint keeps the preferred tier and
  // everything quicker. And 'economy' must not render as a raw lowercase word.
  it("states the speed preference as preferred-or-faster", () => {
    render(<SenderStepIntro linkData={makeLink({ preferred_speed: "economy" })} questions={["package"]} onContinue={() => {}} />);
    expect(screen.getByText("Economy or faster")).toBeInTheDocument();
  });

  // preferred_carrier is stored lowercase by the creator's picker.
  it("renders a lowercase carrier preference with its proper name", () => {
    render(<SenderStepIntro linkData={makeLink({ preferred_carrier: "usps" })} questions={["package"]} onContinue={() => {}} />);
    expect(screen.getByText("USPS only")).toBeInTheDocument();
  });

  it("leaves VIA blank when the link expresses no preference at all", () => {
    render(
      <SenderStepIntro
        linkData={makeLink({ preferred_speed: null, preferred_carrier: "any" })}
        questions={["package"]}
        onContinue={() => {}}
      />,
    );
    expect(screen.getByText("You'll pick")).toBeInTheDocument();
  });
});
