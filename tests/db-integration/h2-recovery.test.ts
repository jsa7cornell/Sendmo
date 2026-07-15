// H2 carrier-adjustment recovery — REAL-DB integration test.
//
// Decided proposal: proposals/2026-07-15_h2-carrier-adjustment-repair_*decided*.md §5.
//
// This is the layer the four-times-undetected H2 bugs demanded: it runs the
// importable recovery logic + the resolve_recovery_lock RPC against a REAL LOCAL
// Postgres with the REAL schema + migrations applied, so a wrong column, an
// un-inferrable index, or a cap that sums the wrong rows FAILS here instead of
// silently in prod. The mock-client unit tests (tests/unit/adjustments.test.ts)
// cannot catch that class — that's exactly why all four bugs shipped.
//
// Reproduces (pre-fix → post-fix):
//   bug 7 — resolve_recovery_lock threw 42703 (nonexistent column) → now returns sums.
//   bug 4 — onConflict:"source_event_id" hit 42P10 on the partial index → now upserts.
//   bug 5 — a lone $5 adjustment false-flagged (cap counted the cost row) → now recharges;
//           and a genuine >$10 lifetime still correctly flags (cap counts recharges).
//
// RUN (requires Docker for the local stack):
//   supabase start          # boots local Postgres + applies migrations 001..040
//   SUPABASE_LOCAL=1 npm run test:db
// The localGuard HARD-THROWS on any non-loopback target (Review N-b / 2026-05-04).
//
// NOTE: transactions is append-only (Rule 16 — the DB REVOKEs DELETE), so this
// suite never deletes transactions rows; it namespaces every seeded row with a
// per-run id so reruns don't collide. Teardown scopes to the non-append tables.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveLocalTarget } from "./localGuard.ts";

