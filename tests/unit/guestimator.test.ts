import { describe, it, expect } from "vitest";
import { parseGuestimation } from "@/components/recipient/MagicGuestimator";

describe("parseGuestimation", () => {
  it("recognizes laptop", () => {
    const result = parseGuestimation("a laptop");
    expect(result).not.toBeNull();
    expect(result!.itemName).toBe("Laptop");
    expect(result!.packaging).toBe("box");
    expect(result!.length).toBe(13);
    expect(result!.width).toBe(10);
    expect(result!.height).toBe(3);
    expect(result!.weightLbs).toBe(5);
  });

  it("recognizes skis with tube packaging", () => {
    const result = parseGuestimation("pair of skis");
    expect(result).not.toBeNull();
    expect(result!.packaging).toBe("tube");
    expect(result!.length).toBe(80);
    expect(result!.weightLbs).toBe(15);
  });

  it("recognizes books with envelope packaging", () => {
    const result = parseGuestimation("a textbook");
    expect(result).not.toBeNull();
    expect(result!.packaging).toBe("envelope");
    expect(result!.itemName).toBe("Book");
  });

  it("detects urgency keywords → express", () => {
    const result = parseGuestimation("urgent laptop delivery");
    expect(result).not.toBeNull();
    expect(result!.speedHint).toBe("express");
    expect(result!.itemName).toBe("Laptop");
  });

  it("detects cheap keywords → economy", () => {
    const result = parseGuestimation("ship shoes cheapest way");
    expect(result).not.toBeNull();
    expect(result!.speedHint).toBe("economy");
    expect(result!.itemName).toBe("Shoes");
  });

  it("detects 'no rush' → economy", () => {
    const result = parseGuestimation("phone, no rush");
    expect(result).not.toBeNull();
    expect(result!.speedHint).toBe("economy");
  });

  it("returns null for unknown items", () => {
    expect(parseGuestimation("a live parrot")).toBeNull();
    expect(parseGuestimation("")).toBeNull();
    expect(parseGuestimation("   ")).toBeNull();
  });

  it("is case insensitive", () => {
    const result = parseGuestimation("LAPTOP in a BOX");
    expect(result).not.toBeNull();
    expect(result!.itemName).toBe("Laptop");
  });

  it("matches phone variants", () => {
    expect(parseGuestimation("iphone 15 pro")!.itemName).toBe("Phone");
    expect(parseGuestimation("samsung galaxy")!.itemName).toBe("Phone");
  });

  it("returns no speed hint when none detected", () => {
    const result = parseGuestimation("just a laptop");
    expect(result).not.toBeNull();
    expect(result!.speedHint).toBeUndefined();
  });
});
