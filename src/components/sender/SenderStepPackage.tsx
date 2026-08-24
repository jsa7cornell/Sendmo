import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Package, Mail, ScrollText, ArrowLeft, ArrowRight } from "lucide-react";
import MagicGuestimator from "@/components/recipient/MagicGuestimator";
import StepQuestionHeader from "@/components/recipient/StepQuestionHeader";
import type { GuestimatorResult } from "@/lib/types";
import type { SenderParcel, PackagingType } from "./senderState";

interface Props {
  initialParcel: SenderParcel | null;
  onSubmit: (parcel: SenderParcel) => void;
  onBack?: () => void;
  onGuestimatorUsed?: () => void;
  continueLabel: string;
}

const PACKAGING_OPTIONS: { value: PackagingType; label: string; Icon: typeof Package }[] = [
  { value: "box", label: "Box / Rigid", Icon: Package },
  { value: "envelope", label: "Envelope / Soft", Icon: Mail },
  { value: "tube", label: "Tube / Irregular", Icon: ScrollText },
];

// One question: what's in the box, and how big is it.
//
// This step used to carry the destination and the ship-from address too, on a
// screen headed "Package Details" — so a sender whose link already answered
// both scrolled past two pre-filled address cards to reach the only fields
// that were theirs. Each address is its own step now, and neither is shown at
// all when the link answered it (2026-08-24).
export default function SenderStepPackage({
  initialParcel, onSubmit, onBack, onGuestimatorUsed, continueLabel,
}: Props) {
  const [tried, setTried] = useState(false);
  const [packaging, setPackaging] = useState<PackagingType>(initialParcel?.packaging ?? "box");
  const [length, setLength] = useState(initialParcel ? String(initialParcel.length) : "");
  const [width, setWidth] = useState(initialParcel ? String(initialParcel.width) : "");
  const [height, setHeight] = useState(initialParcel ? String(initialParcel.height) : "");
  const [weightLbs, setWeightLbs] = useState(initialParcel ? String(initialParcel.weightOz / 16) : "");
  const [description, setDescription] = useState(initialParcel?.description ?? "");

  function handleGuestimate(result: GuestimatorResult) {
    setPackaging(result.packaging);
    setLength(String(result.length));
    setWidth(String(result.width));
    if (result.packaging !== "envelope") setHeight(String(result.height));
    setWeightLbs(String(result.weightLbs));
    setDescription(result.itemName);
    onGuestimatorUsed?.();
  }

  function handleContinue() {
    setTried(true);
    const l = parseFloat(length);
    const w = parseFloat(width);
    const h = packaging === "envelope" ? 1 : parseFloat(height);  // envelope height defaults to 1in
    const wt = parseFloat(weightLbs);
    if (!l || !w || !h || !wt) return;

    onSubmit({ length: l, width: w, height: h, weightOz: wt * 16, description, packaging });
  }

  const dimsIncomplete = tried && (!length || !width || (packaging !== "envelope" && !height) || !weightLbs);

  return (
    <div className="space-y-5">
      <StepQuestionHeader question="What are you shipping?" />

      <MagicGuestimator onResult={handleGuestimate} />

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        {/* Packaging type */}
        <div>
          <label className="text-sm font-medium text-foreground mb-2 block">
            Packaging type
          </label>
          <div className="grid grid-cols-3 gap-2">
            {PACKAGING_OPTIONS.map(({ value, label, Icon }) => {
              const selected = packaging === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPackaging(value)}
                  className={
                    "flex flex-col items-center gap-1.5 rounded-xl border-2 p-3 transition " +
                    (selected
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border bg-background hover:border-muted-foreground/30 text-muted-foreground")
                  }
                >
                  <Icon className={"w-5 h-5 " + (selected ? "text-primary" : "")} />
                  <span className="text-xs font-medium">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Item description <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            type="text"
            placeholder="e.g. ceramic mug"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
        </div>

        {/* Dimensions */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Dimensions <span className="font-normal text-muted-foreground">(inches)</span>
          </label>
          <div className={packaging === "envelope" ? "grid grid-cols-2 gap-3" : "grid grid-cols-3 gap-3"}>
            <input type="number" inputMode="numeric" placeholder="Length" value={length} onChange={(e) => setLength(e.target.value)}
              className={`rounded-xl border ${tried && !length ? "border-destructive" : "border-border"} bg-background px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`} />
            <input type="number" inputMode="numeric" placeholder="Width" value={width} onChange={(e) => setWidth(e.target.value)}
              className={`rounded-xl border ${tried && !width ? "border-destructive" : "border-border"} bg-background px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`} />
            {packaging !== "envelope" && (
              <input type="number" inputMode="numeric" placeholder="Height" value={height} onChange={(e) => setHeight(e.target.value)}
                className={`rounded-xl border ${tried && !height ? "border-destructive" : "border-border"} bg-background px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`} />
            )}
          </div>
        </div>

        {/* Weight */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Weight <span className="font-normal text-muted-foreground">(lbs)</span>
          </label>
          <input type="number" inputMode="numeric" placeholder="e.g. 5" value={weightLbs} onChange={(e) => setWeightLbs(e.target.value)}
            className={`w-full rounded-xl border ${tried && !weightLbs ? "border-destructive" : "border-border"} bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`} />
        </div>

        {dimsIncomplete && (
          <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive space-y-1">
            <p className="font-medium">Please fix these before continuing:</p>
            <ul className="list-disc list-inside text-xs">
              {!length && <li>Length</li>}
              {!width && <li>Width</li>}
              {packaging !== "envelope" && !height && <li>Height</li>}
              {!weightLbs && <li>Weight</li>}
            </ul>
          </div>
        )}
      </div>

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
