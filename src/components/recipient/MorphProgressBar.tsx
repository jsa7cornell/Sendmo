import { MapPin, Send, Package, Truck, UserRound, CreditCard, Check, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

// The morph bar (design brief point 2, 2026-08-19 flow-redesign proposal).
// SIX fixed segments for every flow — Destination / Origin / Package /
// Shipping / Contact / Payment — with four states per segment: upcoming,
// current, done, skipped. A skip changes ONE segment's state in place;
// nothing is ever added, removed, or relabeled, which is what makes the
// label↔link transformation a state change the user can watch instead of a
// teleport into a different product.
//
// "Skipped" is distinguished by SHAPE, not hue (review B4): done is a primary
// fill with a check, skipped is a muted fill with an arrow — "handed to the
// sender". Amber was the handoff's choice and was rejected because amber
// already means the Express speed tier (SPEC §6), which renders directly
// beneath this bar on the Shipping step. The glyph also keeps the four states
// legible without color discrimination.
//
// A skipped segment stays clickable — skipping IS an answer, and clicking it
// is how the user gets back to undo it.

const SEGMENTS = [
  { icon: MapPin, label: "Destination" },
  { icon: Send, label: "Origin" },
  { icon: Package, label: "Package" },
  { icon: Truck, label: "Shipping" },
  { icon: UserRound, label: "Contact" },
  { icon: CreditCard, label: "Payment" },
];

interface Props {
  activeIndex: number;
  completedIndexes: number[];
  /** Segments answered with "the sender will fill this in". */
  skippedIndexes: number[];
  onClickIndex?: (index: number) => void;
}

export default function MorphProgressBar({ activeIndex, completedIndexes, skippedIndexes, onClickIndex }: Props) {
  return (
    <div className="flex items-center justify-between w-full max-w-lg mx-auto mb-8">
      {SEGMENTS.map((seg, i) => {
        const isSkipped = skippedIndexes.includes(i);
        const isCompleted = !isSkipped && completedIndexes.includes(i);
        const isActive = i === activeIndex;
        const isFuture = !isCompleted && !isSkipped && !isActive;
        // Reachability is the guard's job (goToStep → canAccessStep); the bar
        // only offers clicks on segments the user has already been through.
        const canClick = (isCompleted || isSkipped) && !isActive && onClickIndex;

        const Icon = isCompleted ? Check : isSkipped ? ArrowRight : seg.icon;

        return (
          <div key={seg.label} className="flex items-center flex-1 last:flex-none">
            {/* Segment circle */}
            <button
              type="button"
              disabled={!canClick}
              aria-label={isSkipped ? `${seg.label} — the sender fills this in` : seg.label}
              aria-current={isActive ? "step" : undefined}
              onClick={() => canClick && onClickIndex(i)}
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-colors",
                isCompleted && "bg-primary text-primary-foreground cursor-pointer hover:bg-primary/90",
                isSkipped && "bg-muted text-muted-foreground border-2 border-dashed border-muted-foreground/40 cursor-pointer hover:bg-muted/70",
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
                isSkipped && "italic",
              )}
            >
              {seg.label}
            </span>

            {/* Connector line */}
            {i < SEGMENTS.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-3",
                  (isCompleted || isSkipped) ? "bg-primary" : "bg-muted",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
