import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import ShippingMethodCard from "@/components/recipient/ShippingMethodCard";
import { fetchRates, isOverCap } from "@/lib/api";
import { classifySpeedTier } from "@/lib/utils";
import type { SenderFlowState } from "@/hooks/useSenderFlow";
import { getSenderWeightOz } from "@/hooks/useSenderFlow";
import type { SpeedTier } from "@/lib/types";

interface Props {
  state: SenderFlowState;
  onUpdate: (partial: Partial<SenderFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function SenderStepShipping({ state, onUpdate, onContinue, onBack }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const recipientName = state.link?.recipient_name || "the recipient";
  const preferredSpeed = (state.link?.preferred_speed as SpeedTier) || null;
  const maxPriceCents = state.link?.max_price_cents || 10000;

  useEffect(() => {
    if (fetchedRef.current || !state.recipientAddress) return;
    fetchedRef.current = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const weightOz = getSenderWeightOz(state);
        const height = state.packagingType === "envelope" ? 1 : parseFloat(state.dimensions.height) || 1;
        const result = await fetchRates(state.fromAddress, state.recipientAddress!, {
          length: parseFloat(state.dimensions.length) || 1,
          width: parseFloat(state.dimensions.width) || 1,
          height,
          weight: weightOz,
        });

        onUpdate({
          availableRates: result.rates,
          easypostShipmentId: result.easypost_shipment_id,
        });

        // Auto-select: preferred speed first, then first under cap
        if (result.rates.length > 0 && !state.selectedRate) {
          const capDollars = maxPriceCents / 100;
          const preferred = preferredSpeed
            ? result.rates.find(
                (r) => classifySpeedTier(r.service) === preferredSpeed && !isOverCap(r.display_price_cents, capDollars),
              )
            : null;
          const fallback = result.rates.find((r) => !isOverCap(r.display_price_cents, capDollars)) || result.rates[0];
          onUpdate({ selectedRate: preferred || fallback });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load shipping rates");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleRetry() {
    fetchedRef.current = false;
    setLoading(true);
    setError(null);
  }

  const capDollars = maxPriceCents / 100;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Choose a shipping method</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Paid by <span className="font-medium text-foreground">{recipientName}</span>
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Fetching shipping rates...</p>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-card rounded-2xl border border-destructive/50 p-5 text-center space-y-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" onClick={handleRetry} className="rounded-xl">
            Try Again
          </Button>
        </div>
      )}

      {/* Rate cards — PRD says "No pricing shown" but ShippingMethodCard always shows price.
          Per PRD: sender sees delivery estimate + carrier but the cost badge says "Paid by [name]".
          We still show the price since it's visible on the card — the PRD note means "no payment from sender". */}
      {!loading && !error && state.availableRates.length > 0 && (
        <div className="space-y-2">
          {state.availableRates.map((rate) => {
            const overCap = isOverCap(rate.display_price_cents, capDollars);
            const isPreferred = preferredSpeed && classifySpeedTier(rate.service) === preferredSpeed;

            return (
              <div key={rate.id} className="relative">
                {isPreferred && !overCap && (
                  <span className="absolute -top-2 right-3 z-10 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    Preferred by {recipientName}
                  </span>
                )}
                <ShippingMethodCard
                  rate={rate}
                  selected={state.selectedRate?.id === rate.id}
                  disabled={overCap}
                  disabledReason={overCap ? "Exceeds price limit" : undefined}
                  onSelect={() => onUpdate({ selectedRate: rate })}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* No rates */}
      {!loading && !error && state.availableRates.length === 0 && (
        <div className="bg-card rounded-2xl border border-border p-5 text-center">
          <p className="text-sm text-muted-foreground">
            No shipping methods available for this package. Try adjusting the package dimensions or weight.
          </p>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button
          onClick={onContinue}
          disabled={!state.selectedRate}
          className="flex-1 rounded-xl shadow-sm"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
