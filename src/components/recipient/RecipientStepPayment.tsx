import { useState } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2, Download, ExternalLink, Copy, CreditCard, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, buyLabel } from "@/lib/api";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import { getTotalPriceCents } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { LabelResult } from "@/lib/types";

// ─── Mock Payment Form (Stripe stub) ───────────────────────
// TODO: Replace with <Elements> + <PaymentElement> when Stripe ships

function MockPaymentForm({
  totalCents,
  loading,
  onPay,
  liveMode = false,
}: {
  totalCents: number;
  loading: boolean;
  onPay: () => void;
  liveMode?: boolean;
}) {
  return (
    <div className={`bg-card rounded-2xl border shadow-sm p-5 ${liveMode ? "border-destructive/30" : "border-border"}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Payment</h3>
        </div>
        <Badge variant="outline" className={`text-xs ${liveMode ? "border-destructive/50 text-destructive bg-destructive/10" : "border-amber-300 text-amber-700 bg-amber-50"}`}>
          {liveMode ? "LIVE — Comp" : "Test Mode"}
        </Badge>
      </div>

      {/* Decorative card fields */}
      <div className="space-y-3 mb-4">
        <div>
          <label className="text-xs text-muted-foreground">Card number</label>
          <div className="mt-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            4242 4242 4242 4242
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Expiry</label>
            <div className="mt-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              12/29
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">CVC</label>
            <div className="mt-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              123
            </div>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground mb-4">
        {liveMode
          ? "LIVE mode — a real shipping label will be generated. No payment charged (comp)."
          : "Payment is simulated in test mode. A test label will be generated via EasyPost test mode."}
      </p>

      <Button
        onClick={onPay}
        disabled={loading}
        className="w-full rounded-xl shadow-sm text-base py-5"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Generating label…
          </>
        ) : (
          `Pay ${formatCents(totalCents)} & generate label`
        )}
      </Button>
    </div>
  );
}

// ─── Label Ready View ───────────────────────────────────────

function LabelReady({
  labelResult,
  state,
}: {
  labelResult: LabelResult;
  state: RecipientFlowState;
}) {
  const [copied, setCopied] = useState(false);
  const shortLink = `sendmo.co/s/${labelResult.sendmo_id || "test"}`;

  function handleCopy() {
    navigator.clipboard.writeText(`https://${shortLink}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-5">
      {/* Success banner */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-success/10 border border-success/30 rounded-2xl p-5 text-center"
      >
        <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-2" />
        <h2 className="text-xl font-bold text-foreground">Your shipping label and link are ready</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Tracking: {labelResult.tracking_number}
        </p>
      </motion.div>

      {/* View/Download label */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Shipping Label</h3>
        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 rounded-xl gap-2"
            onClick={() => window.open(labelResult.label_url, "_blank")}
          >
            <ExternalLink className="w-4 h-4" />
            View Label
          </Button>
          <Button
            className="flex-1 rounded-xl gap-2"
            onClick={() => {
              const a = document.createElement("a");
              a.href = labelResult.label_url;
              a.download = `sendmo-label-${labelResult.tracking_number}.pdf`;
              a.click();
            }}
          >
            <Download className="w-4 h-4" />
            Download PDF
          </Button>
        </div>
      </div>

      {/* Share link */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Share Link</h3>
        <div className="flex items-center gap-2 bg-muted/50 rounded-xl px-3 py-2.5">
          <span className="text-sm text-foreground font-mono flex-1 truncate">{shortLink}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="rounded-lg gap-1.5 shrink-0"
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>

      {/* Shipment summary */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Shipment Details</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">To</dt>
            <dd className="font-medium text-foreground">
              {state.destinationAddress.city}, {state.destinationAddress.state}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">From</dt>
            <dd className="font-medium text-foreground">
              {state.originAddress.city}, {state.originAddress.state}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Carrier</dt>
            <dd className="font-medium text-foreground">
              {carrierDisplayName(labelResult.carrier)} — {serviceDisplayName(labelResult.service)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Total</dt>
            <dd className="font-bold text-primary text-lg">
              {formatCents(getTotalPriceCents(state))}
            </dd>
          </div>
        </dl>
      </div>

      {/* CTA */}
      <Button
        variant="outline"
        className="w-full rounded-xl"
        onClick={() => window.location.href = "/dashboard"}
      >
        Go to your account page
      </Button>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onBack: () => void;
  liveMode?: boolean;
}

export default function RecipientStepPayment({ state, onUpdate, onBack, liveMode = false }: Props) {
  const [error, setError] = useState<string | null>(null);

  // If label already generated, show the ready state
  if (state.labelResult) {
    return <LabelReady labelResult={state.labelResult} state={state} />;
  }

  const totalCents = getTotalPriceCents(state);
  const loading = state.paymentStatus === "processing";

  async function handlePay() {
    if (!state.selectedRate || !state.easypostShipmentId) return;

    setError(null);
    onUpdate({ paymentStatus: "processing" });

    try {
      // Simulate payment delay (Stripe stub)
      await new Promise((r) => setTimeout(r, 1500));

      // Call real EasyPost label API (test or live depending on admin mode)
      const result = await buyLabel(
        state.easypostShipmentId,
        state.selectedRate.id,
        state.originAddress,
        state.destinationAddress,
        liveMode,
      );

      onUpdate({
        paymentStatus: "succeeded",
        labelResult: result,
        // Advance to step 12 visually handled by labelResult check
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Label generation failed");
      onUpdate({ paymentStatus: "failed" });
    }
  }

  return (
    <div className="space-y-5">
      {/* Shipment summary */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Shipment Summary</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">To</dt>
            <dd className="font-medium">
              {state.destinationAddress.city}, {state.destinationAddress.state}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">From</dt>
            <dd className="font-medium">
              {state.originAddress.city}, {state.originAddress.state}
            </dd>
          </div>
          {state.selectedRate && (
            <>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Service</dt>
                <dd className="font-medium">
                  {carrierDisplayName(state.selectedRate.carrier)} — {serviceDisplayName(state.selectedRate.service)}
                </dd>
              </div>
              {state.selectedRate.estimated_days && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Est. delivery</dt>
                  <dd className="font-medium">{state.selectedRate.estimated_days} days</dd>
                </div>
              )}
            </>
          )}
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Package</dt>
            <dd className="font-medium">
              {state.dimensions.length}×{state.dimensions.width}
              {state.packagingType !== "envelope" ? `×${state.dimensions.height}` : ""} in,{" "}
              {state.weight.lbs || 0} lbs {state.weight.oz || 0} oz
            </dd>
          </div>
          {state.insurance && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Insurance</dt>
              <dd className="font-medium text-success">Included ($2.50)</dd>
            </div>
          )}
          <div className="border-t border-border pt-2 mt-2 flex justify-between">
            <dt className="font-semibold text-foreground">Total</dt>
            <dd className="text-2xl font-bold text-primary">{formatCents(totalCents)}</dd>
          </div>
        </dl>
      </div>

      {/* Mock payment form */}
      <MockPaymentForm
        totalCents={totalCents}
        loading={loading}
        onPay={handlePay}
        liveMode={liveMode}
      />

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Back button */}
      {!loading && (
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
      )}
    </div>
  );
}
