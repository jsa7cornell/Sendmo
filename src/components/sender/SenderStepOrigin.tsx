import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import StepQuestionHeader from "@/components/recipient/StepQuestionHeader";
import type { AddressInput } from "@/lib/types";
import { originErrors } from "./senderState";

interface Props {
  value: AddressInput;
  onChange: (a: AddressInput) => void;
  tried: boolean;
  onContinue: () => void;
  onBack?: () => void;
  continueLabel: string;
}

// Asked only when the link's creator didn't already supply the ship-from
// address. When they did, this step never appears and the address shows in the
// summary card with an edit — see planSenderSteps.
export default function SenderStepOrigin({
  value, onChange, tried, onContinue, onBack, continueLabel,
}: Props) {
  const errors = originErrors(value);
  const showErrors = tried && errors.length > 0;

  return (
    <div className="space-y-5">
      <StepQuestionHeader question="Where's it shipping from?" />

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <SmartAddressInput
          label="Sender address"
          nameLabel="Your name"
          nameHint="your name"
          addressLabel="Origin address"
          addressPlaceholder="Start typing your address…"
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
