import { describe, it, expect } from "vitest";

// The useRecipientFlow hook this file was named for was deleted 2026-08-18 —
// it was a stale pre-provider duplicate whose step maps lacked step 14. Its
// pure helpers (validation / canFetchRates) live on and are pinned here.
import { canFetchRates, type RecipientFlowState } from "@/hooks/useRecipientFlow";
import { emptyAddress } from "@/lib/utils";

// ─── canFetchRates — phone gate (audit finding 2) ───────────────────────────
//
// canFetchRates is the predicate that gates the debounced full-label rate
// fetch. Before the fix it checked verified/street/dims/weight but NOT phone —
// so a phone-less verified address let fetchRates run, addressToApi threw, and
// the user saw the raw "addressToApi: incomplete address (...)" string. These
// pin that canFetchRates now refuses to fetch until BOTH addresses have a
// usable phone, matching getValidationErrors steps 1 + 10.

describe("canFetchRates — phone gate", () => {
  const ready = (originPhone: string, destPhone: string): RecipientFlowState =>
    ({
      originAddress: {
        ...emptyAddress(),
        street: "1 Origin St",
        city: "San Francisco",
        state: "CA",
        zip: "94107",
        phone: originPhone,
        verified: true,
      },
      destinationAddress: {
        ...emptyAddress(),
        street: "2 Dest Ave",
        city: "Oakland",
        state: "CA",
        zip: "94612",
        phone: destPhone,
        verified: true,
      },
      dimensions: { length: "10", width: "8", height: "6" },
      weight: { lbs: "2", oz: "0" },
      packagingType: "box",
    } as RecipientFlowState);

  it("returns true when both addresses have a usable phone", () => {
    expect(canFetchRates(ready("4155550100", "4155550142"))).toBe(true);
  });

  it("returns false when the origin phone is missing", () => {
    expect(canFetchRates(ready("", "4155550142"))).toBe(false);
  });

  it("returns false when the destination phone is missing", () => {
    expect(canFetchRates(ready("4155550100", ""))).toBe(false);
  });

  it("returns false when a phone is present but not plausible", () => {
    expect(canFetchRates(ready("123", "4155550142"))).toBe(false);
  });
});
