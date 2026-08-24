import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import StepQuestionHeader from "./StepQuestionHeader";
import SkipToSenderLink from "./SkipToSenderLink";
import DimmedWhenDeferred from "./DimmedWhenDeferred";
import ParcelQuestion from "@/components/shipment/ParcelQuestion";
import type { ParcelDraft } from "@/components/shipment/parcelDraft";
import { getTotalWeightOz } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { GuestimatorResult, SpeedTier } from "@/lib/types";

// Step 14 (slug `package`) — the parcel: what it is, how it's packed, its
// dimensions and weight. Extracted from RecipientStepFullShipping's
// mode="package" branch when the step maps unified (2026-08-19). The carrier
// choice and the rate fetch that used to sit below these fields moved to the
// Shipping step (RecipientStepShipping) — the design's Package screen shows
// no prices, so the fetch runs downstream of both halves (amendment A1 of the
// 2026-08-19 flow-redesign proposal records the behavior change: prices no
// longer live-update while dimensions are edited).

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

  // The parcel fields, their reveal behaviour and the Guestimator all live in
  // the shared <ParcelQuestion> (2026-08-24) — the sender flow asks the same
  // question and there is no reason for two of these. This maps flow state to
  // its draft shape and back.
  const draft: ParcelDraft = {
    description: state.itemDescription,
    packaging: state.packagingType,
    length: state.dimensions.length,
    width: state.dimensions.width,
    height: state.dimensions.height,
    weightLbs: state.weight.lbs,
    weightOz: state.weight.oz,
  };

  function applyDraft(patch: Partial<ParcelDraft>) {
    const next: Partial<RecipientFlowState> = {};
    if (patch.description !== undefined) next.itemDescription = patch.description;
    if (patch.packaging !== undefined) next.packagingType = patch.packaging;
    if (patch.length !== undefined || patch.width !== undefined || patch.height !== undefined) {
      next.dimensions = {
        length: patch.length ?? state.dimensions.length,
        width: patch.width ?? state.dimensions.width,
        height: patch.height ?? state.dimensions.height,
      };
    }
    if (patch.weightLbs !== undefined || patch.weightOz !== undefined) {
      next.weight = {
        lbs: patch.weightLbs ?? state.weight.lbs,
        oz: patch.weightOz ?? state.weight.oz,
      };
    }
    onUpdate(next);
  }

  function handleGuestimation(result: GuestimatorResult) {
    onUpdate({
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
      <ParcelQuestion
        value={draft}
        onChange={applyDraft}
        onGuestimated={handleGuestimation}
        showErrors={showErrors}
        invalid={{
          length: tried && !parseFloat(state.dimensions.length),
          width: tried && !parseFloat(state.dimensions.width),
          height: tried && !parseFloat(state.dimensions.height),
          weight: tried && getTotalWeightOz(state) <= 0,
        }}
      />
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
