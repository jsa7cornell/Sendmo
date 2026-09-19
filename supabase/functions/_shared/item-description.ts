// What goes in shipments.item_description at buy time (PR7, seller-link
// launch). Extracted for Vitest (labels/index.ts calls Deno.serve at module
// load — pricing.ts precedent).
//
// Priority: the request parcel's description (sender flows type it) — else,
// on SELLER sales only, the seller's listing text (the buyer's client sends
// no parcel, so before this every sale persisted NULL while notes sat
// unread). The caller SNAPSHOTS the value onto the shipment — a stored copy,
// never a live join — so later listing edits can't rewrite the history of
// past sales. Flex and full-label behavior is byte-identical to before.
export function resolveItemDescription(params: {
    parcelDescription: unknown;
    linkType: string | null;
    linkNotes: string | null;
}): string | null {
    if (typeof params.parcelDescription === "string" && params.parcelDescription.trim().length > 0) {
        return params.parcelDescription;
    }
    if (params.linkType === "seller_link" && params.linkNotes && params.linkNotes.trim().length > 0) {
        return params.linkNotes;
    }
    return null;
}
