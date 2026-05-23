// src/pages/AdminReconciliation.tsx
//
// Reconciliation tab for the Admin page. Ported from previews/reconciliation-dashboard.html
// preserving the column structure and the Net-margin identity in the legend.
//
// Mockup: previews/reconciliation-dashboard.html
// Decided proposal: proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md §2.5
// H4 of the pre-launch P1 build.
//
// Design tokens: honors index.css (blue-primary, not the mockup's green).
//
// Net-margin identity (from the mockup legend ~line 450):
//   Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback
//   − Label cost + Refund from EasyPost − Adjustment charged = Net margin
//
// H5 note: this component is intentionally composable — H5 adds a
// "Rejected refunds" filter/sub-view here. Do not bake assumptions that
// prevent a filter sub-view from being dropped in.

import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCw, FileText, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReconSummary {
  total_count: number;
  reconciled_count: number;
  needs_attention_count: number;
  net_margin_cents: number;
  carrier_adjustments_total_cents: number;
  refunds_in_flight_cents: number;
  chargebacks_count: number;
  easypost_wallet_balance_cents: number | null;
  period: { start_date: string; end_date: string };
  last_run_at: string;
}

interface NeedsAttentionItem {
  type: "chargeback" | "carrier_adjustment" | "stuck_refund" | "orphan_ep_shipment";
  shipment_id?: string;
  shipment_public?: string;
  carrier?: string;
  carrier_adjustment_id?: string;
  delta_cents?: number;
  reason?: string | null;
  claimed_weight_oz?: number | null;
  captured_weight_oz?: number | null;
  days_until_dispute_deadline?: number;
  deadline_past?: boolean;
  amount_cents?: number;
  refund_submitted_at?: string;
  days_since_submitted?: number;
}

interface CarrierAdjustment {
  id: string;
  delta_cents: number;
  reason: string | null;
  claimed_weight_oz: number | null;
  captured_weight_oz: number | null;
  recovery_status: string;
  created_at: string;
  resolved_at: string | null;
  days_until_dispute_deadline: number;
}

interface ReconRow {
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
  // Timeline
  label_created_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  // Financials (all in cents, negative = outflow/cost)
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
  easypost_refund_status: string | null;
  recon_status: "reconciled" | "adjustment_review" | "chargeback" | "refund_overdue";
  carrier_adjustments: CarrierAdjustment[];
  stripe_payment_intent_id: string | null;
}

