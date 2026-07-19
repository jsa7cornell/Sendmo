import { motion } from "framer-motion";
import {
  Link2, CheckCircle2, ArrowRight,
  HelpCircle, FileText, Tag,
} from "lucide-react";
import type { OnboardingChoice } from "@/lib/types";

interface Props {
  onSelect: (choice: OnboardingChoice) => void;
}

export default function RecipientStepPathChoice({ onSelect }: Props) {
  return (
    <div className="space-y-5">
      <div className="text-center mb-6">
        {/* Heading is intent-neutral: "prepaid" (= recipient-paid) no longer fits the seller card. */}
        <h1 className="text-2xl font-bold text-foreground">How do you want to ship?</h1>
        <p className="text-muted-foreground mt-2">Pick the setup that matches your situation</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* ── Flexible Prepaid Shipping Link ── */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.985 }}
          onClick={() => onSelect("flexible")}
          className="text-left bg-card rounded-2xl border border-border shadow-sm overflow-hidden group hover:border-violet-400/60 hover:shadow-md transition-all"
        >
          {/* Header */}
          <div className="relative bg-gradient-to-br from-violet-500/15 via-violet-500/8 to-violet-500/3 px-5 py-5 flex items-center gap-3">
            <span className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border/60">You pay</span>
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center shrink-0">
              <Link2 className="w-5 h-5 text-violet-600" />
            </div>
            <div className="pr-14">
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
          <div className="relative bg-gradient-to-br from-primary/15 via-primary/8 to-primary/3 px-5 py-5 flex items-center gap-3">
            <span className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border/60">You pay</span>
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
              <FileText className="w-5 h-5 text-primary" />
            </div>
            <div className="pr-14">
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

        {/* ── Sell & Ship (buyer-pays seller link) ── */}
        <motion.button
          type="button"
          whileTap={{ scale: 0.985 }}
          onClick={() => onSelect("seller_link")}
          className="text-left bg-card rounded-2xl border border-emerald-300/50 shadow-sm overflow-hidden group hover:border-emerald-400/70 hover:shadow-md transition-all"
        >
          {/* Header */}
          <div className="relative bg-gradient-to-br from-emerald-500/15 via-emerald-500/8 to-emerald-500/3 px-5 py-5 flex items-center gap-3">
            <span className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200">Buyer pays</span>
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
              <Tag className="w-5 h-5 text-emerald-600" />
            </div>
            <div className="pr-20">
              <h3 className="font-semibold text-foreground leading-tight flex items-center gap-2">
                Sell &amp; Ship
                <span className="text-[10px] font-bold uppercase tracking-wide text-white bg-emerald-600 px-1.5 py-0.5 rounded">New</span>
              </h3>
              <p className="text-xs text-emerald-600 font-medium mt-0.5">Post a link — the buyer pays for shipping</p>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {/* Best when */}
            <div className="rounded-xl bg-emerald-50 border border-emerald-200/60 px-4 py-3">
              <p className="text-sm font-medium text-emerald-800">Best when…</p>
              <ul className="mt-1.5 space-y-1">
                <li className="flex items-start gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
                  You're selling an item
                </li>
                <li className="flex items-start gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />
                  You want the buyer to pay shipping
                </li>
              </ul>
            </div>

            {/* How it works */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">How it works</p>
              <ol className="space-y-2">
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
                  <span className="text-sm text-foreground">You enter your address and package size &amp; weight</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
                  <span className="text-sm text-foreground">Share your link — in a listing or straight to the buyer</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
                  <span className="text-sm text-foreground">Buyer enters their address, picks a speed, and pays — you print the label</span>
                </li>
              </ol>
            </div>

            {/* Buyer experience */}
            <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
              <p className="text-xs font-semibold text-muted-foreground mb-1">What the buyer does</p>
              <p className="text-sm text-foreground">Opens your link, enters their address, picks a speed, and pays. No account needed.</p>
            </div>

            {/* CTA */}
            <div className="flex items-center gap-1 text-sm font-medium text-emerald-600 group-hover:gap-2 transition-all pt-1">
              Choose this option <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </motion.button>
      </div>
    </div>
  );
}
