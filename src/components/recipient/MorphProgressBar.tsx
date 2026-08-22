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
// Exactly ONE segment is filled solid: the current one. Done segments used to
// carry the solid primary fill while current got only a thin ring, so a screen
// with two finished steps behind it showed two loud circles and one quiet one
// — the quiet one being where the user actually was. Done is now a tinted
// check, which still reads as finished without competing for the eye.
//
// FILL and GLYPH are separate axes because they answer separate questions:
// fill is "where am I", glyph is "what happened here". A segment can be both
// current and skipped — the user navigated back to a question they handed off
// — and it must show both, or the bar quietly relabels a skipped step as an
// ordinary one the moment you stand on it.
//
// "Skipped" is distinguished by SHAPE, not hue (review B4): an arrow in a
// dashed circle — "handed to the sender". Amber was the handoff's choice and
// was rejected because amber already means the Express speed tier (SPEC §6),
// which renders directly beneath this bar on the Shipping step. The glyph also
// keeps the four states legible without color discrimination.
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
        // TWO independent axes, deliberately not collapsed into one state.
        // FILL answers "where am I" — only the active segment is solid, which
        // is what stops finished steps from out-shouting the current one.
        // GLYPH + label style answer "what happened here", and they are read
        // from skippedIndexes/completedIndexes directly, so they survive being
        // active. Collapsing them (isSkipped = !isActive && …) made a skipped
        // step you navigated back onto render as an ordinary current step —
        // right down to the aria-label — which is exactly the relabeling this
        // component's morph is supposed to never do.
        const isActive = i === activeIndex;
        const isSkipped = skippedIndexes.includes(i);
        const isCompleted = !isSkipped && completedIndexes.includes(i);
        const isFuture = !isActive && !isSkipped && !isCompleted;
        // Reachability is the guard's job (goToStep → canAccessStep); the bar
        // only offers clicks on segments the user has already been through,
        // and never on the one they are standing on.
        const canClick = !isActive && (isCompleted || isSkipped) && onClickIndex;

        const Icon = isSkipped ? ArrowRight : (isCompleted && !isActive) ? Check : seg.icon;

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
                isActive && "bg-primary text-primary-foreground ring-4 ring-primary/20",
                // Standing on a step you skipped: filled because you are here,
                // still dashed because the question is still the sender's.
                isActive && isSkipped && "border-2 border-dashed border-primary-foreground/60",
                !isActive && isCompleted && "bg-primary/10 text-primary cursor-pointer hover:bg-primary/20",
                !isActive && isSkipped && "bg-muted text-muted-foreground border-2 border-dashed border-muted-foreground/40 cursor-pointer hover:bg-muted/70",
                isFuture && "border-2 border-muted text-muted-foreground bg-muted/30",
                !canClick && "cursor-default",
              )}
            >
              <Icon className="w-4 h-4" />
            </button>

            {/* Label (hidden on mobile). Only the current step's label is at
                full weight — same reason its circle is the only filled one. */}
            <span
              className={cn(
                "hidden sm:inline ml-2 text-xs whitespace-nowrap",
                isActive ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
                isSkipped && "italic",
              )}
            >
              {seg.label}
            </span>

            {/* Connector line. Skipped segments get the muted line: the flow
                moved past them, but nothing was completed there. */}
            {i < SEGMENTS.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-3",
                  isSkipped ? "bg-muted-foreground/30" : isCompleted ? "bg-primary/40" : "bg-muted",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
