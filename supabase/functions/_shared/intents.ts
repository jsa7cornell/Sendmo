// _shared/intents.ts — Stripe PaymentIntent ↔ shipment resolution with Path B fallback.
//
// Why this exists:
//   In SendMo's full-label flow, payments/index.ts creates the Stripe PI BEFORE
//   the shipments row exists. So `stripe_intents.shipment_id` is NULL — the PI
//   metadata carries `easypost_shipment_id` (text) but not the (not-yet-existing)
//   shipment UUID. labels/index.ts forward-stitches `shipments.stripe_payment_intent_id`
//   AFTER the shipment row is inserted (post-H1, 2026-05-23 LOG entry).
//
//   Webhook handlers that need {user_id, shipment_id, link_id} for a PI must
//   therefore Path-B fallback: if `stripe_intents.shipment_id` is null, look up
//   the shipments row by `stripe_payment_intent_id` and read user_id/link_id
//   via the sendmo_links join.
//
// Reference incident:
//   2026-05-24 YPPY9AK refund stuck at `refund_status='submitted'` even though
//   the Stripe refund posted ($-918¢ ledger row written with shipment_id=NULL).
//   The charge.refunded handler couldn't resolve the shipment → no refund_status
//   advance, no refunds-table mirror, no Email B. Fixed by adding this fallback.
//
// Type-only import of SupabaseClient (matches the budget.ts / ledger.ts pattern)
// so Vitest can import this helper directly with a typed mock.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.97.0";

export interface PiContext {
    userId: string | null;
    shipmentId: string | null;
    linkId: string | null;
}

export async function resolvePiContextWithFallback(
    supabase: SupabaseClient,
    piId: string | null,
): Promise<PiContext> {
    if (!piId) return { userId: null, shipmentId: null, linkId: null };

    const { data: intentRow } = await supabase
        .from("stripe_intents")
        .select("user_id, shipment_id, link_id")
        .eq("stripe_intent_id", piId)
        .maybeSingle();
    let userId: string | null = (intentRow as { user_id?: string } | null)?.user_id ?? null;
    let shipmentId: string | null = (intentRow as { shipment_id?: string } | null)?.shipment_id ?? null;
    let linkId: string | null = (intentRow as { link_id?: string } | null)?.link_id ?? null;

    if (shipmentId) return { userId, shipmentId, linkId };

    // Path B fallback.
    const { data: shipRow } = await supabase
        .from("shipments")
        .select("id, link_id, sendmo_links!inner(user_id)")
        .eq("stripe_payment_intent_id", piId)
        .maybeSingle();
    if (shipRow) {
        shipmentId = (shipRow as { id?: string }).id ?? null;
        linkId = linkId ?? ((shipRow as { link_id?: string | null }).link_id ?? null);
        const linkJoin = (shipRow as { sendmo_links?: { user_id?: string } | null }).sendmo_links;
        userId = userId ?? (linkJoin?.user_id ?? null);
    }
    return { userId, shipmentId, linkId };
}
