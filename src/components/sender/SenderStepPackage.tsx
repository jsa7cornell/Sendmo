import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import StepQuestionHeader from "@/components/recipient/StepQuestionHeader";
import ParcelQuestion from "@/components/shipment/ParcelQuestion";
import { type ParcelDraft, EMPTY_PARCEL_DRAFT } from "@/components/shipment/parcelDraft";
import type { SenderParcel } from "./senderState";

interface Props {
  initialParcel: SenderParcel | null;
  onSubmit: (parcel: SenderParcel) => void;
  onBack?: () => void;
  continueLabel: string;
}

// One question: what's in the box, and how big is it.
//
// The fields, the Guestimator and the describe-it-first reveal are the shared
// <ParcelQuestion> (2026-08-24) — the same component the link's creator
// answers this question with. Before that the two flows had different UIs for
// identical fields, and the sender's showed every field up front.
export default function SenderStepPackage({
  initialParcel, onSubmit, onBack, continueLabel,
}: Props) {
  const [tried, setTried] = useState(false);
  const [draft, setDraft] = useState<ParcelDraft>(() => {
    if (!initialParcel) return EMPTY_PARCEL_DRAFT;
    const lbs = Math.floor(initialParcel.weightOz / 16);
    const oz = Math.round(initialParcel.weightOz % 16);
    return {
      description: initialParcel.description,
      packaging: initialParcel.packaging,
      length: String(initialParcel.length),
      width: String(initialParcel.width),
      height: String(initialParcel.height),
      weightLbs: lbs ? String(lbs) : "",
      weightOz: oz ? String(oz) : "",
    };
  });

  const l = parseFloat(draft.length);
  const w = parseFloat(draft.width);
  // An envelope has no meaningful height; the carriers still want a number.
  const h = draft.packaging === "envelope" ? 1 : parseFloat(draft.height);
  const weightOz = (parseFloat(draft.weightLbs) || 0) * 16 + (parseFloat(draft.weightOz) || 0);

  const missing: string[] = [];
  if (!l) missing.push("Length");
  if (!w) missing.push("Width");
  if (!h) missing.push("Height");
  if (!weightOz) missing.push("Weight");

  function handleContinue() {
    setTried(true);
    if (missing.length > 0) return;
    onSubmit({
      length: l, width: w, height: h, weightOz,
      description: draft.description,
      packaging: draft.packaging,
    });
  }

  const showErrors = tried && missing.length > 0;

  return (
    <div className="space-y-5">
      <StepQuestionHeader question="What are you shipping?" />

      <ParcelQuestion
        value={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        showErrors={showErrors}
        invalid={{
          length: tried && !l,
          width: tried && !w,
          height: tried && !h,
          weight: tried && !weightOz,
        }}
      />

      {showErrors && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive space-y-1">
          <p className="font-medium">Please fix these before continuing:</p>
          <ul className="list-disc list-inside text-xs">
            {missing.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}

      <div className="flex gap-3">
        {onBack && (
          <Button variant="outline" onClick={onBack} className="rounded-xl">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        )}
        <Button onClick={handleContinue} className="flex-1 rounded-xl shadow-sm">
          {continueLabel}
          <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
