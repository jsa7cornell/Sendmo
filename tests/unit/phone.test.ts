import { describe, it, expect } from "vitest";
import { formatPhoneAsYouType, isUsablePhone } from "@/lib/phone";

describe("phone — formatPhoneAsYouType", () => {
  it("formats a US number progressively as digits are added", () => {
    expect(formatPhoneAsYouType("408")).toBe("(408)");
    expect(formatPhoneAsYouType("408679")).toBe("(408) 679");
    expect(formatPhoneAsYouType("4086790449")).toBe("(408) 679-0449");
  });

  it("formats an international number when input starts with +", () => {
    // Leading + drops the US default and formats per detected country code.
    const formatted = formatPhoneAsYouType("+442079460958");
    expect(formatted.startsWith("+44")).toBe(true);
    expect(formatted).toContain("20");
  });

  it("passes input through raw when the user is deleting (shorter than previous)", () => {
    // Reformatting on delete re-inserts separators and traps the cursor —
    // a shorter new value means a deletion, so return it untouched.
    expect(formatPhoneAsYouType("(408) 679", "(408) 679-0")).toBe("(408) 679");
    expect(formatPhoneAsYouType("", "(408")).toBe("");
  });

  it("handles empty input", () => {
    expect(formatPhoneAsYouType("")).toBe("");
  });
});

describe("phone — isUsablePhone", () => {
  it("accepts a complete US number in various formats", () => {
    expect(isUsablePhone("4086790449")).toBe(true);
    expect(isUsablePhone("(408) 679-0449")).toBe(true);
    expect(isUsablePhone("408-679-0449")).toBe(true);
  });

  it("accepts a valid international number", () => {
    expect(isUsablePhone("+44 20 7946 0958")).toBe(true);
  });

  it("rejects too-short / incomplete numbers", () => {
    expect(isUsablePhone("408679")).toBe(false);
    expect(isUsablePhone("12345")).toBe(false);
  });

  it("rejects empty / null / undefined without throwing", () => {
    expect(isUsablePhone("")).toBe(false);
    expect(isUsablePhone(null)).toBe(false);
    expect(isUsablePhone(undefined)).toBe(false);
    expect(isUsablePhone("   ")).toBe(false);
  });

  it("rejects non-numeric garbage", () => {
    expect(isUsablePhone("not a phone")).toBe(false);
  });
});
