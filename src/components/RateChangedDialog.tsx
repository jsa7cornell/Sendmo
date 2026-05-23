// src/components/RateChangedDialog.tsx
//
// Renders when the labels function refuses a buy because the buy-time rate
// exceeded the quoted price (gate triggered — proposal 2026-05-23_buy-time-rate-gate).
// Used by both full-label (RecipientStepPayment) and flex (SenderFlow) flows.
//
// The dialog has two key states:
//   • Refunded successfully — happy message, "review the new rate" + "cancel".
//   • Refund failed — honest copy: "we tried, our team is on it, reference X".
// In both cases the action buttons let the user re-shop or cancel.

import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { BuyLabelRateChangedError } from "@/lib/api";

interface RateChangedDialogProps {
  error: BuyLabelRateChangedError;
  onReshop: () => void;     // re-enter the rate-shop step with a fresh quote
  onCancel: () => void;     // dismiss, navigate the user back
}

function fmt$(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function RateChangedDialog({ error, onReshop, onCancel }: RateChangedDialogProps) {
  const oldPrice = fmt$(error.quotedDisplayPriceCents);
  const newPrice = fmt$(error.newDisplayPriceCents);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="rounded-full bg-amber-100 p-2 flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-700" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">The shipping cost changed</h2>
            <p className="text-sm text-muted-foreground mt-1">
              While we were finalizing your label, the carrier's rate moved up.
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 mb-4 text-sm">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-muted-foreground">You were quoted</span>
            <span className="font-mono line-through text-muted-foreground">{oldPrice}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">New price</span>
            <span className="font-bold text-base">{newPrice}</span>
          </div>
        </div>

        {error.refunded ? (
          <p className="text-sm text-foreground mb-5">
            We've refunded your <span className="font-semibold">{oldPrice}</span> charge — Stripe usually shows refunds within a few minutes. You can continue at the new price or cancel.
          </p>
        ) : (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 mb-5">
            <p className="text-sm font-semibold text-red-800 mb-1">Refund pending</p>
            <p className="text-sm text-red-700">
              We tried to refund your <span className="font-semibold">{oldPrice}</span> charge automatically, but our payment system was slow. Our team has been alerted and will complete the refund within 24 hours.
            </p>
            {error.paymentIntentId && (
              <p className="text-xs text-red-600 mt-2 font-mono break-all">
                Reference: {error.paymentIntentId}
              </p>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} className="flex-1">
            <X className="w-4 h-4 mr-1.5" /> Cancel
          </Button>
          <Button onClick={onReshop} className="flex-1">
            <RefreshCw className="w-4 h-4 mr-1.5" /> Review new rate
          </Button>
        </div>
      </div>
    </div>
  );
}
