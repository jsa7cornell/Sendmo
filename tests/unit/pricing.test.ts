import { describe, it, expect } from "vitest";
import { applyMargin, addInsurance, formatCents, isOverCap } from "@/lib/api";

describe("applyMargin", () => {
  it("applies 15% margin to a rate", () => {
    expect(applyMargin(1000)).toBe(1150); // $10.00 → $11.50
  });

  it("rounds to nearest cent", () => {
    expect(applyMargin(333)).toBe(383); // $3.33 × 1.15 = $3.8295 → $3.83
  });

  it("handles zero", () => {
    expect(applyMargin(0)).toBe(0);
  });
});

describe("addInsurance", () => {
  it("adds $2.50 (250 cents)", () => {
    expect(addInsurance(1150)).toBe(1400); // $11.50 + $2.50 = $14.00
  });
});

describe("formatCents", () => {
  it("formats cents as dollar string", () => {
    expect(formatCents(1150)).toBe("$11.50");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(99)).toBe("$0.99");
    expect(formatCents(10000)).toBe("$100.00");
  });
});

describe("isOverCap", () => {
  it("returns false when under default $100 cap", () => {
    expect(isOverCap(9999)).toBe(false);
  });

  it("returns false at exactly $100", () => {
    expect(isOverCap(10000)).toBe(false);
  });

  it("returns true when over $100", () => {
    expect(isOverCap(10001)).toBe(true);
  });

  it("respects custom cap", () => {
    expect(isOverCap(5001, 50)).toBe(true);
    expect(isOverCap(5000, 50)).toBe(false);
  });
});
