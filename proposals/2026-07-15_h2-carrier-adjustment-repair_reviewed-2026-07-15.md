---
title: H2 Carrier-Adjustment Auto-Recovery — Full Repair
slug: h2-carrier-adjustment-repair
project: sendmo
status: revised
created: 2026-07-15
last_updated: 2026-07-15 16:00
reviewed: 2026-07-15
decided: null
author: Claude Opus 4.8 session — "SendMo H2 carrier-adjustment repair 2026-07-15" (traced the full chain against the live prod schema via Supabase MCP)
reviewer: Claude Opus 4.8 — fresh-eyes reviewer; cold read against PLAYBOOK Rule 16 (ledger writer map) + Rule 19, PAYMENTS.md, the decided 2026-05-22 proposal (§2.4 + N2/N3/D2), and independently verified every schema claim + all four bugs against live prod (fkxykvzsqdjzhurntgah) via Supabase MCP
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

---

## Review

```yaml
reviewer: Claude Opus 4.8 — fresh-eyes reviewer; cold read against PLAYBOOK Rule 16 (ledger writer map) + Rule 19, PAYMENTS.md, the decided 2026-05-22 proposal (§2.4 + N2/N3/D2), the live prod schema (fkxykvzsqdjzhurntgah) via Supabase MCP, and every referenced file (adjustments.ts, webhooks/index.ts invoice arm, stripe-webhook payment_intent.succeeded arm, stripe.ts createAdjustmentRecharge, migration 033, both test files)
reviewed_at: 2026-07-15
verdict: approve-with-changes
```

### Summary

The diagnosis is excellent and independently verifiable — I re-ran every schema claim against live prod and all four bugs (5–8) hold exactly as described (evidence in each finding below). The bug-5-is-drift-from-§2.4 framing is correct and load-bearing. **The problem is the fix for bugs 6/8, not the diagnosis of them:** the central design move — have `resolveRecovery` synchronously write a `type='charge'` ledger row while `stripe-webhook` skips its own — (a) adds a **second writer of `charge` rows**, which contradicts PLAYBOOK Rule 16's sole-writer map without declaring the amendment, and (b) splits one logical charge row across two writers with **two different idempotency keys and no shared dedup**, creating both a silent missing-row and a double-row failure mode that the current single-writer design doesn't have. There is a cleaner fix that repairs bugs 6 and 8 without moving the writer or touching Rule 16. Everything else — the RPC column fix (7), the fallback-basis fix (5), the local-Postgres harness with a hard prod-URL guard, the static-audit extensions — I endorse.

### Blocking issues

**B1 — The synchronous recharge-row insert makes `resolveRecovery` a second writer of `charge` rows, contradicting PLAYBOOK Rule 16 without declaring the amendment.**
*Location:* §3 / §4 `_shared/adjustments.ts` (the `supabase.from("transactions").insert({ type: "charge", ... })` sketch); §4 `stripe-webhook` skip guard.
*Issue:* PLAYBOOK Rule 16's writer map (verified in `PLAYBOOK.md`, the `transactions` row of the schema table) states verbatim: `charge / refund / refund_fee_recovered / fee_stripe / chargeback → stripe-webhook (sole writer, unchanged)`. The proposal has `resolveRecovery` — which runs inside the `webhooks` function — insert a `type='charge'` row. That is a new `charge` writer. The decided 2026-05-22 proposal §2.1 was scrupulous about this exact thing: every writer-map change (`label_cost`, `easypost_refund`, `carrier_adjustment`) was *declared* as a deliberate Rule 16 amendment and landed as a concrete `PLAYBOOK.md` edit. This proposal changes the `charge` writer silently. Per the review protocol, contradicting a project rule is automatically blocking even when the logic is internally consistent.
*Suggested fix:* Either (preferred — see B2) don't move the writer at all, or, if the synchronous insert is retained, add a `## Rule 16 reconciliation` section that amends the writer map (`charge` → `stripe-webhook` **+ `webhooks`/`resolveRecovery` for the `carrier_adjustment` role**) and lands it as a `PLAYBOOK.md` edit in §4, exactly as migration 032 did.

