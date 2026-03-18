import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import PriceSummaryCard from "./PriceSummaryCard";
import ShippingMethodCard from "./ShippingMethodCard";
import MagicGuestimator from "./MagicGuestimator";
import { fetchRates, isOverCap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getTotalPriceCents, getTotalWeightOz, canFetchRates } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { AddressInput, GuestimatorResult, PackagingType, ShippingRate } from "@/lib/types";

// ─── Packaging Options ──────────────────────────────────────

const PACKAGING_OPTIONS: { id: PackagingType; label: string; desc: string }[] = [
  { id: "box", label: "Box / Rigid", desc: "Standard cardboard box" },
  { id: "envelope", label: "Envelope / Soft Pack", desc: "Padded mailer or poly bag" },
  { id: "tube", label: "Tube / Irregular", desc: "Cylindrical or odd shape" },
];

// ─── Props ──────────────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  errors: string[];
  tried: boolean;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  liveMode?: boolean;
}

export default function RecipientStepFullShipping({
  state, errors, tried, onUpdate, onContinue, onBack, liveMode = false,
}: Props) {
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const fetchRef = useRef(0);
  const showErrors = tried && errors.length > 0;

  // ── Stable ref for onUpdate to avoid re-fetch loops ───────
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveModeRef = useRef(liveMode);
  liveModeRef.current = liveMode;

  // ── Rate-triggering values (only these should cause a re-fetch) ──
  const originVerified = state.originAddress.verified;
  const originStreet = state.originAddress.street;
  const destVerified = state.destinationAddress.verified;
  const destStreet = state.destinationAddress.street;
  const dimL = state.dimensions.length;
  const dimW = state.dimensions.width;
  const dimH = state.dimensions.height;
  const wtLbs = state.weight.lbs;
  const wtOz = state.weight.oz;
  const pkgType = state.packagingType;

  // ── Rate fetching with debounce ───────────────────────────
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);

    const s = stateRef.current;
    if (!canFetchRates(s)) return;

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

        onUpdateRef.current({
          availableRates: rates,
          easypostShipmentId: easypost_shipment_id,
          selectedRate: rates.length > 0 ? rates[0] : null,
        });
      } catch (err) {
        if (id !== fetchRef.current) return;
        setRatesError(err instanceof Error ? err.message : "Failed to fetch rates");
        onUpdateRef.current({ availableRates: [], selectedRate: null });
      } finally {
        if (id === fetchRef.current) setRatesLoading(false);
      }
    }, 600);

    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    };
    // Only re-trigger when actual package/address values change — NOT when rates/selectedRate update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originVerified, originStreet, destVerified, destStreet, dimL, dimW, dimH, wtLbs, wtOz, pkgType]);

  // ── Guestimator handler ───────────────────────────────────

  function handleGuestimation(result: GuestimatorResult) {
    onUpdate({
      packagingType: result.packaging,
      dimensions: {
        length: String(result.length),
        width: String(result.width),
        height: String(result.height),
      },
      weight: {
        lbs: String(Math.floor(result.weightLbs)),
        oz: String(Math.round((result.weightLbs % 1) * 16)),
      },
      itemDescription: result.itemName,
    });
  }

  // ── Helpers ───────────────────────────────────────────────

  const cityState = state.destinationAddress.verified
    ? `${state.destinationAddress.city}, ${state.destinationAddress.state}`
    : "";

  const totalCents = getTotalPriceCents(state);
  const estimatedDays = state.selectedRate?.estimated_days ?? null;

  return (
    <div className="space-y-5">
      {/* Sticky price card */}
      <PriceSummaryCard
        cityState={cityState}
        priceCents={state.selectedRate ? totalCents : null}
        estimatedDays={estimatedDays}
      />

      {/* Ship From */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Ship from (sender's address)</h3>
        <SmartAddressInput
          label="origin"
          value={state.originAddress}
          onChange={(addr: AddressInput) => onUpdate({ originAddress: addr })}
          error={tried && !state.originAddress.verified ? "Sender address is required" : undefined}
        />
      </div>

      {/* Magic Guestimator */}
      <MagicGuestimator onResult={handleGuestimation} />

      {/* Item description */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <label htmlFor="item-desc" className="text-sm font-medium text-foreground">
          Item description <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <Input
          id="item-desc"
          value={state.itemDescription}
          onChange={(e) => onUpdate({ itemDescription: e.target.value })}
          placeholder="e.g., Used laptop, pair of running shoes"
          className="mt-1.5 rounded-xl"
        />
      </div>

      {/* Packaging type */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Packaging type</h3>
        <div className="grid grid-cols-3 gap-2">
          {PACKAGING_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onUpdate({ packagingType: opt.id })}
              className={cn(
                "rounded-xl border p-3 text-left transition-all",
                state.packagingType === opt.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30",
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={cn(
                  "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center",
                  state.packagingType === opt.id ? "border-primary" : "border-muted-foreground/40",
                )}>
                  {state.packagingType === opt.id && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
                </div>
                <span className="text-sm font-medium text-foreground">{opt.label}</span>
              </div>
              <p className="text-xs text-muted-foreground ml-5.5">{opt.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Dimensions */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Package dimensions (inches)</h3>
        <div className={cn("grid gap-3", state.packagingType === "envelope" ? "grid-cols-2" : "grid-cols-3")}>
          <div>
            <label className="text-xs text-muted-foreground">Length</label>
            <Input
              inputMode="numeric"
              value={state.dimensions.length}
              onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, length: e.target.value } })}
              placeholder="L"
              className={cn("mt-1 rounded-xl", tried && !parseFloat(state.dimensions.length) && "border-destructive")}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Width</label>
            <Input
              inputMode="numeric"
              value={state.dimensions.width}
              onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, width: e.target.value } })}
              placeholder="W"
              className={cn("mt-1 rounded-xl", tried && !parseFloat(state.dimensions.width) && "border-destructive")}
            />
          </div>
          {state.packagingType !== "envelope" && (
            <div>
              <label className="text-xs text-muted-foreground">Height</label>
              <Input
                inputMode="numeric"
                value={state.dimensions.height}
                onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, height: e.target.value } })}
                placeholder="H"
                className={cn("mt-1 rounded-xl", tried && !parseFloat(state.dimensions.height) && "border-destructive")}
              />
            </div>
          )}
        </div>
      </div>

      {/* Weight */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Package weight</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Pounds</label>
            <Input
              inputMode="numeric"
              value={state.weight.lbs}
              onChange={(e) => onUpdate({ weight: { ...state.weight, lbs: e.target.value } })}
              placeholder="lbs"
              className={cn("mt-1 rounded-xl", tried && getTotalWeightOz(state) <= 0 && "border-destructive")}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Ounces</label>
            <Input
              inputMode="numeric"
              value={state.weight.oz}
              onChange={(e) => onUpdate({ weight: { ...state.weight, oz: e.target.value } })}
              placeholder="oz"
              className="mt-1 rounded-xl"
            />
          </div>
        </div>
      </div>

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
            {state.availableRates.map((rate: ShippingRate) => {
              const overCap = isOverCap(rate.display_price_cents);
              return (
                <ShippingMethodCard
                  key={rate.id}
                  rate={rate}
                  selected={state.selectedRate?.id === rate.id}
                  disabled={overCap}
                  disabledReason={overCap ? "Exceeds price cap" : undefined}
                  onSelect={() => onUpdate({ selectedRate: rate })}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Insurance */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Add shipping insurance</h3>
            <p className="text-xs text-muted-foreground mt-0.5">+$2.50 — covers up to $100 in damage or loss</p>
          </div>
          <Switch
            checked={state.insurance}
            onCheckedChange={(checked: boolean) => onUpdate({ insurance: checked })}
          />
        </div>
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

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          Continue to payment
        </Button>
      </div>
    </div>
  );
}
