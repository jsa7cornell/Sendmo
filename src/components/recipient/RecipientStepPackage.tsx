import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MagicGuestimator from "./MagicGuestimator";
import StepQuestionHeader from "./StepQuestionHeader";
import SkipToSenderLink from "./SkipToSenderLink";
import DimmedWhenDeferred from "./DimmedWhenDeferred";
import { cn } from "@/lib/utils";
import { getTotalWeightOz } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { GuestimatorResult, PackagingType, SpeedTier } from "@/lib/types";

// Step 14 (slug `package`) — the parcel: what it is, how it's packed, its
// dimensions and weight. Extracted from RecipientStepFullShipping's
// mode="package" branch when the step maps unified (2026-08-19). The carrier
// choice and the rate fetch that used to sit below these fields moved to the
// Shipping step (RecipientStepShipping) — the design's Package screen shows
// no prices, so the fetch runs downstream of both halves (amendment A1 of the
// 2026-08-19 flow-redesign proposal records the behavior change: prices no
// longer live-update while dimensions are edited).

const PACKAGING_OPTIONS: { id: PackagingType; label: string; desc: string }[] = [
  { id: "box", label: "Box / Rigid", desc: "Standard cardboard box" },
  { id: "envelope", label: "Envelope / Soft Pack", desc: "Padded mailer or poly bag" },
  { id: "tube", label: "Tube / Irregular", desc: "Cylindrical or odd shape" },
];

interface Props {
  state: RecipientFlowState;
  errors: string[];
  tried: boolean;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  /** "Sender fills this in" — defers the parcel to the sender. */
  onNoAddress: () => void;
  onKeepIt: () => void;
}

export default function RecipientStepPackage({
  state, errors, tried, onUpdate, onContinue, onBack, onNoAddress, onKeepIt,
}: Props) {
  const showErrors = tried && errors.length > 0;

  // The parcel fields start collapsed behind "or fill in manually" — describing
  // the item is the intended path, and four cards of dimensions in front of
  // someone who was going to type "a hardcover cookbook" is the wrong first
  // impression.
  //
  // They are NOT collapsible once there is something to see. Any parcel value
  // present (the guestimator just filled them, or the user is returning to a
  // filled step) reveals them, so an auto-filled estimate is always visible and
  // correctable rather than hidden behind a link. `showErrors` reveals them
  // too: a validation summary naming Length and Width must never point at
  // fields the user cannot see.
  const [manualOpen, setManualOpen] = useState(false);
  const hasParcelValues = !!(
    state.dimensions.length || state.dimensions.width || state.dimensions.height ||
    state.weight.lbs || state.weight.oz || state.itemDescription
  );
  const showParcelFields = manualOpen || hasParcelValues || showErrors;

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
      recommendedSpeedHint: (result.speedHint ?? null) as SpeedTier | null,
      // Persisted (not component-local) so the Shipping step downstream can
      // show the beta disclaimer beside the price these values produce.
      usedGuestimator: true,
    });
  }

  return (
    <div className="space-y-5">

      {/* The question, asked once, with its one action beside it. The
          sender='self' gate that used to hide this went with the rest of the
          unreachable 'self' branches (2026-08-23 review finding 1). */}
      <StepQuestionHeader
        question="What's being shipped?"
        action={
          <SkipToSenderLink
            deferred={state.deferredPackage}
            onDefer={onNoAddress}
            onUndo={onKeepIt}
          />
        }
      />

      <DimmedWhenDeferred deferred={state.deferredPackage}>
      <div className="space-y-5">
      {/* Describe it and we size it — the intended path. */}
      <MagicGuestimator
        onResult={handleGuestimation}
        title="Describe the product"
        subtitle={null}
        placeholder="e.g., a hardcover cookbook"
        icon={false}
        action={showParcelFields ? undefined : (
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="text-sm font-medium text-foreground underline underline-offset-4 rounded px-1 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            or fill in manually
          </button>
        )}
      />

      {showParcelFields && (
      <>
      {/* ONE card, not four (2026-08-23). Description, packaging, dimensions
          and weight are all the same question — "what is the parcel" — and
          four stacked cards made them read as four separate decisions. The
          per-heading sparkles went too: they marked "the Guestimator fills
          this", which was true of three of the four headings and therefore
          told the user nothing. The Guestimator card above says it once. */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-5">
        <div>
          <label htmlFor="item-desc" className="text-sm font-semibold text-foreground">
            Item description <span className="text-muted-foreground font-normal">(optional — for the shipping label)</span>
          </label>
          <Input
            id="item-desc"
            value={state.itemDescription}
            onChange={(e) => onUpdate({ itemDescription: e.target.value })}
            placeholder="e.g., Hardcover cookbook"
            className="mt-1.5 rounded-xl"
          />
        </div>

        <div className="border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Packaging type</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
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
                    "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0",
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

        <div className="border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Dimensions <span className="text-muted-foreground font-normal">(inches)</span></h3>
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

        <div className="border-t border-border pt-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Weight</h3>
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
      </div>
      </>
      )}

      </div>
      </DimmedWhenDeferred>

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
          Continue
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
