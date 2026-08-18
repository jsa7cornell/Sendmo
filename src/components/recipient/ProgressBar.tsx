import { MapPin, Send, Package, CreditCard, Tag, Settings2, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecipientPath } from "@/lib/types";

// One segment per question (John, 2026-08-18): the old shared set collapsed
// origin + package into one "Shipment Details" segment, so completing the
// origin step advanced the bar by nothing. Per-path sets because the two flows
// genuinely ask different questions after Destination. "Package & Shipping"
// stays one segment until step 14 itself splits (unified-onboarding proposal
// Phase 2) — the bar reflects the flow that exists, not the one planned.
const FULL_LABEL_SEGMENTS = [
  { icon: MapPin, label: "Destination" },
  { icon: Send, label: "Origin" },
  { icon: Package, label: "Package & Shipping" },
  { icon: CreditCard, label: "Payment" },
  { icon: Tag, label: "Label" },
];

const FLEX_SEGMENTS = [
  { icon: MapPin, label: "Destination" },
  { icon: Settings2, label: "Preferences" },
  { icon: CreditCard, label: "Save Card" },
  { icon: Link2, label: "Share Link" },
];

interface Props {
  path: RecipientPath | null; // decides which segment set renders (null → full label, the pre-fork default)
  activeIndex: number;       // progress index into the path's segment set
  completedIndexes: number[];
  onClickIndex?: (index: number) => void;
}

export default function ProgressBar({ path, activeIndex, completedIndexes, onClickIndex }: Props) {
  const STEPS = path === "flexible" ? FLEX_SEGMENTS : FULL_LABEL_SEGMENTS;
  return (
    <div className="flex items-center justify-between w-full max-w-lg mx-auto mb-8">
      {STEPS.map((step, i) => {
        const isCompleted = completedIndexes.includes(i);
        const isActive = i === activeIndex;
        const isFuture = !isCompleted && !isActive;
        const canClick = isCompleted && onClickIndex;

        const Icon = step.icon;

        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            {/* Step circle */}
            <button
              type="button"
              disabled={!canClick}
              aria-label={step.label}
              aria-current={isActive ? "step" : undefined}
              onClick={() => canClick && onClickIndex(i)}
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-colors",
                isCompleted && "bg-primary text-primary-foreground cursor-pointer hover:bg-primary/90",
                isActive && "border-2 border-primary text-primary bg-primary/5",
                isFuture && "border-2 border-muted text-muted-foreground bg-muted/30",
                !canClick && "cursor-default",
              )}
            >
              <Icon className="w-4 h-4" />
            </button>

            {/* Label (hidden on mobile) */}
            <span
              className={cn(
                "hidden sm:inline ml-2 text-xs font-medium whitespace-nowrap",
                (isCompleted || isActive) ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>

            {/* Connector line */}
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-3",
                  isCompleted ? "bg-primary" : "bg-muted",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
