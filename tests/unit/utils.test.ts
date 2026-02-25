import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

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
});
