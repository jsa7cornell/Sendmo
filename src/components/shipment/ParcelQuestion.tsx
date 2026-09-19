import { useState } from "react";
import { Input } from "@/components/ui/input";
import MagicGuestimator from "@/components/recipient/MagicGuestimator";
import { cn } from "@/lib/utils";
import type { GuestimatorResult, PackagingType } from "@/lib/types";
import type { ParcelDraft } from "./parcelDraft";

export type { ParcelDraft };

// "What is the parcel" — one question, shared by BOTH flows (2026-08-24).
//
// The creator's side got this shape on 2026-08-23; the sender's had a
// different one (a four-card stack with every field visible from the start).
// There is no reason for two, so this is the one, and each flow adapts its own
// state to `ParcelDraft` at the boundary.
//
// The fields start collapsed behind "or fill in manually": describing the item
// is the intended path, and four cards of dimensions in front of someone who
// was going to type "a hardcover cookbook" is the wrong first impression.
//
// Filled values render as a one-line summary card with "Adjust" opening the
// fields (2026-08-30, Direction A review — supersedes the 2026-08-24
// always-expanded rule). The old invariant survives in two ways: every value
// is visible on the summary, and `showErrors` always forces the real fields
// open — a validation summary naming Length and Width must never point at
// fields the user cannot see.

const PACKAGING_OPTIONS: { id: PackagingType; label: string; desc: string }[] = [
  { id: "box", label: "Box / Rigid", desc: "Standard cardboard box" },
  { id: "envelope", label: "Envelope / Soft Pack", desc: "Padded mailer or poly bag" },
  { id: "tube", label: "Tube / Irregular", desc: "Cylindrical or odd shape" },
];

interface Props {
  value: ParcelDraft;
  onChange: (patch: Partial<ParcelDraft>) => void;
  /**
   * Fired in addition to the field patch when the Guestimator answers, for
   * state only one flow keeps (the creator persists the speed hint and the
   * used-the-Guestimator flag; the sender only needs the fields).
   */
  onGuestimated?: (result: GuestimatorResult) => void;
  /** Reveals the fields and paints the invalid ones. */
  showErrors?: boolean;
  invalid?: { length?: boolean; width?: boolean; height?: boolean; weight?: boolean };
}

const PACKAGING_SHORT: Record<PackagingType, string> = {
  box: "box",
  envelope: "envelope",
  tube: "tube",
};

