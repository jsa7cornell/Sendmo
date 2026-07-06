// _shared/paid-amount.ts
//
// getPaidAmountCentsForShipment — the amount the CUSTOMER actually paid for
// a shipment, sourced from the ledger's +charge row via the PI stitch.
// Refund emails must quote this (what moves back to the card), NOT
// shipments.rate_cents (SendMo's EasyPost cost — ~15%+$1 lower).
// Falls back to `fallbackCents` when no charge row is found (comp labels,
// webhook-lag window).

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.97.0";

export async function getPaidAmountCentsForShipment(
    supabase: SupabaseClient,
    stripePaymentIntentId: string | null,
    fallbackCents: number,
): Promise<number> {
    if (!stripePaymentIntentId) return fallbackCents;
    try {
        const { data } = await supabase
            .from("transactions")
            .select("amount_cents")
            .eq("stripe_intent_id", stripePaymentIntentId)
            .eq("type", "charge")
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
        const cents = (data as { amount_cents?: number } | null)?.amount_cents;
        return typeof cents === "number" && cents > 0 ? cents : fallbackCents;
    } catch {
        return fallbackCents;
    }
}
