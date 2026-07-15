---
title: H2 Carrier-Adjustment Auto-Recovery — Full Repair
slug: h2-carrier-adjustment-repair
project: sendmo
status: in-review
created: 2026-07-15
last_updated: 2026-07-15 12:30
reviewed: null
decided: null
author: Claude Opus 4.8 session — "SendMo H2 carrier-adjustment repair 2026-07-15" (traced the full chain against the live prod schema via Supabase MCP)
reviewer: null
outcome: null
---

> **Not a launch blocker.** H2 recovers SendMo's own margin when a carrier re-bills a
> shipment after pickup. It never touches customer-money-safety (a customer is only ever
> charged the exact carrier overage + $1, and only within caps). So this proposal
> prioritizes **correctness and durable test coverage** over speed. Nothing here should
> gate the launch switch (T1-1).

## 1. Context

**H2** is the carrier-adjustment recovery engine. When a carrier re-weighs or re-rates a
package after it's picked up (a "reweigh", "dim", or "address_correction" surcharge),
EasyPost sends a `shipment.invoice.created` webhook. SendMo is supposed to:

1. record the adjustment,
2. decide whether to absorb it, auto-recharge the customer, or flag it for manual review, and
3. if it recharges, collect the money off-session and email the customer.

**H2 has never once worked in production.** The 2026-07-15 T2-2 live verification (a
synthetic `shipment.invoice.created` HMAC-signed and POSTed to prod) exposed **four**
schema bugs stacked behind each other. Those four are **already fixed and deployed**
(PR [#52](https://github.com/jsa7cornell/Sendmo/pull/52) + migration
`carrier_adjustments_source_event_id_plain_unique`, both on `main`). This proposal does
**not** redo them — it builds on them.

But fixing those four only got the event as far as **recording** the adjustment. The
recovery half — the cap check, the recharge, the ledger row, the email — has *still* never
run. Tracing the whole chain against the **live prod schema** turned up **four more bugs**
(5–8), each of which would stop the recovery cold. Empirical proof they're unreached:

```
select count(*) from carrier_adjustments where recovery_status='recovered';  → 0
select count(*) from stripe_intents where intent_role='carrier_adjustment';  → 0
```

Zero recoveries, zero recharge PaymentIntents, ever. The one live artifact is the synthetic
`-$5` cost row on shipment `4Z8ZJZX` (`carrier_adjustments` id `14a3ce84…`, `transactions`
id `082a2c11…`), which flagged `blocked_by_cap:"shipment_lifetime"` — bug 5 below.

**Why nothing caught any of this:** edge functions are in no `tsconfig`, and every existing
test mocks the Supabase client, so a wrong column name or an un-inferrable index is invisible
until it errors at runtime in prod. The schema-column audit (`tests/unit/schemaColumnAudit.test.ts`,
added 2026-07-14) closes part of that gap statically, but it can't see a broken RPC body or a
cap that sums the wrong rows.

### The full chain, and where each bug sits

```
EasyPost shipment.invoice.created
   │
   ▼
webhooks/index.ts  (invoice arm)
   ├─ resolve shipment by easypost_shipment_id            ← bug 1 (FIXED)
   ├─ derive owner from stripe_intents / sendmo_links
   ├─ UPSERT carrier_adjustments  onConflict:source_event_id ← bug 4 (FIXED)
   ├─ INSERT transactions  type='carrier_adjustment' -delta  ← inserted BEFORE the cap check → bug 5
   └─ resolveRecovery(...)
        │
        ▼
   _shared/adjustments.ts
        ├─ tier decision (absorb / recharge / flag)
        ├─ checkCapsWithLock
        │     ├─ rpc resolve_recovery_lock(...)            ← bug 7  (throws every call → always falls back)
        │     │     • per-shipment  = Σ carrier_adjustment cost rows   ← bug 5 (double-count) + drift from §2.4
        │     │     • per-card 24h   = Σ charge rows LIKE 'adjustment_%' ← bug 6 (never matches)
        │     │     • per-user 7d    = Σ charge rows LIKE 'adjustment_%' ← bug 6 (never matches)
        │     └─ unlocked fallback (per-shipment + per-user only)       ← what ACTUALLY runs, every time
        ├─ createAdjustmentRecharge → off-session PI
        └─ markAdjustmentResolved(recovery_tx_id = null)   ← bug 8 (link never set)
        │
        ▼  (recharge PI succeeds → Stripe fires payment_intent.succeeded)
   stripe-webhook/index.ts  payment_intent.succeeded arm
        └─ INSERT transactions type='charge' key='stripe.<eventId>:charge' ← does NOT match the cap filter (bug 6)
           and never patches carrier_adjustments.recovery_tx_id            ← bug 8
```

## 2. Bug inventory

### Already fixed & deployed (recap only — do not redo)

| # | What | Fix (shipped in PR #52 + migration) |
|---|------|-------------------------------------|
| 1 | invoice arm selected `shipments.user_id` (no such column) → every event errored, mislabeled `shipment_not_found` (warn, invisible) | owner derived from `stripe_intents.user_id` with `sendmo_links.user_id` fallback; query-error vs not-found un-conflated |
| 2 | `stripe-webhook` Email-B fallback: same nonexistent-column bug | fixed column ref |
| 3 | `tracking-admin` ledger select used `transactions.stripe_payment_intent_id`/`stripe_refund_id` (don't exist) | → `stripe_intent_id`/`stripe_charge_id` |
| 4 | `carrier_adjustments` upsert `onConflict:"source_event_id"` couldn't infer the *partial* unique index → error 42P10 | migrated to a plain unique index (`carrier_adjustments_source_event_id_key`, verified live) |

### Outstanding — this proposal's scope

**Bug 5 — per-shipment cap double-counts the cost row (the stated blocker).**
`webhooks/index.ts:416` inserts the `-delta` `carrier_adjustment` cost row **before**
`resolveRecovery` runs. The per-shipment cap then sums `type='carrier_adjustment'` rows —
which now includes the row for *this very adjustment* — and adds the prospective
`rechargeAmount` (`delta + $1`) on top. A first, lone $5 adjustment computes
`|−500| + 600 = 1100 > CAP_PER_SHIPMENT_CENTS (1000)` → false `flag`.
**Reproduced live on `4Z8ZJZX`.**

Deeper than an off-by-one, this is **drift from the decided spec**. §2.4 of the decided
proposal defines all three caps on the **customer-recharge** side — "≤ $10 in
*auto-recharged adjustments* per shipment", "≤ $20 / ≤ $50 in *adjustment re-charges*". It
does **not** say any cap counts SendMo's `carrier_adjustment` cost rows. N3 of the same
review is explicit: the `carrier_adjustment` row is SendMo's *cost*; the recharge is the
*"+charge"* recovery, and "caps gate the latter." Summing cost rows for the per-shipment cap
is a re-interpretation that was never decided.

**Bug 6 — per-card and per-user caps use a discriminator that never matches (NEW).**
Both wider caps filter `transactions.idempotency_key LIKE 'adjustment\_%'`. But no
`transactions` row is ever written with that key. `createAdjustmentRecharge` uses
`adjustment_<shipment>_<adj>_<attempt>` only as the **Stripe-side** PI idempotency key — it
never lands in `transactions.idempotency_key`. When the recharge PI succeeds, the ledger
charge row is written by `stripe-webhook` `payment_intent.succeeded` with
`idempotency_key = 'stripe.<eventId>:charge'`. So the cap filter matches **nothing** →
per-card and per-user caps always sum **0** and never fire. (Verified: `transactions` has no
`intent_role` column at all; the only place the adjustment role is recorded is
`stripe_intents.intent_role='carrier_adjustment'`.)

**Bug 7 — the cap-lock RPC references a nonexistent column and throws on every call (NEW).**
Migration `033_resolve_recovery_lock_rpc.sql:87` joins
`stripe_intents si ON si.stripe_payment_intent_id = t.stripe_intent_id`. **`stripe_intents`
has no `stripe_payment_intent_id` column** — the column is `stripe_intent_id` (verified
against the live schema). plpgsql resolves column names at *execution*, not creation, so the
migration applied clean but every `resolve_recovery_lock` call raises `42703`. In
`adjustments.ts` that's caught as `cap_lock_rpc_threw` and the code **falls to the unlocked
fallback on every single call.** Consequences:
- the **N2 race guard has never run in prod** — the load-bearing `FOR UPDATE` serialization the
  decided proposal accepted (D2) has been dead since it shipped;
- the per-card cap isn't enforced even in degraded mode (the fallback only does per-shipment +
  per-user).

**Bug 8 — `recovery_tx_id` is never linked (NEW).**
`markAdjustmentResolved` is always called with `recoveryTxId = null`, and
`payment_intent.succeeded` doesn't know the `carrier_adjustment_id`, so
`carrier_adjustments.recovery_tx_id` is never populated. The `adjustments.ts` header comment
claims a "`charge.succeeded` arm writes the actual ledger row" and patches the cross-reference
— **that arm does not exist** (`stripe-webhook` has no `charge.succeeded` case at all). Effect:
the Reconciliation "Adjustment collected" join never closes; a recovered adjustment can't be
tied to the charge that recovered it. Severity: reporting/reconciliation, not money-safety.

**Observation 9 (not a separate fix) — the recharge ledger row is indistinguishable.**
Because the recharge charge row is written by the generic `payment_intent.succeeded` path
with a generic key and no adjustment marker on `transactions`, the ledger can't tell an
adjustment recharge from an ordinary shipment charge without joining `stripe_intents`. This is
the root that makes bug 6 unfixable-in-place; §3 addresses it by giving `resolveRecovery`
ownership of its own ledger row.

## 3. The cap-accounting decision (task B)

This is the crux and the thing I most want reviewed. **What should the three caps count?**

**Decision: all three caps count the customer-facing recharges, per §2.4 — restoring the
decided spec, not inventing a new rule.** Concretely, a cap sums prior
**adjustment recharge charges** (`transactions.type='charge'` where the PI's
`stripe_intents.intent_role='carrier_adjustment'`), scoped:
- **per-shipment** — lifetime, by `shipment_id`;
- **per-card** — trailing 24h, by `payment_method_id`;
- **per-user** — trailing 7d, by `user_id`.

The prospective check stays `existing_recharged + rechargeAmount ≤ cap`.

**Why this is right and fixes bug 5 for free:** the current adjustment's own recharge row
doesn't exist yet at check time, and the `-delta` *cost* row is no longer counted at all — so
the lone-$5 double-count disappears. All three caps now measure the same quantity
(money auto-recharged), which is exactly what §2.4 says and what a fraud-prevention cap should
measure. (Cost rows are still written; they're just not what the recharge caps read.)

**To make bug 6's filter correct rather than delete it,** `resolveRecovery` will **own the
recharge ledger row**: right after the off-session PI returns `succeeded`, it synchronously
inserts the `type='charge'` row itself with `idempotency_key = adjustment_<shipment>_<adj>_<attempt>`
(the same prefix the caps filter on) and sets `carrier_adjustments.recovery_tx_id` to it
(fixes bug 8). `stripe-webhook`'s `payment_intent.succeeded` arm then **skips** its own charge-row
insert when `metadata.intent_role === 'carrier_adjustment'` (so there's exactly one charge
row, not two). The caps' existing `LIKE 'adjustment\_%'` filter becomes accurate, and the RPC
column bug (7) is fixed to `si.stripe_intent_id`.

**The honest wrinkle — the N2 race can't be fully closed the way D2 described.** D2 accepted
"wrap the cap-check + INSERT in a single `FOR UPDATE` transaction." That's not literally
achievable here: the recharge is a **Stripe API call**, which cannot run inside the SQL
`FOR UPDATE` transaction (the RPC is pure SQL and can't call Stripe; holding a DB row lock
across an external HTTP call is an anti-pattern). The lock is released when
`resolve_recovery_lock` returns — *before* the PI is created. So two `shipment.invoice`
events on the same shipment arriving within ~100ms can both read "recharged so far = $0" and
both proceed. **This residual race exists today regardless of this proposal** (in fact it's
worse today — the RPC throws, so there's no lock at all).

Two ways to handle the residual race — **recommending (a)**:

- **(a) Accept the sub-second same-shipment race; shrink it and cap the blast radius.**
  Having `resolveRecovery` write the recharge row synchronously (above) shrinks the window to
  the Stripe round-trip, and each recharge becomes immediately visible to the *next* event.
  The per-shipment $10 ceiling caps the worst case at roughly 2× one adjustment. The decided
  review itself rated N2 **non-blocking**, and two ShipmentInvoice events on one shipment
  inside 100ms is rare. Keep the `FOR UPDATE` RPC (now fixed) as the serializer for the *read*
  — it still prevents interleaved reads in the common case. **Simple, no new construct
  (Rule 6).**
- **(b) True zero-race via a reservation row inside the locked RPC.** Insert a "recharge
  reserved" marker within the `FOR UPDATE` transaction, before the Stripe call, that the
  concurrent event's cap-read counts; reconcile it on PI success/failure. Higher fidelity to
  D2's intent, but it's a **new bookkeeping construct** and more moving parts for a rare event
  on SendMo's own margin. Available if the reviewer/John judges the race unacceptable; I don't
  think it's worth it here.

I lean hard on (a). Flagging as **Open Question 1**.

## 4. File-by-file plan

> Nothing here lands until this proposal is decided (task D gates implementation beyond the
> already-shipped fixes).

**`supabase/migrations/03X_resolve_recovery_lock_fix.sql` (new).**
`CREATE OR REPLACE FUNCTION public.resolve_recovery_lock(...)` identical to 033 except the
per-card join uses the real column:
```sql
JOIN public.stripe_intents si ON si.stripe_intent_id = t.stripe_intent_id
```
(New migration, not an edit to 033 — 033 already applied to prod.) Keeps grants/`SECURITY
DEFINER`/`search_path`. This is additive and non-destructive (a dev-DB apply is ordinary
development per Rule 0.5; the prod apply rides the normal migration deploy).

**`supabase/functions/_shared/adjustments.ts`.**
- In `resolveRecovery`, after `pi.status === 'succeeded'`, **insert the recharge ledger row**
  before the email:
  ```ts
  const { data: txRow } = await supabase.from("transactions").insert({
      user_id: paymentContext.user_id,
      shipment_id: shipment.id,
      link_id: null,
      stripe_intent_id: pi.id,
      type: "charge",
      funding_source: "card",
      amount_cents: rechargeAmount,            // +; money collected
      mode: shipment.is_test ? "test" : "live",
      idempotency_key: `adjustment_${shipment.id}_${carrierAdjustmentId}_${attempt}`,
      description: `Carrier adjustment recharge — ${reasonText ?? "adjustment"}`,
  }).select("id").maybeSingle();
  ```
  then `markAdjustmentResolved(supabase, carrierAdjustmentId, "recovered", txRow?.id ?? null, sessionId)`
  (fixes bug 8). Insert is idempotent on the `adjustment_%` key; a 23505 is treated as
  already-written (retry/webhook-collision safe).
- `checkCapsWithLock`: no logic change needed once the RPC is fixed and the recharge rows carry
  the `adjustment_%` key — the per-card/per-user sums start matching real rows (fixes bug 6).
  The per-shipment sum in the **unlocked fallback** currently reads `type='carrier_adjustment'`
  cost rows (`adjustments.ts:495-499`) — **change it to read the recharge charge rows** the same
  way the RPC's per-shipment sum will (`type='charge'` + `idempotency_key LIKE 'adjustment\_%'`
  + `shipment_id`), so fallback and RPC agree and both match §2.4 (fixes bug 5 in the fallback).
- The RPC's per-shipment sum (migration): change from `type='carrier_adjustment'` to the same
  recharge-charge basis. **This is the core of the bug-5 fix** — per-shipment stops counting cost
  rows.

**`supabase/functions/stripe-webhook/index.ts` (`payment_intent.succeeded`).**
- Skip the charge-row insert when `meta.intent_role === 'carrier_adjustment'` (resolveRecovery
  owns it now) — still upsert `stripe_intents` and still write the `fee_stripe` row. Guard:
  ```ts
  const isAdjustmentRecharge = intent_role === "carrier_adjustment";
  if (!isAdjustmentRecharge) { /* existing transactions insert */ }
  ```
  This keeps exactly one charge row per recharge and avoids a double-count from the other side.

**`webhooks/index.ts` (invoice arm).** No functional change required for the cap fix (the cost
row stays as SendMo's cost record). *Optional cleanup, flag for review:* the header comment and
`adjustments.ts` header both describe a nonexistent `charge.succeeded` arm — update the comments
to describe the real synchronous-ledger-row design (documentation-only; prevents the next agent
chasing a ghost).

**`tests/unit/schemaColumnAudit.test.ts`.** Extend per the audit's own extension seam (§ test
plan) to catch: (a) `onConflict:"<col>"` targeting a **partial** unique index, and
(b) columns referenced **inside `rpc` SQL bodies / migration function bodies** — the class that
hid bugs 4 and 7. See §Test plan.

## 5. Test plan (task C)

**The hard finding first:** SendMo's so-called "integration" layer does **not** seed a DB or
tear anything down — `tests/integration/*.test.ts` just `fetch()` deployed Edge Functions, and
the prod-wipe rails are advisory (a doc note + an anon-key `describe.skip`). So a *real* seeded
integration test for H2 is **net-new infrastructure**, not a copy of an existing pattern. This
is a scope decision (**Open Question 2**).

**Recommended: a local-Postgres integration harness** (real DB, real schema, real
`@supabase/supabase-js`, no Stripe/EasyPost network):
1. `supabase start` (local stack) → apply all migrations → gives a real Postgres that
   **rejects wrong columns and un-inferrable indexes** — the exact class that mocks miss.
2. A `vitest.integration.config.ts` project (or a new `db-integration` config) that connects
   with the local service-role key. A **hard guard**: assert the target URL is the local ref
   (e.g. `127.0.0.1`/the known test ref) and **refuse to run** otherwise — the programmatic
   prod-wipe rail the post-mortem wanted but never got.
3. Seed a profile + shipment + `stripe_intents` row, then drive the code under test against the
   real DB. Stripe's `createAdjustmentRecharge` is stubbed to return a `succeeded` PI (we are
   **not** running live recharges — constraint honored); everything else is real SQL.
4. Assert end state: `carrier_adjustments.recovery_status`, the recharge `transactions` row,
   `recovery_tx_id` linkage, and the three cap sums.
5. Teardown: truncate only the seeded rows by id (never a blanket truncate — Rule 0.5), scoped
   to the local DB.

**Must reproduce on pre-fix code, pass on post-fix:**
- **bug 5** — seed one $5 adjustment on a fresh shipment → pre-fix resolves `flag
  (shipment_lifetime)`; post-fix resolves `recharge $6`.
- **bug 4** — the partial-index `onConflict` (already fixed) — a `.upsert` regression test that
  the plain index resolves.
- **bug 7** — call `resolve_recovery_lock` directly → pre-fix raises `42703`; post-fix returns
  the three sums. (Real Postgres is what makes this catchable.)
- **bug 1** — the invoice arm resolves the owner without selecting `shipments.user_id`.

**Static audit extension** (cheap, ships regardless of the DB-harness decision):
- **onConflict-vs-partial-index:** add a `UNIQUE_INDEXES` snapshot map (cols + `partial` flag +
  predicate, from `pg_index`), regex the `.upsert(..., { onConflict: "..." })` options arg, and
  fail when the target set matches only a `partial:true` index → converts the un-inferrable
  runtime 42P10 into a static failure.
- **RPC/migration body columns:** walk `supabase/migrations/*.sql` function bodies for
  `FROM/JOIN <table>` + column refs and check against the `SCHEMA` snapshot — the check that
  would have caught bug 7 at commit time.

**Unit tests** (`tests/unit/adjustments.test.ts`): update the mock's cap-sum expectations to the
recharge-charge basis; add cases for the synchronous recharge-row write + `recovery_tx_id`
linkage. These stay as fast policy tests; they are **not** a substitute for the DB harness.

## 6. Out of scope

- The four already-shipped fixes (bugs 1–4) — recap only.
- Any live synthetic recharge that leaves a permanent ledger row on prod (explicitly gated;
  test-mode + the harness instead).
- The admin Reconciliation **dashboard** rendering of recovered adjustments (bug 8 fixes the
  *data* linkage; any UI polish is a separate follow-up).
- The N3 dispute-window countdown, sweep drift-detection, and Email-B work — all already decided
  in the 2026-05-22 proposal and out of this repair's frame.
- Reservation-based zero-race (Option 1(b)) unless the reviewer/John elects it.

## 7. Open questions

1. **Cap-race (§3):** accept option **(a)** — sub-second same-shipment race tolerated, blast
   radius bounded by the $10 per-shipment ceiling — or build the reservation row **(b)**? I
   recommend (a); it matches the decided "N2 non-blocking" rating and avoids a new construct.
2. **Integration harness (§5):** local Supabase (`supabase start`, needs Docker) vs. a
   scoped-write test against a dedicated **test** Supabase project vs. staying with unit-only +
   the extended static audit. I recommend the local-Postgres harness — it's the only option that
   actually catches the schema/index/RPC bug class that has burned H2 four separate times — but
   it's net-new infra and adds a Docker dependency to the test suite.
3. **Cap unit — delta vs delta+fee:** §2.4 says caps count "re-charges", and a recharge is
   `delta + $1`. Should the $10/$20/$50 thresholds measure `delta+fee` (what the customer is
   actually charged — my default) or `delta` alone (the carrier overage)? The decided text
   doesn't resolve it. I default to `delta+fee` (it's the literal recharge amount and the
   conservative choice), but it's a genuine ambiguity worth a one-line ruling.
4. **Comment cleanup:** OK to include the documentation-only fix of the "charge.succeeded arm"
   ghost comments in this PR, or keep the PR purely functional?
