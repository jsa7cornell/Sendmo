import { motion } from "framer-motion";
import {
  Link2, CheckCircle2, ArrowRight, Printer,
  HelpCircle, FileText,
} from "lucide-react";
import type { RecipientPath } from "@/lib/types";

interface Props {
  onSelect: (path: RecipientPath) => void;
}

export default function RecipientStepPathChoice({ onSelect }: Props) {
  return (
    <div className="space-y-5">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">How should we set up your prepaid shipment?</h1>
        <p className="text-muted-foreground mt-2">It depends on what you know about the shipment right now</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* ── Flexible Prepaid Shipping Link ── */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.985 }}
          onClick={() => onSelect("flexible")}
          className="text-left bg-card rounded-2xl border border-border shadow-sm overflow-hidden group hover:border-violet-400/60 hover:shadow-md transition-all"
        >
          {/* Header */}
          <div className="bg-gradient-to-br from-violet-500/15 via-violet-500/8 to-violet-500/3 px-5 py-5 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center shrink-0">
              <Link2 className="w-5 h-5 text-violet-600" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground leading-tight">Flexible Prepaid Shipping Link</h3>
              <p className="text-xs text-violet-600 font-medium mt-0.5">Send a link — they handle the details</p>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {/* Best when */}
            <div className="rounded-xl bg-violet-50 border border-violet-200/60 px-4 py-3">
              <p className="text-sm font-medium text-violet-800">Best when you don't know…</p>
              <ul className="mt-1.5 space-y-1">
                <li className="flex items-start gap-2 text-sm text-violet-700">
                  <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
                  The sender's address
                </li>
                <li className="flex items-start gap-2 text-sm text-violet-700">
                  <HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
                  The item's weight or size
                </li>
              </ul>
            </div>

            {/* How it works */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">How it works</p>
              <ol className="space-y-2">
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
                  <span className="text-sm text-foreground">You set your shipping preferences and a spending cap</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
                  <span className="text-sm text-foreground">Share a link with your sender via text or email</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-violet-100 text-violet-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
                  <span className="text-sm text-foreground">They enter the details and print the label</span>
                </li>
              </ol>
            </div>

            {/* Sender experience */}
            <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
              <p className="text-xs font-semibold text-muted-foreground mb-1">What the sender does</p>
              <p className="text-sm text-foreground">Opens a link, enters their address and item info, prints the label. No account needed.</p>
            </div>

            {/* CTA */}
            <div className="flex items-center gap-1 text-sm font-medium text-violet-600 group-hover:gap-2 transition-all pt-1">
              Choose this option <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </motion.button>

        {/* ── Completed Prepaid Label ── */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.985 }}
          onClick={() => onSelect("full_label")}
          className="text-left bg-card rounded-2xl border border-border shadow-sm overflow-hidden group hover:border-primary/60 hover:shadow-md transition-all"
        >
          {/* Header */}
          <div className="bg-gradient-to-br from-primary/15 via-primary/8 to-primary/3 px-5 py-5 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground leading-tight">Completed Prepaid Label</h3>
              <p className="text-xs text-primary font-medium mt-0.5">You fill everything in — they just print</p>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {/* Best when */}
            <div className="rounded-xl bg-blue-50 border border-blue-200/60 px-4 py-3">
              <p className="text-sm font-medium text-blue-800">Best when you already know…</p>
              <ul className="mt-1.5 space-y-1">
                <li className="flex items-start gap-2 text-sm text-blue-700">
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
                  Where the item is shipping from
                </li>
                <li className="flex items-start gap-2 text-sm text-blue-700">
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
                  What's being shipped (size, weight)
                </li>
              </ul>
            </div>

            {/* How it works */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">How it works</p>
              <ol className="space-y-2">
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-blue-100 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
                  <span className="text-sm text-foreground">You enter the sender's address and package details</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-blue-100 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
                  <span className="text-sm text-foreground">Pick a carrier and shipping speed</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-blue-100 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
                  <span className="text-sm text-foreground">Send them the label — all they do is print and stick it on the box</span>
                </li>
              </ol>
            </div>

            {/* Sender experience */}
            <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
              <p className="text-xs font-semibold text-muted-foreground mb-1">What the sender does</p>
              <p className="text-sm text-foreground">Prints the label you made. That's it — zero decisions for them.</p>
            </div>

            {/* CTA */}
            <div className="flex items-center gap-1 text-sm font-medium text-primary group-hover:gap-2 transition-all pt-1">
              Choose this option <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </motion.button>
      </div>
    </div>
  );
}