// resolveRecovery's side-effect deps — stubbed so the chain runs without network.
// createAdjustmentRecharge returns a succeeded PI (we do NOT hit Stripe or leave
// live ledger rows; the recharge charge row is simulated explicitly where a test
// needs it, exactly as stripe-webhook's payment_intent.succeeded arm would write it).
vi.mock("../../supabase/functions/_shared/stripe.ts", () => ({
  createAdjustmentRecharge: vi.fn().mockResolvedValue({
    id: "pi_local_recharge",
    status: "succeeded",
    amount: 600,
    currency: "usd",
    client_secret: "",
    capture_method: "automatic",
  }),
}));
vi.mock("../../supabase/functions/_shared/resend.ts", () => ({
  sendEmail: vi.fn().mockResolvedValue({ id: "local-email" }),
}));
vi.mock("../../supabase/functions/_shared/alert.ts", () => ({
  sendAdminAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../supabase/functions/_shared/logger.ts", () => ({ log: vi.fn() }));

import { resolveRecovery } from "../../supabase/functions/_shared/adjustments.ts";

const target = resolveLocalTarget(); // null → skip; non-local → THROWS
const describeDb = target ? describe : describe.skip;

// A per-run tag keeps seeded rows disjoint across reruns (transactions can't be deleted).
const RUN = `dbit_${Math.floor(Date.now() / 1000)}_${Math.floor(process.hrtime()[1] % 100000)}`;

describeDb("H2 recovery — real local DB", () => {
  let sb: SupabaseClient;
  const userId = "00000000-0000-4000-8000-0000000000aa";
  const pmId = `pm_${RUN}`;

  // helper: a fresh shipment id per test so per-shipment sums start clean.
  const newShipmentId = () =>
    `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;

  beforeAll(() => {
    sb = createClient(target!.url, target!.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    // Scope teardown to non-append tables; transactions are append-only (Rule 16).
    await sb.from("carrier_adjustments").delete().like("source_event_id", `si_${RUN}%`);
    await sb.from("stripe_intents").delete().like("stripe_intent_id", `pi_${RUN}%`);
  });

  // ── bug 7 — the RPC executes and returns the three sums ────────────────────
  it("resolve_recovery_lock returns sums without erroring (bug 7)", async () => {
    const shipmentId = newShipmentId();
    const { data, error } = await sb.rpc("resolve_recovery_lock", {
      p_shipment_id: shipmentId,
      p_payment_method_id: pmId,
      p_user_id: userId,
    });
    // Pre-fix (migration 033) this raised 42703 on the nonexistent
    // stripe_intents.stripe_payment_intent_id column.
    expect(error).toBeNull();
    expect(data).toMatchObject({
      shipment_lifetime: expect.any(Number),
      card_24h: expect.any(Number),
      user_7d: expect.any(Number),
    });
  });

  // ── bug 4 — onConflict upsert resolves against the plain unique index ──────
  it("upsert onConflict:source_event_id updates in place (bug 4)", async () => {
    const shipmentId = newShipmentId();
    const sid = `si_${RUN}_bug4`;
    const first = await sb
      .from("carrier_adjustments")
      .upsert(
        { shipment_id: shipmentId, source: "easypost", source_event_id: sid, delta_cents: 500, recovery_status: "pending" },
        { onConflict: "source_event_id" },
      );
    expect(first.error).toBeNull();
    const second = await sb
      .from("carrier_adjustments")
      .upsert(
        { shipment_id: shipmentId, source: "easypost", source_event_id: sid, delta_cents: 800, recovery_status: "pending" },
        { onConflict: "source_event_id" },
      );
    // Pre-fix (partial unique index) this raised 42P10 — the index couldn't be inferred.
    expect(second.error).toBeNull();
    const { data } = await sb
      .from("carrier_adjustments").select("delta_cents").eq("source_event_id", sid).maybeSingle();
    expect(data?.delta_cents).toBe(800); // the .updated amount wins
  });

  // ── bug 5 — a lone $5 adjustment RECHARGES (cap must not count the cost row) ─
  it("a lone $5 adjustment resolves to recharge, not flag (bug 5)", async () => {
    const shipmentId = newShipmentId();
    const sid = `si_${RUN}_bug5a`;

    // Simulate webhooks/index.ts: the -delta carrier_adjustment COST row is
    // written BEFORE resolveRecovery, then the carrier_adjustments row.
    await sb.from("transactions").insert({
      user_id: userId, shipment_id: shipmentId, type: "carrier_adjustment",
      amount_cents: -500, mode: "test", idempotency_key: `carrier_adjustment_${sid}`,
      description: "cost row",
    });
    const { data: adj } = await sb
      .from("carrier_adjustments")
      .upsert(
        { shipment_id: shipmentId, source: "easypost", source_event_id: sid, delta_cents: 500, recovery_status: "pending" },
        { onConflict: "source_event_id" },
      )
      .select("id")
      .maybeSingle();

    const r = await resolveRecovery({
      supabase: sb,
      sessionId: `${RUN}-bug5a`,
      shipment: {
        id: shipmentId, public_code: `PC${RUN.slice(-6)}`, user_id: userId,
        carrier: "USPS", is_test: true, stripe_payment_intent_id: "pi_seed",
      },
      carrierAdjustmentId: adj!.id as string,
      deltaCents: 500,
      paymentContext: { payment_method_id: pmId, user_id: userId, customer_id: "cus_seed" },
    });

    // Post-fix: the RPC's per-shipment sum counts RECHARGE charges (there are
    // none yet), NOT the -500 cost row → 0 + 600 ≤ 1000 → recharge.
    // Pre-fix (033 summing carrier_adjustment rows): 500 + 600 = 1100 > 1000 → flag.
    expect(r.decision).toBe("recharge");
    expect(r.amount_cents).toBe(600);
  });

  // ── bug 5 (other half) — a genuine >$10 lifetime STILL flags ───────────────
  it("per-shipment cap flags once recharges exceed $10 lifetime (bug 5 correctness)", async () => {
    const shipmentId = newShipmentId();
    const sid1 = `si_${RUN}_bug5b1`;
    const sid2 = `si_${RUN}_bug5b2`;

    // A prior recharge already landed: the stripe-webhook payment_intent.succeeded
    // arm wrote a +600 charge row keyed adjustment_<shipment>_<adj>_<attempt>.
    const priorAdjId = "00000000-0000-4000-8000-00000000b5b1";
    await sb.from("transactions").insert({
      user_id: userId, shipment_id: shipmentId, stripe_intent_id: `pi_${RUN}_prior`,
      type: "charge", amount_cents: 600, mode: "test",
      idempotency_key: `adjustment_${shipmentId}_${priorAdjId}_1`, description: "prior recharge",
    });

    const { data: adj2 } = await sb
      .from("carrier_adjustments")
      .upsert(
        { shipment_id: shipmentId, source: "easypost", source_event_id: sid2, delta_cents: 500, recovery_status: "pending" },
        { onConflict: "source_event_id" },
      )
      .select("id")
      .maybeSingle();
    void sid1;

    const r = await resolveRecovery({
      supabase: sb,
      sessionId: `${RUN}-bug5b`,
      shipment: {
        id: shipmentId, public_code: `PD${RUN.slice(-6)}`, user_id: userId,
        carrier: "USPS", is_test: true, stripe_payment_intent_id: "pi_seed2",
      },
      carrierAdjustmentId: adj2!.id as string,
      deltaCents: 500,
      paymentContext: { payment_method_id: pmId, user_id: userId, customer_id: "cus_seed" },
    });

    // $6 already recharged + $5 + $1 fee = $12 > $10 → correctly flag.
    expect(r.decision).toBe("flag");
    expect(r.blocked_by_cap).toBe("shipment_lifetime");
  });
});
