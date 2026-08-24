import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
// The recipient flow's question heading, reused rather than re-cut — both
// flows now ask one question per step and they should look identical doing it.
import StepQuestionHeader from "@/components/recipient/StepQuestionHeader";
import { isUsablePhone } from "@/lib/phone";
import type { AddressInput } from "@/lib/types";

interface Props {
  value: AddressInput;
  onChange: (a: AddressInput) => void;
  tried: boolean;
  onContinue: () => void;
  onBack?: () => void;
  /** "Continue" on an ordinary pass, "Save" when re-opened from the summary. */
  continueLabel: string;
}

export function destinationErrors(a: AddressInput): string[] {
  const errs: string[] = [];
  if (!a.street || !a.city || !a.state || !a.zip) errs.push("A complete delivery address");
  if (!isUsablePhone(a.phone)) errs.push("A phone number — the carriers require one");
  return errs;
}

// The one question a destination-deferred link exists to ask. Previously it
// was a card buried at the top of a screen headed "Package Details", above a
// pre-answered origin and a pre-filled parcel form.
export default function SenderStepDestination({
  value, onChange, tried, onContinue, onBack, continueLabel,
}: Props) {
  const errors = destinationErrors(value);
  const showErrors = tried && errors.length > 0;

  return (
    <div className="space-y-5">
      <StepQuestionHeader question="Where is it going?" />

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <SmartAddressInput
          label="Delivery address"
          nameLabel="Recipient's name"
          nameHint="who it's going to"
          addressLabel="Delivery address"
          addressPlaceholder="Start typing the delivery address…"
          value={value}
          onChange={onChange}
          error={showErrors ? errors[0] : undefined}
        />
      </div>

      {showErrors && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive space-y-1">
          <p className="font-medium">Please fix these before continuing:</p>
          <ul className="list-disc list-inside text-xs">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="flex gap-3">
        {onBack && (
          <Button variant="outline" onClick={onBack} className="rounded-xl">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        )}
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          {continueLabel}
          <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
