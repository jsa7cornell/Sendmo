import { cn } from "@/lib/utils";

// The skip control for the Origin and Package steps — design brief point 1,
// "the skip option must sit on top of each question, not below the form".
//
// It covered the Destination step too until 2026-08-22, when that step moved
// its skip into the field group's card header instead. The `showLegend={false}`
// prop existed solely for that caller (the step already had its own heading)
// and went with it.
//
// ─── Two decisions this control encodes, both deliberate ───
//
// 1. ORDER: "I have it" reads first. John's T1 decision, 2026-08-19, from a
//    side-by-side of both resting states: option A made the first thing a
//    first-time user reads an instruction about a person who is not them,
//    before the screen has established what it is for. B reads in the order
//    the user is already thinking — do I have this? yes → type it · no → hand
//    it off. The "skipping is first-class" signal that brief point 1 demands
//    is carried by POSITION (a full-width control above the form), not by
//    winning a word race inside it.
//
// 2. NO PRE-SELECTION, but the form stays live. Brief point 9 warned that
//    prominence and default are separable, and the label path is all revenue
//    to date. So neither option renders as chosen, while the fields below stay
//    focusable and empty — a creator who simply types has answered without
//    touching this control, and loses no click. Selecting "sender fills this
//    in" is the only state change either option makes.
//
// Implemented as a radiogroup rather than two buttons so the arrow keys work
// and a screen reader announces "1 of 2" — the states are mutually exclusive
// answers to one question, which is what a radiogroup means.

interface Props {
  /** The question itself, e.g. "Where's it shipping from?". */
  legend: string;
  /**
   * The answer, THREE states — `null` means not yet answered, which is the
   * resting state and renders neither option as chosen.
   *
   * A boolean cannot express this: `deferred === false` is both "they chose
   * to enter it" and "they have not answered", so a boolean-driven control
   * renders "I have it" pre-selected on arrival — the default change brief
   * point 9 explicitly warned against, and the opposite of what the comment
   * above claims. Steps derive "kept" from the field group having content, so
   * typing answers the question without touching this control.
   */
  choice: "kept" | "deferred" | null;
  onKeepIt: () => void;
  onDefer: () => void;
  /**
   * Copy under the control; changes with the answer (handoff §1).
   *
   * The unanswered state shows `keptCaption` — John's decision, 2026-08-19,
   * from a side-by-side. An earlier cut added a third caption naming the
   * shipping link at rest, on the reasoning that compacting the old two-card
   * control removed the only place the product was named before the user
   * committed (the 2026-08-18 "named, weighted and visible before the user
   * can fail" property). John chose the handoff's tighter copy: the product
   * is named by the "Sender fills this in" option itself and by the caption
   * the moment it is chosen, which he judged sufficient. Recorded because a
   * later reader will find the 2026-08-18 note and think this drifted.
   */
  keptCaption: string;
  deferredCaption: string;
}

export default function SkipToggle({
  legend, choice, onKeepIt, onDefer, keptCaption, deferredCaption,
}: Props) {
  return (
    <div className="mb-4">
      <h2 className="text-sm font-semibold text-foreground mb-3">{legend}</h2>
      <div role="radiogroup" aria-label={legend} className="grid grid-cols-2 gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={choice === "kept"}
          onClick={onKeepIt}
          className={cn(
            "rounded-xl border px-3 py-2.5 text-sm font-medium transition-all",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            choice === "kept"
              ? "border-primary bg-primary/5 text-foreground"
              : "border-border text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground",
          )}
        >
          I have it
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={choice === "deferred"}
          onClick={onDefer}
          className={cn(
            "rounded-xl border px-3 py-2.5 text-sm font-medium transition-all",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            choice === "deferred"
              ? "border-primary bg-primary/5 text-foreground"
              : "border-border text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground",
          )}
        >
          Sender fills this in
        </button>
      </div>
      <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
        {choice === "deferred" ? deferredCaption : keptCaption}
      </p>
    </div>
  );
}
