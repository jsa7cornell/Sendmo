import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import FlexPreferencesForm from "@/components/forms/FlexPreferencesForm";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { SpeedTier } from "@/lib/types";

interface Props {
  state: RecipientFlowState;
  errors: string[];
  tried: boolean;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepFlexPreferences({
  state,
  errors,
  tried,
  onUpdate,
  onContinue,
  onBack,
}: Props) {
  return (
    <div className="space-y-5">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">How fast should it get there?</h1>
        <p className="text-muted-foreground mt-2">Just pick a speed — your sender handles the rest</p>
      </div>

      <FlexPreferencesForm
        value={{
          speed_preference: state.speed_preference as SpeedTier,
          preferred_carrier: state.preferred_carrier,
          price_cap: state.price_cap,
        }}
        onChange={(v) => onUpdate(v)}
      />

      {/* Validation errors */}
      {tried && errors.length > 0 && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3">
          <ul className="space-y-1 text-sm text-destructive">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          Continue
        </Button>
      </div>
    </div>
  );
}
