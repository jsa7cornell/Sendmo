import { useState, useEffect } from "react";
import { Navigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import CancelLabelModal from "@/components/CancelLabelModal";
import { Ban } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

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
    shipment_created_at: string;
    is_test: boolean;
    is_live: boolean;
    sender_name: string | null;
    recipient_name: string | null;
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

export default function Admin() {
    const { user, session, loading: authLoading, isAdmin, profileLoaded } = useAuth();
    const [data, setData] = useState<ReportRow[]>([]);
    const [filteredData, setFilteredData] = useState<ReportRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dateFilter, setDateFilter] = useState<"7days" | "30days" | "all">("30days");
    const [envFilter, setEnvFilter] = useState<"all" | "production" | "test">("production");
    const [cancelTarget, setCancelTarget] = useState<CancelTarget | null>(null);

    useEffect(() => {
        if (user && profileLoaded && isAdmin && session) fetchReport();
    }, [user, profileLoaded, isAdmin, session]);

    useEffect(() => {
        if (user && profileLoaded && isAdmin) applyFilter(data, dateFilter, envFilter);
    }, [user, profileLoaded, isAdmin, data, dateFilter, envFilter]);

    // Wait for auth to resolve before deciding what to render.
    if (authLoading) return null;

    // Signed out → bounce to login with return path.
    if (!user) return <Navigate to="/login?redirectTo=/admin" replace />;

    // Wait for profile to load before checking admin status — avoids flashing
    // "Admin access required" during the stale window on an account switch.
    if (!profileLoaded) return null;

    // Signed in but not an admin → friendly access-denied screen.
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
                const emailStr = (email || "").toLowerCase();

                if (shs.length === 0) {
                    // is_test comes from the DB (sendmo_links.is_test), never client heuristics.
                    // Per PLAYBOOK Rule 14: the server sets this; the email pattern check is
                    // unreliable and was violating rule 14. Links without shipments fall back
                    // to the link-level is_test flag.
                    const linkIsTest = link.is_test ?? true; // default true = fail-safe
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
                        shipment_created_at: link.created_at,
                        is_test: linkIsTest,
                        is_live: !linkIsTest,
                        sender_name: null,
                        recipient_name: null,
                    });
                } else {
                    for (const sh of shs) {
                        // Stripe Phase A: derive margin from the transactions ledger,
                        // not the legacy payments table (which was dropped in migration 017).
                        //
                        //   collected = SUM(charge)          -- card/balance customer payments (positive)
                        //   refunded  = SUM(refund)          -- money returned (negative)
                        //   compCost  = SUM(comp_grant)      -- SendMo absorbs EasyPost cost (negative)
                        //
                        // Comp shipments now correctly show negative margin (WISHLIST closed).
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
                            // Pure comp shipment: margin = comp_grant (negative — cost to SendMo).
                            margin = compSum;
                        } else if (collected !== null && cost !== null) {
                            margin = collected - cost - ins + refundSum;
                        } else {
                            margin = null;
                        }


                        rows.push({
                            // Use shipment creation date, not link creation date.
                            // A flex link can be reused across multiple shipments at different times;
                            // the "Date" column should reflect when the label was bought, not when
                            // the link was originally created.
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
                            shipment_created_at: sh.created_at || link.created_at,
                            // is_test comes from the DB — set server-side at shipment creation.
                            // Never derived from client heuristics (email patterns, tracking prefixes).
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

    function applyFilter(allData: ReportRow[], dateF: string, envF: string) {
        let result = allData;
        if (envF === "production") result = result.filter(d => !d.is_test);
        if (envF === "test") result = result.filter(d => d.is_test);
        if (dateF !== "all") {
            const days = dateF === "7days" ? 7 : 30;
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            result = result.filter(d => new Date(d.created_at) >= cutoff);
        }
        setFilteredData(result);
    }

    // Called by CancelLabelModal after a successful cancel — optimistic update
    function handleCancelled(shipmentId: string) {
        setData(prev => prev.map(row =>
            row.shipment_uuid === shipmentId
                ? { ...row, shipment_status: "cancelled", refund_status: "submitted" }
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

    const getLinkTypeBadge = (type: string) => {
        if (type === "full_label") return <Badge className="bg-blue-500 hover:bg-blue-600 border-none">Full Label</Badge>;
        if (type === "flexible") return <Badge className="bg-purple-500 hover:bg-purple-600 border-none">Flexible</Badge>;
        return <Badge variant="outline">{type}</Badge>;
    };

    const getLinkStatusBadge = (status: string) => {
        switch (status) {
            case "active": return <Badge className="bg-green-500 hover:bg-green-600 border-none">Active</Badge>;
            case "draft": return <Badge className="bg-gray-400 hover:bg-gray-500 border-none">Draft</Badge>;
            case "cancelled": return <Badge className="bg-red-500 hover:bg-red-600 border-none">Cancelled</Badge>;
            case "expired": return <Badge className="bg-amber-500 hover:bg-amber-600 border-none">Expired</Badge>;
            default: return <Badge variant="outline" className="capitalize">{status}</Badge>;
        }
    };

    const getShipmentStatusBadge = (status: string) => {
        if (status === "—") return "—";
        switch (status) {
            case "label_created": return <Badge className="bg-purple-500 hover:bg-purple-600 border-none">Label Created</Badge>;
            case "in_transit": return <Badge className="bg-blue-500 hover:bg-blue-600 border-none">In Transit</Badge>;
            case "delivered": return <Badge className="bg-green-500 hover:bg-green-600 border-none">Delivered</Badge>;
            case "return_to_sender": return <Badge className="bg-red-500 hover:bg-red-600 border-none">Returned</Badge>;
            case "cancelled": return <Badge className="bg-gray-400 hover:bg-gray-500 border-none">Cancelled</Badge>;
            default: return <Badge variant="outline" className="capitalize">{status.replace(/_/g, " ")}</Badge>;
        }
    };

    const getRefundBadge = (status: string) => {
        switch (status) {
            case "none": return null;
            case "submitted": return <Badge className="bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-100 text-[10px] py-0 px-1.5">Refund Pending</Badge>;
            case "refunded": return <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-100 text-[10px] py-0 px-1.5">Refunded</Badge>;
            case "rejected": return <Badge className="bg-red-100 text-red-700 border border-red-200 hover:bg-red-100 text-[10px] py-0 px-1.5">Refund Rejected</Badge>;
            case "not_applicable": return <Badge variant="outline" className="text-[10px] py-0 px-1.5">Not Eligible</Badge>;
            default: return null;
        }
    };

    // Determine if a row can have its label cancelled.
    // is_test check is first: test labels are categorically ineligible.
    const canCancelLabel = (row: ReportRow) =>
        !row.is_test &&
        row.shipment_uuid !== "" &&
        row.easypost_shipment_id !== null &&
        row.shipment_status === "label_created" &&
        row.refund_status === "none";

    const getCancelDisabledReason = (row: ReportRow): string | null => {
        if (row.shipment_uuid === "" || row.shipment_id === "—") return "No label to cancel";
        // Test label check first — it's the most fundamental block
        if (row.is_test) return "Test labels cannot be voided";
        if (row.shipment_status === "cancelled") return "Already cancelled";
        if (row.shipment_status === "in_transit") return "Label is in transit";
        if (row.shipment_status === "delivered") return "Already delivered";
        if (row.refund_status === "submitted") return "Refund already submitted";
        if (row.refund_status === "refunded") return "Already refunded";
        if (!row.easypost_shipment_id) return "No carrier reference";
        return null;
    };

    // Summaries — exclude cancelled shipments from cost/margin.
    // Cancelled labels were voided with the carrier (EasyPost absorbs the cost for pre-Stripe
    // labels with no Stripe PI; Stripe refund handles post-Phase-E ones). Counting their
    // rate_cents as a "label cost" in the summary bar inflates costs without a matching
    // revenue entry, which makes the margin look worse than it really is.
    const activeRows = filteredData.filter(r => r.shipment_status !== "cancelled");
    const totalCollected = activeRows.reduce((sum, r) => sum + (r.collected_cents || 0), 0);
    const totalLabelCost = activeRows.reduce((sum, r) => sum + (r.label_cost_cents || 0) + (r.insurance_cost_cents || 0), 0);
    const totalMargin = totalCollected - totalLabelCost;

    return (
        <div className="min-h-screen bg-gray-50 p-8 text-sm">
            <div className="max-w-[1500px] mx-auto space-y-8">
                {/* Header */}
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900">Admin / Reporting</h1>
                    <p className="text-muted-foreground mt-1">Every link and label created, with financials</p>
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
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
                        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                            <div className="overflow-x-auto">
                                <table className="w-full text-left border-collapse whitespace-nowrap">
                                    <thead>
                                        <tr className="bg-gray-50/50 border-b text-xs uppercase tracking-wider text-muted-foreground">
                                            <th className="px-4 py-3 font-medium">Date Created</th>
                                            <th className="px-4 py-3 font-medium">Link ID</th>
                                            <th className="px-4 py-3 font-medium">Type</th>
                                            <th className="px-4 py-3 font-medium">Status</th>
                                            <th className="px-4 py-3 font-medium">Mode</th>
                                            <th className="px-4 py-3 font-medium">Recipient</th>
                                            <th className="px-4 py-3 font-medium">From</th>
                                            <th className="px-4 py-3 font-medium">To</th>
                                            <th className="px-4 py-3 font-medium">Shipment ID</th>
                                            <th className="px-4 py-3 font-medium">Carrier</th>
                                            <th className="px-4 py-3 font-medium text-right">Collected</th>
                                            <th className="px-4 py-3 font-medium text-right">Label Cost</th>
                                            <th className="px-4 py-3 font-medium text-right">Insurance</th>
                                            <th className="px-4 py-3 font-medium text-right">Margin</th>
                                            <th className="px-4 py-3 font-medium">Shipment Status</th>
                                            <th className="px-4 py-3 font-medium">Tracking #</th>
                                            <th className="px-4 py-3 font-medium">Label</th>
                                            <th className="px-4 py-3 font-medium">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {filteredData.length === 0 ? (
                                            <tr>
                                                <td colSpan={18} className="px-4 py-8 text-center text-muted-foreground">
                                                    No records found for the selected filters.
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredData.map((row, i) => {
                                                const canCancel = canCancelLabel(row);
                                                const disabledReason = getCancelDisabledReason(row);
                                                return (
                                                    <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                                                        <td className="px-4 py-3">{formatDate(row.created_at)}</td>
                                                        <td className="px-4 py-3 font-mono text-xs text-gray-600">
                                                            {row.link_id}
                                                            {row.is_test && <Badge variant="outline" className="ml-2 text-[10px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>}
                                                        </td>
                                                        <td className="px-4 py-3">{getLinkTypeBadge(row.link_type)}</td>
                                                        <td className="px-4 py-3">{getLinkStatusBadge(row.link_status)}</td>
                                                        <td className="px-4 py-3">
                                                            {row.is_live ? (
                                                                <Badge className="bg-green-500 hover:bg-green-600 border-none text-white">Live</Badge>
                                                            ) : (
                                                                <Badge className="bg-gray-400 hover:bg-gray-500 border-none text-white">Test</Badge>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-3" title={row.recipient_email}>{truncateEmail(row.recipient_email)}</td>
                                                        <td className="px-4 py-3 text-gray-700 max-w-[120px] truncate" title={row.sender_name || "—"}>{row.sender_name || "—"}</td>
                                                        <td className="px-4 py-3 text-gray-700 max-w-[120px] truncate" title={row.recipient_name || "—"}>{row.recipient_name || "—"}</td>
                                                        <td className="px-4 py-3 text-gray-500">{row.shipment_id}</td>
                                                        <td className="px-4 py-3 font-medium">{row.carrier}</td>
                                                        <td className="px-4 py-3 text-right">{formatMoney(row.collected_cents)}</td>
                                                        <td className="px-4 py-3 text-right">{formatMoney(row.label_cost_cents)}</td>
                                                        <td className="px-4 py-3 text-right">{formatMoney(row.insurance_cost_cents)}</td>
                                                        <td className={`px-4 py-3 text-right font-bold ${row.margin_cents !== null && row.margin_cents > 0 ? 'text-green-600' : row.margin_cents !== null && row.margin_cents < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                                                            {formatMoney(row.margin_cents)}
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            <div className="flex flex-col gap-1">
                                                                {getShipmentStatusBadge(row.shipment_status)}
                                                                {getRefundBadge(row.refund_status)}
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{row.tracking_number}</td>
                                                        <td className="px-4 py-3">
                                                            {row.label_url ? (
                                                                <a href={row.label_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline text-xs font-medium">View Label</a>
                                                            ) : "—"}
                                                        </td>
                                                        <td className="px-4 py-3">
                                                            {row.shipment_id !== "—" && (
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
                                                            )}
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
                            <div className="w-px h-12 bg-gray-200"></div>
                            <div className="space-y-1">
                                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Label Cost</p>
                                <p className="text-2xl font-bold">{formatMoney(totalLabelCost)}</p>
                            </div>
                            <div className="w-px h-12 bg-gray-200"></div>
                            <div className="space-y-1 text-right">
                                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total SendMo Margin</p>
                                <p className={`text-3xl font-bold ${totalMargin > 0 ? 'text-green-600' : totalMargin < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                                    {formatMoney(totalMargin)}
                                </p>
                            </div>
                        </div>
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
