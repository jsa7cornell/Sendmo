import { useState } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, AlertCircle } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "cancel" | "change";
  /** True when the shipment had a captured PaymentIntent. False for comp shipments. */
  paid: boolean;
  /** Refund amount in cents. Null when paid=false or amount unknown (comp path). */
  amountPaidCents: number | null;
  /** Fired when the user confirms; should perform the actual cancel call.
   *  Component sets submitting state around the await. */
  onConfirm: () => Promise<void>;
  /** Error message from a prior cancel attempt. When set, renders inline
   *  inside the modal and the primary CTA switches to "Try again." Surfaces
   *  carrier rejections (UPS/USPS refused the void) without dismissing the
   *  modal — the user sees the result in the same place they took the action. */
  errorMessage?: string | null;
}

function formatRefundCopy(paid: boolean, amountPaidCents: number | null): string {
  if (!paid) return "Any payment made for this label will be refunded to the original purchase method.";
  if (amountPaidCents != null) {
    const dollars = (amountPaidCents / 100).toFixed(2);
    return `We'll refund $${dollars} to the card on file. Refunds usually appear within a few minutes to a few days.`;
  }
  return "We'll refund the charge to the card on file. Refunds usually appear within a few minutes to a few days.";
}

// Confirm dialog for Cancel + Change actions on /t/<public_code>.
// Pure presenter — the actual cancel call lives in TrackingPage (which holds
// the cancel token + access token + reason context).
//
// Decided proposal: 2026-05-11_label-cancel-and-change_decided-2026-05-12.
export default function CancelLabelDialog({
  open, onOpenChange, mode, paid, amountPaidCents, onConfirm, errorMessage,
}: Props) {
  const [submitting, setSubmitting] = useState(false);

  const title = mode === "cancel" ? "Cancel this label?" : "Change package details?";
  const refundLine = formatRefundCopy(paid, amountPaidCents);
  const tail = mode === "cancel"
    ? "This can't be undone."
    : "We'll take you back to the start so you can ship again. This can't be undone.";
  const description = `${refundLine} ${tail}`;

  const hasError = !!errorMessage;
  const confirmLabel = hasError
    ? "Try again"
    : (mode === "cancel" ? "Yes, cancel" : "Yes, start over");

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {hasError && (
          <div className="bg-destructive/5 border border-destructive/30 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-xs">
              <p className="font-semibold text-foreground">Couldn't cancel this label</p>
              <p className="text-muted-foreground mt-0.5">{errorMessage}</p>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {hasError ? "Close" : "Keep label"}
          </Button>
          <Button
            variant={mode === "cancel" ? "destructive" : "default"}
            disabled={submitting}
            onClick={handleConfirm}
          >
            {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