**B2 — Splitting the charge row across two writers with two different idempotency keys removes the Rule 16 dedup backstop and introduces a missing-row AND a double-row failure mode. The current single-writer design is strictly safer here.**
*Location:* §3 ("resolveRecovery will own the recharge ledger row… stripe-webhook then skips… when `metadata.intent_role === 'carrier_adjustment'`").
*Issue:* Verified the two keys don't overlap: the synchronous insert would use `adjustment_<shipment>_<adj>_<attempt>` (§4 sketch), while `stripe-webhook`'s `payment_intent.succeeded` arm writes `stripe.<eventId>:charge` (`stripe-webhook/index.ts:264`). Because the keys differ, the `transactions.idempotency_key` UNIQUE constraint — the entire backbone of Rule 16 dedup — **cannot see across the two writers.** The only thing keeping exactly one row is the `intent_role` metadata check. So:
>   - **Missing-row:** the recharge PI succeeds at Stripe, but the synchronous insert fails or is lost (DB error, or the `webhooks` isolate is reclaimed after the Stripe round-trip but before the insert commits — this is the *exact* isolate-reclaim class the 2026-07-06 `fee_stripe` fix documents at `stripe-webhook/index.ts:277-281`). `stripe-webhook` then *also* skips (metadata says `carrier_adjustment`) → **money collected, zero `charge` rows anywhere.** A silent ledger hole; the fee_stripe row still lands, so net-margin silently understates and reconciliation never closes. Today's design has no such hole: `stripe-webhook` is durable and Stripe retries it to 2xx.
>   - **Double-row:** if `metadata.intent_role` is absent/wrong when `stripe-webhook` processes the event (`resolveIdsFromMetadata` returns null role → default `"shipment"`), the skip doesn't fire → **two `charge` rows** with different keys and no dedup to catch it.
*Suggested fix:* Keep `stripe-webhook` as the **sole** `charge` writer (preserves Rule 16, keeps the durable Stripe-retried path). Fix bugs 6+8 there instead: in the `payment_intent.succeeded` arm, when `intent_role === 'carrier_adjustment'`, (i) derive the ledger idempotency key as `adjustment_<shipment_id>_<carrier_adjustment_id>_<attempt>` from the PI metadata (which `createAdjustmentRecharge` already stamps — `stripe.ts:387-394`) so it matches the caps' `LIKE 'adjustment\_%'` filter (fixes bug 6), and (ii) `UPDATE carrier_adjustments SET recovery_tx_id = <new row> WHERE id = metadata.carrier_adjustment_id` (fixes bug 8). `resolveRecovery` just marks `recovery_status` and never touches `transactions`. Cost: `recovery_tx_id` is null for the sub-second window until the webhook lands — acceptable, since bug 8 is reporting-severity by the proposal's own rating, and it self-heals. This is fewer moving parts, no new writer, no cross-function skip flag, and no way to drop the money row. It does slightly widen the OQ1 race (the next event won't see the recharge row until the async webhook lands) — call that out and weigh it, but a durable money row should win over a shorter race window on SendMo's own margin.

**B3 — The RPC per-shipment sum and the unlocked-fallback per-shipment sum must switch to the recharge-charge basis in the *same* change, or the two cap paths disagree.**
*Location:* §4 (RPC migration `03X` + `adjustments.ts:495-499` fallback).
*Issue:* This is really an execution-ordering flag on an otherwise-correct plan. Migration 033's per-shipment sum reads `type='carrier_adjustment'` cost rows (`033_resolve_recovery_lock_rpc.sql:71-76`), and the fallback reads the same (`adjustments.ts:495-499`). Bug 5 is only fixed if **both** move to `type='charge' AND idempotency_key LIKE 'adjustment\_%'`. If the new migration fixes only the bug-7 column join (`si.stripe_intent_id`) but leaves the per-shipment `SELECT` on `carrier_adjustment`, then fixing bug 7 *activates* the RPC (it stops throwing) and the now-live RPC path still double-counts cost rows — you'd have shipped a fix that re-introduces bug 5 on the path that was previously dead. The proposal does say to change both (§4), but the two edits live in different files/migrations; make it one atomic landing and add a test asserting RPC-path and fallback-path return the same decision for the same fixture.

### Non-blocking concerns

**N-a — Fixing bug 7 turns on the N2 `FOR UPDATE` guard for the first time in production.** The proposal correctly notes the guard has been dead since it shipped. Flipping previously-dead serialization code live is itself a behavior change worth one line in the verification plan: confirm the RPC's `PERFORM 1 FROM shipments … FOR UPDATE` doesn't deadlock against any other transaction that locks `shipments` (e.g., a concurrent tracking-poll update to the same row). Low risk (the RPC is short and commits fast), but it's net-new concurrency in the money path.

**N-b — OQ2 harness: the prod-URL guard must be a hard throw at connection time, not a `describe.skip`.** The proposal rightly criticizes the existing rails as "advisory (a doc note + an anon-key `describe.skip`)". The replacement must not repeat that shape: assert `127.0.0.1`/the known local ref in the code path that constructs the service-role client and `throw` if it doesn't match, before any query runs. A skipped `describe` is exactly what failed to prevent the 2026-05-04 prod wipe. Otherwise I strongly endorse the local-Postgres harness — it is the only option that catches the schema/index/RPC class that has now burned H2 four times, and the Docker dependency is worth it.

**N-c — The static-audit "RPC/migration body column" check (the one that would have caught bug 7) is the highest-value audit extension but also the hardest to make non-flaky.** Regexing `FROM/JOIN <table>` + column refs out of plpgsql bodies will have false positives (aliases, CTEs, `NEW.`/`OLD.` trigger refs, dynamic SQL). Recommend scoping it narrowly to `JOIN … ON <alias>.<col>` and simple `WHERE <alias>.<col>` forms against the schema snapshot, and accepting that it won't cover every construct — a partial check that catches the join-column class is worth more than a comprehensive one that gets disabled for noise. Don't let it become the thing a future agent `.skip`s.

### Nits

- **§2 bug-5 mis-cites the decided review's N3.** The proposal says *"N3 of the same review is explicit: the `carrier_adjustment` row is SendMo's cost; the recharge is the '+charge' recovery, and 'caps gate the latter.'"* I read N3 (decided proposal line 348) — it is the **dispute-window-aging** concern; the phrase "caps gate the latter" appears nowhere in that review. The **substance is still correct** and independently grounded: §2.4 (lines 152-154) says the caps count *"auto-recharged adjustments"* / *"adjustment re-charges"*, which is the customer-recharge side, not cost rows. So bug 5 is genuine drift — but fix the citation to point at §2.4 (which does support it) rather than N3 (which doesn't), so the next reader doesn't chase a quote that isn't there.
- §4 `AdjustmentShipment.stripe_payment_intent_id`: the field is named `stripe_payment_intent_id` in the `_shared/adjustments.ts` interface (line 76) and in `webhooks/index.ts`, but it's sourced from `shipments.stripe_payment_intent_id` (a real column) — fine, just note the naming near-collision with the bug-7 `stripe_intents.stripe_payment_intent_id` ghost so nobody "fixes" the wrong one during the RPC repair.
- OQ3 (delta vs delta+fee): default to `delta+fee` is right and, usefully, self-consistent — the recharge row's `amount_cents` *is* `delta+fee` (`resolveRecovery` computes `rechargeAmount = deltaCents + HANDLING_FEE_CENTS`), so if the caps sum the charge rows they measure `delta+fee` automatically. One-line ruling, no code impact. Ship it.

### Predicted pitfalls (if shipped as written)

1. **Silent ledger hole — money collected, no `charge` row.** (Ties B2 + the 2026-07-06 `fee_stripe` isolate-reclaim incident + Rule 16.) The recharge PI succeeds; the `webhooks` isolate is reclaimed before the synchronous insert commits; `stripe-webhook` skips because `intent_role==='carrier_adjustment'`. Result: a real Stripe charge with no SendMo `charge` row and a `fee_stripe` row that has nothing to offset. Net-margin understates by the recharge amount, permanently and silently — the same shape as the fee_stripe rows that were being dropped until the `runInBackground` fix, except here there's no second writer to recover it. This is the single most likely production failure and it's a *regression* vs. today's single-writer design.

2. **Double `charge` row when metadata is absent.** (Ties B2 + decided-review B4, "re-flattening an idempotency namespace the sibling proposal kept distinct.") Any path where the recharge PI reaches `stripe-webhook` without `intent_role='carrier_adjustment'` in metadata (retry with stripped metadata, a manual admin re-charge, a Stripe object reconstruction) defeats the skip guard. Two `charge` rows land with two different keys; the UNIQUE constraint catches neither. This is precisely the class the decided review flagged as B4 — different-key writers with no shared dedup produce ledger drift nobody can reproduce.

3. **The prod-URL guard ships as advisory and the next integration run truncates prod.** (Ties directly to the 2026-05-04 prod-DB-wipe post-mortem + Rule 0.5.) If the harness's teardown truncates seeded rows and the guard is a `describe.skip` or a soft warning rather than a hard throw on the connection string, a misconfigured `POSTGRES_PRISMA_URL`/service-role env re-runs the 2026-05-04 incident verbatim. The proposal's instinct (a programmatic guard) is right; the failure mode is shipping it at the same fidelity as the rails it criticizes.

4. **Bug-7 fix silently re-introduces bug 5 on the newly-live RPC path.** (Ties B3.) If the new migration fixes the `si.stripe_intent_id` join but not the per-shipment `SELECT`'s `type='carrier_adjustment'` basis, then activating the RPC (previously always-throwing) turns on a per-shipment cap that double-counts cost rows — the exact false-`flag` the proposal is trying to kill, now on the path that used to be dead. Both edits must land together with a parity test.

5. **Turning on the FOR UPDATE lock exposes a latent deadlock/lock-wait in the money path.** (Ties N-a.) The N2 guard has never executed in prod; its first real run under two concurrent same-shipment events is also the first test of whether `shipments`-row locking interacts badly with any other writer of that row (tracking poll, cancel-label). Rare, but it's genuinely untested concurrency being switched on in the charge path.

### What the proposal got right

- **The diagnosis is fully reproducible.** I independently verified against live prod: `stripe_intents` has `stripe_intent_id` and **no** `stripe_payment_intent_id` (bug 7 confirmed at `033:87`); `transactions` has **no** `intent_role` column (bug 6 confirmed); `carrier_adjustments_source_event_id_key` is a **plain** unique index; and `recovered=0, intent_role='carrier_adjustment'=0, total_adjustments=1` (recovery has never run; only the synthetic `4Z8ZJZX` row exists). Every schema claim holds. That is exemplary "traced against the live schema" work.
- **Bug 5 as drift-from-§2.4 is the right framing and it's correct.** §2.4 caps are explicitly on the recharge side ("auto-recharged adjustments" / "adjustment re-charges"); summing `carrier_adjustment` cost rows was never decided. This is the protocol's "restoring the spec, not a new finding" done properly (modulo the N3 citation nit).
- **Honesty about the N2 race not being literally closeable.** The observation that the recharge is a Stripe HTTP call and therefore cannot sit inside the SQL `FOR UPDATE` transaction is exactly right, and the decision to shrink-and-bound rather than hold a DB lock across an external call is the correct instinct. OQ1 recommendation (a) is the right call — do **not** build the reservation row for a rare event on SendMo's own margin bounded by the $10 ceiling. (Note: adopting B2 slightly widens that window; still accept (a).)
- **Naming the test-infra root cause.** "The integration layer doesn't seed a DB, it fetches deployed functions" is the honest finding that explains why H2 failed four times undetected, and the local-Postgres harness with a hard guard is the right, if net-new, fix. OQ2 → local harness, with N-b's hard-throw caveat.
- **OQ4 → include the comment cleanup.** The ghost `charge.succeeded`-arm comments in `adjustments.ts` (lines 119-121) actively misled — they're part of why bug 8 hid. Fixing them in the same PR is documentation hygiene, not scope creep. Yes.

## Author response

Round-1 response. **Verdict accepted: approve-with-changes, zero unresolved disagreements** — so no "Tradeoffs for John" section is needed. The reviewer's B1/B2 catch is correct and its alternative is strictly better than my draft; I'm changing the design. Per-point below. **Sections 3–4 of the body are superseded on the writer-location point by this response — implementation follows the design stated here.**

**B1 — second `charge` writer contradicts Rule 16. ✅ Accept (moot under B2).** Right, and I missed it. My draft would have made `resolveRecovery` (running inside `webhooks`) a `charge` writer, which the Rule 16 map assigns solely to `stripe-webhook`, without declaring the amendment the way migration 032's writer-map changes were declared. Adopting B2 removes the second writer entirely, so no Rule 16 amendment is needed at all — cleaner than declaring one.

**B2 — keep `stripe-webhook` as sole `charge` writer; fix bugs 6+8 there. ✅ Accept — this is the design now.** The split-writer/two-key missing-row hole (recharge succeeds at Stripe, the `webhooks` isolate is reclaimed before the synchronous insert commits, `stripe-webhook` skips on metadata → money collected, zero `charge` rows) is the same isolate-reclaim class as the 2026-07-06 `fee_stripe` fix, and my design had no second writer to recover it. **Revised design:**
- `resolveRecovery` fires the off-session PI, sets `recovery_status`, and **never touches `transactions`.** (Drop the synchronous insert and the `markAdjustmentResolved(recoveryTxId)` change.)
- `stripe-webhook` `payment_intent.succeeded` stays the sole `charge` writer. When `intent_role === 'carrier_adjustment'`, it (i) derives the ledger `idempotency_key = adjustment_<shipment_id>_<carrier_adjustment_id>_<attempt>` from the PI metadata that `createAdjustmentRecharge` already stamps (`stripe.ts:387-394`) — so the row matches the caps' `LIKE 'adjustment\_%'` filter (**fixes bug 6**) — and (ii) `UPDATE carrier_adjustments SET recovery_tx_id = <new charge row id> WHERE id = <metadata.carrier_adjustment_id>` (**fixes bug 8**). No skip guard, no cross-function flag, one durable Stripe-retried writer, and the `idempotency_key` UNIQUE constraint still backstops dedup within that one writer.
- **Cost accepted:** `recovery_tx_id` is null for the sub-second window until the webhook lands, and (per the reviewer's own note) this slightly widens the OQ1 race — the next same-shipment event won't see the recharge row until the async webhook writes it. Both are acceptable: bug 8 is reporting-severity and self-heals; the race stays bounded by the $10 per-shipment ceiling. A durable money row beats a shorter race window on SendMo's own margin. **OQ1 recommendation (a) still stands.**

**B3 — RPC per-shipment sum + fallback per-shipment sum must move to the recharge-charge basis atomically. ✅ Accept.** Sharp ordering catch: fixing only bug 7's join column would *activate* the previously-always-throwing RPC while its per-shipment `SELECT` still reads `type='carrier_adjustment'` cost rows — re-introducing bug 5 on the newly-live path. Both the migration's per-shipment `SELECT` and the `adjustments.ts:495-499` fallback move to `type='charge' AND idempotency_key LIKE 'adjustment\_%' AND shipment_id=…` in the same landing, with a **parity test** asserting the RPC path and the fallback path return the same decision for the same fixture.

**N-a — turning on the FOR UPDATE guard is net-new concurrency in the money path. ✅ Accept.** Added to the verification plan: confirm the RPC's `PERFORM 1 FROM shipments … FOR UPDATE` doesn't lock-wait/deadlock against other `shipments`-row writers (tracking poll, cancel-label) under two concurrent same-shipment events.

**N-b — prod-URL guard must be a hard throw at connect time, not `describe.skip`. ✅ Accept.** The guard asserts the local/test ref in the code path that constructs the service-role client and `throw`s before any query runs. Not a skipped `describe` — that's the exact shape that failed on 2026-05-04.

**N-c — scope the RPC/migration-body column audit narrowly. ✅ Accept.** Limit to `JOIN … ON <alias>.<col>` and simple `WHERE <alias>.<col>` against the snapshot; accept partial coverage over a noisy check a future agent disables. Catching the join-column class (bug 7) is the whole point.

**Nits — all ✅.**
- N3 → §2.4 citation fixed: §2 will cite §2.4 ("auto-recharged adjustments" / "adjustment re-charges" — the recharge side) as the drift basis, not review N3 (which is the dispute-window-aging concern). Substance unchanged; the quote now points where it's actually supported.
- Noted the `stripe_payment_intent_id` naming near-collision: `AdjustmentShipment.stripe_payment_intent_id` (real, from `shipments`) vs. the `stripe_intents.stripe_payment_intent_id` **ghost** in the RPC (bug 7). The RPC fix touches only the latter; comment added so nobody "fixes" the wrong one.
- OQ3 → `delta+fee`, ratified and self-consistent: the recharge row's `amount_cents` *is* `delta+fee`, so caps summing charge rows measure `delta+fee` automatically. No code impact.

**OQ dispositions (author + reviewer converged):** OQ1 → (a) accept the bounded race, no reservation row. OQ2 → local-Postgres harness with N-b's hard-throw guard. OQ3 → `delta+fee`. OQ4 → include the ghost-comment cleanup.

**Net change to the plan:** the diagnosis (bugs 5–8), the cap-semantics decision (restore §2.4), the RPC column fix, the atomic per-shipment-basis fix, the local harness, and the audit extensions all stand. The **only** design change is *where* bugs 6+8 are fixed: in `stripe-webhook` (sole writer, derive-key + patch-`recovery_tx_id`) instead of a new synchronous writer in `resolveRecovery`. This *removes* files/edits from the plan (no `resolveRecovery` transactions insert, no skip guard, no Rule 16 amendment) — strictly simpler.

**Awaiting John's decision** to move to implementation. Nothing is unresolved between author and reviewer.

## Addendum — admin alert on live outcomes (John requirement, 2026-07-15, post-review)

John asked to **be emailed any time H2 fires on a live shipment.** Scope chosen: **recharge + flag** (the money-moving and needs-your-review outcomes); silent `absorb` cases (≤$1, carrier credit, comp) do **not** email. This is an ops-visibility requirement layered on the repair — the point is that H2 has never run live, so its first real firings should be visible, not buried in `event_logs`.

**Design — extend the existing `_shared/alert.ts:sendAdminAlert` (Rule 6, no new construct).** It already has exactly the two framings needed:
- **`flag` → `variant:"alert"`** (red "[SendMo ALERT] …", needs-a-human): fires on the three flag branches in `resolveRecovery` — `above_ceiling` (>$10), `no_saved_pm`, and `cap_breach`. Rows: public_code, carrier, reason, `delta_cents`, flag reason (+ `blocked_by_cap` when present). `actionUrl` → `${APP_URL}/admin?shipment=<id>` so John can act.
- **`recharge` (succeeded) → `variant:"notice"`** (blue "[SendMo] …", routine FYI): fires after `markAdjustmentResolved(...,"recovered",...)`. Rows: public_code, carrier, reason, `delta_cents`, `recharge_amount` (delta+fee), `pi_id`.

**Guards:**
- **Live only** — gate every send on `!shipment.is_test`, so test-mode verification and the integration harness never email John.
- **Dedup per `carrier_adjustment_id`** — reuse the same `notifications_log` marker pattern the customer email already uses (`sendCarrierAdjustmentEmail`), with a distinct `event_type` (e.g. `admin_alert.carrier_adjustment:<id>`), so a `.updated` re-fire or webhook retry doesn't double-email. `sendAdminAlert` already never throws, so a send failure can't break recovery.

**Send-sites (all in `_shared/adjustments.ts:resolveRecovery`):** the three `flag` returns and the successful-`recharge` return. No new files; ~1 helper + 4 call-sites. Rides the same PR.

**Test coverage:** the local-Postgres integration test (§5) asserts the `notifications_log` admin-alert marker is written for a live recharge and a live flag, and is **absent** for a test-mode run and for an `absorb`. Unit test asserts `sendAdminAlert` is called with `variant:"alert"` on flag and `variant:"notice"` on recharge, and not at all when `is_test`.

**Reconciliation with the customer email:** unchanged. The customer still gets `carrierAdjustmentEmail` on a successful recharge (N5 send-site); this admin alert is a **separate** email to `SENDMO_ADMIN_EMAIL`, deduped independently. A live recharge therefore sends two emails (customer + admin notice); a live flag sends one (admin alert only — no customer charge happened).

**Status of this addendum:** added after the round-1 review at John's request. It's small and uses an already-reviewed primitive, so I don't think it needs a fresh review round — but flagging it so the next session knows it post-dates the Review section. Folds into the same implementation.
