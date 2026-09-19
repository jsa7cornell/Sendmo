import { describe, it, expect } from "vitest";
import { cn, carrierDisplayName, speedDisplayName } from "@/lib/utils";

describe("utils", () => {
    describe("cn", () => {
        it("merges class names correctly", () => {
            expect(cn("px-2 py-1", "bg-red-500")).toBe("px-2 py-1 bg-red-500");
        });

        it("handles conditional classes", () => {
            const isActive = true;
            expect(cn("base-class", isActive && "active-class")).toBe("base-class active-class");
        });

        it("resolves tailwind conflicts correctly using tailwind-merge", () => {
            // px-2 and px-4 conflict, px-4 should win
            expect(cn("px-2", "px-4")).toBe("px-4");
            // text-red-500 and text-blue-500 conflict, blue should win
            expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
        });

        it("ignores falsy values", () => {
            expect(cn("class1", null, undefined, false, "", "class2")).toBe("class1 class2");
        });
    });

    // Both of these are display contracts fed from TWO sources with different
    // casing conventions: EasyPost's wire values and the creator's own picker.
    // Each broke silently once because only a component test covered it.
    describe("carrierDisplayName", () => {
        it("maps EasyPost's mixed-case service values", () => {
            expect(carrierDisplayName("FedExDefault")).toBe("FedEx");
            expect(carrierDisplayName("UPSMI")).toBe("UPS Mail Innovations");
        });

        it("maps a link's lowercase preferred_carrier", () => {
            // What the creator's picker actually stores — prod holds "usps"
            // and "ups". These missed every key until 2026-08-26.
            expect(carrierDisplayName("usps")).toBe("USPS");
            expect(carrierDisplayName("ups")).toBe("UPS");
        });

        it("passes an unknown carrier through unchanged", () => {
            expect(carrierDisplayName("Pigeon")).toBe("Pigeon");
        });

        it("is total — a missing carrier returns rather than throws", () => {
            // EtaBanner types this `string`, DetailsCard types the same server
            // field `string | null`. The helper must survive being wrong.
            expect(() => carrierDisplayName(null as unknown as string)).not.toThrow();
            expect(() => carrierDisplayName(undefined as unknown as string)).not.toThrow();
        });
    });

    describe("speedDisplayName", () => {
        it("labels every tier the picker can write", () => {
            // Keyed to SpeedTier. The map said `no_rush` until 2026-08-26, so
            // 'economy' fell through and rendered as a raw lowercase word.
            expect(speedDisplayName("economy")).toBe("Economy");
            expect(speedDisplayName("standard")).toBe("Standard");
            expect(speedDisplayName("express")).toBe("Express");
        });
    });
});
