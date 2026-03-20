import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2, CheckCircle2, XCircle, Package } from "lucide-react";

interface CancelLabelModalProps {
    open: boolean;
    onClose: () => void;
    shipment: {
        shipmentId: string;       // Supabase UUID
        easypostShipmentId: string;
        carrier: string;
        trackingNumber: string;
        rateCents: number;
        createdAt: string;
        isTest: boolean;
    };
    onCancelled: (shipmentId: string) => void;
    accessToken?: string;  // If provided, use for auth (dashboard); otherwise anon key (admin)
}

type ModalState = "confirm" | "loading" | "success" | "error";

export default function CancelLabelModal({
    open,
    onClose,
    shipment,
    onCancelled,
    accessToken,
}: CancelLabelModalProps) {
    const [state, setState] = useState<ModalState>("confirm");
    const [resultMessage, setResultMessage] = useState("");
    const [refundStatus, setRefundStatus] = useState("");

    const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
    const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

    function formatMoney(cents: number) {
        return "$" + (cents / 100).toFixed(2);
    }

    function formatDate(ds: string) {
        return new Intl.DateTimeFormat("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        }).format(new Date(ds));
    }

    async function handleCancel() {
        setState("loading");
        try {
            const res = await fetch(`${BASE_URL}/functions/v1/cancel-label`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${accessToken || ANON_KEY}`,
                },
                body: JSON.stringify({
                    shipment_id: shipment.shipmentId,
                    // Note: live_mode is NOT sent — the server reads is_test from the DB.
                    // Never trust the client to determine whether a shipment is a test record.
                }),
            });

            const json = await res.json();

            if (!res.ok || json.error) {
                setResultMessage(json.error || "Something went wrong. Please try again.");
                setState("error");
                return;
            }

            setResultMessage(json.message || "Label void submitted successfully.");
            setRefundStatus(json.refund_status || "submitted");
            setState("success");
            onCancelled(shipment.shipmentId);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Network error. Please try again.";
            setResultMessage(msg);
            setState("error");
        }
    }

    function handleClose() {
        setState("confirm");
        setResultMessage("");
        setRefundStatus("");
        onClose();
    }

    return (
        <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
            <DialogContent className="sm:max-w-md">
                {/* ── Confirm State ── */}
                {state === "confirm" && (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <AlertTriangle className="h-5 w-5 text-amber-500" />
                                Void & Cancel Label
                            </DialogTitle>
                            <DialogDescription>
                                This will permanently void this shipping label. This action cannot be undone.
                            </DialogDescription>
                        </DialogHeader>

                        {/* Shipment summary */}
                        <div className="my-2 rounded-xl border border-border bg-muted/40 p-4 space-y-2 text-sm">
                            <div className="flex items-center gap-2 mb-3">
                                <Package className="h-4 w-4 text-muted-foreground" />
                                <span className="font-semibold text-foreground">Shipment Details</span>
                            </div>
                            <div className="grid grid-cols-2 gap-y-1.5 text-muted-foreground">
                                <span>Carrier</span>
                                <span className="font-medium text-foreground">{shipment.carrier}</span>
                                <span>Tracking #</span>
                                <span className="font-mono text-xs text-foreground truncate">{shipment.trackingNumber}</span>
                                <span>Label Cost</span>
                                <span className="font-medium text-foreground">{formatMoney(shipment.rateCents)}</span>
                                <span>Created</span>
                                <span className="text-foreground">{formatDate(shipment.createdAt)}</span>
                                <span>Mode</span>
                                <span>
                                    {shipment.isTest
                                        ? <Badge variant="outline" className="text-[10px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>
                                        : <Badge variant="outline" className="text-[10px] py-0 px-1 border-green-300 text-green-700 bg-green-50">Live</Badge>
                                    }
                                </span>
                            </div>
                        </div>

                        {/* Policy note — white-labeled, no carrier branding */}
                        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 space-y-1">
                            <p className="font-medium">SendMo Refund Policy</p>
                            <ul className="list-disc list-inside space-y-1 text-blue-700">
                                <li>Labels can only be voided before the package is picked up.</li>
                                <li>Refunds are processed within 2–4 weeks after void confirmation.</li>
                                <li>Credits are applied to your SendMo account balance.</li>
                            </ul>
                        </div>

                        <DialogFooter className="mt-2 gap-2 sm:gap-0">
                            <Button variant="outline" onClick={handleClose}>
                                Keep Label
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={handleCancel}
                                className="gap-2"
                            >
                                <AlertTriangle className="h-4 w-4" />
                                Void Label
                            </Button>
                        </DialogFooter>
                    </>
                )}

                {/* ── Loading State ── */}
                {state === "loading" && (
                    <div className="py-12 flex flex-col items-center gap-4 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        <p className="text-sm font-medium">Submitting void request…</p>
                    </div>
                )}

                {/* ── Success State ── */}
                {state === "success" && (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-green-700">
                                <CheckCircle2 className="h-5 w-5" />
                                Label Voided
                            </DialogTitle>
                        </DialogHeader>
                        <div className="py-4 space-y-3">
                            <p className="text-sm text-muted-foreground">{resultMessage}</p>
                            {refundStatus && (
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="text-muted-foreground">Refund Status:</span>
                                    <Badge className={
                                        refundStatus === "refunded"
                                            ? "bg-green-500 hover:bg-green-600 border-none"
                                            : refundStatus === "submitted"
                                                ? "bg-blue-500 hover:bg-blue-600 border-none"
                                                : refundStatus === "rejected"
                                                    ? "bg-red-500 hover:bg-red-600 border-none"
                                                    : "bg-gray-400 hover:bg-gray-500 border-none"
                                    }>
                                        {refundStatus === "submitted" ? "Processing"
                                            : refundStatus === "refunded" ? "Refunded"
                                                : refundStatus === "rejected" ? "Rejected"
                                                    : refundStatus}
                                    </Badge>
                                </div>
                            )}
                        </div>
                        <DialogFooter>
                            <Button onClick={handleClose}>Done</Button>
                        </DialogFooter>
                    </>
                )}

                {/* ── Error State ── */}
                {state === "error" && (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-red-700">
                                <XCircle className="h-5 w-5" />
                                Void Request Failed
                            </DialogTitle>
                        </DialogHeader>
                        <div className="py-4">
                            <p className="text-sm text-muted-foreground">{resultMessage}</p>
                        </div>
                        <DialogFooter className="gap-2 sm:gap-0">
                            <Button variant="outline" onClick={handleClose}>Close</Button>
                            <Button onClick={() => setState("confirm")}>Try Again</Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
