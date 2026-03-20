import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2, AlertCircle, Package, Truck,
  Zap, Leaf, ArrowLeft, ArrowRight, CheckCircle2,
  DollarSign, Shield,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import MagicGuestimator from "@/components/recipient/MagicGuestimator";
import { fetchLink, fetchSenderRates, formatCents } from "@/lib/api";
import type { GuestimatorResult } from "@/lib/types";
import type { LinkData } from "@/lib/api";
import type { AddressInput, ShippingRate } from "@/lib/types";

// ─── Speed tier helpers ─────────────────────────────────────

function speedInfo(speed: string | null) {
  if (!speed) return null;
  const map: Record<string, { label: string; Icon: typeof Truck; color: string }> = {
    economy: { label: "Economy", Icon: Leaf, color: "text-emerald-600" },
    standard: { label: "Standard", Icon: Truck, color: "text-primary" },
    express: { label: "Express", Icon: Zap, color: "text-orange-600" },
  };
  return map[speed] || null;
}

// ─── Sender Step: Address ───────────────────────────────────

function SenderStepAddress({
  linkData,
  address,
  onAddressChange,
  onContinue,
}: {
  linkData: LinkData;
  address: AddressInput;
  onAddressChange: (a: AddressInput) => void;
  onContinue: () => void;
}) {
  const [tried, setTried] = useState(false);

  function handleContinue() {
    setTried(true);
    if (!address.name || !address.street || !address.city || !address.state || !address.zip) return;
    onContinue();
  }

  const speed = speedInfo(linkData.preferred_speed);

  return (
    <div className="space-y-5">
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold text-foreground">Ship a package</h1>
        <p className="text-muted-foreground mt-1">
          {linkData.recipient_name} has prepaid for shipping to{" "}
          {linkData.recipient_city}, {linkData.recipient_state}
        </p>
      </div>

      {/* Link config banner */}
      <div className="bg-muted/50 rounded-xl border border-border px-4 py-3">
        <div className="flex flex-wrap gap-3 text-xs">
          {speed && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <speed.Icon className={`w-3 h-3 ${speed.color}`} />
              {speed.label} shipping
            </span>
          )}
          {linkData.preferred_carrier && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Truck className="w-3 h-3" />
              {linkData.preferred_carrier.toUpperCase()} only
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <DollarSign className="w-3 h-3" />
            Up to {formatCents(linkData.max_price_cents)}
          </span>
        </div>
      </div>

      {/* Address form */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-4">Where is the package shipping from?</h3>
        <SmartAddressInput
          label="Sender address"
          nameLabel="Sender's Name"
          nameHint="your name"
          value={address}
          onChange={onAddressChange}
          error={tried && !address.street ? "Please enter an address" : undefined}
        />
      </div>

      <Button onClick={handleContinue} className="w-full rounded-xl shadow-sm">
        See shipping options
        <ArrowRight className="w-4 h-4 ml-1" />
      </Button>
    </div>
  );
}

// ─── Sender Step: Package Details ───────────────────────────

function SenderStepPackage({
  onSubmit,
  onBack,
}: {
  onSubmit: (parcel: { length: number; width: number; height: number; weight: number; description: string }) => void;
  onBack: () => void;
}) {
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [description, setDescription] = useState("");
  const [tried, setTried] = useState(false);

  function handleGuestimation(result: GuestimatorResult) {
    setLength(String(result.length));
    setWidth(String(result.width));
    setHeight(String(result.height));
    setWeight(String(result.weightLbs));
    setDescription(result.itemName);
  }

  function handleContinue() {
    setTried(true);
    const l = parseFloat(length);
    const w = parseFloat(width);
    const h = parseFloat(height);
    const wt = parseFloat(weight);
    if (!l || !w || !h || !wt) return;

    onSubmit({
      length: l,
      width: w,
      height: h,
      weight: wt * 16, // lbs → oz
      description,
    });
  }

  const missing = tried && (!length || !width || !height || !weight);

  return (
    <div className="space-y-5">
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold text-foreground">Package details</h1>
        <p className="text-muted-foreground mt-1">Tell us about what you're shipping</p>
      </div>

      {/* Magic Guestimator */}
      <MagicGuestimator onResult={handleGuestimation} />

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        {/* Dimensions */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Box dimensions <span className="font-normal text-muted-foreground">(inches)</span>
          </label>
          <div className="grid grid-cols-3 gap-3">
            {[
              { val: length, set: setLength, ph: "Length" },
              { val: width, set: setWidth, ph: "Width" },
              { val: height, set: setHeight, ph: "Height" },
            ].map(({ val, set, ph }) => (
              <input
                key={ph}
                type="number"
                placeholder={ph}
                value={val}
                onChange={(e) => set(e.target.value)}
                className={`rounded-xl border ${tried && !val ? "border-destructive" : "border-border"} bg-background px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`}
              />
            ))}
          </div>
        </div>

        {/* Weight */}
        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Weight <span className="font-normal text-muted-foreground">(lbs)</span>
          </label>
          <input
            type="number"
            placeholder="e.g. 5"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className={`w-full rounded-xl border ${tried && !weight ? "border-destructive" : "border-border"} bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`}
          />
        </div>

        {missing && (
          <p className="text-sm text-destructive">Please fill in all dimensions and weight.</p>
        )}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <Button onClick={handleContinue} className="flex-1 rounded-xl shadow-sm">
          Get shipping options
        </Button>
      </div>
    </div>
  );
}

// ─── Sender Step: Rates ─────────────────────────────────────

function SenderStepRates({
  linkData,
  rates,
  loading,
  error,
  selectedRate,
  onSelectRate,
  onContinue,
  onBack,
  onRetry,
}: {
  linkData: LinkData;
  rates: ShippingRate[];
  loading: boolean;
  error: string | null;
  selectedRate: ShippingRate | null;
  onSelectRate: (r: ShippingRate) => void;
  onContinue: () => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="text-center py-16 space-y-3">
        <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
        <p className="text-foreground font-medium">Finding shipping options…</p>
        <p className="text-sm text-muted-foreground">Checking rates from available carriers</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-2">Rates are playing hide and seek</h2>
          <p className="text-sm text-muted-foreground mb-4">We couldn't reach the shipping carriers right now. It's probably them, not you.</p>
          <div className="flex gap-3 justify-center">
            <Button variant="outline" onClick={onBack} className="rounded-xl">
              <ArrowLeft className="w-4 h-4 mr-1" /> Edit details
            </Button>
            <Button onClick={onRetry} className="rounded-xl">Try again</Button>
          </div>
        </div>
      </div>
    );
  }

  if (rates.length === 0) {
    const speed = speedInfo(linkData.preferred_speed);
    return (
      <div className="space-y-5">
        <div className="bg-muted rounded-2xl p-6 text-center">
          <Package className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-2">No options for this one</h2>
          <p className="text-sm text-muted-foreground mb-1">
            The recipient's preferences are a little too picky for this package. Try adjusting the size or weight.
          </p>
          <p className="text-xs text-muted-foreground">
            {linkData.preferred_carrier && `Carrier: ${linkData.preferred_carrier.toUpperCase()}. `}
            {speed && `Speed: ${speed.label} or faster. `}
            Max: {formatCents(linkData.max_price_cents)}.
          </p>
          <Button variant="outline" onClick={onBack} className="rounded-xl mt-4">
            <ArrowLeft className="w-4 h-4 mr-1" /> Edit package details
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="text-center mb-4">
        <h1 className="text-2xl font-bold text-foreground">Choose a shipping option</h1>
        <p className="text-muted-foreground mt-1">
          Shipping to {linkData.recipient_city}, {linkData.recipient_state} · Prepaid by {linkData.recipient_name}
        </p>
      </div>

      <div className="space-y-3">
        {rates.map((rate) => {
          const isSelected = selectedRate?.id === rate.id;
          return (
            <button
              key={rate.id}
              type="button"
              onClick={() => onSelectRate(rate)}
              className={`
                w-full text-left rounded-2xl border-2 p-4 transition-all
                ${isSelected
                  ? "border-primary bg-primary/5 shadow-sm"
                  : "border-border bg-card hover:border-muted-foreground/30"
                }
              `}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-foreground">{rate.carrier} {rate.service}</p>
                  <p className="text-sm text-muted-foreground">
                    {rate.estimated_days
                      ? `${rate.estimated_days} business day${rate.estimated_days > 1 ? "s" : ""}`
                      : "Estimated delivery TBD"}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-lg font-bold ${isSelected ? "text-primary" : "text-foreground"}`}>
                    {formatCents(rate.display_price_cents)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">prepaid by {linkData.recipient_name || "recipient"}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <Button
          onClick={onContinue}
          disabled={!selectedRate}
          className="flex-1 rounded-xl shadow-sm"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

// ─── Main Sender Flow ───────────────────────────────────────

type Step = "loading" | "error" | "address" | "package" | "rates" | "done";

export default function SenderFlow() {
  const { shortCode } = useParams<{ shortCode: string }>();

  const [step, setStep] = useState<Step>("loading");
  const [linkData, setLinkData] = useState<LinkData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [senderAddress, setSenderAddress] = useState<AddressInput>({
    name: "", street: "", city: "", state: "", zip: "",
  });
  const [parcel, setParcel] = useState<{ length: number; width: number; height: number; weight: number; description: string } | null>(null);

  const [rates, setRates] = useState<ShippingRate[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);

  // Load link on mount
  useEffect(() => {
    if (!shortCode) {
      setLoadError("No link code provided");
      setStep("error");
      return;
    }

    fetchLink(shortCode)
      .then((data) => {
        setLinkData(data);
        setStep("address");
      })
      .catch((err) => {
        setLoadError(err.message || "We looked everywhere, but this link doesn't seem to exist. Double-check the URL?");
        setStep("error");
      });
  }, [shortCode]);

  // Fetch rates
  async function handleFetchRates(parcelData?: typeof parcel) {
    const p = parcelData || parcel;
    if (!linkData || !p) return;

    setRatesLoading(true);
    setRatesError(null);
    setSelectedRate(null);
    setStep("rates");

    try {
      const result = await fetchSenderRates(
        senderAddress,
        {
          name: linkData.recipient_name || "Recipient",
          city: linkData.recipient_city || "",
          state: linkData.recipient_state || "",
          zip: linkData.recipient_zip || "",
        },
        { length: p.length, width: p.width, height: p.height, weight: p.weight },
        {
          preferred_carrier: linkData.preferred_carrier,
          preferred_speed: linkData.preferred_speed,
          max_price_cents: linkData.max_price_cents,
        },
      );

      setRates(result.rates);
    } catch (err) {
      setRatesError(err instanceof Error ? err.message : "Failed to fetch rates");
    } finally {
      setRatesLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader actions={
        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5" />
          Prepaid shipping
        </span>
      } />

      <div className="flex-1 py-8 px-4">
        <div className="container max-w-md mx-auto">
          <AnimatePresence mode="wait">
            {step === "loading" && (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center py-16 space-y-3"
              >
                <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
                <p className="text-foreground font-medium">Loading shipping link…</p>
              </motion.div>
            )}

            {step === "error" && (
              <motion.div key="error" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
                  <AlertCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
                  <h2 className="text-lg font-bold text-foreground mb-2">Hmm, that link didn't work</h2>
                  <p className="text-sm text-muted-foreground">{loadError}</p>
                </div>
                <Button variant="outline" className="w-full rounded-xl mt-5" onClick={() => (window.location.href = "/")}>
                  Back to SendMo
                </Button>
              </motion.div>
            )}

            {step === "address" && linkData && (
              <motion.div key="address" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <SenderStepAddress
                  linkData={linkData}
                  address={senderAddress}
                  onAddressChange={setSenderAddress}
                  onContinue={() => setStep("package")}
                />
              </motion.div>
            )}

            {step === "package" && linkData && (
              <motion.div key="package" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <SenderStepPackage
                  onSubmit={(p) => {
                    setParcel(p);
                    handleFetchRates(p);
                  }}
                  onBack={() => setStep("address")}
                />
              </motion.div>
            )}

            {step === "rates" && linkData && (
              <motion.div key="rates" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <SenderStepRates
                  linkData={linkData}
                  rates={rates}
                  loading={ratesLoading}
                  error={ratesError}
                  selectedRate={selectedRate}
                  onSelectRate={setSelectedRate}
                  onContinue={() => setStep("done")}
                  onBack={() => setStep("package")}
                  onRetry={() => handleFetchRates()}
                />
              </motion.div>
            )}

            {step === "done" && linkData && selectedRate && (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                <div className="space-y-5">
                  <div className="bg-success/10 border border-success/30 rounded-2xl p-6 text-center">
                    <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-3" />
                    <h2 className="text-xl font-bold text-foreground">Your label is ready!</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      {selectedRate.carrier} {selectedRate.service} — {formatCents(selectedRate.display_price_cents)}, prepaid by {linkData.recipient_name || "recipient"}
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
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">From</dt>
                        <dd className="font-medium text-foreground">{senderAddress.city}, {senderAddress.state}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">To</dt>
                        <dd className="font-medium text-foreground">{linkData.recipient_city}, {linkData.recipient_state}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Carrier</dt>
                        <dd className="font-medium text-foreground">{selectedRate.carrier} {selectedRate.service}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Cost</dt>
                        <dd className="font-medium text-foreground">{formatCents(selectedRate.display_price_cents)} (prepaid by {linkData.recipient_name || "recipient"})</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
