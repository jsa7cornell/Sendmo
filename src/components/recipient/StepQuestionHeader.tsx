import type { ReactNode } from "react";

// The question heading for a flow step, with its one action on the same row.
//
// This is the 2026-08-22 paradigm, and it is deliberately ONE component rather
// than a header row hand-rolled per step: the three question steps
// (Destination, Origin, Package) previously each stated their question in a
// different place — a page <h2> on Destination, a fieldset legend inside the
// SkipToggle card on the other two — which is why the skip control ended up in
// its own card above the form. Asking the question once, here, is what lets
// the skip be a link beside it.
//
// One action, not a toolbar. The action is always the same thing: who answers
// this question, me or the sender.

interface Props {
  /** The question itself, e.g. "What's being shipped?". */
  question: string;
  /** The skip link (or its reverse) — see SkipToSenderLink. */
  action?: ReactNode;
}

// No supporting line (2026-08-23). Every step had one and none of them earned
// its place: "Carriers need a phone number for the delivery address" sat above
// a field already labelled "Phone number (the shipping carriers insist on it)".
// The question and its fields say it; a paragraph between them only delays
// reaching the form.
export default function StepQuestionHeader({ question, action }: Props) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h2 className="text-xl font-bold text-foreground">{question}</h2>
      {action}
    </div>
  );
}
