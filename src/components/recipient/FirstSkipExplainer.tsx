import { Undo2 } from "lucide-react";

// From the design handoff: "The very first time a creator defers anything in a
// session, a one-time dark explainer bubble appears (bg near-black, white
// text) stating this is now a shipping link, with an inline Undo action. On
// every subsequent defer, only a small 'Undo — answer it yourself' text link
// appears — no repeated banner."
//
// Why one-time matters, beyond taste: the product change needs to be stated at
// the moment it happens (unified-onboarding proposal, John's point 3), but a
// banner that reappears on every skip trains the user to stop reading it —
// and this one carries the only explanation of what a shipping link IS. The
// second and third skips do not change the product; they change what the
// sender has to fill in, which the payment summary states in full.
//
// "Seen" lives in flow state (`seenSkipExplainer`), not component state, so it
// survives the step navigation that a skip performs — the skip that triggers
// the bubble is the same action that unmounts the step rendering it.

interface Props {
  variant: "first" | "subsequent";
  onUndo: () => void;
}

export default function FirstSkipExplainer({ variant, onUndo }: Props) {
  if (variant === "subsequent") {
    return (
      <button
        type="button"
        onClick={onUndo}
        className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary rounded-lg px-2 py-1 -ml-2 transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Undo2 className="w-3 h-3" aria-hidden="true" />
        Undo — answer it yourself
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-xl bg-foreground text-background px-4 py-3">
      <p className="text-sm leading-relaxed">
        <span className="font-semibold">This is a shipping link now.</span>{" "}
        They fill in what you skipped and print the label — you set a spending cap
        and are only charged when they ship.
      </p>
      <button
        type="button"
        onClick={onUndo}
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background focus-visible:ring-offset-2 focus-visible:ring-offset-foreground"
      >
        <Undo2 className="w-3 h-3" aria-hidden="true" />
        Undo — answer it yourself
      </button>
    </div>
  );
}
