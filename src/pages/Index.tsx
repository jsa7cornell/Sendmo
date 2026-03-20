import { Link2, Shield, Zap, ArrowRight, CheckCircle2, Users, CreditCard, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";

export default function Index() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />

      {/* Hero */}
      <section className="container max-w-5xl mx-auto px-4 pt-16 pb-20 text-center">
        <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 text-primary px-4 py-1.5 text-sm font-medium mb-6">
          <Zap className="w-3.5 h-3.5" />
          Prepaid shipping made easy
        </div>

        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-foreground leading-tight max-w-3xl mx-auto">
          Create a shipping label.{" "}
          <span className="text-primary">Share it with anyone.</span>
        </h1>

        <p className="text-lg text-muted-foreground mt-6 max-w-2xl mx-auto leading-relaxed">
          Set up a link once. Share it with anyone who needs to send you something.
          They click, enter package details, and print a label — you pay, they ship. No back-and-forth.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10">
          <Button
            className="rounded-xl text-lg py-6 px-8 shadow-md gap-2"
            onClick={() => window.location.href = "/onboarding"}
          >
            Get started — it's free
            <ArrowRight className="w-5 h-5" />
          </Button>
          <Button
            variant="outline"
            className="rounded-xl text-lg py-6 px-8"
            onClick={() => window.location.href = "/faq"}
          >
            Learn more
          </Button>
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
            Create your label link
            <ArrowRight className="w-5 h-5" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-card">
        <div className="container max-w-5xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">SendMo — Prepaid shipping made easy</span>
          </div>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href="/faq" className="hover:text-foreground transition-colors">FAQ</a>
            <a href="mailto:support@sendmo.co" className="hover:text-foreground transition-colors">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
