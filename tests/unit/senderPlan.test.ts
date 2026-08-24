import { describe, it, expect } from "vitest";
import { planSenderSteps } from "@/components/sender/senderState";

// What the sender is asked, and — the point of the whole thing — what they
// are NOT asked because the link already answers it. Before 2026-08-24 every
// sender got the same three-questions-on-one-screen form regardless.

const ORIGIN = { street1: "629 Sugar Bowl Road", phone: "4155550100" };
const PARCEL = { length_in: 20, width_in: 10, height_in: 10, weight_oz: 240 };

describe("planSenderSteps", () => {
  it("asks nothing but the destination when the creator specced the rest", () => {
    const plan = planSenderSteps({
      needs_destination: true, origin_prefill: ORIGIN, package_prefill: PARCEL,
    });
    expect(plan.questions).toEqual(["destination"]);
    expect(plan.answered).toEqual(["origin", "package"]);
  });

  it("asks for origin and parcel on a bare link", () => {
    const plan = planSenderSteps({
      needs_destination: false, origin_prefill: null, package_prefill: null,
    });
    expect(plan.questions).toEqual(["origin", "package"]);
    expect(plan.answered).toEqual([]);
  });

  it("keeps the destination out of it when the creator's address is on file", () => {
    // Rule 7 — the sender never sees or edits that address, so it is neither
    // asked nor listed as something they could edit.
    const plan = planSenderSteps({
      needs_destination: false, origin_prefill: ORIGIN, package_prefill: PARCEL,
    });
    expect(plan.questions).toEqual([]);
    expect(plan.answered).toEqual(["origin", "package"]);
  });

  it("still asks for the origin when the prefill has no usable phone", () => {
    // A phone-less from-address is rejected by the carriers, so a prefill
    // missing one is a half-answer — skipping the step would bypass the gate.
    for (const phone of [undefined, null, "", "123"]) {
      const plan = planSenderSteps({
        needs_destination: false,
        origin_prefill: { street1: "629 Sugar Bowl Road", phone },
        package_prefill: PARCEL,
      });
      expect(plan.questions).toEqual(["origin"]);
    }
  });

  it("still asks for the parcel when the prefill is missing a weight", () => {
    const plan = planSenderSteps({
      needs_destination: false, origin_prefill: ORIGIN,
      package_prefill: { ...PARCEL, weight_oz: null },
    });
    expect(plan.questions).toEqual(["package"]);
  });

  it("orders the questions the way the flow walks them", () => {
    const plan = planSenderSteps({
      needs_destination: true, origin_prefill: null, package_prefill: null,
    });
    expect(plan.questions).toEqual(["destination", "origin", "package"]);
  });
});
