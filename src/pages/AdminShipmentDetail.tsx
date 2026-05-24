// src/pages/AdminShipmentDetail.tsx
//
// Per-shipment detail view for the Admin Reconciliation tab.
// Route: /admin/shipments/:public_code
//
// Ported from previews/shipment-detail.html preserving:
// - Parties, addresses, package & service, timeline (left column)
// - Full event-by-event money ledger → net margin (right column)
// - References out (EasyPost / Stripe / tracking page / flex link)
// - Admin actions (Issue refund / Cancel label / Re-poll EasyPost)
//
// Design tokens: honors index.css (blue-primary).
//
// Decided proposal:
//   proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md §2.5

import { useState, useEffect } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TxEvent {
  id: string;
  type: string;
  amount_cents: number;
  created_at: string;
}

interface ShipmentDetail {
  shipment_id: string;
  shipment_public: string;
  easypost_shipment_id: string | null;
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  label_url: string | null;
  is_test: boolean;
  is_live: boolean;
  payment_method: string | null;
  link_short_code: string | null;
  link_type: string | null;
  owner_user_id: string | null;
  owner_email: string | null;
  stripe_payment_intent_id: string | null;
  // Timeline
  label_created_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  // Addresses
  sender_address: { name: string; street1: string; city: string; state: string; zip: string } | null;
  recipient_address: { name: string; street1: string; city: string; state: string; zip: string } | null;
  // Financials
  paid_cents: number;
  stripe_fee_cents: number;
  refunded_to_customer_cents: number;
  adjustment_collected_cents: number;
  chargeback_cents: number;
  label_cost_cents: number;
  easypost_refund_cents: number;
  adjustment_charged_cents: number;
  net_margin_cents: number;
  // Status
  shipment_status: string;
  refund_status: string | null;
  recon_status: string;
  // Full ledger
  transactions: TxEvent[];
  carrier_adjustments: Array<{
    id: string;
    delta_cents: number;
    reason: string | null;
    claimed_weight_oz: number | null;
    captured_weight_oz: number | null;
    recovery_status: string;
    created_at: string;
    days_until_dispute_deadline: number;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const str = "$" + dollars.toFixed(2);
  return cents < 0 ? `−${str}` : `+${str}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

function txTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    charge: "Customer charge",
    fee_stripe: "Stripe processing fee",
    refund: "Refund to customer",
    refund_fee_recovered: "Refund fee recovered",
    comp_grant: "Comp grant (SendMo absorbed cost)",
    label_cost: "Label purchased",
    easypost_refund: "Carrier refund credited",
    carrier_adjustment: "Carrier adjustment",
    chargeback: "Chargeback",
    balance_topup: "Balance top-up",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}

function txSide(type: string): "stripe" | "ep" | "internal" {
  if (["charge", "fee_stripe", "refund", "refund_fee_recovered", "chargeback", "carrier_adjustment"].includes(type)) {
    // carrier_adjustment charge to customer is Stripe, but the EasyPost charge is label_cost-like
    if (type === "carrier_adjustment") return "stripe";
    return "stripe";
  }
  if (["label_cost", "easypost_refund"].includes(type)) return "ep";
  return "internal";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminShipmentDetail() {
  const { public_code } = useParams<{ public_code: string }>();
  const { user, session, loading: authLoading, isAdmin, profileLoaded } = useAuth();
  const [detail, setDetail] = useState<ShipmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // useEffect MUST come before any conditional returns — React Rules of Hooks.
  // Previous version had the auth-guard returns above this and would intermittently
  // trip React error #310 ("rendered more hooks than during the previous render")
  // when authLoading flipped between renders.
  useEffect(() => {
    if (!session || !public_code) return;
    fetchDetail();
  }, [session, public_code]);

  // Auth guards — only run AFTER all hooks above.
  if (authLoading) return null;
  if (!user) return <Navigate to="/login?redirectTo=/admin" replace />;
  if (!profileLoaded) return null;
  if (!isAdmin) return <Navigate to="/admin" replace />;

  async function fetchDetail() {
    setLoading(true);
    setError(null);
    try {
      const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
      // The reconciliation-report returns all shipments; we find ours by ID or public code.
      // For the detail view, we pass the public_code as a filter.
      // Since reconciliation-report returns all rows in period, we do a broad query
      // and filter client-side for the matching shipment.
      const res = await fetch(
        `${BASE_URL}/functions/v1/reconciliation-report?start_date=2020-01-01&end_date=${new Date().toISOString().slice(0, 10)}`,
        {
          headers: {
            Authorization: `Bearer ${session!.access_token}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const json = await res.json();
      const rows: ShipmentDetail[] = json.rows ?? [];
      // Match by public_code (SM-XXXX), tracking number, or shipment ID prefix.
      const found = rows.find(
        (r) =>
          r.shipment_public.toLowerCase() === (public_code ?? "").toLowerCase() ||
          r.tracking_number?.toLowerCase() === (public_code ?? "").toLowerCase() ||
          r.shipment_id.startsWith(public_code ?? "")
      );
      if (!found) throw new Error(`Shipment "${public_code}" not found in the reconciliation report.`);
      setDetail(found);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-5xl mx-auto">
          <div className="py-16 text-center text-muted-foreground">Loading shipment detail…</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <div className="max-w-5xl mx-auto space-y-4">
          <Link to="/admin?tab=reconciliation" className="text-primary hover:underline text-sm font-semibold flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" /> Back to Reconciliation
          </Link>
          <div className="bg-red-50 text-red-600 p-4 rounded-xl border border-red-200 text-sm">
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!detail) return null;

