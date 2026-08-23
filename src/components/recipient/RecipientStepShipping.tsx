import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import ShippingMethodCard from "./ShippingMethodCard";
import { fetchRates, pickRecommendedRate, formatCents } from "@/lib/api";
import { getTotalPriceCents, getTotalWeightOz, canFetchRates } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { ShippingRate } from "@/lib/types";

// Step 20 (slug `shipping`), label-path mode — carrier rates for a fully
// specified shipment. Extracted from RecipientStepFullShipping when the step
// maps unified (2026-08-19): the rate fetch used to live beside the parcel
// fields and re-fire per keystroke; on its own step the inputs upstream are
// frozen, so the effect fires once on entry. The debounce, the fetchRef
// stale-response guard, and the canFetchRates gate are preserved VERBATIM —
// each exists because of a specific bug (see the effect comments) and the
// 2026-08-19 amendment A2 requires them to survive the extraction.
//
// The flex-path mode of this step (speed/cap preferences when anything was
// skipped) is RecipientStepFlexPreferences, chosen by RecipientOnboarding on
// data.path — one step, two modes (§2.2 of the flow-redesign proposal).

interface Props {
  state: RecipientFlowState;
  errors: string[];
  tried: boolean;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  liveMode?: boolean;
}

export default function RecipientStepShipping({
  state, errors, tried, onUpdate, onContinue, onBack, liveMode = false,
}: Props) {
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const fetchRef = useRef(0);
  const showErrors = tried && errors.length > 0;

  // ── Stable refs to avoid re-fetch loops ───────────────────
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Rate-triggering values ────────────────────────────────
  // On this step the parcel and addresses are upstream and frozen, so these
  // change only when the user comes back after editing an earlier step —
  // which is exactly when a re-fetch is wanted. Phone is included:
  // canFetchRates() requires a usable phone on both addresses (FedEx/UPS
  // PHONENUMBEREMPTY), so a phone change flips the gate and MUST re-run the
  // effect (2026-05-20 phone-flow audit).
  const originVerified = state.originAddress.verified;
  const originStreet = state.originAddress.street;
  const originPhone = state.originAddress.phone;
  const destVerified = state.destinationAddress.verified;
  const destStreet = state.destinationAddress.street;
  const destPhone = state.destinationAddress.phone;
  const dimL = state.dimensions.length;
  const dimW = state.dimensions.width;
  const dimH = state.dimensions.height;
  const wtLbs = state.weight.lbs;
  const wtOz = state.weight.oz;
  const pkgType = state.packagingType;

  // Ref'd for the async closure, same as the pre-split component.
  const liveModeRef = useRef(liveMode);
  liveModeRef.current = liveMode;

  // ── Rate fetching ─────────────────────────────────────────
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);

    const s = stateRef.current;
    if (!canFetchRates(s)) return;
    // NO "already have rates" short-circuit. An earlier cut of this file
    // skipped the fetch when availableRates was non-empty, to avoid re-fetching
    // on Back→forward without edits. That is wrong on the money path: this step
    // UNMOUNTS when the user goes back to edit the parcel, so on return the
    // effect sees the previous fetch's rates in flow state and keeps them —
    // the user edits 10x10x10 5lb to 30x10x10 40lb and pays the small-package
    // price. Verified by tests/e2e/rate-refetch.spec.ts, which counts the
    // calls. Re-fetching on entry is one request; a stale quote is a wrong
    // charge.

    fetchDebounceRef.current = setTimeout(async () => {
      const id = ++fetchRef.current;
      setRatesLoading(true);
      setRatesError(null);

      try {
        const wt = getTotalWeightOz(s);
        const h = s.packagingType === "envelope" ? 1 : parseFloat(s.dimensions.height) || 0;

        const { rates, easypost_shipment_id } = await fetchRates(
          s.originAddress,
          s.destinationAddress,
          {
            length: parseFloat(s.dimensions.length),
            width: parseFloat(s.dimensions.width),
            height: h,
            weight: wt,
          },
          liveModeRef.current,
        );

        if (id !== fetchRef.current) return; // stale

        // Apply the AI-recommended rate when a speed hint is set; otherwise default
        // to the cheapest "best value" rate (≤5 day delivery, fall back to cheapest).
        const hint = stateRef.current.recommendedSpeedHint;
        const recommended = pickRecommendedRate(rates, hint);

        onUpdateRef.current({
          availableRates: rates,
          easypostShipmentId: easypost_shipment_id,
          selectedRate: recommended,
        });
      } catch (err) {
        if (id !== fetchRef.current) return;
        setRatesError(err instanceof Error ? err.message : "Failed to fetch rates");
        onUpdateRef.current({ availableRates: [], selectedRate: null });
      } finally {
        if (id === fetchRef.current) setRatesLoading(false);
      }
    }, 100);

    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    };
    // Only re-trigger when actual package/address values change — NOT when rates/selectedRate update
  }, [originVerified, originStreet, originPhone, destVerified, destStreet, destPhone, dimL, dimW, dimH, wtLbs, wtOz, pkgType]);

  const totalCents = getTotalPriceCents(state);

  return (
    <div className="space-y-5">

      {/* Shipping method */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Shipping method</h3>

        {ratesLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-2xl bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {ratesError && (
          <p className="text-sm text-destructive">{ratesError}</p>
        )}

        {!ratesLoading && !ratesError && state.availableRates.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {canFetchRates(state)
              ? "No rates available for this route"
              : "Fill in addresses, dimensions, and weight to see available shipping options"}
          </p>
        )}

        {!ratesLoading && state.availableRates.length > 0 && (
          <div className="space-y-2">
            {state.availableRates.map((rate: ShippingRate) => (
              <ShippingMethodCard
                key={rate.id}
                rate={rate}
                selected={state.selectedRate?.id === rate.id}
                onSelect={() => onUpdate({ selectedRate: rate, recommendedSpeedHint: null })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Validation summary */}
      <AnimatePresence>
        {showErrors && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Please fix the following:</span>
            </div>
            <ul className="text-sm text-destructive space-y-0.5 ml-6">
              {errors.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Estimated cost — always shown right above the payment button */}
      <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Estimated cost</h3>
        </div>
        {state.selectedRate ? (
          <>
            <div className="text-sm text-foreground">
              <span className="font-medium">{state.selectedRate.carrier} {state.selectedRate.service}</span>
              {state.selectedRate.estimated_days && (
                <span className="text-muted-foreground">
                  {" "}· arrives in ~{state.selectedRate.estimated_days} {state.selectedRate.estimated_days === 1 ? "day" : "days"}
                </span>
              )}
            </div>
            <div className="text-2xl font-bold text-primary mt-1">
              {formatCents(totalCents)}
              {state.insurance && (
                <span className="text-xs text-muted-foreground font-normal ml-2">includes insurance</span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Fill in addresses, dimensions, and weight to see your estimated cost.
          </p>
        )}

        {state.usedGuestimator && (
          <p className="text-[11px] text-muted-foreground mt-3 leading-snug">
            Magic Guestimator is in beta. The estimated cost shown is based on the AI's predicted package
            dimensions and weight — actual cost may differ if the carrier measures differently at the warehouse.
          </p>
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          Continue to payment
        </Button>
      </div>

      {/* Page-level T&C */}
      <p className="text-[11px] text-muted-foreground text-center leading-snug pt-1">
        By continuing you agree to SendMo's{" "}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Terms</a>
        {" "}and{" "}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Privacy Policy</a>.
        Shipping rates include carrier price plus SendMo's service fee. Final cost may be adjusted by the carrier
        if package dimensions or weight differ from what was declared.
      </p>
    </div>
  );
}
