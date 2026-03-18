import { describe, it, expect } from "vitest";
import { carrierDisplayName, serviceDisplayName, classifySpeedTier } from "@/lib/utils";

describe("carrierDisplayName", () => {
  it("normalizes EasyPost carrier codes to display names", () => {
    expect(carrierDisplayName("UPSDAP")).toBe("UPS");
    expect(carrierDisplayName("FedExDefault")).toBe("FedEx");
    expect(carrierDisplayName("USPS")).toBe("USPS");
    expect(carrierDisplayName("DhlEcs")).toBe("DHL eCommerce");
  });

  it("returns raw value for unknown carriers", () => {
    expect(carrierDisplayName("SomeNewCarrier")).toBe("SomeNewCarrier");
  });
});

describe("serviceDisplayName", () => {
  it("maps known EasyPost service names to readable names", () => {
    expect(serviceDisplayName("GROUND_HOME_DELIVERY")).toBe("Home Delivery");
    expect(serviceDisplayName("FEDEX_2_DAY")).toBe("2 Day");
    expect(serviceDisplayName("GroundAdvantage")).toBe("Ground Advantage");
    expect(serviceDisplayName("Priority")).toBe("Priority Mail");
    expect(serviceDisplayName("Upsgroundsavergreaterthan1lb")).toBe("Ground Saver");
    expect(serviceDisplayName("Nextdayairearlyam")).toBe("Next Day Air Early AM");
  });

  it("falls back to camelCase splitting for unknown services", () => {
    expect(serviceDisplayName("SomeNewService")).toBe("Some New Service");
    expect(serviceDisplayName("SOME_THING")).toBe("Some Thing");
  });
});

describe("classifySpeedTier", () => {
  it("classifies USPS services", () => {
    expect(classifySpeedTier("GroundAdvantage")).toBe("economy");
    expect(classifySpeedTier("Priority")).toBe("standard");
    expect(classifySpeedTier("Express")).toBe("express");
  });

  it("classifies UPS services", () => {
    expect(classifySpeedTier("Ground")).toBe("economy");
    expect(classifySpeedTier("3DaySelect")).toBe("standard");
    expect(classifySpeedTier("2ndDayAir")).toBe("express");
    expect(classifySpeedTier("NextDayAir")).toBe("express");
  });

  it("classifies FedEx services", () => {
    expect(classifySpeedTier("FEDEX_GROUND")).toBe("economy");
    expect(classifySpeedTier("GROUND_HOME_DELIVERY")).toBe("economy");
    expect(classifySpeedTier("FEDEX_2_DAY")).toBe("express");
    expect(classifySpeedTier("STANDARD_OVERNIGHT")).toBe("express");
  });

  it("defaults to standard for unknown services", () => {
    expect(classifySpeedTier("SomethingNew")).toBe("standard");
  });
});
