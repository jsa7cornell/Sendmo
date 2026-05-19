// Affirmative confirmation block for sender_flex viewers on /t/<public_code>.
// Proposal: 2026-05-19_unify-confirmation-into-tracking — author response N1 + John directive #6.
// Replaces the receipt slot for senders who used a prepaid flex link
// (Pattern D off_session charge is against the recipient's saved PM — sender is not the payer).

import { Check } from "lucide-react";

interface PaidByRecipientBlockProps {
  recipientFirstName: string;   // e.g. "Jane"
}

export default function PaidByRecipientBlock({ recipientFirstName }: PaidByRecipientBlockProps) {
  return (
    <div className="bg-[hsl(142,71%,95%)] border border-[hsl(142,71%,45%/0.35)] rounded-2xl p-3 mb-3 flex items-center gap-2.5">
      {/* Green check circle */}
      <div
        className="w-[22px] h-[22px] bg-[hsl(142,71%,45%)] text-white rounded-full flex items-center justify-center shrink-0"
        aria-hidden="true"
      >
        <Check size={12} strokeWidth={3.5} />
      </div>

      {/* Text */}
      <p className="text-[13px] leading-tight m-0">
        <strong className="text-[hsl(142,50%,25%)] font-semibold">
          {recipientFirstName} has paid for shipping
        </strong>
        <span className="block text-muted-foreground text-[11.5px] mt-0.5">
          No charge to you — the prepaid label is on the recipient.
        </span>
      </p>
    </div>
  );
}
