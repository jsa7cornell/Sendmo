import { useState, useEffect } from "react";
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
import { DollarSign, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { processRefund } from "@/lib/refundService";
import type { RefundRequest } from "@/lib/refundService";

export interface RefundTarget {
    shipmentId: string;           // Supabase UUID
    chargeTransactionId: string;  // UUID of the type='charge' transactions row
    collectedCents: number;       // Gross charge amount (for display / prefill cap)
    isTest: boolean;
    shipmentPublicId: string;     // SM-XXXX display ID
}

interface RefundModalProps {
    open: boolean;
    onClose: () => void;
    target: RefundTarget;
    onRefunded: (shipmentId: string, expectedBalance: number) => void;
}

type ModalState = "form" | "loading" | "success" | "error";

type ReasonValue = RefundRequest["reason"];

const REASON_LABELS: Record<ReasonValue, string> = {
    requested_by_customer: "Requested by customer",
    duplicate: "Duplicate charge",
    fraudulent: "Fraudulent",
    admin_override: "Admin override / goodwill",
};

function formatMoney(cents: number) {
    return "$" + (cents / 100).toFixed(2);
}

export default function RefundModal({
    open,
    onClose,
    target,
    onRefunded,
}: RefundModalProps) {
    const [state, setState] = useState<ModalState>("form");
    const [amountInput, setAmountInput] = useState("");
    const [reason, setReason] = useState<ReasonValue>("requested_by_customer");
    const [resultMessage, setResultMessage] = useState("");
    const [refundedAmountCents, setRefundedAmountCents] = useState(0);
    const [validationError, setValidationError] = useState<string | null>(null);

    // Pre-fill amount to the full collected amount on open.
    // In a full implementation this would fetch the remaining balance from the
    // server; for now we use collected_cents as the cap (the endpoint enforces
    // the actual remaining balance).
    useEffect(() => {
        if (open) {
            setAmountInput((target.collectedCents / 100).toFixed(2));
            setReason("requested_by_customer");
            setValidationError(null);
            setState("form");
            setResultMessage("");
        }
    }, [open, target.collectedCents]);

    function handleClose() {
        if (state === "loading") return; // Don't close while in flight.
        setState("form");
        setResultMessage("");
        setValidationError(null);
        onClose();
    }

    async function handleSubmit() {
        setValidationError(null);
        const parsed = parseFloat(amountInput);
        if (isNaN(parsed) || parsed <= 0) {
            setValidationError("Enter a valid positive dollar amount.");
            return;
        }
        const amountCents = Math.round(parsed * 100);
        if (amountCents > target.collectedCents) {
            setValidationError(`Cannot exceed $${(target.collectedCents / 100).toFixed(2)} (amount collected).`);
            return;
        }

        setState("loading");

        const result = await processRefund({
            shipmentId: target.shipmentId,
            chargeTransactionId: target.chargeTransactionId,
            amountCents,
            reason,
        });

        if (!result.success) {
            setResultMessage(result.error || "Refund failed. Please try again.");
            setState("error");
            return;
        }

        setRefundedAmountCents(result.amount_cents ?? amountCents);
        setResultMessage(
            `Refund of ${formatMoney(result.amount_cents ?? amountCents)} initiated. ` +
            `The charge.refunded webhook will land the ledger row within seconds.`
        );
        setState("success");
        onRefunded(target.shipmentId, result.expected_post_refund_balance ?? 0);
    }

    return (
        <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
            <DialogContent className="sm:max-w-md">
                {/* ── Form State ── */}
                {state === "form" && (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <DollarSign className="h-5 w-5 text-blue-500" />
                                Issue Refund
                            </DialogTitle>
                            <DialogDescription>
                                Initiate a Stripe refund for shipment <span className="font-mono">{target.shipmentPublicId}</span>.
                                The ledger row lands when the <code>charge.refunded</code> webhook fires.
                            </DialogDescription>
                        </DialogHeader>

                        <div className="my-2 rounded-xl border border-border bg-muted/40 p-4 space-y-4 text-sm">
                            {/* Amount */}
                            <div>
                                <label htmlFor="refund-amount" className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                                    Amount (USD)
                                </label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                                    <input
                                        id="refund-amount"
                                        type="number"
                                        min="0.01"
                                        step="0.01"
                                        max={(target.collectedCents / 100).toFixed(2)}
                                        value={amountInput}
                                        onChange={(e) => {
                                            setAmountInput(e.target.value);
                                            setValidationError(null);
                                        }}
                                        className="w-full pl-7 pr-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                    />
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Max: {formatMoney(target.collectedCents)} collected.
                                    Partial refunds allowed — the endpoint enforces the actual remaining balance.
                                </p>
                            </div>

                            {/* Reason */}
                            <div>
                                <label htmlFor="refund-reason" className="block text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                                    Reason
                                </label>
                                <select
                                    id="refund-reason"
                                    value={reason}
                                    onChange={(e) => setReason(e.target.value as ReasonValue)}
                                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                >
                                    {(Object.entries(REASON_LABELS) as [ReasonValue, string][]).map(([val, label]) => (
                                        <option key={val} value={val}>{label}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Mode badge */}
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Mode:</span>
                                {target.isTest
                                    ? <Badge variant="outline" className="text-[10px] py-0 px-1 border-amber-300 text-amber-700 bg-amber-50">Test</Badge>
                                    : <Badge variant="outline" className="text-[10px] py-0 px-1 border-green-300 text-green-700 bg-green-50">Live</Badge>
                                }
                            </div>
                        </div>

                        {validationError && (
                            <p className="text-sm text-red-600 -mt-2">{validationError}</p>
                        )}

                        <DialogFooter className="mt-2 gap-2 sm:gap-0">
                            <Button variant="outline" onClick={handleClose}>
                                Cancel
                            </Button>
                            <Button
                                onClick={handleSubmit}
                                className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
                            >
                                <DollarSign className="h-4 w-4" />
                                Confirm Refund
                            </Button>
                        </DialogFooter>
                    </>
                )}

                {/* ── Loading State ── */}
                {state === "loading" && (
                    <div className="py-12 flex flex-col items-center gap-4 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        <p className="text-sm font-medium">Initiating refund with Stripe…</p>
                    </div>
                )}

                {/* ── Success State ── */}
                {state === "success" && (
                    <>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-green-700">
                                <CheckCircle2 className="h-5 w-5" />
                                Refund Initiated
                            </DialogTitle>
                        </DialogHeader>
                        <div className="py-4 space-y-3">
                            <p className="text-sm text-muted-foreground">{resultMessage}</p>
                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">Refunded:</span>
                                <span className="font-semibold text-green-700">{formatMoney(refundedAmountCents)}</span>
                            </div>
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
                                Refund Failed
                            </DialogTitle>
                        </DialogHeader>
                        <div className="py-4">
                            <p className="text-sm text-muted-foreground">{resultMessage}</p>
                        </div>
                        <DialogFooter className="gap-2 sm:gap-0">
                            <Button variant="outline" onClick={handleClose}>Close</Button>
                            <Button onClick={() => setState("form")}>Try Again</Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