interface ReconResponse {
  summary: ReconSummary;
  needs_attention: NeedsAttentionItem[];
  rows: ReconRow[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(cents: number | null, alwaysSign = false): string {
  if (cents === null || cents === undefined) return "—";
  if (cents === 0) return "—";
  const dollars = Math.abs(cents) / 100;
  const str = "$" + dollars.toFixed(2);
  if (alwaysSign) return cents >= 0 ? `+${str}` : `−${str}`;
  return cents < 0 ? `−${str}` : str;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
}

function ReconStatusBadge({ status }: { status: ReconRow["recon_status"] }) {
  if (status === "reconciled") {
    return <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 text-[11px] py-0.5 px-2 font-semibold">✓ Reconciled</Badge>;
  }
  if (status === "adjustment_review") {
    return <Badge className="bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100 text-[11px] py-0.5 px-2">⚖ Adjustment — review</Badge>;
  }
  if (status === "chargeback") {
    return <Badge className="bg-red-100 text-red-700 border border-red-200 hover:bg-red-100 text-[11px] py-0.5 px-2">🛑 Chargeback</Badge>;
  }
  if (status === "refund_overdue") {
    return <Badge className="bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100 text-[11px] py-0.5 px-2">⏳ Refund overdue</Badge>;
  }
  return <Badge variant="outline" className="text-[11px]">{status}</Badge>;
}

// ─── Main component ────────────────────────────────────────────────────────────

// ─── Rejected refunds sub-view ────────────────────────────────────────────────
// H5 addition — shows all refund_status='rejected' shipments as a manual queue.
// Triggered by the "Rejected refunds" filter chip in the toolbar.

interface RejectedRefundRow {
  id: string;
  public_code: string;
  carrier: string | null;
  rate_cents: number | null;
  refund_submitted_at: string | null;
  cancelled_at: string | null;
  easypost_refund_status: string | null; // 'rejected' | 'submitted' (timeout signature)
  is_test: boolean;
}

function RejectedRefundsPanel({ session }: { session: { access_token: string } | null }) {
  const [rows, setRows] = useState<RejectedRefundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);

  const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    // Fetch from reconciliation-report, then filter client-side.
    // This reuses the existing admin endpoint rather than adding a new one.
    const params = new URLSearchParams({ start_date: "2020-01-01", end_date: new Date().toISOString().slice(0, 10) });
    fetch(`${BASE_URL}/functions/v1/reconciliation-report?${params}`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
    })
      .then((r) => r.json())
      .then((json) => {
        // Filter for rejected-refund shipments from the rows array.
        const rejected = (json.rows ?? [])
          .filter((r: ReconRow) => r.refund_status === "rejected")
          .map((r: ReconRow) => ({
            id: r.shipment_id,
            public_code: r.shipment_public,
            carrier: r.carrier,
            rate_cents: r.refunded_to_customer_cents < 0 ? Math.abs(r.refunded_to_customer_cents) : r.paid_cents,
            refund_submitted_at: null, // not in ReconRow; use cancelled_at as proxy
            cancelled_at: r.cancelled_at,
            easypost_refund_status: r.easypost_refund_status,
            is_test: r.is_test,
          }));
        setRows(rejected);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [session, BASE_URL]);

  async function runRefundSweep() {
    if (!session) return;
    setSweepBusy(true);
    setSweepMsg(null);
    try {
      const res = await fetch(`${BASE_URL}/functions/v1/cron-refund-sweep`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed (${res.status})`);
      setSweepMsg(
        `Sweep complete — ${json.processed} scanned, ${json.refunded} recovered, ${json.rejected} rejected, ${json.timed_out} timed out, ${json.errors} errors.`
      );
    } catch (err: unknown) {
      setSweepMsg(err instanceof Error ? err.message : "Sweep failed");
    } finally {
      setSweepBusy(false);
    }
  }

  if (loading) return <div className="py-8 text-center text-muted-foreground text-sm">Loading rejected refunds…</div>;
  if (error) return <div className="bg-red-50 text-red-600 p-4 rounded-xl border border-red-200 text-sm">Error: {error}</div>;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <XCircle className="h-4 w-4 text-red-500" />
        <h2 className="text-sm font-bold">Rejected refunds — manual queue</h2>
        <span className="bg-red-100 text-red-700 rounded-full px-2 py-0.5 text-xs font-bold">{rows.length}</span>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="rounded-xl text-xs"
          onClick={runRefundSweep}
          disabled={sweepBusy}
        >
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", sweepBusy && "animate-spin")} />
          {sweepBusy ? "Running…" : "Run refund sweep now"}
        </Button>
      </div>
      {sweepMsg && <p className="text-xs text-muted-foreground px-1">{sweepMsg}</p>}

      {rows.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <p className="text-sm text-green-600 font-semibold">No rejected refunds — all clear</p>
          <p className="text-xs text-muted-foreground mt-1">When EasyPost rejects a void or a refund times out, it appears here.</p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-red-200 overflow-hidden shadow-sm">
          <p className="px-4 py-2.5 text-xs text-muted-foreground border-b border-border">
            These shipments had their void rejected by the carrier, or timed out after 21 days. Check EasyPost for details and follow up with the customer if needed.
          </p>
          <div className="divide-y divide-border">
            {rows.map((row) => {
              const isTimeout = row.easypost_refund_status === "submitted"; // timeout signature
              return (
                <div key={row.id} className="px-4 py-3 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg flex-none flex items-center justify-center bg-red-50 text-base">
                    {isTimeout ? "⏱" : "🚫"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold">
                      <Link to={`/admin/shipments/${row.public_code}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {row.public_code}
                      </Link>
                      {row.is_test && (
                        <Badge variant="outline" className="ml-1.5 text-[10px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {row.carrier ?? "Unknown carrier"} ·{" "}
                      {row.rate_cents != null ? `$${(row.rate_cents / 100).toFixed(2)}` : "—"} ·{" "}
                      <span className={cn("font-semibold", isTimeout ? "text-amber-700" : "text-red-600")}>
                        {isTimeout ? "Timed out after 21 days" : "Hard rejected by carrier"}
                      </span>
                    </p>
                  </div>
                  <div className="flex-none">
                    <Badge className={cn(
                      "text-[11px] py-0.5 px-2",
                      isTimeout
                        ? "bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100"
                        : "bg-red-100 text-red-700 border border-red-200 hover:bg-red-100"
                    )}>
                      {isTimeout ? "Timeout" : "Carrier rejected"}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

interface AdminReconciliationProps {
  session: { access_token: string } | null;
  // Inherited from Admin.tsx top toolbar (All / Production / Test). When the
  // user flips that chip, the reconciliation report re-fetches with the
  // filter applied — so summary cards AND per-shipment table both reflect
  // the chosen environment. "all" is unfiltered.
  envFilter?: "all" | "production" | "test";
}

export default function AdminReconciliation({ session, envFilter = "all" }: AdminReconciliationProps) {
  const [data, setData] = useState<ReconResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null); // carrier_adjustment_id being actioned
  const [actionMsg, setActionMsg] = useState<{ id: string; kind: "ok" | "err"; text: string } | null>(null);

  // Date filter — default last 30 days matching the Labels tab.
  const [dateRange, setDateRange] = useState<"7days" | "30days" | "all">("30days");
  // H5 — view mode: 'main' | 'rejected_refunds'
  const [viewMode, setViewMode] = useState<"main" | "rejected_refunds">("main");

  const getDateParams = useCallback(() => {
    const end = new Date();
    const start = new Date();
    if (dateRange === "7days") start.setDate(end.getDate() - 7);
    else if (dateRange === "30days") start.setDate(end.getDate() - 30);
    else start.setFullYear(2020, 0, 1); // "all" — well before SendMo existed

    const params = new URLSearchParams({
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
    });
    if (envFilter === "production") params.set("env", "production");
    else if (envFilter === "test") params.set("env", "test");
    return params;
  }, [dateRange, envFilter]);

  const fetchReport = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const params = getDateParams();
      const res = await fetch(`${BASE_URL}/functions/v1/reconciliation-report?${params}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const json = await res.json();
      setData(json);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [session, getDateParams]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  // ── Action handler ────────────────────────────────────────────────────────

  async function handleAction(
    action: "dispute" | "recharge" | "absorb",
    carrier_adjustment_id: string,
    expected_credit_cents?: number
  ) {
    if (!session) return;
    setActionBusy(carrier_adjustment_id);
    setActionMsg(null);
    try {
      const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${BASE_URL}/functions/v1/admin-recon-action`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, carrier_adjustment_id, expected_credit_cents }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed (${res.status})`);
      setActionMsg({ id: carrier_adjustment_id, kind: "ok", text: `Action "${action}" applied.` });
      // Refresh to show updated state.
      await fetchReport();
    } catch (err: unknown) {
      setActionMsg({
        id: carrier_adjustment_id,
        kind: "err",
        text: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setActionBusy(null);
    }
  }

  // ── Run sweep ─────────────────────────────────────────────────────────────

  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);

  async function runSweep() {
    if (!session) return;
    setSweepBusy(true);
    setSweepMsg(null);
    try {
      const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${BASE_URL}/functions/v1/reconciliation-sweep`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "daily" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed (${res.status})`);
      setSweepMsg(`Sweep complete — ${json.mismatches ?? 0} mismatches, ${json.recovery_re_fires ?? 0} recovery re-fires.`);
      await fetchReport();
    } catch (err: unknown) {
      setSweepMsg(err instanceof Error ? err.message : "Sweep failed");
    } finally {
      setSweepBusy(false);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="py-16 text-center text-muted-foreground text-sm">Loading reconciliation data…</div>;
  }

  if (error) {
    return (
      <div className="bg-red-50 text-red-600 p-4 rounded-xl border border-red-200 text-sm">
        Error: {error}
      </div>
    );
  }

  const { summary, needs_attention, rows } = data ?? { summary: null, needs_attention: [], rows: [] };

  // ── Rejected refunds count (for the chip badge) ──────────────────────────
  const rejectedCount = data?.rows?.filter((r) => r.refund_status === "rejected").length ?? 0;

  return (
    <div className="space-y-6">
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
        {/* H5 — view toggle: main reconciliation vs rejected-refunds queue */}
        <div className="flex bg-white w-fit border rounded-full p-1 shadow-sm">
          <button
            onClick={() => setViewMode("main")}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-medium transition-colors",
              viewMode === "main"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Reconciliation
          </button>
          <button
            onClick={() => setViewMode("rejected_refunds")}
            className={cn(
              "relative px-4 py-1.5 rounded-full text-xs font-medium transition-colors",
              viewMode === "rejected_refunds"
                ? "bg-red-600 text-white shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Rejected refunds
            {rejectedCount > 0 && viewMode !== "rejected_refunds" && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-600 text-white text-[9px] font-bold">
                {rejectedCount}
              </span>
            )}
          </button>
        </div>

        {/* H5 — Rejected refunds sub-view (exits the main toolbar early) */}
        {viewMode === "rejected_refunds" && (
          <div className="w-full">
            {/* Render the panel below the chip — we break out of the flex row early */}
          </div>
        )}

        {/* Date range filter — only shown in main view */}
        {viewMode === "main" && (
        <div className="flex bg-white w-fit border rounded-full p-1 shadow-sm">
          {(["7days", "30days", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setDateRange(f)}
              className={cn(
                "px-4 py-1.5 rounded-full text-xs font-medium transition-colors",
                dateRange === f
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "7days" ? "Last 7 days" : f === "30days" ? "Last 30 days" : "All time"}
            </button>
          ))}
        </div>
        )}
        {viewMode === "main" && summary && (
          <span className="text-xs text-muted-foreground">
            Last reconciled: {fmtDate(summary.last_run_at)}
          </span>
        )}
        <div className="flex-1" />
        {viewMode === "main" && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl text-xs"
            onClick={runSweep}
            disabled={sweepBusy}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", sweepBusy && "animate-spin")} />
            {sweepBusy ? "Running…" : "Run reconciliation now"}
          </Button>
        )}
      </div>
      {viewMode === "main" && sweepMsg && (
        <p className="text-xs text-muted-foreground px-1">{sweepMsg}</p>
      )}

      {/* ── H5: Rejected refunds sub-view ───────────────────────────────── */}
      {viewMode === "rejected_refunds" && (
        <RejectedRefundsPanel session={session} />
      )}

      {/* ── Main reconciliation view (hidden when viewing rejected refunds) */}
      {viewMode === "main" && summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="bg-card rounded-xl border border-border shadow-sm p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reconciled</p>
            <p className="text-2xl font-bold mt-1.5">
              {summary.reconciled_count} / {summary.total_count}
            </p>
            {summary.needs_attention_count > 0 ? (
              <p className="text-xs text-amber-600 font-semibold mt-1">{summary.needs_attention_count} need attention</p>
            ) : (
              <p className="text-xs text-green-600 font-semibold mt-1">All clear</p>
            )}
          </div>

          <div className="bg-card rounded-xl border border-border shadow-sm p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net margin</p>
            <p className={cn(
              "text-2xl font-bold mt-1.5",
              summary.net_margin_cents > 0 ? "text-green-600" : summary.net_margin_cents < 0 ? "text-red-600" : ""
            )}>
              {fmt(summary.net_margin_cents)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">after all costs</p>
          </div>

          <div className="bg-card rounded-xl border border-border shadow-sm p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Carrier adjustments</p>
            <p className="text-2xl font-bold mt-1.5">{fmt(summary.carrier_adjustments_total_cents)}</p>
            <p className="text-xs text-muted-foreground mt-1">total charged to wallet</p>
          </div>

          <div className="bg-card rounded-xl border border-border shadow-sm p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chargebacks</p>
            <p className={cn("text-2xl font-bold mt-1.5", summary.chargebacks_count > 0 && "text-red-600")}>
              {summary.chargebacks_count === 0 ? "None" : summary.chargebacks_count}
            </p>
            {summary.chargebacks_count > 0 && (
              <p className="text-xs text-red-600 font-semibold mt-1">Review needed</p>
            )}
          </div>

          <div className="bg-card rounded-xl border border-border shadow-sm p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">EasyPost wallet</p>
            <p className="text-2xl font-bold mt-1.5">
              {summary.easypost_wallet_balance_cents != null
                ? fmt(summary.easypost_wallet_balance_cents)
                : "—"}
            </p>
            {summary.easypost_wallet_balance_cents != null ? (
              <p className="text-xs text-green-600 font-semibold mt-1">✓ Live balance</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">API key needed</p>
            )}
          </div>
        </div>
      )}

      {/* ── Needs attention panel (main view only) ───────────────────────── */}
      {viewMode === "main" && needs_attention.length > 0 && (
        <div className="bg-card rounded-xl border border-amber-200 overflow-hidden shadow-sm">
          <div className="bg-amber-50 px-4 py-3 border-b border-amber-200 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-bold">Needs attention</h2>
            <span className="bg-amber-500 text-white rounded-full px-2 py-0.5 text-xs font-bold">
              {needs_attention.length}
            </span>
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground">Items the sweep can't resolve on its own</span>
          </div>

          <div className="divide-y divide-border">
            {needs_attention.map((item, idx) => (
              <div key={idx} className="px-4 py-3 flex items-start gap-3">
                {/* Icon */}
                <div className={cn(
                  "w-8 h-8 rounded-lg flex-none flex items-center justify-center text-base",
                  item.type === "chargeback" ? "bg-red-100" :
                  item.type === "carrier_adjustment" ? "bg-amber-100" :
                  "bg-blue-100"
                )}>
                  {item.type === "chargeback" ? "🛑" :
                   item.type === "carrier_adjustment" ? "⚖️" :
                   item.type === "stuck_refund" ? "⏳" : "❗"}
                </div>

                {/* Body */}
                <div className="flex-1 min-w-0">
                  {item.type === "chargeback" && (
                    <>
                      <p className="text-sm font-bold">Chargeback filed — respond before the deadline</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <strong>{item.shipment_public}</strong> · {item.carrier} · disputed <strong>{fmt(item.amount_cents ?? 0)}</strong> + ~$15 Stripe dispute fee
                      </p>
                    </>
                  )}
                  {item.type === "carrier_adjustment" && (
                    <>
                      <p className="text-sm font-bold">
                        Carrier adjustment over $10 — review before charging the customer
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <strong>{item.shipment_public}</strong> · {item.carrier} · {item.reason ?? "reweigh"} ·{" "}
                        <strong>{fmt(item.delta_cents ?? 0)}</strong>
                        {item.claimed_weight_oz != null && item.captured_weight_oz != null && (
                          <> · declared {(item.claimed_weight_oz / 16).toFixed(1)} lb, carrier captured {(item.captured_weight_oz / 16).toFixed(1)} lb</>
                        )}
                      </p>
                      {item.days_until_dispute_deadline != null && (
                        <p className={cn(
                          "text-xs font-semibold mt-1",
                          item.deadline_past ? "text-red-600" : item.days_until_dispute_deadline < 14 ? "text-amber-600" : "text-muted-foreground"
                        )}>
                          {item.deadline_past
                            ? `⚠ Dispute window closed ${Math.abs(item.days_until_dispute_deadline)} days ago`
                            : `Dispute window: ${item.days_until_dispute_deadline} days remaining`}
                        </p>
                      )}
                    </>
                  )}
                  {item.type === "stuck_refund" && (
                    <>
                      <p className="text-sm font-bold">Refund stuck at "submitted" past 3 weeks</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <strong>{item.shipment_public}</strong> · {item.carrier} · voided{" "}
                        {item.days_since_submitted} days ago · EasyPost still reports submitted
                      </p>
                    </>
                  )}
                  {actionMsg != null && actionMsg.id === item.carrier_adjustment_id && (
                    <p className={cn(
                      "text-xs mt-1 font-medium",
                      actionMsg.kind === "ok" ? "text-green-600" : "text-red-600"
                    )}>
                      {actionMsg.text}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-1.5 flex-none">
                  {item.type === "carrier_adjustment" && item.carrier_adjustment_id && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionBusy === item.carrier_adjustment_id}
                        onClick={() => handleAction("dispute", item.carrier_adjustment_id!)}
                        className="text-xs border-red-300 text-red-600 hover:bg-red-50"
                      >
                        Dispute
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionBusy === item.carrier_adjustment_id}
                        onClick={() => handleAction("recharge", item.carrier_adjustment_id!)}
                        className="text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                      >
                        Re-charge customer
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionBusy === item.carrier_adjustment_id}
                        onClick={() => handleAction("absorb", item.carrier_adjustment_id!)}
                        className="text-xs"
                      >
                        Absorb
                      </Button>
                    </>
                  )}
                  {item.type === "chargeback" && (
                    <>
                      <Button size="sm" variant="outline" className="text-xs border-amber-300 text-amber-700">
                        Submit evidence
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs">
                        Accept
                      </Button>
                    </>
                  )}
                  {item.type === "stuck_refund" && (
                    <Button size="sm" variant="outline" className="text-xs">
                      Re-poll EasyPost
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Full shipment table (main view only) ─────────────────────────── */}
      {viewMode === "main" && <div className="bg-card rounded-xl border border-border overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-bold">All shipments — every money movement</h2>
          <span className="flex-1" />
          <span className="text-xs text-muted-foreground">
            Click a shipment ID for full detail · {rows.length} shipments
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse whitespace-nowrap text-xs" style={{ minWidth: "1560px" }}>
            <thead>
              <tr className="bg-gray-50/50 border-b text-[10px] uppercase tracking-wider text-muted-foreground">
                <th rowSpan={2} className="px-3 py-2 font-bold border-b border-border">Shipment</th>
                <th rowSpan={2} className="px-3 py-2 font-bold border-b border-border">Carrier</th>
                {/* Timeline group */}
                <th colSpan={3} className="px-3 py-1 font-bold text-center border-l-2 border-border bg-gray-100/60">Timeline</th>
                {/* Customer (Stripe) group */}
                <th colSpan={5} className="px-3 py-1 font-bold text-center border-l-2 border-border bg-blue-50/60 text-blue-700">Customer side — Stripe</th>
                {/* EasyPost group */}
                <th colSpan={3} className="px-3 py-1 font-bold text-center border-l-2 border-border bg-amber-50/60 text-amber-700">EasyPost side</th>
                {/* Net margin */}
                <th rowSpan={2} className="px-3 py-2 font-bold text-right border-l-2 border-border border-b border-border">Net margin</th>
                <th rowSpan={2} className="px-3 py-2 font-bold border-l-2 border-border border-b border-border">Status</th>
              </tr>
              <tr className="bg-gray-50/50 text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 font-bold border-l-2 border-border">Label created</th>
                <th className="px-3 py-2 font-bold">Ship date</th>
                <th className="px-3 py-2 font-bold">Delivered</th>
                <th className="px-3 py-2 font-bold text-right border-l-2 border-border">Paid</th>
                <th className="px-3 py-2 font-bold text-right">Stripe fee</th>
                <th className="px-3 py-2 font-bold text-right">Refunded<br/>to customer</th>
                <th className="px-3 py-2 font-bold text-right">Adjustment<br/>collected</th>
                <th className="px-3 py-2 font-bold text-right">Chargeback</th>
                <th className="px-3 py-2 font-bold text-right border-l-2 border-border">Label cost</th>
                <th className="px-3 py-2 font-bold text-right">Refunded<br/>from EasyPost</th>
                <th className="px-3 py-2 font-bold text-right">Adjustment<br/>charged</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-4 py-8 text-center text-muted-foreground text-sm">
                    No shipments for the selected period.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.shipment_id} className="hover:bg-gray-50/50 transition-colors">
                    {/* Shipment ID */}
                    <td className="px-3 py-2">
                      <Link
                        to={`/admin/shipments/${row.tracking_number || row.shipment_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary font-bold hover:underline"
                      >
                        {row.shipment_public}
                      </Link>
                      {row.payment_method === "comp" && (
                        <span className="ml-1.5 inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">COMP</span>
                      )}
                      {row.is_test && (
                        <Badge variant="outline" className="ml-1.5 text-[10px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>
                      )}
                    </td>
                    {/* Carrier */}
                    <td className="px-3 py-2 text-muted-foreground">{row.carrier ?? "—"}</td>
                    {/* Timeline */}
                    <td className="px-3 py-2 border-l-2 border-border/30 font-mono">{fmtDate(row.label_created_at)}</td>
                    <td className="px-3 py-2 font-mono">
                      {row.cancelled_at ? <span className="text-muted-foreground italic">— voided</span> : fmtDate(row.shipped_at)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {row.delivered_at ? (
                        fmtDate(row.delivered_at)
                      ) : row.shipment_status === "in_transit" ? (
                        <Badge className="bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-100 text-[10px]">In transit</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    {/* Customer (Stripe) */}
                    <td className="px-3 py-2 text-right border-l-2 border-border/30">
                      {row.paid_cents > 0 ? <span className="font-mono">{fmt(row.paid_cents)}</span> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.stripe_fee_cents < 0 ? (
                        <span className="text-red-600">{fmt(row.stripe_fee_cents)}</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.refunded_to_customer_cents < 0 ? (
                        <span className="text-red-600">{fmt(row.refunded_to_customer_cents)}</span>
                      ) : row.refund_status === "submitted" ? (
                        <Badge className="bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100 text-[10px]">submitted</Badge>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.adjustment_collected_cents > 0 ? (
                        <span className="text-green-600">+{fmt(row.adjustment_collected_cents)}</span>
                      ) : row.recon_status === "adjustment_review" ? (
                        <span className="text-muted-foreground text-[10px] italic">pending review</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.chargeback_cents < 0 ? (
                        <span className="text-red-600">{fmt(row.chargeback_cents)}</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* EasyPost */}
                    <td className="px-3 py-2 text-right border-l-2 border-border/30 font-mono">
                      {row.label_cost_cents < 0 ? (
                        <span className="text-red-600">{fmt(row.label_cost_cents)}</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.easypost_refund_cents > 0 ? (
                        <span className="text-green-600">+{fmt(row.easypost_refund_cents)}</span>
                      ) : row.easypost_refund_status === "submitted" ? (
                        <Badge className="bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100 text-[10px]">submitted</Badge>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {row.adjustment_charged_cents < 0 ? (
                        <span className="text-red-600">{fmt(row.adjustment_charged_cents)}</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* Net margin */}
                    <td className={cn(
                      "px-3 py-2 text-right font-bold font-mono border-l-2 border-border/30",
                      row.net_margin_cents > 0 ? "text-green-600" : row.net_margin_cents < 0 ? "text-red-600" : ""
                    )}>
                      {row.net_margin_cents !== 0 ? fmt(row.net_margin_cents, true) : "—"}
                    </td>
                    {/* Status */}
                    <td className="px-3 py-2 border-l-2 border-border/30">
                      <ReconStatusBadge status={row.recon_status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>}

      {/* ── Legend (main view only) ───────────────────────────────────────── */}
      {viewMode === "main" && <div className="text-xs text-muted-foreground leading-relaxed px-1">
        <p>
          <strong className="text-foreground">The reconcile identity (money columns, left to right):</strong>
          <br />
          <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px] font-mono">
            Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback − Label cost + Refund from EasyPost − Adjustment charged = Net margin
          </code>
          <br />
          A row is <strong>✓ Reconciled</strong> when every counterpart movement is present and the math closes to the cent.{" "}
          <strong>Click any shipment ID</strong> for the full detail view — parties, addresses, package, the complete event-by-event ledger, and links out to EasyPost / Stripe / the tracking page.
        </p>
        <p className="mt-2">
          <strong className="text-foreground">Timeline</strong> — label created, carrier ship date (first scan), and delivery.
          Voided shipments never ship, so those cells read "— voided".
        </p>
        <p className="mt-2">
          <strong className="text-foreground">Carrier adjustments</strong> have two columns — <em>Adjustment charged</em> (what EasyPost billed
          the wallet) vs <em>Adjustment collected</em> (what we re-charged the customer, incl. the $1 handling fee).
          ≤ $1 absorbed · $1–$10 auto-recharged · &gt; $10 flagged.
        </p>
        <p className="mt-2">
          <strong className="text-foreground">Chargeback</strong> — disputed amount clawed back <em>plus</em> the ~$15 Stripe dispute fee, as one
          figure. <strong>COMP</strong> shipments have no customer side.
        </p>
      </div>}
    </div>
  );
}
