import { ArrowRight, Undo2 } from "lucide-react";

// "Sender will fill this in →" — the skip, as a link beside the question
// rather than a control in a card of its own (2026-08-22). Replaces SkipToggle
// on all three question steps.
//
// Why a link and not the old two-button radiogroup: the radiogroup asked the
// user to answer a SECOND question ("who fills this in?") before they could
// answer the first, and it needed its own card to do so — three stacked boxes
// for one question. Nothing is lost by demoting it: typing in the fields is
// still how you answer "I have it", which is what the radiogroup's own
// no-pre-selection rule already relied on.
//
// Skipping ADVANCES. It is a complete answer to the step's only question, so
// asking the user to then press Continue is asking them to confirm something
// they just said. Reversing it does NOT navigate — the user is looking at the
// step they want back, so it reopens in place.

interface Props {
  /** Whether this question is currently handed to the sender. */
  deferred: boolean;
  onDefer: () => void;
  onUndo: () => void;
}

const CLASSES =
  "shrink-0 inline-flex items-center gap-1.5 text-sm font-semibold text-primary rounded-lg px-2 py-1 -mr-2 transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export default function SkipToSenderLink({ deferred, onDefer, onUndo }: Props) {
  if (deferred) {
    return (
      <button type="button" onClick={onUndo} className={CLASSES}>
        <Undo2 className="w-4 h-4" aria-hidden="true" />
        Enter it myself
      </button>
    );
  }
  return (
    <button type="button" onClick={onDefer} className={CLASSES}>
      Sender will fill this in
      <ArrowRight className="w-4 h-4" aria-hidden="true" />
    </button>
  );
}
