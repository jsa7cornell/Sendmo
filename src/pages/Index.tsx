import { Link2, Shield, Zap, ArrowRight, CheckCircle2, Users, CreditCard, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";
import SiteFooter from "@/components/SiteFooter";
import { SELLER_LINK_VISIBLE, SELLER_LINK_LIVE } from "@/lib/featureFlags";

export default function Index() {
  // Everyone lands here at sendmo.co — signed in or not. (Reverses T3-3, which
  // bounced signed-in visitors to /dashboard; the dashboard is now one click
  // away in the header user menu instead of a forced destination.)
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader />

      {/* Hero */}
      <section className="container max-w-5xl mx-auto px-4 pt-16 pb-20 text-center">
        {/* The two product nouns take their path color (blue = you pay,
            green = buyer pays) and each card below repeats its color as a
            top rule — the title's color coding IS the wayfinding, so the
            spans and the rules must stay in sync. */}
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground leading-tight max-w-3xl mx-auto text-balance">
          Shareable <span className="text-primary">shipping labels</span> and{" "}
          <span className="text-emerald-600">shipping links</span>{" "}
          <span className="text-muted-foreground font-semibold">
            for buying, selling, and just generally getting stuff
          </span>{" "}
          where it needs to go.
        </h1>

        {/* Two doors, split on who pays. Launch-gated — with the seller flag
            off this renders as the single you-pay card it has always been. */}
        <div
          className={`grid gap-4 mx-auto mt-12 text-left ${
            SELLER_LINK_VISIBLE ? "sm:grid-cols-2 max-w-3xl" : "max-w-md"
          }`}
        >
          <div className="relative overflow-hidden bg-card rounded-2xl border border-border shadow-sm p-6 flex flex-col gap-3">
            <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-primary" />
            <h2 className="text-xl font-bold text-foreground">Buy a Shipping Label</h2>
            <p className="text-sm text-muted-foreground leading-relaxed flex-1">
              Buy a shipping label that you or someone else can fill out.
            </p>
            <Button
              className="rounded-xl gap-2 self-start"
              onClick={() => window.location.href = "/onboarding"}
            >
              Buy a shipping label
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>

          {SELLER_LINK_VISIBLE && (
            <div className="relative overflow-hidden bg-card rounded-2xl border border-border shadow-sm p-6 flex flex-col gap-3">
              <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-emerald-600" />
              <h2 className="text-xl font-bold text-foreground">Create a Shipping Checkout Link</h2>
              <p className="text-sm text-muted-foreground leading-relaxed flex-1">
                Allow your buyers to pay for shipping — useful on Facebook Marketplace.
              </p>
              <Button
                disabled={!SELLER_LINK_LIVE}
                className="rounded-xl gap-2 self-start bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={SELLER_LINK_LIVE ? () => { window.location.href = "/sell"; } : undefined}
              >
                Create a checkout link
                {SELLER_LINK_LIVE ? (
                  <ArrowRight className="w-4 h-4" />
                ) : (
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-white/20 rounded-full px-2 py-0.5">
                    Soon
                  </span>
                )}
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* How it works */}
      <section className="container max-w-5xl mx-auto px-4 py-20">
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-4">
          How SendMo works
        </h2>
        <p className="text-muted-foreground text-center mb-12 max-w-lg mx-auto">
          From "can you ship this to me?" to a label in their hands — in minutes.
        </p>

        <div className="grid gap-6 sm:grid-cols-3">
          {[
            {
              step: "1",
              icon: Link2,
              title: "Create a label link",
              desc: "Enter your address, set your shipping preferences, and get a shareable link. Your address stays private.",
            },
            {
              step: "2",
              icon: Package,
              title: "Sender enters details",
              desc: "The sender clicks your link, enters the package dimensions and weight, and picks a shipping speed.",
            },
            {
              step: "3",
              icon: CheckCircle2,
              title: "Print & ship",
              desc: "A prepaid label is generated instantly. The sender prints it, attaches it, and drops off the package.",
            },
          ].map((item) => (
            <div key={item.step} className="bg-card rounded-2xl border border-border shadow-sm p-6 text-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4">
                <item.icon className="w-6 h-6" />
              </div>
              <div className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-bold text-muted-foreground mb-3">
                {item.step}
              </div>
              <h3 className="font-semibold text-foreground mb-2">{item.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Value props */}
      <section className="container max-w-5xl mx-auto px-4 py-20">
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-12">
          Why SendMo?
        </h2>

        <div className="grid gap-6 sm:grid-cols-2">
          {[
            {
              icon: Shield,
              title: "Address stays private",
              desc: "Your address is never visible to senders. It only appears on the printed label.",
            },
            {
              icon: CreditCard,
              title: "Recipient pays, sender ships",
              desc: "No more Venmo-ing shipping costs back and forth. One clean transaction.",
            },
            {
              icon: Users,
              title: "Works with anyone",
              desc: "Share your link with marketplace sellers, friends, family, or vendors. No account needed to send.",
            },
            {
              icon: Zap,
              title: "Real carrier rates",
              desc: "Compare USPS, UPS, and FedEx rates side by side. Pick the speed and price that works for you.",
            },
          ].map((item) => (
            <div key={item.title} className="flex gap-4 bg-card rounded-2xl border border-border shadow-sm p-5">
              <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                <item.icon className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground mb-1">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Use cases */}
      <section className="container max-w-5xl mx-auto px-4 py-20">
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground text-center mb-4">
          Perfect for
        </h2>
        <p className="text-muted-foreground text-center mb-12">
          Anyone who receives packages from multiple senders
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { emoji: "🛒", title: "Marketplace buyers", desc: "Facebook Marketplace, Craigslist, OfferUp — get sellers to ship to you easily" },
            { emoji: "🏢", title: "Office managers", desc: "One link for all vendors and employees to ship items to the office" },
            { emoji: "🎁", title: "Gift recipients", desc: "Share with friends and family so they can send gifts without asking for your address" },
          ].map((item) => (
            <div key={item.title} className="bg-card rounded-2xl border border-border shadow-sm p-5 text-center">
              <span className="text-3xl mb-3 block">{item.emoji}</span>
              <h3 className="font-semibold text-foreground mb-1">{item.title}</h3>
              <p className="text-sm text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="container max-w-5xl mx-auto px-4 py-20 text-center">
        <div className="bg-primary/5 border border-primary/20 rounded-2xl p-10 sm:p-16">
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground mb-4">
            Ready to simplify shipping?
          </h2>
          <p className="text-muted-foreground mb-8 max-w-md mx-auto">
            Your first link takes about 60 seconds to set up. No account required.
          </p>
          <Button
            className="rounded-xl text-lg py-6 px-10 shadow-md gap-2"
            onClick={() => window.location.href = "/onboarding"}
          >
            Get started
            <ArrowRight className="w-5 h-5" />
          </Button>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
