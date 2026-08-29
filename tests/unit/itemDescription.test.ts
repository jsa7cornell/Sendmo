import { describe, it, expect } from "vitest";
import { resolveItemDescription } from "../../supabase/functions/_shared/item-description";

// PR7: seller sales inherit the listing text; flex/full-label are unchanged.

describe("resolveItemDescription", () => {
    it("prefers the request parcel's description on every flow", () => {
        expect(resolveItemDescription({ parcelDescription: "A typed note", linkType: "seller_link", linkNotes: "Listing text" }))
            .toBe("A typed note");
        expect(resolveItemDescription({ parcelDescription: "A typed note", linkType: "flexible", linkNotes: null }))
            .toBe("A typed note");
    });

    it("falls back to the listing notes ONLY on seller sales", () => {
        expect(resolveItemDescription({ parcelDescription: undefined, linkType: "seller_link", linkNotes: "Vintage armchair" }))
            .toBe("Vintage armchair");
        // Flex links also carry notes — those must NOT leak into item_description
        // (unchanged pre-PR7 behavior for recipient-pays flows).
        expect(resolveItemDescription({ parcelDescription: undefined, linkType: "flexible", linkNotes: "flex note" }))
            .toBe(null);
        expect(resolveItemDescription({ parcelDescription: undefined, linkType: null, linkNotes: null }))
            .toBe(null);
    });

    it("treats blank strings as absent on both sides", () => {
        expect(resolveItemDescription({ parcelDescription: "   ", linkType: "seller_link", linkNotes: "  " }))
            .toBe(null);
    });
});
