# Handoff — FedEx Smart Post denylist + buy-time-rate-gate follow-up

> Paste the body below into a fresh Claude Code session at `~/AI Brain/sendmo/`.
> This continues investigation of the FedEx Smart Post quote-vs-buy divergence
> originally surfaced by GC37EXG ($9.61 charged / $19.23 billed). The denylist
> patch is in the working tree; what remains is a small set of deploy +
> telemetry + script-extension follow-ups, plus a one-line comment tightening.

---

## Where things stand (2026-05-23 end of session)

The investigation started with the working theory that FedEx Smart Post showed
a buy-time re-rate because (a) SendMo writes `weight=0`/`dim=0` on every
shipment row (separate spinoff task), or (b) Smart Post's USPS-last-mile leg
adds a hub re-rate fee that's not in the rate-shop quote.

**Both theories are now ruled out for GC37EXG specifically.** The empirical
findings:

1. **GC37EXG was test-mode (`is_live=false`).** No physical package, no FedEx
   hub, no real re-rate. The $9.62 "loss" is a synthetic test-mode artifact —
   but a synthetic artifact that surfaces a real integration risk for live
   Smart Post traffic, where we have **zero shipments to verify behavior on**.
2. **The `rate.fetched` event log for GC37EXG recorded weight=32 oz at quote
   time** — not zero. The `weight=0` data-quality bug is purely a write-side
   bug in the labels function (already fixed in the uncommitted H1 hunk:
   `p_weight_oz: Number(buyData.parcel?.weight ?? parcel?.weight_oz ?? 0)`),
   not the cause of the Smart Post divergence.
3. **EasyPost API rejects degenerate parcels at the validation layer**
   (`{error: "Wrong parameter type."}` for `weight=0` or any `dim=0`). So the
   rates function cannot have silently sent zeroes and gotten a floor-priced
   quote — that path would error back to the user, not stealth-quote.
4. **Smart Post is the only carrier+service in the entire 32-shipment dataset
   with a meaningful quote→buy gap.** USPS GroundAdvantage (27 shipments) and
   UPS Ground / Groundsaver (4 shipments) all show $0.00 gap across the same
   test/live split.
5. **The divergence is entirely within the EasyPost API surface.** Same
   `shp_…` id, same `easypost_rate_id`, two different `rate` values across
   `/shipments` (rate-shop) vs `/shipments/{id}/buy` (label purchase):
   - rate-shop: Smart Post = $7.49 (base) → displayed $9.61 to customer
   - /buy: `selected_rate.rate` = $19.23 → written to `shipments.rate_cents`

**The diagnosis is therefore: EasyPost's test-mode integration contract for
Smart Post does not guarantee that the quoted rate equals the buy-time rate.
Whether the same property holds in live mode is unknowable from the current
dataset.** That's the risk the denylist is mitigating.

## What shipped

**Pushed to `main` (commit `8a0a94b`):**
- `chore(rates): log parcel dims on rate.fetched (Smart Post gap diagnostics)`
- Added `parcel_length`, `parcel_width`, `parcel_height` to the rates Edge
  Function's success-path event log (was only logging `parcel_weight_oz`).
- Rates Edge Function **deployed** to project `fkxykvzsqdjzhurntgah`.
- Effective immediately: every new `rate.fetched` event_logs row will
  preserve parcel dims, making the next quote-vs-buy gap forensically
  resolvable from telemetry alone.