  const netMarginPositive = detail.net_margin_cents > 0;
  const netMarginNegative = detail.net_margin_cents < 0;

  return (
    <div className="min-h-screen bg-gray-50 p-8 text-sm">
      <div className="max-w-5xl mx-auto space-y-5">
        {/* Back link */}
        <Link
          to="/admin?tab=reconciliation"
          className="text-primary hover:underline text-sm font-semibold flex items-center gap-1"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Reconciliation
        </Link>

        {/* Header */}
        <div className="flex items-start gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">{detail.shipment_public}</h1>
            {detail.tracking_number && detail.tracking_number !== "—" && (
              <p className="text-muted-foreground mt-0.5">Tracking code {detail.tracking_number}</p>
            )}
          </div>
          <div className="flex-1" />
          {detail.recon_status === "reconciled" ? (
            <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 text-sm py-1 px-3">✓ Reconciled</Badge>
          ) : detail.recon_status === "adjustment_review" ? (
            <Badge className="bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100 text-sm py-1 px-3">⚖ Adjustment — review</Badge>
          ) : detail.recon_status === "chargeback" ? (
            <Badge className="bg-red-100 text-red-700 border border-red-200 hover:bg-red-100 text-sm py-1 px-3">🛑 Chargeback</Badge>
          ) : (
            <Badge variant="outline" className="text-sm py-1 px-3">{detail.recon_status}</Badge>
          )}
        </div>

        <p className="text-muted-foreground -mt-2">
          <strong>{detail.carrier ?? "Unknown carrier"} {detail.service ?? ""}</strong>
          {detail.tracking_number && detail.tracking_number !== "—" && <> · tracking <strong>{detail.tracking_number}</strong></>}
          {detail.delivered_at && <> · delivered {fmtDateShort(detail.delivered_at)}</>}
          {detail.link_short_code && (
            <> · created from{" "}
              <a href={`/s/${detail.link_short_code}`} className="text-primary hover:underline">
                /s/{detail.link_short_code}
              </a>
            </>
          )}
          {detail.is_test && " · "}
          {detail.is_test && <Badge variant="outline" className="ml-1 text-[10px] border-amber-300 text-amber-700 bg-amber-50">Test</Badge>}
        </p>

        {/* Admin actions */}
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" className="rounded-xl text-xs">
            Issue refund
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl text-xs"
            disabled={detail.shipment_status !== "label_created"}
            title={detail.shipment_status !== "label_created" ? "Can't void — not in label_created status" : undefined}
          >
            Cancel / void label
          </Button>
          <Button variant="outline" size="sm" className="rounded-xl text-xs">
            Re-poll EasyPost
          </Button>
          <Button variant="outline" size="sm" className="rounded-xl text-xs">
            View event log
          </Button>
        </div>

        {/* Two-column grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
          {/* ── Left: shipment facts ─────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Parties */}
            {(detail.sender_address || detail.recipient_address) && (
              <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-border font-bold text-sm">Parties</div>
                <div className="px-4 py-3 space-y-3 text-sm">
                  {detail.sender_address && (
                    <div className="flex gap-3">
                      <span className="w-24 text-muted-foreground flex-none">Sender</span>
                      <div>
                        <strong>{detail.sender_address.name}</strong>
                        <div className="text-muted-foreground text-xs">used the link</div>
                      </div>
                    </div>
                  )}
                  {detail.recipient_address && (
                    <div className="flex gap-3">
                      <span className="w-24 text-muted-foreground flex-none">Recipient</span>
                      <div>
                        <strong>{detail.recipient_address.name}</strong>
                        <div className="text-muted-foreground text-xs">
                          link owner ·{" "}
                          {detail.owner_user_id ? (
                            <Link
                              to={`/admin/users/${detail.owner_user_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {detail.owner_email || "view user"}
                            </Link>
                          ) : (
                            detail.owner_email || "unknown"
                          )}
                          {" · "}
                          {detail.payment_method === "comp" ? "comp label" : "card charged"}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Addresses */}
            {(detail.sender_address || detail.recipient_address) && (
              <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-border font-bold text-sm">Addresses</div>
                <div className="px-4 py-3 space-y-3 text-sm">
                  {detail.sender_address && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Ship from</p>
                      <p>{detail.sender_address.name}</p>
                      <p className="text-muted-foreground">{detail.sender_address.street1}</p>
                      <p className="text-muted-foreground">{detail.sender_address.city}, {detail.sender_address.state} {detail.sender_address.zip}</p>
                    </div>
                  )}
                  {detail.recipient_address && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Ship to</p>
                      <p>{detail.recipient_address.name}</p>
                      <p className="text-muted-foreground">{detail.recipient_address.street1}</p>
                      <p className="text-muted-foreground">{detail.recipient_address.city}, {detail.recipient_address.state} {detail.recipient_address.zip}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Carrier adjustments (if any) */}
            {detail.carrier_adjustments.length > 0 && (
              <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-border font-bold text-sm">Carrier adjustments</div>
                <div className="divide-y divide-border">
                  {detail.carrier_adjustments.map((adj) => (
                    <div key={adj.id} className="px-4 py-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{adj.reason ?? "Adjustment"}</span>
                        <span className={adj.delta_cents > 0 ? "text-red-600 font-bold" : "text-green-600 font-bold"}>
                          {adj.delta_cents > 0 ? "+" : ""}${(Math.abs(adj.delta_cents) / 100).toFixed(2)}
                        </span>
                      </div>
                      {adj.claimed_weight_oz != null && adj.captured_weight_oz != null && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Declared {(adj.claimed_weight_oz / 16).toFixed(1)} lb · carrier captured {(adj.captured_weight_oz / 16).toFixed(1)} lb
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className={cn(
                          "text-[10px] py-0 px-1.5",
                          adj.recovery_status === "recovered" ? "border-green-300 text-green-700 bg-green-50" :
                          adj.recovery_status === "pending" ? "border-amber-300 text-amber-700 bg-amber-50" :
                          adj.recovery_status === "absorbed" ? "border-gray-300 text-gray-600" :
                          adj.recovery_status === "disputed" ? "border-blue-300 text-blue-700 bg-blue-50" :
                          "border-red-300 text-red-700 bg-red-50"
                        )}>
                          {adj.recovery_status}
                        </Badge>
                        {adj.recovery_status === "pending" && (
                          <span className={cn(
                            "text-[10px] font-medium",
                            adj.days_until_dispute_deadline < 0 ? "text-red-600" :
                            adj.days_until_dispute_deadline < 14 ? "text-amber-600" : "text-muted-foreground"
                          )}>
                            {adj.days_until_dispute_deadline < 0
                              ? `Dispute window closed ${Math.abs(adj.days_until_dispute_deadline)}d ago`
                              : `${adj.days_until_dispute_deadline}d until dispute deadline`}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Timeline */}
            <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border font-bold text-sm">Timeline</div>
              <div className="px-4 py-4">
                <ul className="space-y-3">
                  <li className="flex gap-3 text-sm">
                    <div className="w-2.5 h-2.5 rounded-full bg-primary mt-1 flex-none" />
                    <div>
                      <p className="font-semibold">Label created</p>
                      <p className="text-muted-foreground text-xs">{fmtDate(detail.label_created_at)}</p>
                    </div>
                  </li>
                  {detail.shipped_at && (
                    <li className="flex gap-3 text-sm">
                      <div className="w-2.5 h-2.5 rounded-full bg-primary mt-1 flex-none" />
                      <div>
                        <p className="font-semibold">Shipped — first carrier scan</p>
                        <p className="text-muted-foreground text-xs">{fmtDate(detail.shipped_at)}</p>
                      </div>
                    </li>
                  )}
                  {detail.carrier_adjustments.map((adj) => (
                    <li key={adj.id} className="flex gap-3 text-sm">
                      <div className="w-2.5 h-2.5 rounded-full bg-amber-500 mt-1 flex-none" />
                      <div>
                        <p className="font-semibold">Carrier adjustment posted</p>
                        <p className="text-muted-foreground text-xs">{fmtDate(adj.created_at)} · {detail.carrier} {adj.reason ?? "adjustment"}</p>
                      </div>
                    </li>
                  ))}
                  {detail.delivered_at && (
                    <li className="flex gap-3 text-sm">
                      <div className="w-2.5 h-2.5 rounded-full bg-green-500 mt-1 flex-none" />
                      <div>
                        <p className="font-semibold">Delivered</p>
                        <p className="text-muted-foreground text-xs">{fmtDate(detail.delivered_at)}</p>
                      </div>
                    </li>
                  )}
                  {detail.cancelled_at && (
                    <li className="flex gap-3 text-sm">
                      <div className="w-2.5 h-2.5 rounded-full bg-gray-400 mt-1 flex-none" />
                      <div>
                        <p className="font-semibold">Label voided</p>
                        <p className="text-muted-foreground text-xs">{fmtDate(detail.cancelled_at)}</p>
                      </div>
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>

          {/* ── Right: the money ─────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Money ledger */}
            <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border font-bold text-sm flex items-center gap-2">
                Money ledger
                <span className="text-muted-foreground font-normal text-xs">— every event on this shipment</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                    <th className="px-4 py-2 text-left font-bold">Date</th>
                    <th className="px-4 py-2 text-left font-bold">Event</th>
                    <th className="px-4 py-2 text-left font-bold">Side</th>
                    <th className="px-4 py-2 text-right font-bold">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {detail.transactions.map((tx) => {
                    const side = txSide(tx.type);
                    return (
                      <tr key={tx.id}>
                        <td className="px-4 py-2 text-muted-foreground text-xs">{fmtDateShort(tx.created_at)}</td>
                        <td className="px-4 py-2">
                          <p className="font-semibold">{txTypeLabel(tx.type)}</p>
                        </td>
                        <td className="px-4 py-2">
                          {side === "stripe" ? (
                            <Badge className="bg-blue-50 text-primary border border-blue-200 hover:bg-blue-50 text-[10px] font-bold py-0 px-1.5">Stripe</Badge>
                          ) : side === "ep" ? (
                            <Badge className="bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-50 text-[10px] font-bold py-0 px-1.5">EasyPost</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] py-0 px-1.5">Internal</Badge>
                          )}
                        </td>
                        <td className={cn(
                          "px-4 py-2 text-right font-mono font-bold",
                          tx.amount_cents > 0 ? "text-green-600" : "text-red-600"
                        )}>
                          {fmt(tx.amount_cents)}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Total row */}
                  <tr className="bg-gray-50 border-t border-border">
                    <td colSpan={3} className="px-4 py-3 font-bold">Net margin</td>
                    <td className={cn(
                      "px-4 py-3 text-right font-mono font-bold text-base",
                      netMarginPositive ? "text-green-600" : netMarginNegative ? "text-red-600" : ""
                    )}>
                      {detail.net_margin_cents !== 0 ? fmt(detail.net_margin_cents) : "$0.00"}
                    </td>
                  </tr>
                </tbody>
              </table>
              {/* Reconciled banner */}
              {detail.recon_status === "reconciled" && (
                <div className="flex items-center gap-2 px-4 py-3 bg-green-50 text-green-700 text-sm font-bold border-t border-green-100">
                  <span>✓ Reconciled — every movement matched</span>
                </div>
              )}
            </div>

            {/* References */}
            <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-border font-bold text-sm">References &amp; links</div>
              <div className="px-4 py-3 space-y-2 text-sm">
                <div className="flex gap-3">
                  <span className="w-28 text-muted-foreground flex-none">Shipment ID</span>
                  <span className="font-mono text-xs">{detail.shipment_id.slice(0, 12)}…</span>
                </div>
                {detail.easypost_shipment_id && (
                  <div className="flex gap-3">
                    <span className="w-28 text-muted-foreground flex-none">EasyPost</span>
                    <span className="font-mono text-xs">{detail.easypost_shipment_id.slice(0, 16)}…</span>
                  </div>
                )}
                {detail.stripe_payment_intent_id && (
                  <div className="flex gap-3">
                    <span className="w-28 text-muted-foreground flex-none">Stripe PI</span>
                    <a
                      href={`https://dashboard.stripe.com${detail.is_test ? "/test" : ""}/payments/${detail.stripe_payment_intent_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1 font-mono text-xs"
                    >
                      {detail.stripe_payment_intent_id.slice(0, 16)}… <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
                {detail.tracking_number && detail.tracking_number !== "—" && (
                  <div className="flex gap-3">
                    <span className="w-28 text-muted-foreground flex-none">Tracking page</span>
                    <a
                      href={`/t/${detail.tracking_number}`}
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      sendmo.co/t/{detail.tracking_number} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
                {detail.link_short_code && (
                  <div className="flex gap-3">
                    <span className="w-28 text-muted-foreground flex-none">
                      {detail.link_type === "flexible" ? "Flex link" : "Full label link"}
                    </span>
                    <a
                      href={`/s/${detail.link_short_code}`}
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      sendmo.co/s/{detail.link_short_code} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
                {detail.label_url && (
                  <div className="flex gap-3">
                    <span className="w-28 text-muted-foreground flex-none">Label PDF</span>
                    <a
                      href={detail.label_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      View label <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}
                <div className="flex gap-3">
                  <span className="w-28 text-muted-foreground flex-none">Mode</span>
                  <span>{detail.is_test ? "Test" : "Live"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
