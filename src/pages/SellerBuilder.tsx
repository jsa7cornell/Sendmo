import { useNavigate } from "react-router-dom";
import { Tag, ArrowLeft, MapPin, Share2, CreditCard } from "lucide-react";
import AppHeader from "@/components/AppHeader";

/**
 * Seller-builder — the "Sell & Ship" (buyer-pays seller link) entry surface.
 *
 * Decided proposal: proposals/2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md
 *
 * PR2 scaffold: routing + the seller-facing intro. Deliberately its OWN page,
 * NOT the recipient RecipientPath state machine (review N5). The multi-step
 * form lands here next: (1) origin address + Guesstimator package + optional
 * carrier constraint + single-use/reusable, (2) create the seller_link row,
 * (3) share screen. Link creation + the buyer checkout need the 040 schema on
 * a live DB, so those steps arrive with PR3.
 */
export default function SellerBuilder() {
  const navigate = useNavigate();

  const steps = [
    { icon: MapPin, title: "Your address & package", body: "Enter where it ships from and the box size & weight — the Guesstimator can fill this in." },
    { icon: Share2, title: "Share your link", body: "Drop it in a listing or send it straight to the buyer." },
    { icon: CreditCard, title: "Buyer pays, you print", body: "The buyer adds their address, picks a speed, and pays. You get a ready-to-print label." },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        <button
          type="button"
          onClick={() => navigate("/onboarding")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to shipping options
        </button>

        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 flex items-center justify-center mx-auto">
            <Tag className="w-7 h-7 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Sell &amp; Ship</h1>
          <p className="text-muted-foreground max-w-md mx-auto">
            Create a link, post it, and the buyer pays for shipping — you just print the label.
          </p>
          <span className="inline-block text-xs font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-full">
            Buyer pays
          </span>
        </div>

        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-4 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
                <s.icon className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="font-semibold text-foreground leading-tight">{i + 1}. {s.title}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border border-dashed border-border bg-muted/30 px-5 py-4 text-center">
          <p className="text-sm text-muted-foreground">
            The builder form is being wired up next. This is the entry point for the new seller flow.
          </p>
        </div>
      </div>
    </div>
  );
}