**In the working tree (uncommitted), authored by John during this session:**
- `supabase/functions/rates/index.ts` — `SERVICE_DENYLIST` constant at the
  top of the file (lines 11–30). FedEx Smart Post is the only entry. Filter
  is **declared but not yet wired into the rate-filter chain in the request
  handler.** Verify the filter is actually applied before deploying — see
  [§3 below](#3-verify-the-denylist-is-actually-wired-into-the-filter-chain).
- `supabase/functions/labels/index.ts` — comment correction in the H1
  forward-stitch hunk: the previous comment misattributed the GC37EXG loss
  to "Smart Post quoted a 0-oz rate but billed real weight," which the
  rate.fetched log proves false. New comment notes the Smart Post gap is
  still under investigation and unrelated to the write-side weight=0 bug.
- New proposal: `proposals/2026-05-23_buy-time-rate-gate.md` (not read in
  this session — read it first; the denylist is meant to be temporary until
  the gate lands).
- Diagnostic script: `scripts/probe-smartpost-rate-divergence-2026-05-23.mjs`
  — three-fixture probe (real / zero-dims / zero-weight) against EasyPost
  test API. Output already captured: REAL got 18 rates across all three
  carriers with Smart Post at $11.24 for 12×9×3 in / 32 oz SF→Cambridge.
  Both ZERO fixtures error with "Wrong parameter type" (API-layer
  validation rejection).

## Read first, in order

1. **`proposals/2026-05-23_buy-time-rate-gate.md`** — the parent proposal the
   denylist is staged ahead of. Decides what the buy-time gate does, what its
   re-enable criteria are, and whether the denylist should be removed in
   favor of the gate or kept alongside it.
2. **`LOG.md` 2026-05-23 entry "Reconciliation dashboard — empty-columns
   fix"** — context for the GC37EXG -$9.62 row that surfaced this whole
   investigation. The entry calls out SM-727C (= GC37EXG) as a real loss to
   flag for post-launch review.
3. **`supabase/functions/rates/index.ts:11-30`** — the denylist constant and
   its re-enable criteria comment. The "30 consecutive shipments via the
   gate's soft-warning event" line is unobservable while the denylist is on
   (no Smart Post traffic to observe) — this needs to be reframed as shadow
   observations once the buy-time-rate-gate is live.
4. **`scripts/probe-smartpost-rate-divergence-2026-05-23.mjs`** — the
   diagnostic probe. Run it with the op-read pattern at the top of the file
   to reproduce the current Smart Post rate-shop behavior.

## Recommended next actions (in order)

### 1. Read the buy-time-rate-gate proposal

Don't proceed past this until you've read it — the gate's design may
subsume some of the recommendations below or change their shape.

### 2. Deploy the denylisted rates fn

```bash
npx supabase functions deploy rates
```

The denylist constant exists in the file but live customer traffic isn't seeing
it until the deploy goes out. Smoke-test by running the SenderFlow in test
mode against a Smart Post-eligible ZIP pair and confirm the carrier picker
shows USPS + UPS but not FedEx Smart Post.

### 3. Verify the denylist is actually wired into the filter chain

The constant is declared but I haven't traced the filter chain to confirm
`SERVICE_DENYLIST` is referenced inside the `.filter(...)` block where the
other price/carrier/speed filters live (around the original line 278). If
it's declared but never consumed, the deploy is a no-op. Check before
deploying.

### 4. Add a `rate.service_denylisted` event_logs row when filtering

Cheap telemetry — when a service is filtered out by `SERVICE_DENYLIST`, drop
a `rate.service_denylisted` event with `{carrier, service, would_have_been:
displayPrice}`. This gives a counter for "how many rate-shops would have
shown Smart Post" and a baseline for the re-enable decision. Without it the
denylist is silent, and the re-enable bar in the comment is unobservable.

### 5. Tighten the denylist re-enable bar comment

The current comment (lines 24-26) says:

> Re-enable AFTER (a) the buy-time-rate-gate lands and (b) the weight=0
> data-capture bug is fixed and we've observed buy-time delta < 5% for
> 30 consecutive Smart Post shipments via the gate's soft-warning event.

But if we're denylisting Smart Post, we have zero Smart Post shipments to
observe — the bar is structurally unachievable. The bar needs to be
reframed as **shadow observations** (the rate-shop logs the Smart Post
quote and re-issues against `/shipments/{id}/buy` in a separate test-mode
call to compare, without surfacing Smart Post to the customer). Or the
denylist should be lifted in stages once the buy-time gate exists.
Whichever direction the buy-time-rate-gate proposal takes will dictate
this — fix the comment to match.

### 6. (Optional) Extend the probe script with a true quote→buy round-trip

The current probe only hits `/shipments` (rate-shop). To empirically
reproduce the GC37EXG divergence on demand, the script would also need to
call `/shipments/{id}/buy` with the Smart Post `rate_id` from the rate-shop
response and compare `selected_rate.rate` to the original quote. No real
label gets generated in test mode — it's safe. Only worth doing if the
buy-time-rate-gate proposal wants empirical evidence of stable-vs-stochastic
divergence behavior to inform its design.

### 7. (Defer until live data exists) Verify live mode

We have zero LIVE Smart Post shipments. The denylist is a precaution
extrapolated from test-mode behavior. At some point — probably after the
buy-time-rate-gate is shipping rate quotes against `/buy` validation in
shadow mode — we'll want empirical live-mode evidence to either confirm
the denylist is permanently warranted or relax it.

## Files touched in this session

**Pushed (8a0a94b):**
- `supabase/functions/rates/index.ts` (+6) — parcel dims on rate.fetched
  success log

**Uncommitted (in John's working tree at handoff time):**
- `supabase/functions/rates/index.ts` — `SERVICE_DENYLIST` constant added
- `supabase/functions/labels/index.ts` — H1 forward-stitch comment
  correction (Smart Post misattribution removed)
- `scripts/probe-smartpost-rate-divergence-2026-05-23.mjs` — diagnostic
  probe
- `proposals/2026-05-23_buy-time-rate-gate.md` — parent proposal (authored
  in a parallel session; **read this before doing anything else**)

## Database evidence (already collected — re-query if you want to refresh)

The forensic queries that established the empirical baseline are in this
session's transcript. The two most useful ones:

```sql
-- Per-shipment quote-vs-billed gap, full dataset
SELECT s.public_code, s.carrier, s.service, s.is_live, s.rate_cents,
       s.display_price_cents,
       (s.rate_cents::numeric / 100) AS billed_dollars,
       ROUND(((s.display_price_cents::numeric - 100) / 1.15) / 100, 2) AS implied_quote_dollars,
       ROUND((s.rate_cents - ((s.display_price_cents - 100) / 1.15)::int)::numeric / 100, 2) AS gap_dollars
FROM shipments s
WHERE s.rate_cents IS NOT NULL AND s.display_price_cents IS NOT NULL AND s.rate_cents > 0
ORDER BY s.created_at DESC;

-- Carrier mix across all shipments
SELECT
  (SELECT COUNT(*) FROM shipments WHERE service ILIKE '%smart%post%' OR service = 'SMART_POST') AS smartpost_shipments,
  (SELECT COUNT(*) FROM shipments WHERE carrier LIKE 'FedEx%')                                  AS fedex_shipments,
  (SELECT COUNT(*) FROM shipments WHERE carrier = 'USPS')                                       AS usps_shipments,
  (SELECT COUNT(*) FROM shipments WHERE carrier LIKE 'UPS%')                                    AS ups_shipments,
  (SELECT COUNT(*) FROM shipments)                                                              AS total;
```

Result snapshot at handoff time: **1 Smart Post shipment** (GC37EXG) out of
32 total — and it's the only one with a meaningful gap. Dataset is small;
treat the denylist as a precaution proportional to sample size, not as
proven systemic carrier failure.

## My recommendation (one line)

**Read the buy-time-rate-gate proposal first, then do (2) + (3) + (5) as a
single small commit before tonight's pre-launch.** (4) is nice-to-have but
won't fire usefully until the gate exists; (6) and (7) wait for live data.
