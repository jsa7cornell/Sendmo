import { useState } from "react";
import { Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCents, buyLabel, addressToApi, BuyLabelRateChangedError } from "@/lib/api";
import { RateChangedDialog } from "@/components/RateChangedDialog";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import { getTotalPriceCents } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { LabelResult } from "@/lib/types";
import StripePaymentForm from "./StripePaymentForm";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

// Direct fetch for comp-mode label buys — bypasses Stripe entirely and
// passes the user's JWT so the labels function's admin gate accepts the
// `comp: true` claim. Avoids the shared post() helper which sends the
// anon key, which has no user identity attached.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
async function buyCompLabel(args: {
  accessToken: string;
  easypost_shipment_id: string;
  easypost_rate_id: string;
  from_address: unknown;
  to_address: unknown;
  recipient_email?: string;
  sender_email?: string;
  display_price_cents: number;
}): Promise<LabelResult> {
  const { accessToken, ...body } = args;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/labels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ ...body, live_mode: true, comp: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || `API error ${res.status}`);
  return data as LabelResult;
}

// ─── Main Component ─────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onBack: () => void;
  liveMode?: boolean;
  compMode?: boolean;
}

export default function RecipientStepPayment({ state, onUpdate, onBack, liveMode = false, compMode = false }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [compLoading, setCompLoading] = useState(false);
  const [rateChanged, setRateChanged] = useState<BuyLabelRateChangedError | null>(null);
  const { session } = useAuth();
  const navigate = useNavigate();

  const totalCents = getTotalPriceCents(state);
  const loading = state.paymentStatus === "processing";

  // Redirect to the canonical tracking page after a successful label buy.
  // Mirrors the SenderFlow pattern (SenderFlow.tsx:177-191):
  //   - ?fresh=1 flags the celebration state for TrackingPage.
  //   - ?cancel=<hex> passes the cancel_token so TrackingPage can write it
  //     to sessionStorage on first render (TrackingPage.tsx:178-185), enabling
  //     the Cancel button for the payer in the same tab.
  //   - { replace: true } so the back button doesn't return to a stale payment step.
  function redirectToTracking(result: LabelResult) {
    if (!result.public_code) return;
    const cancelSuffix = result.cancel_token ? `&cancel=${result.cancel_token}` : "";
    navigate(`/t/${result.public_code}?fresh=1${cancelSuffix}`, { replace: true });
  }

  // Called by StripePaymentForm AFTER the card has been successfully charged.
  // We pass the captured PaymentIntent id to /labels, which verifies it
  // server-side, buys the EasyPost label, and writes the payment row.
  async function handlePaymentSuccess(paymentIntentId: string) {
    if (!state.selectedRate || !state.easypostShipmentId) {
      throw new Error("Missing rate or shipment id");
    }
    setError(null);
    onUpdate({ paymentStatus: "processing" });

    try {
      const result = await buyLabel(
        state.easypostShipmentId,
        state.selectedRate.id,
        state.originAddress,
        state.destinationAddress,
        liveMode,
        {
          recipient_email: state.email || undefined,
          sender_email: state.senderEmail || undefined,
        },
        undefined,
        {
          payment_intent_id: paymentIntentId,
          display_price_cents: totalCents,
        },
        // Full-label users now reach payment step authenticated (proposal
        // 2026-05-11_account-creation-timing). Sending the JWT lets the labels
        // function stamp shipments.user_id from auth.uid() instead of the
        // system placeholder.
        session?.access_token,
        // Pass the item description from the Magic Guestimator / manual entry
        // through to the labels function so shipments.item_description gets
        // populated (was being dropped before — flex path SenderFlow.tsx:173
        // already does this correctly; the full-label call site was missing it).
        { description: state.itemDescription ?? undefined },
      );

      onUpdate({ paymentStatus: "succeeded", labelResult: result });
      redirectToTracking(result);
    } catch (err) {
      // Buy-time rate gate trip — refund issued (or attempted); render the
      // dialog so the user can either re-shop at the new price or cancel.
      // Don't surface as an inline error since the dialog is the UI for it.
      if (err instanceof BuyLabelRateChangedError) {
        setRateChanged(err);
        onUpdate({ paymentStatus: "failed" });
        return;       // do NOT re-throw — Stripe form would treat as a card error.
      }
      const msg = err instanceof Error ? err.message : "Label generation failed";
      setError(msg);
      onUpdate({ paymentStatus: "failed" });
      throw err; // Let StripePaymentForm show the error inline too
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

      {/* Comp button (admin "Live Comp" mode) OR Stripe payment form */}
      {compMode ? (
        <div className="bg-card rounded-2xl border border-amber-300 bg-amber-50/50 shadow-sm p-5 space-y-3">
          <div className="flex items-start gap-2">
            <Gift className="w-5 h-5 text-amber-700 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-amber-900">Live Comp mode</h3>
              <p className="text-xs text-amber-800 mt-1">
                EasyPost will charge SendMo for a real, printable label. The recipient is not charged.
                Recorded as <code className="bg-amber-100 px-1 rounded">payment_method = comp</code> in the admin report.
              </p>
            </div>
          </div>
          <Button
            onClick={async () => {
              if (!session?.access_token) {
                setError("Not signed in — re-authenticate to comp a label.");
                return;
              }
              if (!state.selectedRate || !state.easypostShipmentId) {
                setError("Missing rate or shipment id.");
                return;
              }
              setError(null);
              setCompLoading(true);
              onUpdate({ paymentStatus: "processing" });
              try {
                const result = await buyCompLabel({
                  accessToken: session.access_token,
                  easypost_shipment_id: state.easypostShipmentId,
                  easypost_rate_id: state.selectedRate.id,
                  from_address: addressToApi(state.originAddress),
                  to_address: addressToApi(state.destinationAddress),
                  recipient_email: state.email || undefined,
                  sender_email: state.senderEmail || undefined,
                  display_price_cents: totalCents,
                });
                onUpdate({ paymentStatus: "succeeded", labelResult: result });
                redirectToTracking(result);
              } catch (err) {
                const msg = err instanceof Error ? err.message : "Comp label failed";
                setError(msg);
                onUpdate({ paymentStatus: "failed" });
              } finally {
                setCompLoading(false);
              }
            }}
            disabled={compLoading || loading}
            className="w-full rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-medium"
          >
            {compLoading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating comp label…</>
            ) : (
              <>Generate Comp Label ({formatCents(totalCents)} value)</>
            )}
          </Button>
        </div>
      ) : (
        <StripePaymentForm
          totalCents={totalCents}
          easypostShipmentId={state.easypostShipmentId}
          liveMode={liveMode}
          receiptEmail={state.email || undefined}
          onSuccess={handlePaymentSuccess}
          accessToken={session?.access_token}
        />
      )}

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

      {/* Buy-time rate gate dialog (proposal 2026-05-23_buy-time-rate-gate) */}
      {rateChanged && (
        <RateChangedDialog
          error={rateChanged}
          onReshop={() => {
            // Back to the rate-shop step so the user sees fresh rates.
            // The previous PI is already refunded server-side; the next buy
            // creates a new one. Clear local error/state defensively.
            setRateChanged(null);
            setError(null);
            onUpdate({ paymentStatus: "idle", selectedRate: null });
            onBack();
          }}
          onCancel={() => {
            // Dismiss and leave the buyer where they are. The refund is
            // already done (or pending — copy in dialog reflects which).
            setRateChanged(null);
            onUpdate({ paymentStatus: "idle" });
          }}
        />
      )}
    </div>
  );
}
