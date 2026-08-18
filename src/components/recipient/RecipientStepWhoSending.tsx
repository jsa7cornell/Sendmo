import { motion } from "framer-motion";
import { Inbox, ArrowRight, Send, Tag } from "lucide-react";
import { SELLER_LINK_VISIBLE, SELLER_LINK_LIVE } from "@/lib/featureFlags";
import type { SenderKind } from "@/lib/types";

interface Props {
  onSelect: (sender: SenderKind) => void;
  onSellInstead: () => void;
}

/**
 * Step 0 — "Who's sending the package?"
 *
 * Deliberately lopsided. Both answers start the same flow and differ only in
 * which party owns which address, but they are not equally common: someone
 * shipping TO the account holder is the product's core case, and mailing
 * something out yourself is a real but secondary one. So the receiving case is
 * a full card and the outbound case is a text link beneath it — present and
 * reachable, not competing for attention (John, 2026-08-18).
 *
 * Who-pays is stated once in the subtitle. Both answers are you-pay, so
 * repeating it per option would differentiate nothing — that was the failure of
 * the picker this replaced, which badged two identical "YOU PAY" pills.
 */
export default function RecipientStepWhoSending({ onSelect, onSellInstead }: Props) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Who's sending the package?</h1>
        <p className="text-muted-foreground mt-2">Either way, you're the one paying for shipping.</p>
      </div>

      {/* Primary path — someone is shipping to the account holder. */}
      <motion.button
        type="button"
        whileTap={{ scale: 0.99 }}
        onClick={() => onSelect("other")}
        className="group w-full flex flex-col justify-start gap-2 text-left bg-card rounded-2xl border border-border shadow-sm p-6 transition-all hover:border-primary/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
          <Inbox className="w-5 h-5" aria-hidden="true" />
        </span>
        <h2 className="font-semibold text-foreground text-lg leading-tight mt-1">Someone else</h2>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
          They're sending something to you. You'll get a label to send them — or a link they fill in,
          if you don't have their address.
        </p>
        <span className="pt-3 inline-flex items-center gap-1 text-sm font-medium text-primary transition-all group-hover:gap-2">
          Continue <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
      </motion.button>

      {/* Secondary path — the account holder mails something out. Same flow,
          same link_type; only which address is theirs differs. */}
      <div className="text-center">
        <button
          type="button"
          onClick={() => onSelect("self")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground rounded-xl px-3 py-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Send className="w-3.5 h-3.5" aria-hidden="true" />
          I'm mailing something out myself
          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Seller entry point. Inert while the buyer checkout is still test-mode —
          announcing the product without letting anyone start a sale that can't
          be paid for. See SELLER_LINK_MODE. */}
      {SELLER_LINK_VISIBLE && (
        <div className="text-center border-t border-border pt-5">
          {SELLER_LINK_LIVE ? (
            <button
              type="button"
              onClick={onSellInstead}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground rounded-xl px-3 py-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Tag className="w-3.5 h-3.5" aria-hidden="true" />
              Selling something? Create a link the buyer pays for
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground px-3 py-2">
              <Tag className="w-3.5 h-3.5" aria-hidden="true" />
              Selling something? A link the buyer pays for
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-muted border border-border rounded-full px-2 py-0.5">
                Coming soon
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