export default function ParcelQuestion({
  value, onChange, onGuestimated, showErrors = false, invalid = {},
}: Props) {
  const [manualOpen, setManualOpen] = useState(false);
  // Whether the current values came from the Guestimator (vs a prefill or a
  // returning visit) — only changes the summary card's first line.
  const [estimated, setEstimated] = useState(false);
  const hasParcelValues = !!(
    value.length || value.width || value.height ||
    value.weightLbs || value.weightOz || value.description
  );
  // Filled values render as a one-line summary card with "Adjust" (2026-08-30,
  // Direction A review — John approved the mock). This supersedes the
  // 2026-08-24 "reveal the fields, the reveal is the confirmation" behavior:
  // the values stay visible and correctable — the summary shows them and
  // Adjust opens the same fields — they just stop being five inputs as the
  // first thing on the screen. showErrors still forces the real fields open:
  // a validation summary naming Length must never point at a field the user
  // cannot see.
  const showParcelFields = manualOpen || showErrors;
  const showSummary = hasParcelValues && !showParcelFields;

  function handleGuestimation(result: GuestimatorResult) {
    onChange({
      packaging: result.packaging,
      length: String(result.length),
      width: String(result.width),
      height: String(result.height),
      weightLbs: String(Math.floor(result.weightLbs)),
      weightOz: String(Math.round((result.weightLbs % 1) * 16)),
      description: result.itemName,
    });
    setEstimated(true);
    onGuestimated?.(result);
  }

  const dimsLabel =
    value.packaging === "envelope"
      ? [value.length, value.width].filter(Boolean).join(" × ")
      : [value.length, value.width, value.height].filter(Boolean).join(" × ");
  const weightLabel = [
    value.weightLbs && `${value.weightLbs} lb`,
    value.weightOz && `${value.weightOz} oz`,
  ]
    .filter(Boolean)
    .join(" ");
  const summaryLine = [
    dimsLabel && `${dimsLabel} in`,
    weightLabel,
    PACKAGING_SHORT[value.packaging],
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-5">
      {/* Describe it and we size it — the intended path. */}
      <MagicGuestimator
        onResult={handleGuestimation}
        title="Describe it in plain words"
        subtitle="This also prints on the shipping label."
        placeholder="e.g., a hardcover cookbook"
        icon={false}
        action={showParcelFields || showSummary ? undefined : (
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="text-sm font-medium text-foreground underline underline-offset-4 rounded px-1 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            or fill in manually
          </button>
        )}
      />

      {showSummary && (
        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4">
          <p className="text-sm font-medium text-foreground">
            {estimated && value.description ? (
              <>Our estimate for <span className="font-semibold">{value.description}</span></>
            ) : (
              "Your package"
            )}
          </p>
          <p className="mt-1 font-mono text-sm text-foreground tabular-nums">{summaryLine}</p>
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="mt-2 text-sm font-medium text-primary underline underline-offset-4 rounded px-0.5 transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Adjust size, weight or packaging
          </button>
        </div>
      )}

      {showParcelFields && (
        // ONE card, not four (2026-08-23). Description, packaging, dimensions
        // and weight are all the same question — "what is the parcel" — and
        // four stacked cards made them read as four separate decisions.
        <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-5">
          <div>
            <label htmlFor="item-desc" className="text-sm font-semibold text-foreground">
              Item description <span className="text-muted-foreground font-normal">(optional — for the shipping label)</span>
            </label>
            <Input
              id="item-desc"
              value={value.description}
              onChange={(e) => onChange({ description: e.target.value })}
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
                  onClick={() => onChange({ packaging: opt.id })}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-all",
                    value.packaging === opt.id
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-muted-foreground/30",
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className={cn(
                      "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0",
                      value.packaging === opt.id ? "border-primary" : "border-muted-foreground/40",
                    )}>
                      {value.packaging === opt.id && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
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
            <div className={cn("grid gap-3", value.packaging === "envelope" ? "grid-cols-2" : "grid-cols-3")}>
              <div>
                <label className="text-xs text-muted-foreground">Length</label>
                <Input
                  inputMode="numeric"
                  value={value.length}
                  onChange={(e) => onChange({ length: e.target.value })}
                  placeholder="L"
                  className={cn("mt-1 rounded-xl", invalid.length && "border-destructive")}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Width</label>
                <Input
                  inputMode="numeric"
                  value={value.width}
                  onChange={(e) => onChange({ width: e.target.value })}
                  placeholder="W"
                  className={cn("mt-1 rounded-xl", invalid.width && "border-destructive")}
                />
              </div>
              {value.packaging !== "envelope" && (
                <div>
                  <label className="text-xs text-muted-foreground">Height</label>
                  <Input
                    inputMode="numeric"
                    value={value.height}
                    onChange={(e) => onChange({ height: e.target.value })}
                    placeholder="H"
                    className={cn("mt-1 rounded-xl", invalid.height && "border-destructive")}
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
                  value={value.weightLbs}
                  onChange={(e) => onChange({ weightLbs: e.target.value })}
                  placeholder="lbs"
                  className={cn("mt-1 rounded-xl", invalid.weight && "border-destructive")}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Ounces</label>
                <Input
                  inputMode="numeric"
                  value={value.weightOz}
                  onChange={(e) => onChange({ weightOz: e.target.value })}
                  placeholder="oz"
                  className="mt-1 rounded-xl"
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
