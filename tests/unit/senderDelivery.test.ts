import { describe, it, expect } from "vitest";
import { formatDeliveryEstimate } from "@/lib/senderDelivery";

// Dates are constructed in LOCAL time (new Date(y, m, d)) to match the
// module — see its timezone note. Constructing them from ISO strings would
// make these tests pass or fail depending on the runner's offset.
const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

describe("formatDeliveryEstimate", () => {
  it("renders a hedged range, never a bare arrival date", () => {
    const out = formatDeliveryEstimate(3, on(2026, 8, 18));
    expect(out).toBe("Estimated Aug 21–23");
    expect(out).not.toMatch(/^Arrives/);
  });

  it("spans a month boundary readably", () => {
    expect(formatDeliveryEstimate(2, on(2026, 8, 29))).toBe("Estimated Aug 31 – Sep 2");
  });

  it("handles same-day estimates", () => {
    expect(formatDeliveryEstimate(0, on(2026, 8, 18))).toBe("Estimated Aug 18–20");
  });

  it("crosses a year boundary", () => {
    expect(formatDeliveryEstimate(1, on(2026, 12, 31))).toBe("Estimated Jan 1–3");
  });

  it("returns null when the carrier gave no estimate — the caller renders nothing", () => {
    expect(formatDeliveryEstimate(null, on(2026, 8, 18))).toBeNull();
    expect(formatDeliveryEstimate(undefined, on(2026, 8, 18))).toBeNull();
  });

  it("returns null for nonsense rather than printing it", () => {
    expect(formatDeliveryEstimate(-1, on(2026, 8, 18))).toBeNull();
    expect(formatDeliveryEstimate(NaN, on(2026, 8, 18))).toBeNull();
    expect(formatDeliveryEstimate(Infinity, on(2026, 8, 18))).toBeNull();
  });

  it("is not sensitive to the time of day — an evening order keeps the user's date", () => {
    const morning = formatDeliveryEstimate(3, new Date(2026, 7, 18, 9, 0, 0));
    const evening = formatDeliveryEstimate(3, new Date(2026, 7, 18, 23, 30, 0));
    expect(evening).toBe(morning);
  });
});
