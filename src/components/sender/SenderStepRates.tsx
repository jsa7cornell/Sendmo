import { Button } from "@/components/ui/button";
import { Loader2, AlertCircle, Package, ArrowLeft, ArrowRight } from "lucide-react";
import type { LinkData } from "@/lib/api";
import type { ShippingRate } from "@/lib/types";
import { isPreferredRate, sortRatesForSender, priceTierSymbol } from "./senderState";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";

interface Props {
  linkData: LinkData;
  rates: ShippingRate[];
  loading: boolean;
  error: string | null;
  selectedRate: ShippingRate | null;
  onSelectRate: (r: ShippingRate) => void;
  onContinue: () => void;
  onBack: () => void;
  onRetry: () => void;
  usedGuestimator?: boolean;
}

// SPEC §8 Step 2. NO prices visible — recipient pays. "Preferred by {name}"
// badge marks rates whose service tier matches the link's preferred_speed.
export default function SenderStepRates({
  linkData, rates, loading, error, selectedRate, onSelectRate, onContinue, onBack, onRetry, usedGuestimator,
}: Props) {
  if (loading) {
    return (
      <div className="text-center py-16 space-y-3">
        <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
        <p className="text-foreground font-medium">Finding shipping options…</p>
        <p className="text-sm text-muted-foreground">Checking rates from available carriers</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-2">Rates are playing hide and seek</h2>
          <p className="text-sm text-muted-foreground mb-4">We couldn't reach the shipping carriers right now. It's probably them, not you.</p>
          <div className="flex gap-3 justify-center">
            <Button variant="outline" onClick={onBack} className="rounded-xl">
              <ArrowLeft className="w-4 h-4 mr-1" /> Edit details
            </Button>
            <Button onClick={onRetry} className="rounded-xl">Try again</Button>
          </div>
        </div>
      </div>
    );
  }

  if (rates.length === 0) {
    return (
      <div className="space-y-5">
        <div className="bg-muted rounded-2xl p-6 text-center">
          <Package className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-2">No options for this one</h2>
          <p className="text-sm text-muted-foreground mb-3">
            The recipient's preferences are a little too picky for this package. Try adjusting the size or weight.
          </p>
          <Button variant="outline" onClick={onBack} className="rounded-xl mt-2">
            <ArrowLeft className="w-4 h-4 mr-1" /> Edit package details
          </Button>
        </div>
      </div>
    );
  }

  const recipient = linkData.recipient_name?.trim() || "the recipient";

  return (
    <div className="space-y-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Choose a shipping option</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Prepaid by {recipient}. Pick the speed that works best.
        </p>
      </div>

      {usedGuestimator && (
        <p className="text-[11px] text-muted-foreground leading-snug rounded-xl bg-muted/40 border border-border px-3 py-2">
          Magic Guestimator is in beta. Shipping options shown are based on the AI's predicted package
          dimensions and weight — the carrier may adjust if measurements differ at the warehouse.
        </p>
      )}

      <div className="space-y-3">
        {sortRatesForSender(rates, linkData).map((rate) => {
          const isSelected = selectedRate?.id === rate.id;
          const preferred = isPreferredRate(rate, linkData);
          const tier = priceTierSymbol(rate.display_price_cents);
          return (
            <button
              key={rate.id}
              type="button"
              onClick={() => onSelectRate(rate)}
              className={
                "w-full text-left rounded-2xl border-2 p-4 transition-all " +
                (isSelected
                  ? "border-primary bg-primary/5 shadow-sm"
                  : "border-border bg-card hover:border-muted-foreground/30")
              }
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-foreground">
                      {carrierDisplayName(rate.carrier)} {serviceDisplayName(rate.service)}
                    </p>
                    {preferred && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary whitespace-nowrap">
                        Preferred by {recipient}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {rate.estimated_days
                      ? `${rate.estimated_days} business day${rate.estimated_days > 1 ? "s" : ""}`
                      : "Estimated delivery TBD"}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span
                    className="font-mono text-sm text-muted-foreground tabular-nums"
                    aria-label={`Cost tier ${tier.length} of 10`}
                    title="Relative cost (recipient pays)"
                  >
                    {tier}
                  </span>
                  <div className={"w-5 h-5 rounded-full border-2 " + (isSelected ? "border-primary" : "border-border")}>
                    {isSelected && <div className="w-full h-full rounded-full bg-primary scale-50" />}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <Button onClick={onContinue} disabled={!selectedRate} className="flex-1 rounded-xl shadow-sm">
          Continue
          <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
