#!/usr/bin/env node
// One-shot historical backfill — 2026-05-23.
//
// Context: SendMo's labels Edge Function was reading parcel dims from the
// client request body (`parcel?.weight_oz ?? 0`), but the client `buyLabel`
// wrapper in src/lib/api.ts strips weight/dims before POSTing — only
// `parcel.description` survives. Result: every shipments row inserted via
// the SenderFlow / RecipientStepPayment paths landed with weight_oz=0 and
// length_in=width_in=height_in=0.
//
// Impact: zero-weight rows broke margin reconciliation. FedEx Smart Post
// returned a misleadingly low rate for a 0-oz quote on shp_ae0561ba…
// (public_code GC37EXG), then FedEx billed the real weight and SendMo
// absorbed $9.62. See LOG.md [2026-05-23] Reconciliation dashboard fix.
//
// Forward fix landed in labels/index.ts on 2026-05-23: reads dims from
// `buyData.parcel` (EasyPost buy response — source of truth, what carriers
// were actually quoted on). This script handles historical rows that fired
// before that forward fix shipped.
//
// Procedure (idempotent — only updates rows that are still all-zero):
//   1. SELECT every shipments row with weight_oz=0 AND length_in=0 AND
//      width_in=0 AND height_in=0, capturing easypost_shipment_id + is_live.
//   2. GET https://api.easypost.com/v2/shipments/<id> using test vs live key.
//   3. Read shipment.parcel.{weight, length, width, height}.
//   4. UPDATE shipments SET weight_oz=…, length_in=…, width_in=…, height_in=…
//      WHERE id=<uuid> AND weight_oz=0 AND length_in=0 AND width_in=0
//      AND height_in=0  (the WHERE clause makes re-runs safe).
//
// Rows that won't be recovered:
//   - The four seed shipments with easypost_shipment_id IN
//     ('shp_test', 'shp_test_002', 'shp_test_003') — those IDs don't exist
//     in EasyPost; they were manual seeds. The script will log them as
//     "easypost_404" and skip. They retain their existing values (16 oz
//     etc., not zero — already populated by the seed).
//
// Run via:
//   SUPABASE_URL=$(op read 'op://Secrets/VITE_SUPABASE_URL/credential') \
//   SB_SERVICE_ROLE_KEY=$(op read 'op://Secrets/SB_SERVICE_ROLE_KEY/credential') \
//   EASYPOST_API_KEY=$(op read 'op://Secrets/EASYPOST_API_KEY/credential') \
//   EASYPOST_TEST_API_KEY=$(op read 'op://Secrets/EASYPOST_TEST_API_KEY/credential') \
//   node scripts/backfill-shipment-parcel-dims-2026-05-23.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SB_SERVICE_ROLE_KEY = process.env.SB_SERVICE_ROLE_KEY;
const EP_TEST = process.env.EASYPOST_TEST_API_KEY;
const EP_LIVE = process.env.EASYPOST_API_KEY;

if (!SUPABASE_URL || !SB_SERVICE_ROLE_KEY || !EP_TEST) {
    console.error(
        "Missing required env: SUPABASE_URL, SB_SERVICE_ROLE_KEY, EASYPOST_TEST_API_KEY",
    );
    process.exit(1);
}

const sb = createClient(SUPABASE_URL, SB_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

async function retrieveShipment(epsId, isLive) {
    const key = isLive ? EP_LIVE : EP_TEST;
    if (!key) throw new Error(`No EasyPost key for is_live=${isLive}`);
    const resp = await fetch(
        `https://api.easypost.com/v2/shipments/${encodeURIComponent(epsId)}`,
        {
            headers: {
                Authorization: `Basic ${Buffer.from(key + ":").toString("base64")}`,
            },
        },
    );
    if (resp.status === 404) return { _notFound: true };
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`EasyPost ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
}

const { data: ships, error: selErr } = await sb
    .from("shipments")
    .select("id, public_code, easypost_shipment_id, is_live, created_at")
    .eq("weight_oz", 0)
    .eq("length_in", 0)
    .eq("width_in", 0)
    .eq("height_in", 0)
    .order("created_at", { ascending: true });

if (selErr) {
    console.error("Supabase select failed:", selErr.message);
    process.exit(1);
}

console.log(`Zero-dim shipments to process: ${ships.length}`);

let updated = 0;
const results = [];

for (const ship of ships) {
    const epsId = ship.easypost_shipment_id;
    if (!epsId || epsId.startsWith("shp_test")) {
        results.push({
            id: ship.id,
            public_code: ship.public_code,
            eps: epsId,
            status: "skipped",
            reason: "seed/fake easypost_shipment_id",
        });
        continue;
    }
    try {
        const ep = await retrieveShipment(epsId, ship.is_live);
        if (ep._notFound) {
            results.push({
                id: ship.id,
                public_code: ship.public_code,
                eps: epsId,
                status: "skipped",
                reason: "easypost_404",
            });
            continue;
        }
        const parcel = ep.parcel;
        if (!parcel) {
            results.push({
                id: ship.id,
                public_code: ship.public_code,
                eps: epsId,
                status: "skipped",
                reason: "easypost shipment has no parcel object",
            });
            continue;
        }
        const w = Number(parcel.weight);
        const l = Number(parcel.length);
        const wd = Number(parcel.width);
        const h = Number(parcel.height);
        if (!(w > 0) || !(l > 0) || !(wd > 0) || !(h > 0)) {
            results.push({
                id: ship.id,
                public_code: ship.public_code,
                eps: epsId,
                status: "skipped",
                reason: `easypost parcel has zero/invalid dims: w=${parcel.weight} l=${parcel.length} w=${parcel.width} h=${parcel.height}`,
            });
            continue;
        }
        const { error: upErr } = await sb
            .from("shipments")
            .update({
                weight_oz: w,
                length_in: l,
                width_in: wd,
                height_in: h,
            })
            .eq("id", ship.id)
            .eq("weight_oz", 0)
            .eq("length_in", 0)
            .eq("width_in", 0)
            .eq("height_in", 0);
        if (upErr) {
            results.push({
                id: ship.id,
                public_code: ship.public_code,
                eps: epsId,
                error: `update: ${upErr.message}`,
            });
            continue;
        }
        updated++;
        results.push({
            id: ship.id,
            public_code: ship.public_code,
            eps: epsId,
            status: "updated",
            dims: { weight_oz: w, length_in: l, width_in: wd, height_in: h },
        });
    } catch (err) {
        results.push({
            id: ship.id,
            public_code: ship.public_code,
            eps: epsId,
            error: err.message,
        });
    }
}

console.log(JSON.stringify({ checked: ships.length, updated, results }, null, 2));
