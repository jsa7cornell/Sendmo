// Buy-idempotency decision for the label purchase path (PR1 of the
// seller-link launch proposal, decided 2026-08-29; revised after the PR1
// code review found the refuse-without-refund money regression).
//
// The labels function looks up an existing `shipments` row for the request's
// easypost_shipment_id AFTER payment verification and BEFORE any claim/buy.
// This module decides what that lookup result means. Extracted (pricing.ts /
// easypost-rates.ts precedent) because labels/index.ts calls Deno.serve at
// module load, so nothing inline in it is reachable from Vitest.
//
// Two facts the table leans on:
//
// 1. A verified PI is PROVABLY the payment minted for THIS shipment. All
//    three paid legs establish the PI↔shipment binding before this decision
//    runs: full-label and seller verify pi.metadata.easypost_shipment_id
//    against the request, and the flex PI is created server-side in the same
//    request with this shipment id in its metadata and idempotency key.
//
// 2. A request can arrive carrying a FRESH capture. The flex leg charges
//    before this check, and its Stripe idempotency key expires after 24h
//    (and changes when the link's default PM changes) — so a stale-tab
//    resubmit can mint a second real charge for a shipment whose label
//    already stands. Refusing without refunding would KEEP that second
//    charge (the review's A1/B1 finding); the mismatch outcome therefore
//    refunds the request's own PI, which provably did not buy the standing
//    label whenever it differs from the row's.
//
// `cancel_token` is a credential (it grants cancel/refund), and
// easypost_shipment_id is attacker-suppliable on an anon-callable endpoint —
// so the row is returned only on a proven binding, and the no-payment
// mismatch fails closed.

export type BuyReplayDecision =
    /** Same payment, same shipment — return the existing label. No claim, no buy, no refund. */
    | "return_existing"
    /**
     * Paid row whose forward-stitch never landed (stripe_payment_intent_id
     * NULL) being replayed with a PI bound to this shipment: same party,
     * same purchase. Return the label AND repair the stitch so the next
     * replay matches directly.
     */
    | "return_existing_repair"
    /**
     * The request's verified PI did not buy the standing label (different
     * PI, or the row is a comp label). Refund the REQUEST's PI — it bought
     * nothing — then 409 without the row's fields. The row's own payment
     * stays untouched.
     */
    | "refund_mismatch"
    /** Row exists, request carries no payment to make whole — 409, never leak the row. */
    | "refuse_mismatch"
    /** No existing row — proceed to the normal claim/buy path. */
    | "proceed";

export function decideBuyReplay(params: {
    /** The existing shipments row's stripe_payment_intent_id, or null. */
    existingPiId: string | null;
    /** Whether the existing row is a comp label (shipments.payment_method === 'comp'). */
    rowIsComp: boolean;
    /** The PI this request verified, or null (comp path — admin-gated, no charge). */
    verifiedPiId: string | null;
    /** Whether this request is an admin comp buy. */
    isComp: boolean;
    /** Whether a row was found at all. */
    rowExists: boolean;
}): BuyReplayDecision {
    if (!params.rowExists) return "proceed";
    if (params.verifiedPiId !== null) {
        if (params.existingPiId === params.verifiedPiId) return "return_existing";
        // A comp row was never bought by any PI — this request's payment
        // bought nothing, whatever its binding says. Refund it.
        if (params.rowIsComp) return "refund_mismatch";
        // Paid row, stitch missing: fact 1 above makes the verified PI this
        // shipment's own payment, so this is the same purchase replayed.
        if (params.existingPiId === null) return "return_existing_repair";
        // Paid row bound to a DIFFERENT PI: the request's charge bought
        // nothing (fact 2 — possibly a fresh capture). Refund it.
        return "refund_mismatch";
    }
    // No verified PI: only the admin-gated comp path reaches the buy without
    // one. A comp replay of a comp row is legitimate; anything else has no
    // payment to make whole and fails closed.
    if (params.isComp && params.rowIsComp && params.existingPiId === null) return "return_existing";
    return "refuse_mismatch";
}
