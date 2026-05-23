#!/usr/bin/env node
// One-shot historical backfill — 2026-05-23.
//
// Context: SendMo's Stripe PI is created in payments/index.ts BEFORE a
// shipments row exists, so the PI's `metadata` carries `easypost_shipment_id`
// (text, 'shp_…') but not `shipment_id` (UUID, doesn't exist yet). The
// stripe-webhook charge-writer reads `metadata.shipment_id` and lands NULL.
// Result: historical `charge` transactions have shipment_id IS NULL and the
// reconciliation dashboard reports $0 Paid per shipment.
//
// Forward fix landed in labels/index.ts on 2026-05-23: after the shipments
// row is minted, it back-links shipments.stripe_payment_intent_id and
// retro-updates transactions.shipment_id. This script handles the historical
// rows that fired before that forward fix shipped.
//
// Procedure (idempotent — only updates rows that are still unlinked):
//   1. Pull every `charge` row with stripe_intent_id IS NOT NULL.
//   2. Retrieve the PI from Stripe (test vs live based on transactions.mode).
//   3. Read pi.metadata.easypost_shipment_id.
//   4. Resolve shipments.id WHERE easypost_shipment_id = <value>.
//   5. UPDATE shipments.stripe_payment_intent_id = pi.id WHERE id = <UUID>
//      AND stripe_payment_intent_id IS NULL.
//
// NOTE: transactions table is append-only — no UPDATE grant for service_role.
// So we do NOT touch transactions.shipment_id. The reconciliation-report
// query joins charges/refunds via t.stripe_intent_id ↔
// s.stripe_payment_intent_id instead (Path B refactor, 2026-05-23).
//
// Run via:
//   SUPABASE_URL=$(op read 'op://Secrets/VITE_SUPABASE_URL/credential') \
//   SB_SERVICE_ROLE_KEY=$(op read 'op://Secrets/SB_SERVICE_ROLE_KEY/credential') \
//   STRIPE_SECRET_KEY_TEST=$(op read 'op://Secrets/STRIPE_SECRET_KEY_TEST/credential') \
//   STRIPE_SECRET_KEY_LIVE=$(op read 'op://Secrets/STRIPE_SECRET_KEY_LIVE/credential') \
//   node scripts/backfill-charge-shipment-links-2026-05-23.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SB_SERVICE_ROLE_KEY = process.env.SB_SERVICE_ROLE_KEY;
const STRIPE_TEST = process.env.STRIPE_SECRET_KEY_TEST;
const STRIPE_LIVE = process.env.STRIPE_SECRET_KEY_LIVE;

if (!SUPABASE_URL || !SB_SERVICE_ROLE_KEY || !STRIPE_TEST) {
    console.error("Missing required env: SUPABASE_URL, SB_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY_TEST");
    process.exit(1);
}

const sb = createClient(SUPABASE_URL, SB_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

async function retrievePI(id, mode) {
    const key = mode === "live" ? STRIPE_LIVE : STRIPE_TEST;
    if (!key) throw new Error(`No Stripe key for mode=${mode}`);
    const resp = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Basic ${Buffer.from(key + ":").toString("base64")}` },
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Stripe ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
}

const { data: charges, error: chErr } = await sb
    .from("transactions")
    .select("id, stripe_intent_id, mode, amount_cents, created_at")
    .eq("type", "charge")
    .not("stripe_intent_id", "is", null)
    .order("created_at", { ascending: true });

if (chErr) {
    console.error("Supabase select failed:", chErr.message);
    process.exit(1);
}

console.log(`Charges to process: ${charges.length}`);

let linked = 0;
const results = [];

for (const tx of charges) {
    const piId = tx.stripe_intent_id;
    const mode = tx.mode;
    try {
        const pi = await retrievePI(piId, mode);
        const epsId = pi.metadata?.easypost_shipment_id ?? null;
        if (!epsId) {
            results.push({ tx_id: tx.id, pi: piId, mode, status: "skipped",
                reason: "PI metadata has no easypost_shipment_id" });
            continue;
        }
        const { data: ship, error: shipErr } = await sb
            .from("shipments")
            .select("id")
            .eq("easypost_shipment_id", epsId)
            .maybeSingle();
        if (shipErr) {
            results.push({ tx_id: tx.id, pi: piId, eps: epsId, error: shipErr.message });
            continue;
        }
        if (!ship?.id) {
            results.push({ tx_id: tx.id, pi: piId, eps: epsId, status: "skipped",
                reason: "no shipments row matches metadata.easypost_shipment_id" });
            continue;
        }
        const shipmentUuid = ship.id;

        const { error: shipUpErr } = await sb
            .from("shipments")
            .update({ stripe_payment_intent_id: piId })
            .eq("id", shipmentUuid)
            .is("stripe_payment_intent_id", null);
        if (shipUpErr) {
            results.push({ tx_id: tx.id, pi: piId, eps: epsId, shipment_id: shipmentUuid,
                error: `ship back-link: ${shipUpErr.message}` });
            continue;
        }

        linked++;
        results.push({ tx_id: tx.id, pi: piId, eps: epsId, shipment_id: shipmentUuid, status: "linked" });
    } catch (err) {
        results.push({ tx_id: tx.id, pi: piId, error: err.message });
    }
}

console.log(JSON.stringify({ checked: charges.length, linked, results }, null, 2));
