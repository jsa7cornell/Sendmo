// src/pages/AdminUserDetail.tsx
//
// Per-user detail view for the Admin panel.
// Route: /admin/users/:userId
//
// One page, no toggle. Renders identity + risk dashboard + lifetime activity
// (shipments + transactions + payment methods) + activity timeline.
//
// Data source: GET /functions/v1/admin-user-detail?user_id=<uuid>.
// All sums computed server-side from the append-only `transactions` ledger.
// transactions = label_cost + easypost_refund (shipment_id-keyed) merged with
// charge + refund + fee_stripe + chargeback (stripe_intent_id-keyed via
// shipments.stripe_payment_intent_id — same Path B pattern as
// reconciliation-report).

import { useState, useEffect } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { ArrowLeft, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserDetailResponse {
  profile: {
    id: string;
    email: string;
    full_name: string | null;
    phone: string | null;
    role: string | null;
    stripe_customer_id_live: string | null;
    stripe_customer_id_test: string | null;
    daily_budget_cents: number | null;
    weekly_budget_cents: number | null;
    created_at: string;
  };
  account: {
    account_age_days: number;
    links_count: number;
    shipments_count: number;
    lifetime_paid_cents: number;
    lifetime_label_cost_cents: number;
    lifetime_stripe_fee_cents: number;
    lifetime_ep_refund_cents: number;
    net_margin_cents: number;
  };
  risk: {
    chargebacks_count: number;
    chargebacks_total_cents: number;
    refunds_count: number;
    refunds_total_cents: number;
    refund_rate_pct: number;
    lifetime_loss_cents: number;
    declines_30d_count: number;
    declines_lifetime_count: number;
    radar_high_risk_count: number;
    account_age_days: number;
  };
  payment_methods: Array<{
    brand: string | null;
    last4: string | null;
    exp_month: number | null;
    exp_year: number | null;
    mode: string;
    funding_source: string | null;
    is_default: boolean;
    created_at: string;
    deleted_at: string | null;
  }>;
  links: Array<{
    id: string;
    short_code: string;
    link_type: string;
    status: string;
    max_price_cents: number | null;
    is_test: boolean;
    created_at: string;
    expires_at: string | null;
    last_decline_email_at: string | null;
  }>;
  shipments: Array<{
    id: string;
    public_code: string;
    easypost_shipment_id: string | null;
    carrier: string | null;
    service: string | null;
    tracking_number: string | null;
    status: string;
    refund_status: string | null;
    easypost_refund_status: string | null;
    payment_method: string | null;
    is_test: boolean;
    rate_cents: number | null;
    display_price_cents: number | null;
    stripe_payment_intent_id: string | null;
    created_at: string;
    delivered_at: string | null;
    cancelled_at: string | null;
  }>;
  transactions: Array<{
    id: string;
    type: string;
    amount_cents: number;
    shipment_id: string | null;
    stripe_intent_id: string | null;
    mode: string;
    created_at: string;
  }>;
  activity_timeline: Array<{
    id: string;
    event_type: string;
    severity: string | null;
    entity_type: string | null;
    entity_id: string | null;
    properties: Record<string, unknown> | null;
    created_at: string;
  }>;
  connection_signals: {
    captured: boolean;
    note: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Composite risk score — heuristic, surfaced as a visual chip. Each signal
// contributes points; >= 5 = High, 2-4 = Watch, else Clear.
function computeRiskTier(risk: UserDetailResponse["risk"]): { tier: "clear" | "watch" | "high"; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];
  if (risk.chargebacks_count > 0) {
    points += 3 + risk.chargebacks_count;
    reasons.push(`${risk.chargebacks_count} chargeback${risk.chargebacks_count > 1 ? "s" : ""}`);
  }
  if (risk.refund_rate_pct >= 30) {
    points += 3;
    reasons.push(`${risk.refund_rate_pct}% refund rate`);
  } else if (risk.refund_rate_pct >= 15) {
    points += 1;
    reasons.push(`${risk.refund_rate_pct}% refund rate (elevated)`);
  }
  if (risk.declines_30d_count >= 3) {
    points += 2;
    reasons.push(`${risk.declines_30d_count} declines in 30d`);
  }
  if (risk.radar_high_risk_count > 0) {
    points += 2;
    reasons.push(`${risk.radar_high_risk_count} Radar high-risk`);
  }
  if (risk.lifetime_loss_cents >= 5000) {
    points += 2;
    reasons.push(`${fmt$(risk.lifetime_loss_cents)} uncovered loss`);
  } else if (risk.lifetime_loss_cents > 0) {
    points += 1;
    reasons.push(`${fmt$(risk.lifetime_loss_cents)} uncovered loss`);
  }
  if (risk.account_age_days < 7) {
    points += 1;
    reasons.push("Account < 7 days old");
  }
  const tier: "clear" | "watch" | "high" = points >= 5 ? "high" : points >= 2 ? "watch" : "clear";
  return { tier, reasons };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminUserDetail() {
  const { userId } = useParams<{ userId: string }>();
  const { user, session, loading: authLoading, isAdmin, profileLoaded } = useAuth();
  const [data, setData] = useState<UserDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // useEffect MUST come before any conditional returns — React Rules of Hooks.
  // Putting the auth-guard returns above this would trip React error #310
  // ("rendered more hooks than during the previous render") when authLoading
  // flips between renders.
  useEffect(() => {
    if (!session || !userId) return;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
        const res = await fetch(`${BASE_URL}/functions/v1/admin-user-detail?user_id=${encodeURIComponent(userId)}`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed (${res.status})`);
        }
        setData(await res.json());
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    })();
  }, [session, userId]);

  // Auth guards — only run AFTER all hooks above.
  if (authLoading) return null;
  if (!user) return <Navigate to="/login?redirectTo=/admin" replace />;
  if (!profileLoaded) return null;
  if (!isAdmin) return <Navigate to="/admin" replace />;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading user…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen p-8 max-w-2xl mx-auto">
        <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-primary hover:underline mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to admin
        </Link>
        <div className="border border-red-200 bg-red-50 rounded p-4 text-sm text-red-700">
          {error || "User not found"}
        </div>
      </div>
    );
  }

  const { profile, account, risk, payment_methods, links, shipments, transactions, activity_timeline, connection_signals } = data;
  const { tier, reasons } = computeRiskTier(risk);

  const tierStyles =
    tier === "high"
      ? { badge: "bg-red-100 text-red-700 border-red-300", label: "High risk", Icon: ShieldAlert }
      : tier === "watch"
      ? { badge: "bg-amber-100 text-amber-700 border-amber-300", label: "Watch", Icon: ShieldAlert }
      : { badge: "bg-emerald-100 text-emerald-700 border-emerald-300", label: "Clear", Icon: ShieldCheck };
  const TierIcon = tierStyles.Icon;

  return (
    <div className="min-h-screen bg-gray-50/40">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Back nav */}
        <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-primary hover:underline mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to admin
        </Link>

        {/* ── Identity strip ──────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-6 mb-8">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold tracking-tight mb-1">{profile.full_name || profile.email}</h1>
            <div className="text-sm text-muted-foreground space-y-0.5">
              <div>
                <span className="font-medium text-foreground">{profile.email}</span>
                {profile.phone && <span> · {profile.phone}</span>}
                {profile.role && profile.role !== "user" && (
                  <Badge variant="outline" className="ml-2 text-[10px] py-0 px-1.5 border-blue-300 text-blue-700 bg-blue-50">{profile.role}</Badge>
                )}
              </div>
              <div className="text-xs">
                User ID: <code className="font-mono text-[11px]">{profile.id}</code> · Joined {fmtDate(profile.created_at)} ({account.account_age_days}d ago)
              </div>
            </div>
          </div>

          {/* Risk chip */}
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-semibold ${tierStyles.badge}`}>
            <TierIcon className="w-4 h-4" />
            {tierStyles.label}
          </div>
        </div>

        {/* ── Risk dashboard (always above the fold) ──────────────────── */}
        <div className="mb-8">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">Risk signals</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <RiskCard label="Chargebacks" primary={`${risk.chargebacks_count}`} secondary={fmt$(risk.chargebacks_total_cents)} variant={risk.chargebacks_count > 0 ? "alert" : "neutral"} />
            <RiskCard label="Refund rate" primary={`${risk.refund_rate_pct}%`} secondary={`${risk.refunds_count} / ${account.shipments_count} ships`} variant={risk.refund_rate_pct >= 30 ? "alert" : risk.refund_rate_pct >= 15 ? "warn" : "neutral"} />
            <RiskCard label="Lifetime loss" primary={fmt$(risk.lifetime_loss_cents)} secondary="uncovered label cost" variant={risk.lifetime_loss_cents >= 5000 ? "alert" : risk.lifetime_loss_cents > 0 ? "warn" : "neutral"} />
            <RiskCard label="Declines (30d)" primary={`${risk.declines_30d_count}`} secondary={`${risk.declines_lifetime_count} lifetime`} variant={risk.declines_30d_count >= 3 ? "alert" : risk.declines_30d_count > 0 ? "warn" : "neutral"} />
            <RiskCard label="Radar high-risk" primary={`${risk.radar_high_risk_count}`} secondary="elevated/highest" variant={risk.radar_high_risk_count > 0 ? "warn" : "neutral"} />
            <RiskCard label="Account age" primary={`${risk.account_age_days}d`} secondary={fmtDate(profile.created_at)} variant={risk.account_age_days < 7 ? "warn" : "neutral"} />
          </div>
          {reasons.length > 0 && (
            <div className="mt-3 text-xs text-muted-foreground">
              <span className="font-semibold">Tier reasoning:</span> {reasons.join(" · ")}
            </div>
          )}
        </div>

        {/* ── Account totals ─────────────────────────────────────────── */}
        <div className="mb-8">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-3 font-semibold">Lifetime account totals</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Links" value={`${account.links_count}`} />
            <KpiCard label="Shipments" value={`${account.shipments_count}`} />
            <KpiCard label="Total paid" value={fmt$(account.lifetime_paid_cents)} />
            <KpiCard label="Stripe fees" value={fmt$(-account.lifetime_stripe_fee_cents)} />
            <KpiCard label="Label costs" value={fmt$(-account.lifetime_label_cost_cents)} />
            <KpiCard label="Net margin" value={fmt$(account.net_margin_cents)} highlight={account.net_margin_cents < 0 ? "negative" : "positive"} />
          </div>
        </div>

        {/* ── Two-column body ────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* LEFT — Profile/Payment methods/Links (1 col) */}
          <div className="space-y-6">
            {/* Stripe customer IDs */}
            <Section title="Stripe">
              <KV label="Customer (live)" value={profile.stripe_customer_id_live ? <code className="text-[11px] font-mono">{profile.stripe_customer_id_live}</code> : "—"} />
              <KV label="Customer (test)" value={profile.stripe_customer_id_test ? <code className="text-[11px] font-mono">{profile.stripe_customer_id_test}</code> : "—"} />
              <KV label="Daily budget" value={profile.daily_budget_cents != null ? fmt$(profile.daily_budget_cents) : "Not set"} />
              <KV label="Weekly budget" value={profile.weekly_budget_cents != null ? fmt$(profile.weekly_budget_cents) : "Not set"} />
            </Section>

            <Section title={`Payment methods (${payment_methods.length})`}>
              {payment_methods.length === 0 && <div className="text-xs text-muted-foreground">No saved methods.</div>}
              {payment_methods.map((pm, i) => (
                <div key={i} className={`text-xs py-1.5 flex items-center justify-between gap-2 ${pm.deleted_at ? "opacity-50 line-through" : ""}`}>
                  <span>
                    {pm.brand} •••• {pm.last4} · {String(pm.exp_month).padStart(2, "0")}/{String(pm.exp_year).slice(-2)}
                    {pm.is_default && <Badge variant="outline" className="ml-1.5 text-[9px] py-0 px-1">default</Badge>}
                  </span>
                  <Badge variant="outline" className="text-[9px] py-0 px-1">{pm.mode}</Badge>
                </div>
              ))}
            </Section>

            <Section title={`Links (${links.length})`}>
              {links.length === 0 && <div className="text-xs text-muted-foreground">No links created.</div>}
              {links.map((l) => (
                <div key={l.id} className="text-xs py-1.5 flex items-center justify-between gap-2">
                  <span>
                    <code className="font-mono">{l.short_code}</code>
                    <Badge variant="outline" className="ml-1.5 text-[9px] py-0 px-1">{l.link_type}</Badge>
                    {l.is_test && <Badge variant="outline" className="ml-1 text-[9px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>}
                  </span>
                  <span className="text-muted-foreground">{l.status}</span>
                </div>
              ))}
            </Section>

            <Section title="Connection signals">
              <div className="text-xs text-muted-foreground italic">{connection_signals.note}</div>
            </Section>
          </div>

          {/* RIGHT — Shipments + Activity (2 cols) */}
          <div className="lg:col-span-2 space-y-6">
            <Section title={`Shipments (${shipments.length})`}>
              {shipments.length === 0 ? (
                <div className="text-xs text-muted-foreground">No shipments yet.</div>
              ) : (
                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="min-w-full text-xs">
                    <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="text-left py-1.5 pr-3">Code</th>
                        <th className="text-left py-1.5 pr-3">Carrier · Svc</th>
                        <th className="text-left py-1.5 pr-3">Status</th>
                        <th className="text-right py-1.5 pr-3">Charged</th>
                        <th className="text-right py-1.5 pr-3">Label cost</th>
                        <th className="text-right py-1.5 pr-3">Net</th>
                        <th className="text-left py-1.5">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shipments.map((s) => {
                        // Per-shipment net margin: sum tx where shipment_id=s.id OR stripe_intent_id=s.stripe_payment_intent_id
                        const myTxs = transactions.filter(
                          (t) =>
                            t.shipment_id === s.id ||
                            (s.stripe_payment_intent_id && t.stripe_intent_id === s.stripe_payment_intent_id),
                        );
                        const paid = myTxs.filter((t) => t.type === "charge").reduce((a, t) => a + t.amount_cents, 0);
                        const labelCost = Math.abs(myTxs.filter((t) => t.type === "label_cost").reduce((a, t) => a + t.amount_cents, 0));
                        const stripeFee = Math.abs(myTxs.filter((t) => t.type === "fee_stripe").reduce((a, t) => a + t.amount_cents, 0));
                        const refunded = Math.abs(myTxs.filter((t) => t.type === "refund").reduce((a, t) => a + t.amount_cents, 0));
                        const epRefund = myTxs.filter((t) => t.type === "easypost_refund").reduce((a, t) => a + t.amount_cents, 0);
                        const net = paid - stripeFee - refunded - labelCost + epRefund;
                        return (
                          <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50/50">
                            <td className="py-1.5 pr-3">
                              <Link to={`/admin/shipments/${s.tracking_number || s.id}`} target="_blank" rel="noopener noreferrer" className="text-primary font-bold hover:underline">
                                {s.public_code}
                              </Link>
                              {s.is_test && <Badge variant="outline" className="ml-1 text-[9px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>}
                            </td>
                            <td className="py-1.5 pr-3">{s.carrier} {s.service}</td>
                            <td className="py-1.5 pr-3">{s.status}{s.refund_status && s.refund_status !== "none" ? ` · ${s.refund_status}` : ""}</td>
                            <td className="py-1.5 pr-3 text-right">{paid > 0 ? fmt$(paid) : "—"}</td>
                            <td className="py-1.5 pr-3 text-right text-red-600">{labelCost > 0 ? fmt$(-labelCost) : "—"}</td>
                            <td className={`py-1.5 pr-3 text-right font-semibold ${net < 0 ? "text-red-600" : "text-emerald-600"}`}>{fmt$(net)}</td>
                            <td className="py-1.5 text-muted-foreground">{fmtDate(s.created_at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title={`Activity (last ${activity_timeline.length} events)`}>
              {activity_timeline.length === 0 ? (
                <div className="text-xs text-muted-foreground">No activity recorded.</div>
              ) : (
                <ol className="space-y-1.5 text-xs">
                  {activity_timeline.slice(0, 30).map((ev) => (
                    <li key={ev.id} className="flex items-start gap-2">
                      <span className="text-muted-foreground tabular-nums w-28 shrink-0">{fmtDateTime(ev.created_at)}</span>
                      <span className="flex-1">
                        <span className="font-mono text-[11px]">{ev.event_type}</span>
                        {ev.severity && ev.severity !== "info" && (
                          <Badge variant="outline" className={`ml-1.5 text-[9px] py-0 px-1 ${ev.severity === "error" ? "border-red-300 text-red-700 bg-red-50" : ev.severity === "warn" ? "border-amber-300 text-amber-700 bg-amber-50" : ""}`}>{ev.severity}</Badge>
                        )}
                        {ev.entity_type && <span className="text-muted-foreground"> · {ev.entity_type}{ev.entity_id ? ` ${ev.entity_id.slice(0, 12)}…` : ""}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RiskCard({ label, primary, secondary, variant }: { label: string; primary: string; secondary: string; variant: "alert" | "warn" | "neutral" }) {
  const styles =
    variant === "alert"
      ? "border-red-300 bg-red-50"
      : variant === "warn"
      ? "border-amber-300 bg-amber-50"
      : "border-gray-200 bg-white";
  const primaryColor = variant === "alert" ? "text-red-700" : variant === "warn" ? "text-amber-700" : "text-foreground";
  return (
    <div className={`rounded-lg border p-3 ${styles}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className={`text-xl font-bold mt-0.5 ${primaryColor}`}>{primary}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{secondary}</div>
    </div>
  );
}

function KpiCard({ label, value, highlight }: { label: string; value: string; highlight?: "positive" | "negative" }) {
  const color = highlight === "negative" ? "text-red-700" : highlight === "positive" ? "text-emerald-700" : "text-foreground";
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className={`text-xl font-bold mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">{title}</h3>
      <div className="divide-y divide-gray-100">
        {children}
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="text-xs py-1.5 flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate max-w-[60%] text-right">{value}</span>
    </div>
  );
}
