import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth.ts";

// ─────────────────────────────────────────────────────────────────────────────
// admin-user-detail — admin-only comprehensive single-user view.
//
// One call returns everything the /admin/users/:userId page renders:
//   • profile (identity)
//   • account totals (links, shipments, lifetime $$$)
//   • risk metrics (chargebacks, refund rate, lifetime loss, declines, Radar)
//   • payment methods (saved cards, including soft-deleted)
//   • recent shipments (with linked shipment_id for navigation)
//   • recent links (sendmo_links rows)
//   • activity timeline (last N event_logs scoped to user via
//     properties->>'sendmo_user_id' or actor_id)
//
// Input: ?user_id=<uuid> OR ?email=<text>. user_id wins if both supplied.
//
// transactions is append-only — this endpoint reads only. No writes.
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let supabase;
  try {
    ({ supabase } = await requireAdmin(req, corsHeaders));
  } catch (r) {
    if (r instanceof Response) return r;
    throw r;
  }

  const url = new URL(req.url);
  const inputUserId = url.searchParams.get("user_id");
  const inputEmail = url.searchParams.get("email");

  if (!inputUserId && !inputEmail) {
    return new Response(JSON.stringify({ error: "Missing user_id or email" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── 1. Resolve profile ─────────────────────────────────────────────────
  let profileQ = supabase.from("profiles").select("*");
  if (inputUserId) profileQ = profileQ.eq("id", inputUserId);
  else profileQ = profileQ.eq("email", inputEmail);
  const { data: profile, error: profErr } = await profileQ.maybeSingle();

  if (profErr) {
    return new Response(JSON.stringify({ error: `Profile lookup failed: ${profErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!profile) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = profile.id as string;

  // ── 2. Links (user-owned) ──────────────────────────────────────────────
  const { data: links } = await supabase
    .from("sendmo_links")
    .select("id, short_code, link_type, status, max_price_cents, is_test, created_at, expires_at, last_decline_email_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  const linkIds = (links ?? []).map((l: { id: string }) => l.id);

  // ── 3. Shipments (via the user's links) ────────────────────────────────
  // shipments has no user_id column (verified in earlier session) — must
  // traverse sendmo_links.user_id. Pull all the user's shipments lifetime.
  const { data: shipments } = linkIds.length
    ? await supabase
        .from("shipments")
        .select(`
          id, public_code, easypost_shipment_id, carrier, service,
          tracking_number, status, refund_status, easypost_refund_status,
          payment_method, is_test, rate_cents, display_price_cents,
          stripe_payment_intent_id, created_at, delivered_at, cancelled_at
        `)
        .in("link_id", linkIds)
        .order("created_at", { ascending: false })
    : { data: [] as unknown[] };

  const shipmentUuids = (shipments ?? []).map((s: { id: string }) => s.id);
  const shipmentPiIds = (shipments ?? [])
    .map((s: { stripe_payment_intent_id: string | null }) => s.stripe_payment_intent_id)
    .filter((p: string | null): p is string => !!p);

  // ── 4. Transactions (lifetime, for this user) ──────────────────────────
  // Two sources merged: shipment_id-keyed (label_cost, easypost_refund,
  // comp_grant) and stripe_intent_id-keyed (charge, refund, fee_stripe,
  // chargeback). Same Path B pattern as reconciliation-report.
  const shipTxsPromise = shipmentUuids.length
    ? supabase
        .from("transactions")
        .select("id, type, amount_cents, shipment_id, stripe_intent_id, mode, created_at, idempotency_key")
        .in("shipment_id", shipmentUuids)
    : Promise.resolve({ data: [] as unknown[] });
  const piTxsPromise = shipmentPiIds.length
    ? supabase
        .from("transactions")
        .select("id, type, amount_cents, shipment_id, stripe_intent_id, mode, created_at, idempotency_key")
        .in("stripe_intent_id", shipmentPiIds)
        .in("type", ["charge", "refund", "fee_stripe", "chargeback"])
    : Promise.resolve({ data: [] as unknown[] });

  const [{ data: shipTxs }, { data: piTxs }] = await Promise.all([shipTxsPromise, piTxsPromise]);

  // Merge with dedupe by id
  type TxRow = {
    id: string; type: string; amount_cents: number; shipment_id: string | null;
    stripe_intent_id: string | null; mode: string; created_at: string;
    idempotency_key: string | null;
  };
  const txById = new Map<string, TxRow>();
  for (const t of (shipTxs ?? []) as TxRow[]) txById.set(t.id, t);
  for (const t of (piTxs ?? []) as TxRow[]) if (!txById.has(t.id)) txById.set(t.id, t);
  const transactions: TxRow[] = Array.from(txById.values()).sort(
    (a, b) => (a.created_at < b.created_at ? 1 : -1),
  );

  // ── 5. Payment methods ─────────────────────────────────────────────────
  const { data: paymentMethods } = await supabase
    .from("payment_methods")
    .select("brand, last4, exp_month, exp_year, mode, funding_source, is_default, created_at, deleted_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  // ── 6. Account aggregates ──────────────────────────────────────────────
  const sumByType = (t: string, sign: 1 | -1 = 1): number =>
    transactions
      .filter((x) => x.type === t)
      .reduce((s, x) => s + sign * Math.abs(x.amount_cents), 0);

  const lifetimePaidCents = sumByType("charge");                  // + cash in
  const lifetimeStripeFeeCents = sumByType("fee_stripe");         // store positive
  const lifetimeRefundCents = sumByType("refund");
  const lifetimeChargebackCents = sumByType("chargeback");
  const lifetimeLabelCostCents = sumByType("label_cost");
  const lifetimeEPRefundCents = sumByType("easypost_refund");
  const netMarginCents =
    lifetimePaidCents
    - lifetimeStripeFeeCents
    - lifetimeRefundCents
    - lifetimeChargebackCents
    - lifetimeLabelCostCents
    + lifetimeEPRefundCents;

  const shipmentsCount = (shipments ?? []).length;
  const refundedShipmentsCount =
    (shipments ?? []).filter((s: { refund_status: string | null }) => s.refund_status === "refunded").length;
  const refundRatePct =
    shipmentsCount > 0 ? Math.round((refundedShipmentsCount * 100) / shipmentsCount) : 0;

  // Lifetime loss = label_cost - charges that resolved to shipments. Defensive
  // floor at 0 — if user is profitable, loss is 0, not a "negative loss".
  const lifetimeLossCents = Math.max(
    0,
    lifetimeLabelCostCents - lifetimePaidCents + lifetimeRefundCents + lifetimeChargebackCents - lifetimeEPRefundCents,
  );

  const accountCreatedAt = profile.created_at as string;
  const accountAgeDays = Math.floor((Date.now() - new Date(accountCreatedAt).getTime()) / 86_400_000);

  // ── 7. Activity timeline (event_logs scoped to this user) ──────────────
  // Best-effort: actor_id is rarely populated, but properties.sendmo_user_id
  // is set by the webhook resolver and a few other writers. We OR them.
  const { data: events } = await supabase
    .from("event_logs")
    .select("id, event_type, severity, entity_type, entity_id, properties, created_at")
    .or(`actor_id.eq.${userId},properties->>sendmo_user_id.eq.${userId}`)
    .order("created_at", { ascending: false })
    .limit(100);

  // ── 8. Risk signals from events ────────────────────────────────────────
  // Declines: stripe.payment_failed events scoped to this user.
  // Radar high-risk: stripe.payment_succeeded where properties.radar_risk_level
  // is 'elevated' or 'highest' — best-effort, the writer may or may not log it.
  const declinesAll = (events ?? []).filter(
    (e: { event_type: string }) => e.event_type === "stripe.payment_failed",
  );
  const thirtyDaysAgoMs = Date.now() - 30 * 86_400_000;
  const declines30d = declinesAll.filter(
    (e: { created_at: string }) => new Date(e.created_at).getTime() >= thirtyDaysAgoMs,
  ).length;

  const radarHighRisk = (events ?? []).filter((e: { properties: Record<string, unknown> | null }) => {
    const level = (e.properties as { radar_risk_level?: string } | null)?.radar_risk_level;
    return level === "elevated" || level === "highest";
  }).length;

  // ── 9. Compose response ────────────────────────────────────────────────
  return new Response(
    JSON.stringify(
      {
        profile: {
          id: profile.id,
          email: profile.email,
          full_name: profile.full_name,
          phone: profile.phone,
          role: profile.role,
          stripe_customer_id_live: profile.stripe_customer_id_live,
          stripe_customer_id_test: profile.stripe_customer_id_test,
          daily_budget_cents: profile.daily_budget_cents,
          weekly_budget_cents: profile.weekly_budget_cents,
          created_at: profile.created_at,
        },
        account: {
          account_age_days: accountAgeDays,
          links_count: links?.length ?? 0,
          shipments_count: shipmentsCount,
          lifetime_paid_cents: lifetimePaidCents,
          lifetime_label_cost_cents: lifetimeLabelCostCents,
          lifetime_stripe_fee_cents: lifetimeStripeFeeCents,
          lifetime_ep_refund_cents: lifetimeEPRefundCents,
          net_margin_cents: netMarginCents,
        },
        risk: {
          chargebacks_count: transactions.filter((t) => t.type === "chargeback").length,
          chargebacks_total_cents: lifetimeChargebackCents,
          refunds_count: transactions.filter((t) => t.type === "refund").length,
          refunds_total_cents: lifetimeRefundCents,
          refund_rate_pct: refundRatePct,
          lifetime_loss_cents: lifetimeLossCents,
          declines_30d_count: declines30d,
          declines_lifetime_count: declinesAll.length,
          radar_high_risk_count: radarHighRisk,
          account_age_days: accountAgeDays,
        },
        payment_methods: paymentMethods ?? [],
        links: links ?? [],
        shipments: shipments ?? [],
        transactions,
        activity_timeline: events ?? [],
        connection_signals: {
          // event_logs.properties does not currently carry ip / user_agent /
          // geography for the user's actions. Surfaced as a placeholder so the
          // UI can state "not captured" rather than render empty.
          captured: false,
          note: "IP / user-agent / geography are not yet captured in event_logs. Future enhancement.",
        },
      },
      null,
      2,
    ),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
