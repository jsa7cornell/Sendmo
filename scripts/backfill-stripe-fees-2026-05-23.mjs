#!/usr/bin/env node
// One-shot historical backfill — 2026-05-23.
//
// Inserts `fee_stripe` ledger rows for every existing `charge` row.
// Companion to scripts/backfill-charge-shipment-links-2026-05-23.mjs.
//
// Context: the H1 writers (label_cost + easypost_refund) shipped today
// (d0ef0b5), and writeStripeFee is shipping with this LOG entry. Existing
// historical `charge` rows have no matching `fee_stripe` row because no
// writer existed before now. This script reconstructs them from Stripe's
// canonical BalanceTransaction objects.
//
// Procedure (idempotent — UNIQUE on idempotency_key handles re-runs):
//   1. SELECT all `charge` rows with stripe_intent_id IS NOT NULL.
//   2. For each, GET /v1/payment_intents/<pi>?expand[]=latest_charge.balance_transaction
//   3. Read pi.latest_charge.balance_transaction.fee (positive cents).
//   4. INSERT a `fee_stripe` row:
//        amount_cents = -fee   (negative — SendMo paid Stripe)
//        idempotency_key = 'fee_stripe_<bt_id>'
//        shipment_id = same as the charge row (joins via PI back-reference
//          we already established via the prior backfill).
//
// transactions table is append-only (no UPDATE/DELETE grant). All operations
// here are INSERTs only. UNIQUE collisions are safe no-ops.
//
// Run via:
//   SUPABASE_URL=$(op read 'op://Secrets/VITE_SUPABASE_URL/credential') \
//   SB_SERVICE_ROLE_KEY=$(op read 'op://Secrets/SB_SERVICE_ROLE_KEY/credential') \
//   STRIPE_SECRET_KEY_TEST=$(op read 'op://Secrets/STRIPE_SECRET_KEY_TEST/credential') \
//   STRIPE_SECRET_KEY_LIVE=$(op read 'op://Secrets/STRIPE_SECRET_KEY_LIVE/credential') \
//   node scripts/backfill-stripe-fees-2026-05-23.mjs

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

async function retrievePIWithBT(piId, mode) {
    const key = mode === "live" ? STRIPE_LIVE : STRIPE_TEST;
    if (!key) throw new Error(`No Stripe key for mode=${mode}`);
    const url = `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}?expand[]=latest_charge.balance_transaction`;
    const resp = await fetch(url, {
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
    .select("id, shipment_id, user_id, link_id, stripe_intent_id, mode, amount_cents, created_at")
    .eq("type", "charge")
    .not("stripe_intent_id", "is", null)
    .order("created_at", { ascending: true });

if (chErr) {
    console.error("Supabase select failed:", chErr.message);
    process.exit(1);
}

console.log(`Charges to process: ${charges.length}`);

let inserted = 0;
let duplicates = 0;
let skipped = 0;
const results = [];

for (const tx of charges) {
    const piId = tx.stripe_intent_id;
    const mode = tx.mode;
    try {
        const pi = await retrievePIWithBT(piId, mode);
        const latestCharge = pi.latest_charge;
        if (!latestCharge || typeof latestCharge !== "object") {
            skipped++;
            results.push({ tx_id: tx.id, pi: piId, status: "skipped", reason: "no latest_charge object" });
            continue;
        }
        const bt = latestCharge.balance_transaction;
        if (!bt || typeof bt !== "object" || typeof bt.fee !== "number" || !bt.id) {
            skipped++;
            results.push({ tx_id: tx.id, pi: piId, status: "skipped", reason: "no balance_transaction object" });
            continue;
        }

        const insertPayload = {
            user_id: tx.user_id,
            shipment_id: tx.shipment_id,    // may be NULL — fine; reconciliation joins via PI
            link_id: tx.link_id,
            stripe_intent_id: piId,
            type: "fee_stripe",
            amount_cents: -Math.abs(bt.fee),
            funding_source: null,           // historical charges; comp would have skipped this path
            mode,
            idempotency_key: `fee_stripe_${bt.id}`,
            description: `Stripe processing fee — ${bt.id} (intent ${piId})`,
        };

        const { error: insErr } = await sb.from("transactions").insert(insertPayload);
        if (insErr) {
            if (insErr.code === "23505") {
                duplicates++;
                results.push({ tx_id: tx.id, pi: piId, bt: bt.id, status: "duplicate" });
                continue;
            }
            results.push({ tx_id: tx.id, pi: piId, bt: bt.id, error: insErr.message });
            continue;
        }
        inserted++;
        results.push({
            tx_id: tx.id,
            pi: piId,
            bt: bt.id,
            fee_cents: bt.fee,
            status: "inserted",
        });
    } catch (err) {
        results.push({ tx_id: tx.id, pi: piId, error: err.message });
    }
}

console.log(JSON.stringify({
    checked: charges.length,
    inserted,
    duplicates,
    skipped,
    results,
}, null, 2));
