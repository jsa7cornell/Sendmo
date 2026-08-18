import { motion } from "framer-motion";
import { Send, Inbox, ArrowRight, Tag } from "lucide-react";
import { SELLER_LINK_ENABLED } from "@/lib/featureFlags";
import type { SenderKind } from "@/lib/types";

interface Props {
  onSelect: (sender: SenderKind) => void;
  onSellInstead: () => void;
}

const OPTIONS: {
  id: SenderKind;
  icon: typeof Send;
  title: string;
  body: string;
}[] = [
  {
    id: "self",
    icon: Send,
    title: "I am",
    // Keeps "you" as the actor who hands the label over — the product never
    // emails a label to the other party on this path (decided 2026-06-27:
    // only the payer gets a creation email).
    body: "You're mailing something out. You'll get a label to print and drop off — charged when you buy it.",
  },
  {
    id: "other",
    icon: Inbox,
    title: "Someone else",
    body: "They're sending something to you. You'll get a label to send them — or a link they fill in, if you don't have their address.",
  },
];

/**
 * Step 0 — replaces the two-product path picker.
 *
 * The question is "who's sending?", not "which product?": it is the one input
 * that changes what happens next and it needs no product knowledge to answer.
 * Both answers begin the same `full_label` flow; the link product appears only
 * if the user later says they don't have the other party's address.
 *
 * Who-pays is stated ONCE in the subtitle. Both options are you-pay, so a
 * per-card "You pay" badge differentiates nothing — that was precisely the
 * failure of the previous picker's two identical YOU PAY badges.
 */
export default function RecipientStepWhoSending({ onSelect, onSellInstead }: Props) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Who's sending the package?</h1>
        <p className="text-muted-foreground mt-2">Either way, you're the one paying for shipping.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {OPTIONS.map((opt) => (
          <motion.button
            key={opt.id}
            type="button"
            whileTap={{ scale: 0.985 }}
            onClick={() => onSelect(opt.id)}
            // flex-col + justify-start defeats the <button> centering that made
            // the old cards' rows disagree by 19px under grid stretch.
            className="group flex h-full flex-col justify-start gap-2 text-left bg-card rounded-2xl border border-border shadow-sm p-5 transition-all hover:border-primary/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <opt.icon className="w-5 h-5" aria-hidden="true" />
            </span>
            <h2 className="font-semibold text-foreground text-lg leading-tight mt-1">{opt.title}</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{opt.body}</p>
            <span className="mt-auto pt-3 inline-flex items-center gap-1 text-sm font-medium text-primary transition-all group-hover:gap-2">
              Continue <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </span>
          </motion.button>
        ))}
      </div>

      {/* Seller link-out. Launch-gated. A signed-in seller reaches /onboarding
          from the Dashboard and would otherwise answer "I am" truthfully and
          land in the you-pay flow with no sign the buyer-pays product exists. */}
      {SELLER_LINK_ENABLED && (
        <div className="text-center">
          <button
            type="button"
            onClick={onSellInstead}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground rounded-xl px-3 py-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Tag className="w-3.5 h-3.5" aria-hidden="true" />
            Selling something? Create a link the buyer pays for
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
