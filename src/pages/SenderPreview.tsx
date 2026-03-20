import { useState } from "react";
import {
  AlertCircle, Package, Truck,
  Zap, Leaf, ArrowLeft, ArrowRight, CheckCircle2,
  DollarSign,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import MagicGuestimator from "@/components/recipient/MagicGuestimator";
import { formatCents } from "@/lib/api";
import type { LinkData } from "@/lib/api";
import type { AddressInput, ShippingRate, GuestimatorResult } from "@/lib/types";

// ─── Mock data ──────────────────────────────────────────────

const MOCK_LINK: LinkData = {
  id: "mock-id",
  short_code: "AbCdEf1234",
  link_type: "flexible",
  status: "active",
  max_price_cents: 5000, // $50
  preferred_speed: "standard",
  preferred_carrier: null,
  size_hint: null,
  notes: null,
  recipient_city: "San Francisco",
  recipient_state: "CA",
  recipient_zip: "94107",
  recipient_name: "John",
};

const MOCK_LINK_CARRIER: LinkData = {
  ...MOCK_LINK,
  preferred_carrier: "usps",
  max_price_cents: 2500, // $25
  preferred_speed: "economy",
};

const MOCK_RATES: ShippingRate[] = [
  { id: "rate_1", carrier: "USPS", service: "Ground Advantage", rate_cents: 523, display_price_cents: 701, estimated_days: 5, currency: "USD" },
  { id: "rate_2", carrier: "USPS", service: "Priority Mail", rate_cents: 890, display_price_cents: 1124, estimated_days: 3, currency: "USD" },
  { id: "rate_3", carrier: "UPS", service: "Ground", rate_cents: 1200, display_price_cents: 1480, estimated_days: 4, currency: "USD" },
];

// ─── Speed helpers ──────────────────────────────────────────

function speedInfo(speed: string | null) {
  if (!speed) return null;
  const map: Record<string, { label: string; Icon: typeof Truck; color: string }> = {
    economy: { label: "Economy", Icon: Leaf, color: "text-emerald-600" },
    standard: { label: "Standard", Icon: Truck, color: "text-primary" },
    express: { label: "Express", Icon: Zap, color: "text-orange-600" },
  };
  return map[speed] || null;
}

// ─── Preview scenarios ──────────────────────────────────────

type Scenario = "happy" | "carrier_lock" | "no_rates" | "error_link" | "error_rates" | "expired" | "used";

export default function SenderPreview() {
  const [scenario, setScenario] = useState<Scenario>("happy");

  const scenarios: { id: Scenario; label: string }[] = [
    { id: "happy", label: "Happy path" },
    { id: "carrier_lock", label: "USPS only + $25 cap" },
    { id: "no_rates", label: "No rates match" },
    { id: "error_rates", label: "Rate fetch error" },
    { id: "error_link", label: "Invalid link" },
    { id: "expired", label: "Expired link" },
    { id: "used", label: "Already used" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader />
      <div className="flex-1 py-6 px-4">
        {/* Scenario picker */}
        <div className="container max-w-2xl mx-auto mb-8">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest text-center mb-3">
            Sender Flow Preview — Pick a scenario
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            {scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => setScenario(s.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                  scenario === s.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-muted-foreground/40"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="container max-w-md mx-auto">
          {scenario === "happy" && <HappyPathDemo link={MOCK_LINK} rates={MOCK_RATES} />}
          {scenario === "carrier_lock" && <HappyPathDemo link={MOCK_LINK_CARRIER} rates={[MOCK_RATES[0]]} />}
          {scenario === "no_rates" && <NoRatesDemo />}
          {scenario === "error_rates" && <RatesErrorDemo />}
          {scenario === "error_link" && <LinkErrorDemo message="We looked everywhere, but this link doesn't exist. Double-check the URL?" />}
          {scenario === "expired" && <LinkErrorDemo message="This link has expired — it had a good run. Ask the sender for a fresh one!" />}
          {scenario === "used" && <LinkErrorDemo message="This link already shipped a package. One and done! Ask for a new link if you need another." />}
        </div>
      </div>
    </div>
  );
}

// ─── Happy path demo ────────────────────────────────────────

function HappyPathDemo({ link, rates }: { link: LinkData; rates: ShippingRate[] }) {
  const [step, setStep] = useState<"address" | "package" | "rates" | "done">("address");
  const [address, setAddress] = useState<AddressInput>({ name: "", street: "", city: "", state: "", zip: "" });
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);

  const speed = speedInfo(link.preferred_speed);

  // Config banner used across steps
  const configBanner = (
    <div className="bg-muted/50 rounded-xl border border-border px-4 py-3 mb-5">
      <div className="flex flex-wrap gap-3 text-xs">
        {speed && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <speed.Icon className={`w-3 h-3 ${speed.color}`} />
            {speed.label} shipping
          </span>
        )}
        {link.preferred_carrier && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Truck className="w-3 h-3" />
            {link.preferred_carrier.toUpperCase()} only
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <DollarSign className="w-3 h-3" />
          Up to {formatCents(link.max_price_cents)}
        </span>
      </div>
    </div>
  );

  if (step === "address") {
    return (
      <div className="space-y-5">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold text-foreground">Ship a package</h1>
          <p className="text-muted-foreground mt-1">
            {link.recipient_name} has prepaid for shipping to {link.recipient_city}, {link.recipient_state}
          </p>
        </div>
        {configBanner}
        <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
          <h3 className="text-sm font-semibold text-foreground mb-4">Where is the package shipping from?</h3>
          <SmartAddressInput label="Sender address" nameLabel="Sender's Name" nameHint="your name" value={address} onChange={setAddress} />
        </div>
        <Button onClick={() => setStep("package")} className="w-full rounded-xl shadow-sm">
          See shipping options <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    );
  }

  if (step === "package") {
    return (
      <div className="space-y-5">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold text-foreground">Package details</h1>
          <p className="text-muted-foreground mt-1">Tell us about what you're shipping</p>
        </div>
        {/* Magic Guestimator */}
        <MagicGuestimator onResult={(_r: GuestimatorResult) => { /* preview — no-op */ }} />
        <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">Box dimensions <span className="font-normal text-muted-foreground">(inches)</span></label>
            <div className="grid grid-cols-3 gap-3">
              {["Length", "Width", "Height"].map((ph) => (
                <input key={ph} type="number" placeholder={ph} className="rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-center" />
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">Weight <span className="font-normal text-muted-foreground">(lbs)</span></label>
            <input type="number" placeholder="e.g. 5" className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm" />
          </div>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setStep("address")} className="rounded-xl"><ArrowLeft className="w-4 h-4 mr-1" /> Back</Button>
          <Button onClick={() => setStep("rates")} className="flex-1 rounded-xl shadow-sm">Get shipping options</Button>
        </div>
      </div>
    );
  }

  if (step === "rates") {
    return (
      <div className="space-y-5">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold text-foreground">Choose a shipping option</h1>
          <p className="text-muted-foreground mt-1">
            Shipping to {link.recipient_city}, {link.recipient_state} · Prepaid by {link.recipient_name}
          </p>
        </div>
        <div className="space-y-3">
          {rates.map((rate) => {
            const isSelected = selectedRate?.id === rate.id;
            return (
              <button
                key={rate.id}
                type="button"
                onClick={() => setSelectedRate(rate)}
                className={`w-full text-left rounded-2xl border-2 p-4 transition-all ${
                  isSelected ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-card hover:border-muted-foreground/30"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-foreground">{rate.carrier} {rate.service}</p>
                    <p className="text-sm text-muted-foreground">{rate.estimated_days} business days</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-bold ${isSelected ? "text-primary" : "text-foreground"}`}>{formatCents(rate.display_price_cents)}</p>
                    <p className="text-[10px] text-muted-foreground">prepaid by {link.recipient_name || "recipient"}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setStep("package")} className="rounded-xl"><ArrowLeft className="w-4 h-4 mr-1" /> Back</Button>
          <Button onClick={() => setStep("done")} disabled={!selectedRate} className="flex-1 rounded-xl shadow-sm">Continue</Button>
        </div>
      </div>
    );
  }

  // Done
  return (
    <div className="space-y-5">
      <div className="bg-success/10 border border-success/30 rounded-2xl p-6 text-center">
        <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-3" />
        <h2 className="text-xl font-bold text-foreground">Your label is ready!</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {selectedRate?.carrier} {selectedRate?.service} — {selectedRate ? formatCents(selectedRate.display_price_cents) : ""}, prepaid by {link.recipient_name || "recipient"}
        </p>
      </div>
      {/* Label placeholder */}
      <div className="bg-card rounded-2xl border-2 border-dashed border-border shadow-sm p-8 text-center">
        <Package className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">Shipping label</p>
        <p className="text-xs text-muted-foreground mb-4">Label generation coming soon — Stripe payment integration in progress.</p>
      </div>
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Shipment summary</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-muted-foreground">To</dt><dd className="font-medium">{link.recipient_city}, {link.recipient_state}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Carrier</dt><dd className="font-medium">{selectedRate?.carrier} {selectedRate?.service}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Cost</dt><dd className="font-medium">{selectedRate ? formatCents(selectedRate.display_price_cents) : ""} (prepaid by {link.recipient_name || "recipient"})</dd></div>
        </dl>
      </div>
    </div>
  );
}

// ─── No rates demo ──────────────────────────────────────────

function NoRatesDemo() {
  const link = MOCK_LINK_CARRIER;
  const speed = speedInfo(link.preferred_speed);
  return (
    <div className="space-y-5">
      <div className="bg-muted rounded-2xl p-6 text-center">
        <Package className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
        <h2 className="text-lg font-bold text-foreground mb-2">No options for this one</h2>
        <p className="text-sm text-muted-foreground mb-1">
          The recipient's preferences are a little too picky for this package. Try adjusting the size or weight.
        </p>
        <p className="text-xs text-muted-foreground">
          {link.preferred_carrier && `Carrier: ${link.preferred_carrier.toUpperCase()}. `}
          {speed && `Speed: ${speed.label} or faster. `}
          Max: {formatCents(link.max_price_cents)}.
        </p>
        <Button variant="outline" className="rounded-xl mt-4">
          <ArrowLeft className="w-4 h-4 mr-1" /> Edit package details
        </Button>
      </div>
    </div>
  );
}

// ─── Rate fetch error demo ──────────────────────────────────

function RatesErrorDemo() {
  return (
    <div className="space-y-5">
      <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
        <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
        <h2 className="text-lg font-bold text-foreground mb-2">Rates are playing hide and seek</h2>
        <p className="text-sm text-muted-foreground mb-4">
          We couldn't reach the shipping carriers right now. It's probably them, not you.
        </p>
        <div className="flex gap-3 justify-center">
          <Button variant="outline" className="rounded-xl">
            <ArrowLeft className="w-4 h-4 mr-1" /> Edit details
          </Button>
          <Button className="rounded-xl">Try again</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Link error demo ────────────────────────────────────────

function LinkErrorDemo({ message }: { message: string }) {
  return (
    <div className="space-y-5">
      <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
        <AlertCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
        <h2 className="text-lg font-bold text-foreground mb-2">Hmm, that link didn't work</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" className="w-full rounded-xl">
        Back to SendMo
      </Button>
    </div>
  );
}
