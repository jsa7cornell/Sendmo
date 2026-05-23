import { useState, useEffect, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import CancelLabelModal from "@/components/CancelLabelModal";
import { Ban, Package, Link2, AlertTriangle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReportRow {
    created_at: string;
    link_id: string;
    link_type: string;
    link_status: string;
    recipient_email: string;
    shipment_uuid: string;       // Supabase UUID for cancel action
    shipment_id: string;         // Formatted display ID (SM-XXXX)
    easypost_shipment_id: string | null;
    carrier: string;
    collected_cents: number | null;
    label_cost_cents: number | null;
    insurance_cost_cents: number | null;
    margin_cents: number | null;
    shipment_status: string;
    tracking_number: string;
    label_url: string | null;
    refund_status: string;
    easypost_refund_status: string | null; // migration 030: EP-side void status
    shipment_created_at: string;
    is_test: boolean;
    is_live: boolean;
    sender_name: string | null;
    recipient_name: string | null;
}

// Links-tab row derived from the same admin-report payload.
interface LinksRow {
    link_id: string;           // short_code
    link_type: string;
    link_status: string;
    recipient_email: string;
    is_test: boolean;
    created_at: string;
    label_count: number;
}

type CancelTarget = {
    shipmentId: string;
    easypostShipmentId: string;
    carrier: string;
    trackingNumber: string;
    rateCents: number;
    createdAt: string;
    isTest: boolean;
};

// ─── Badge helpers ────────────────────────────────────────────────────────────

function getLinkTypeBadge(type: string) {
    if (type === "full_label") return <Badge className="bg-blue-500 hover:bg-blue-600 border-none">Full Label</Badge>;
    if (type === "flexible") return <Badge className="bg-purple-500 hover:bg-purple-600 border-none">Flexible</Badge>;
    return <Badge variant="outline">{type}</Badge>;
}

function getLinkStatusBadge(status: string) {
    switch (status) {
        case "active": return <Badge className="bg-green-500 hover:bg-green-600 border-none">Active</Badge>;
        case "draft": return <Badge className="bg-gray-400 hover:bg-gray-500 border-none">Draft</Badge>;
        case "cancelled": return <Badge className="bg-red-500 hover:bg-red-600 border-none">Cancelled</Badge>;
        case "expired": return <Badge className="bg-amber-500 hover:bg-amber-600 border-none">Expired</Badge>;
        case "completed": return <Badge className="bg-teal-500 hover:bg-teal-600 border-none">Completed</Badge>;
        default: return <Badge variant="outline" className="capitalize">{status}</Badge>;
    }
}

function getShipmentStatusBadge(status: string) {
    if (status === "—") return "—";
    switch (status) {
        case "label_created": return <Badge className="bg-purple-500 hover:bg-purple-600 border-none">Label Created</Badge>;
        case "in_transit": return <Badge className="bg-blue-500 hover:bg-blue-600 border-none">In Transit</Badge>;
        case "delivered": return <Badge className="bg-green-500 hover:bg-green-600 border-none">Delivered</Badge>;
        case "return_to_sender": return <Badge className="bg-red-500 hover:bg-red-600 border-none">Returned</Badge>;
        case "cancelled": return <Badge className="bg-gray-400 hover:bg-gray-500 border-none">Cancelled</Badge>;
        default: return <Badge variant="outline" className="capitalize">{status.replace(/_/g, " ")}</Badge>;
    }
}

function getRefundBadge(status: string) {
    switch (status) {
        case "none": return null;
        case "submitted": return <Badge className="bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-100 text-[10px] py-0 px-1.5">Refund Pending</Badge>;
        case "refunded": return <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 text-[10px] py-0 px-1.5">Refunded</Badge>;
        case "rejected": return <Badge className="bg-red-100 text-red-700 border border-red-200 hover:bg-red-100 text-[10px] py-0 px-1.5">Refund Rejected</Badge>;
        case "not_applicable": return <Badge variant="outline" className="text-[10px] py-0 px-1.5">Not Eligible</Badge>;
        default: return null;
    }
}

/**
 * EasyPost status column — one cell showing the EasyPost-side ground truth.
 *
 * For a cancelled/voided label the money-critical path is:
 *   easypost_refund_status must land 'refunded' for SendMo to be whole.
 *   A label in 'submitted' has NOT yet been confirmed by the carrier —
 *   warning treatment to make it visually obvious.
 *
 * For a live (non-cancelled) label we show the shipment tracking status
 * (label_created / in_transit / delivered) which is the EasyPost ground truth
 * at the shipment level.
 */
function getEasypostStatusCell(row: ReportRow) {
    if (row.shipment_status === "—") return <span className="text-muted-foreground">—</span>;

    if (row.shipment_status === "cancelled") {
        // easypost_refund_status is the carrier ground truth for voided labels.
        const epStatus = row.easypost_refund_status;
        if (!epStatus || epStatus === "submitted") {
            // Money-critical: carrier has NOT yet confirmed the refund.
            return (
                <div className="flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                    <Badge className="bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100 text-[10px] py-0 px-1.5">
                        EP: Pending
                    </Badge>
                </div>
            );
        }
        if (epStatus === "refunded") {
            return <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 text-[10px] py-0 px-1.5">EP: Refunded</Badge>;
        }
        if (epStatus === "rejected") {
            return (
                <div className="flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
                    <Badge className="bg-red-100 text-red-700 border border-red-200 hover:bg-red-100 text-[10px] py-0 px-1.5">
                        EP: Rejected
                    </Badge>
                </div>
            );
        }
        if (epStatus === "not_applicable") {
            return <Badge variant="outline" className="text-[10px] py-0 px-1.5">EP: N/A</Badge>;
        }
        return <Badge variant="outline" className="text-[10px] py-0 px-1.5">{epStatus}</Badge>;
    }

    // Live label — show shipment tracking status as the EasyPost ground truth.
    return getShipmentStatusBadge(row.shipment_status);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Admin() {
    const { user, session, loading: authLoading, isAdmin, profileLoaded } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();

    const [data, setData] = useState<ReportRow[]>([]);
    const [filteredData, setFilteredData] = useState<ReportRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [dateFilter, setDateFilter] = useState<"7days" | "30days" | "all">("30days");
    const [envFilter, setEnvFilter] = useState<"all" | "production" | "test">("production");
    const [search, setSearch] = useState("");
    const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);

    // Account-Budget admin tool (fast-follow of the 2026-05-22 risk-intel
    // proposal). Minimal form — Admin pastes a target user_id + daily/weekly
    // dollar amounts and the set_account_budget RPC (admin-gated, SECURITY
    // DEFINER, migration 031) updates profiles.daily/weekly_budget_cents.
    const [budgetTargetId, setBudgetTargetId] = useState("");
    const [budgetDaily, setBudgetDaily] = useState("");
    const [budgetWeekly, setBudgetWeekly] = useState("");
    const [budgetBusy, setBudgetBusy] = useState(false);
    const [budgetMsg, setBudgetMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

    async function handleSetBudget(e: FormEvent) {
        e.preventDefault();
        setBudgetMsg(null);
        const dailyDollars = parseFloat(budgetDaily);
        const weeklyDollars = parseFloat(budgetWeekly);
        if (!budgetTargetId.trim() || isNaN(dailyDollars) || isNaN(weeklyDollars)) {
            setBudgetMsg({ kind: "err", text: "Need a target_user_id (UUID) and numeric daily + weekly amounts." });
            return;
        }
        const dailyCents = Math.round(dailyDollars * 100);
        const weeklyCents = Math.round(weeklyDollars * 100);
        if (dailyCents < 0 || weeklyCents < 0) {
            setBudgetMsg({ kind: "err", text: "Amounts must be non-negative." });
            return;
        }
        setBudgetBusy(true);
        const { error: rpcErr } = await supabase.rpc("set_account_budget", {
            target_user_id: budgetTargetId.trim(),
            daily_cents: dailyCents,
            weekly_cents: weeklyCents,
        });
        setBudgetBusy(false);
        if (rpcErr) {
            setBudgetMsg({ kind: "err", text: rpcErr.message });
        } else {
            setBudgetMsg({
                kind: "ok",
                text: `Set $${dailyDollars.toFixed(2)}/day · $${weeklyDollars.toFixed(2)}/week for ${budgetTargetId.trim().slice(0, 8)}…`,
            });
        }
    }

    // Two-tab pattern — mirrors Dashboard.tsx (PLAYBOOK Rule 6).
    const tabParam = searchParams.get("tab");
    const initialTab: "labels" | "links" = tabParam === "links" ? "links" : "labels";
    const [tab, setTab] = useState<"labels" | "links">(initialTab);

    function switchTab(next: "labels" | "links") {
        setTab(next);
        const params = new URLSearchParams(searchParams);
        if (next === "labels") params.delete("tab");
        else params.set("tab", next);
        setSearchParams(params, { replace: true });
    }

    useEffect(() => {
        if (user && profileLoaded && isAdmin && session) fetchReport();
    }, [user, profileLoaded, isAdmin, session]);

    useEffect(() => {
        if (user && profileLoaded && isAdmin) applyFilter(data, dateFilter, envFilter, search);
    }, [user, profileLoaded, isAdmin, data, dateFilter, envFilter, search]);

    // Auth guards
    if (authLoading) return null;
    if (!user) return <Navigate to="/login?redirectTo=/admin" replace />;
    if (!profileLoaded) return null;

    if (!isAdmin) {
        return (
            <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex items-center justify-center px-6">
                <div className="bg-card rounded-2xl border border-border shadow-sm p-8 w-full max-w-md text-center">
                    <h2 className="text-lg font-bold text-foreground mb-1">Admin access required</h2>
                    <p className="text-sm text-muted-foreground mb-4">
                        Your account ({user.email}) isn't an admin. If you should have access,
                        ask John to flip your role.
                    </p>
                    <Button asChild variant="outline" className="rounded-xl">
                        <a href="/dashboard">Back to dashboard</a>
                    </Button>
                </div>
            </div>
        );
    }

    async function fetchReport() {
        setLoading(true);
        setError(null);
        try {
            const BASE_URL = import.meta.env.VITE_SUPABASE_URL;

            const res = await fetch(`${BASE_URL}/functions/v1/admin-report`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${session!.access_token}`,
                },
            });

            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Failed to fetch report (${res.status})`);
            }

            const { data: rawData } = await res.json();

            const rows: ReportRow[] = [];

            for (const link of (rawData || [])) {
                const email = Array.isArray(link.profiles) ? link.profiles[0]?.email : (link.profiles as any)?.email;
                const shs = Array.isArray(link.shipments) ? link.shipments : (link.shipments ? [link.shipments] : []);

                if (shs.length === 0) {
                    // Links without shipments — use link-level is_test (PLAYBOOK Rule 14).
                    const linkIsTest = link.is_test ?? true; // fail-safe: unknown = treat as test
                    rows.push({
                        created_at: link.created_at,
                        link_id: link.short_code,
                        link_type: link.link_type,
                        link_status: link.status,
                        recipient_email: email || "—",
                        shipment_uuid: "",
                        shipment_id: "—",
                        easypost_shipment_id: null,
                        carrier: "—",
                        collected_cents: null,
                        label_cost_cents: null,
                        insurance_cost_cents: null,
                        margin_cents: null,
                        shipment_status: "—",
                        tracking_number: "—",
                        label_url: null,
                        refund_status: "none",
                        easypost_refund_status: null,
                        shipment_created_at: link.created_at,
                        is_test: linkIsTest,
                        is_live: !linkIsTest,
                        sender_name: null,
                        recipient_name: null,
                    });
                } else {
                    for (const sh of shs) {
                        // Stripe Phase A: derive margin from the transactions ledger.
                        const txs: Array<{ amount_cents: number; type: string }> =
                            Array.isArray(sh.transactions) ? sh.transactions : (sh.transactions ? [sh.transactions] : []);
                        const sumByType = (t: string) =>
                            txs.filter((x) => x.type === t).reduce((sum, x) => sum + (x.amount_cents || 0), 0);
                        const chargeSum = sumByType("charge");
                        const refundSum = sumByType("refund");     // negative
                        const compSum   = sumByType("comp_grant"); // negative
                        const collected = chargeSum !== 0 ? chargeSum : null;
                        const cost = sh.rate_cents ?? null;
                        const ins = 0;
                        let margin: number | null;
                        if (compSum !== 0 && collected === null) {
                            margin = compSum;
                        } else if (collected !== null && cost !== null) {
                            margin = collected - cost - ins + refundSum;
                        } else {
                            margin = null;
                        }

                        rows.push({
                            // Use shipment creation date (not link creation date) — a flex
                            // link can produce many shipments over time at different dates.
                            created_at: sh.created_at || link.created_at,
                            link_id: link.short_code,
                            link_type: link.link_type,
                            link_status: link.status,
                            recipient_email: email || "—",
                            shipment_uuid: sh.id,
                            shipment_id: "SM-" + sh.id.split("-")[0].slice(0, 4).toUpperCase(),
                            easypost_shipment_id: sh.easypost_shipment_id || null,
                            carrier: sh.carrier || "—",
                            collected_cents: collected,
                            label_cost_cents: cost,
                            insurance_cost_cents: ins,
                            margin_cents: margin,
                            shipment_status: sh.status || "—",
                            tracking_number: sh.tracking_number || "—",
                            label_url: sh.label_url || null,
                            refund_status: sh.refund_status || "none",
                            easypost_refund_status: sh.easypost_refund_status ?? null,
                            shipment_created_at: sh.created_at || link.created_at,
                            // is_test comes from the DB — set server-side at shipment creation.
                            is_test: sh.is_test ?? false,
                            is_live: sh.is_live ?? false,
                            sender_name: sh.sender_address?.name || null,
                            recipient_name: sh.recipient_address?.name || null,
                        });
                    }
                }
            }
            setData(rows);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    function applyFilter(allData: ReportRow[], dateF: string, envF: string, q: string) {
        let result = allData;
        if (envF === "production") result = result.filter(d => !d.is_test);
        if (envF === "test") result = result.filter(d => d.is_test);
        if (dateF !== "all") {
            const days = dateF === "7days" ? 7 : 30;
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            result = result.filter(d => new Date(d.created_at) >= cutoff);
        }
        if (q.trim()) {
            const lower = q.toLowerCase();
            result = result.filter(d =>
                d.recipient_email.toLowerCase().includes(lower) ||
                d.link_id.toLowerCase().includes(lower) ||
                d.tracking_number.toLowerCase().includes(lower) ||
                d.carrier.toLowerCase().includes(lower) ||
                (d.sender_name || "").toLowerCase().includes(lower) ||
                (d.recipient_name || "").toLowerCase().includes(lower)
            );
        }
        setFilteredData(result);
    }

    // Called by CancelLabelModal after a successful cancel — optimistic update.
    function handleCancelled(shipmentId: string) {
        setData(prev => prev.map(row =>
            row.shipment_uuid === shipmentId
                ? { ...row, shipment_status: "cancelled", refund_status: "submitted", easypost_refund_status: "submitted" }
                : row
        ));
        setCancelTarget(null);
    }

    // Formatting helpers
    const formatDate = (ds: string) => new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric"
    }).format(new Date(ds));

    const formatMoney = (cents: number | null) => {
        if (cents === null) return "—";
        return "$" + (cents / 100).toFixed(2);
    };

    const truncateEmail = (email: string) => {
        if (email === "—") return email;
        if (email.length <= 20) return email;
        const parts = email.split("@");
        if (parts.length === 2 && parts[0].length > 10) {
            return parts[0].substring(0, 8) + "...@" + parts[1];
        }
        return email.substring(0, 18) + "...";
    };

    // Determine if a row can have its label cancelled.
    const canCancelLabel = (row: ReportRow) =>
        !row.is_test &&
        row.shipment_uuid !== "" &&
        row.easypost_shipment_id !== null &&
        row.shipment_status === "label_created" &&
        row.refund_status === "none";

    const getCancelDisabledReason = (row: ReportRow): string | null => {
        if (row.shipment_uuid === "" || row.shipment_id === "—") return "No label to cancel";
        if (row.is_test) return "Test labels cannot be voided";
        if (row.shipment_status === "cancelled") return "Already cancelled";
        if (row.shipment_status === "in_transit") return "Label is in transit";
        if (row.shipment_status === "delivered") return "Already delivered";
        if (row.refund_status === "submitted") return "Refund already submitted";
        if (row.refund_status === "refunded") return "Already refunded";
        if (!row.easypost_shipment_id) return "No carrier reference";
        return null;
    };

    // ── Derived data ─────────────────────────────────────────────────────────

    // Labels tab: one row per real shipment (has a shipment_uuid).
    const labelRows = filteredData.filter(r => r.shipment_uuid !== "");

    // Links tab: one row per unique link_id, with a count of labels.
    // De-duplicate by link_id from the full filteredData (include links with
    // zero shipments).
    const linksMap = new Map<string, LinksRow>();
    for (const d of filteredData) {
        if (!linksMap.has(d.link_id)) {
            linksMap.set(d.link_id, {
                link_id: d.link_id,
                link_type: d.link_type,
                link_status: d.link_status,
                recipient_email: d.recipient_email,
                is_test: d.is_test,
                created_at: d.created_at,
                label_count: 0,
            });
        }
        if (d.shipment_uuid !== "") {
            linksMap.get(d.link_id)!.label_count++;
        }
    }
    const linksRows = Array.from(linksMap.values()).sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    // Summary bar excludes cancelled shipments (same logic as before).
    const activeRows = labelRows.filter(r => r.shipment_status !== "cancelled");
    const totalCollected = activeRows.reduce((sum, r) => sum + (r.collected_cents || 0), 0);
    const totalLabelCost = activeRows.reduce((sum, r) => sum + (r.label_cost_cents || 0) + (r.insurance_cost_cents || 0), 0);
    const totalMargin = totalCollected - totalLabelCost;

    // Money-leak alert: cancelled labels where EP hasn't confirmed the refund yet.
    const pendingEpRefunds = labelRows.filter(
        r => r.shipment_status === "cancelled" &&
             (r.easypost_refund_status === "submitted" || r.easypost_refund_status === null)
    );

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-gray-50 p-8 text-sm">
            <div className="max-w-[1500px] mx-auto space-y-8">
                {/* Header */}
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900">Admin / Reporting</h1>
                    <p className="text-muted-foreground mt-1">Every link and label created, with financials</p>
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center flex-wrap">
                    <div className="flex bg-white w-fit border rounded-full p-1 shadow-sm">
                        {(["all", "production", "test"] as const).map(f => (
                            <button
                                key={f}
                                onClick={() => setEnvFilter(f)}
                                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors capitalize ${envFilter === f ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                            >
                                {f}
                            </button>
                        ))}
                    </div>

                    <div className="flex bg-white w-fit border rounded-full p-1 shadow-sm">
                        {(["7days", "30days", "all"] as const).map(f => (
                            <button
                                key={f}
                                onClick={() => setDateFilter(f)}
                                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${dateFilter === f ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                            >
                                {f === "7days" ? "Last 7 days" : f === "30days" ? "Last 30 days" : "All time"}
                            </button>
                        ))}
                    </div>

                    <input
                        type="search"
                        placeholder="Search email, link, tracking…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="border rounded-full px-4 py-1.5 text-xs bg-white shadow-sm focus:outline-none focus:ring-1 focus:ring-primary w-52"
                    />
                </div>

                {/* Content */}
                {loading ? (
                    <div className="py-20 text-center text-muted-foreground">Loading report data...</div>
                ) : error ? (
                    <div className="bg-red-50 text-red-600 p-4 rounded-xl border border-red-200">
                        Error fetching data: {error}
                    </div>
                ) : (
                    <div className="space-y-6">
                        {/* Money-leak alert: pending EP refunds */}
                        {pendingEpRefunds.length > 0 && (
                            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                                <p className="text-xs text-amber-800">
                                    <span className="font-semibold">{pendingEpRefunds.length} cancelled label{pendingEpRefunds.length > 1 ? "s" : ""} awaiting carrier confirmation.</span>{" "}
                                    EasyPost has not yet credited SendMo's account for these voids.
                                    Visit the tracking page for each label to trigger a status poll, or wait for the{" "}
                                    <code className="font-mono">refund.successful</code> webhook.
                                </p>
                            </div>
                        )}

                        {/* Set Account Budget — minimal admin tool (2026-05-22 risk-intel) */}
                        <details className="bg-white rounded-xl shadow-sm border">
                            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground select-none">
                                Set Account Budget
                            </summary>
                            <form onSubmit={handleSetBudget} className="px-4 pb-4 flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
                                <div className="flex flex-col gap-1 flex-1 min-w-[280px]">
                                    <label htmlFor="budget-target-user-id" className="text-[10px] uppercase tracking-wider text-muted-foreground">target_user_id (UUID)</label>
                                    <input
                                        id="budget-target-user-id"
                                        type="text"
                                        value={budgetTargetId}
                                        onChange={e => setBudgetTargetId(e.target.value)}
                                        placeholder="00000000-0000-0000-0000-000000000000"
                                        className="border rounded-md px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                                    />
                                </div>
                                <div className="flex flex-col gap-1 w-32">
                                    <label htmlFor="budget-daily-cents" className="text-[10px] uppercase tracking-wider text-muted-foreground">daily ($)</label>
                                    <input
                                        id="budget-daily-cents"
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        value={budgetDaily}
                                        onChange={e => setBudgetDaily(e.target.value)}
                                        placeholder="200"
                                        className="border rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                    />
                                </div>
                                <div className="flex flex-col gap-1 w-32">
                                    <label htmlFor="budget-weekly-cents" className="text-[10px] uppercase tracking-wider text-muted-foreground">weekly ($)</label>
                                    <input
                                        id="budget-weekly-cents"
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        value={budgetWeekly}
                                        onChange={e => setBudgetWeekly(e.target.value)}
                                        placeholder="500"
                                        className="border rounded-md px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                                    />
                                </div>
                                <Button type="submit" disabled={budgetBusy} className="rounded-md">
                                    {budgetBusy ? "Setting…" : "Set"}
                                </Button>
                                {budgetMsg && (
                                    <p className={cn(
                                        "text-xs sm:ml-3 self-center",
                                        budgetMsg.kind === "ok" ? "text-green-700" : "text-red-600"
                                    )}>
                                        {budgetMsg.text}
                                    </p>
                                )}
                            </form>
                        </details>

                        {/* Tabs — Labels default, Links second (mirrors Dashboard.tsx pattern). */}
                        <div className="flex items-center gap-1 border-b border-border">
                            <button
                                type="button"
                                onClick={() => switchTab("labels")}
                                className={cn(
                                    "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-2",
                                    tab === "labels"
                                        ? "border-primary text-foreground"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Package className="w-4 h-4" />
                                Labels
                                {labelRows.length > 0 && (
                                    <span className="text-[10px] text-muted-foreground font-normal">({labelRows.length})</span>
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => switchTab("links")}
                                className={cn(
                                    "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-2",
                                    tab === "links"
                                        ? "border-primary text-foreground"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Link2 className="w-4 h-4" />
                                Links
                                {linksRows.length > 0 && (
                                    <span className="text-[10px] text-muted-foreground font-normal">({linksRows.length})</span>
                                )}
                            </button>
                        </div>

                        {/* ── Labels tab ─────────────────────────────────── */}
                        {tab === "labels" && (
                            <>
                                <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left border-collapse whitespace-nowrap">
                                            <thead>
                                                <tr className="bg-gray-50/50 border-b text-xs uppercase tracking-wider text-muted-foreground">
                                                    <th className="px-4 py-3 font-medium">Date</th>
                                                    <th className="px-4 py-3 font-medium">Link ID</th>
                                                    <th className="px-4 py-3 font-medium">Source</th>
                                                    <th className="px-4 py-3 font-medium">Recipient</th>
                                                    <th className="px-4 py-3 font-medium">From</th>
                                                    <th className="px-4 py-3 font-medium">To</th>
                                                    <th className="px-4 py-3 font-medium">Shipment ID</th>
                                                    <th className="px-4 py-3 font-medium">Carrier</th>
                                                    <th className="px-4 py-3 font-medium text-right">Collected</th>
                                                    <th className="px-4 py-3 font-medium text-right">Label Cost</th>
                                                    <th className="px-4 py-3 font-medium text-right">Margin</th>
                                                    <th className="px-4 py-3 font-medium">Status / Refund</th>
                                                    <th className="px-4 py-3 font-medium">EasyPost Status</th>
                                                    <th className="px-4 py-3 font-medium">Tracking #</th>
                                                    <th className="px-4 py-3 font-medium">Label</th>
                                                    <th className="px-4 py-3 font-medium">Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100">
                                                {labelRows.length === 0 ? (
                                                    <tr>
                                                        <td colSpan={16} className="px-4 py-8 text-center text-muted-foreground">
                                                            No labels found for the selected filters.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    labelRows.map((row, i) => {
                                                        const canCancel = canCancelLabel(row);
                                                        const disabledReason = getCancelDisabledReason(row);
                                                        return (
                                                            <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                                                                <td className="px-4 py-3">{formatDate(row.created_at)}</td>
                                                                <td className="px-4 py-3 font-mono text-xs text-gray-600">
                                                                    {row.link_id}
                                                                    {row.is_test && <Badge variant="outline" className="ml-2 text-[10px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>}
                                                                </td>
                                                                {/* Source: "Flex link" vs "Full label" from link_type */}
                                                                <td className="px-4 py-3">
                                                                    {row.link_type === "flexible"
                                                                        ? <Badge className="bg-purple-100 text-purple-700 border border-purple-200 hover:bg-purple-100 text-[10px] py-0.5 px-2">Flex link</Badge>
                                                                        : <Badge className="bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-100 text-[10px] py-0.5 px-2">Full label</Badge>
                                                                    }
                                                                </td>
                                                                <td className="px-4 py-3" title={row.recipient_email}>{truncateEmail(row.recipient_email)}</td>
                                                                <td className="px-4 py-3 text-gray-700 max-w-[120px] truncate" title={row.sender_name || "—"}>{row.sender_name || "—"}</td>
                                                                <td className="px-4 py-3 text-gray-700 max-w-[120px] truncate" title={row.recipient_name || "—"}>{row.recipient_name || "—"}</td>
                                                                <td className="px-4 py-3 text-gray-500">{row.shipment_id}</td>
                                                                <td className="px-4 py-3 font-medium">{row.carrier}</td>
                                                                <td className="px-4 py-3 text-right">{formatMoney(row.collected_cents)}</td>
                                                                <td className="px-4 py-3 text-right">{formatMoney(row.label_cost_cents)}</td>
                                                                <td className={`px-4 py-3 text-right font-bold ${row.margin_cents !== null && row.margin_cents > 0 ? "text-green-600" : row.margin_cents !== null && row.margin_cents < 0 ? "text-red-600" : "text-gray-900"}`}>
                                                                    {formatMoney(row.margin_cents)}
                                                                </td>
                                                                <td className="px-4 py-3">
                                                                    <div className="flex flex-col gap-1">
                                                                        {getShipmentStatusBadge(row.shipment_status)}
                                                                        {getRefundBadge(row.refund_status)}
                                                                    </div>
                                                                </td>
                                                                {/* EasyPost Status — carrier ground truth (migration 030) */}
                                                                <td className="px-4 py-3">
                                                                    {getEasypostStatusCell(row)}
                                                                </td>
                                                                <td className="px-4 py-3 font-mono text-xs text-gray-500">{row.tracking_number}</td>
                                                                <td className="px-4 py-3">
                                                                    {row.label_url ? (
                                                                        <a href={row.label_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-xs font-medium">View</a>
                                                                    ) : "—"}
                                                                </td>
                                                                <td className="px-4 py-3">
                                                                    <div title={!canCancel && disabledReason ? disabledReason : undefined}>
                                                                        <Button
                                                                            variant="outline"
                                                                            size="sm"
                                                                            disabled={!canCancel}
                                                                            onClick={() => canCancel && setCancelTarget({
                                                                                shipmentId: row.shipment_uuid,
                                                                                easypostShipmentId: row.easypost_shipment_id!,
                                                                                carrier: row.carrier,
                                                                                trackingNumber: row.tracking_number,
                                                                                rateCents: row.label_cost_cents ?? 0,
                                                                                createdAt: row.shipment_created_at,
                                                                                isTest: row.is_test,
                                                                            })}
                                                                            className={`text-xs gap-1.5 ${canCancel
                                                                                ? "border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400"
                                                                                : "opacity-40 cursor-not-allowed"
                                                                                }`}
                                                                        >
                                                                            <Ban className="h-3 w-3" />
                                                                            {row.refund_status === "submitted" ? "Pending" :
                                                                                row.shipment_status === "cancelled" ? "Voided" :
                                                                                    "Void"}
                                                                        </Button>
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* Summary Bar */}
                                <div className="bg-white rounded-xl shadow-sm border p-6 flex items-center justify-between">
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Collected</p>
                                        <p className="text-2xl font-bold">{formatMoney(totalCollected)}</p>
                                    </div>
                                    <div className="w-px h-12 bg-gray-200" />
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Label Cost</p>
                                        <p className="text-2xl font-bold">{formatMoney(totalLabelCost)}</p>
                                    </div>
                                    <div className="w-px h-12 bg-gray-200" />
                                    <div className="space-y-1 text-right">
                                        <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total SendMo Margin</p>
                                        <p className={`text-3xl font-bold ${totalMargin > 0 ? "text-green-600" : totalMargin < 0 ? "text-red-600" : "text-gray-900"}`}>
                                            {formatMoney(totalMargin)}
                                        </p>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* ── Links tab ──────────────────────────────────── */}
                        {tab === "links" && (
                            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-left border-collapse whitespace-nowrap">
                                        <thead>
                                            <tr className="bg-gray-50/50 border-b text-xs uppercase tracking-wider text-muted-foreground">
                                                <th className="px-4 py-3 font-medium">Created</th>
                                                <th className="px-4 py-3 font-medium">Short Code</th>
                                                <th className="px-4 py-3 font-medium">Type</th>
                                                <th className="px-4 py-3 font-medium">Status</th>
                                                <th className="px-4 py-3 font-medium">Mode</th>
                                                <th className="px-4 py-3 font-medium">Owner</th>
                                                <th className="px-4 py-3 font-medium text-right">Labels</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                            {linksRows.length === 0 ? (
                                                <tr>
                                                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                                                        No links found for the selected filters.
                                                    </td>
                                                </tr>
                                            ) : (
                                                linksRows.map((row, i) => (
                                                    <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                                                        <td className="px-4 py-3">{formatDate(row.created_at)}</td>
                                                        <td className="px-4 py-3 font-mono text-xs text-gray-600">
                                                            {row.link_id}
                                                            {row.is_test && <Badge variant="outline" className="ml-2 text-[10px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>}
                                                        </td>
                                                        <td className="px-4 py-3">{getLinkTypeBadge(row.link_type)}</td>
                                                        <td className="px-4 py-3">{getLinkStatusBadge(row.link_status)}</td>
                                                        <td className="px-4 py-3">
                                                            {row.is_test ? (
                                                                <Badge className="bg-gray-400 hover:bg-gray-500 border-none text-white">Test</Badge>
                                                            ) : (
                                                                <Badge className="bg-green-500 hover:bg-green-600 border-none text-white">Live</Badge>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-3" title={row.recipient_email}>{truncateEmail(row.recipient_email)}</td>
                                                        <td className="px-4 py-3 text-right font-medium">
                                                            {row.label_count === 0
                                                                ? <span className="text-muted-foreground">None</span>
                                                                : row.label_count
                                                            }
                                                        </td>
                                                    </tr>
                                                ))
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Cancel Label Modal */}
            {cancelTarget && (
                <CancelLabelModal
                    open={!!cancelTarget}
                    onClose={() => setCancelTarget(null)}
                    shipment={cancelTarget}
                    onCancelled={handleCancelled}
                />
            )}
        </div>
    );
}
