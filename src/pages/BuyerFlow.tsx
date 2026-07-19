import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2, AlertCircle, ArrowLeft, ArrowRight, Lock, MapPin, Truck, Package,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";
import AddressForm from "@/components/forms/AddressForm";
import StripePaymentForm from "@/components/recipient/StripePaymentForm";
import {
  fetchBuyerRates, formatCents, createSellerCheckoutPI, buyLabelSeller, BuyLabelRateChangedError,
} from "@/lib/api";
import type { LinkData } from "@/lib/api";
import type { AddressInput, ShippingRate, LabelResult } from "@/lib/types";
import { emptyAddress, carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import { isUsablePhone } from "@/lib/phone";
import { isValidEmail, isPreferredRate, pickBestPerCarrier } from "@/components/sender/senderState";

// ─── Buyer rate-shopping flow (seller links) ────────────────
//
// Opened by an ANONYMOUS buyer at /s/<code> when link_type='seller_link'.
// The seller's origin + package are baked into the link (resolved server-side);
// the buyer supplies ONLY their destination, sees PRICE-VISIBLE rates, picks
// one, and pays on-session. No auth, no account creation.
//
// This component owns the whole flow, including the on-session payment. The
// review step shows the order, and on "Pay & get label" it mounts the shared
// StripePaymentForm with a seller-checkout createIntent (server derives the
// amount from the link — the buyer's client never sends one). After the card
// clears, buyLabelSeller buys the EasyPost label and we redirect to the
// tracking page. See M4 (seller-checkout + labels seller branch, deployed).

type BuyerStep = "address" | "rates" | "review";

const STEP_ORDER: BuyerStep[] = ["address", "rates", "review"];

export default function BuyerFlow({ linkData }: { linkData: LinkData }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<BuyerStep>("address");

  // ── Buyer-supplied inputs (the payment handler reads these) ──
  const [buyerAddress, setBuyerAddress] = useState<AddressInput>(emptyAddress());
  const [buyerEmail, setBuyerEmail] = useState("");
  const [tried, setTried] = useState(false); // show validation errors once submitted

  // ── Rates ──
  const [rates, setRates] = useState<ShippingRate[]>([]);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);
  // One EasyPost Shipment backs the whole rate list; seller-checkout + the
  // label buy both key off it. Threaded out of fetchBuyerRates (like fetchRates).
  const [easypostShipmentId, setEasypostShipmentId] = useState("");

  // ── Payment (review step) ──
  // Flip on "Pay & get label" so StripePaymentForm mounts (and creates the PI)
  // only after the buyer commits — not on every review render.
  const [paying, setPaying] = useState(false);
  // Set when the buy-time rate gate trips; shown as a banner back on the rates
  // step after we bounce the buyer there to re-shop.
  const [rateChangedNotice, setRateChangedNotice] = useState<string | null>(null);

  // LinkData (seller-link GET-by-code) exposes no is_test/live signal, so the
  // buyer client runs in TEST mode. The server still derives the true mode from
  // the link for both seller-checkout and the label buy; this only selects the
  // Stripe publishable key for Elements. Revisit if GET-by-code starts
  // returning is_test.
  const buyerLiveMode = false;

  const originLine = linkData.origin_city && linkData.origin_state
    ? `${linkData.origin_city}, ${linkData.origin_state}`
    : null;

  const addressComplete =
    !!buyerAddress.street && !!buyerAddress.city && !!buyerAddress.state &&
    !!buyerAddress.zip && isUsablePhone(buyerAddress.phone);
  const emailValid = isValidEmail(buyerEmail.trim());

  async function loadRates() {
    setStep("rates");
    setRatesLoading(true);
    setRatesError(null);
    setSelectedRate(null);
    setPaying(false);
    try {
      const { rates: r, easypost_shipment_id } = await fetchBuyerRates(
        {
          name: buyerAddress.name,
          street1: buyerAddress.street,
          city: buyerAddress.city,
          state: buyerAddress.state,
          zip: buyerAddress.zip,
          phone: buyerAddress.phone,
        },
        linkData.short_code,
      );
      setEasypostShipmentId(easypost_shipment_id);
      // Price-visible buyers shop on price: trim to one best option per carrier,
      // then order cheapest-first. Default-select the cheapest so there's always
      // a selection.
      const perCarrier = pickBestPerCarrier(r);
      const sorted = [...perCarrier].sort(
        (a, b) => a.display_price_cents - b.display_price_cents,
      );
      setRates(sorted);
      if (sorted.length > 0) setSelectedRate(sorted[0]);
    } catch (err) {
      setRatesError(err instanceof Error ? err.message : "Failed to fetch rates");
    } finally {
      setRatesLoading(false);
    }
  }

  function handleAddressContinue() {
    setTried(true);
    if (!addressComplete || !emailValid) return;
    setRateChangedNotice(null);
    loadRates();
  }

  // Redirect to the canonical tracking page after a successful label buy.
  // Copies RecipientStepPayment.redirectToTracking: ?fresh=1 flags the
  // celebration state, and ?cancel=<hex> passes the cancel_token so
  // TrackingPage writes it to sessionStorage on first render (enabling the
  // buyer's in-session Cancel). { replace: true } drops the payment step from
  // history.
  function redirectToTracking(result: LabelResult) {
    if (!result.public_code) return;
    const cancelSuffix = result.cancel_token ? `&cancel=${result.cancel_token}` : "";
    navigate(`/t/${result.public_code}?fresh=1${cancelSuffix}`, { replace: true });
  }

  // Called by StripePaymentForm AFTER the buyer's card is charged. Buys the
  // EasyPost label with the captured PI id, then redirects to tracking.
  async function handleBuyerSuccess(paymentIntentId: string) {
    if (!selectedRate || !easypostShipmentId) {
      throw new Error("Missing rate or shipment id");
    }
    try {
      const result = await buyLabelSeller({
        easypost_shipment_id: easypostShipmentId,
        easypost_rate_id: selectedRate.id,
        link_short_code: linkData.short_code,
        payment_intent_id: paymentIntentId,
        buyer_email: buyerEmail,
      });
      redirectToTracking(result);
    } catch (err) {
      // Buy-time rate gate trip — the PI was refunded server-side. Bounce back
      // to fresh rates with a notice. Do NOT re-throw: StripePaymentForm would
      // otherwise render it as a card error.
      if (err instanceof BuyLabelRateChangedError) {
        setRateChangedNotice("The shipping price changed — please re-check rates.");
        setPaying(false);
        loadRates();
        return;
      }
      throw err; // Let StripePaymentForm surface the inline error.
    }
  }

  // Fresh PI factory for StripePaymentForm — server derives the amount from the
  // link + rate; the buyer's client never sends one.
  const createSellerIntent = () =>
    createSellerCheckoutPI({
      link_short_code: linkData.short_code,
      easypost_shipment_id: easypostShipmentId,
      easypost_rate_id: selectedRate?.id ?? "",
      buyer_email: buyerEmail,
    });

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader actions={
        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5" />
          Secure checkout
        </span>
      } />

      <div className="flex-1 py-8 px-4">
        <div className="container max-w-md mx-auto">
          <BuyerProgressBar step={step} />

          <AnimatePresence mode="wait">
            {step === "address" && (
              <motion.div key="address" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                <AddressStep
                  linkData={linkData}
                  originLine={originLine}
                  address={buyerAddress}
                  onAddressChange={setBuyerAddress}
                  email={buyerEmail}
                  onEmailChange={setBuyerEmail}
                  tried={tried}
                  emailValid={emailValid}
                  onContinue={handleAddressContinue}
                />
              </motion.div>
            )}

            {step === "rates" && (
              <motion.div key="rates" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                <RatesStep
                  linkData={linkData}
                  rates={rates}
                  loading={ratesLoading}
                  error={ratesError}
                  notice={rateChangedNotice}
                  selectedRate={selectedRate}
                  onSelectRate={setSelectedRate}
                  onContinue={() => { setRateChangedNotice(null); setStep("review"); }}
                  onBack={() => setStep("address")}
                  onRetry={loadRates}
                />
              </motion.div>
            )}

            {step === "review" && selectedRate && (
              <motion.div key="review" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                <ReviewStep
                  buyerAddress={buyerAddress}
                  buyerEmail={buyerEmail}
                  selectedRate={selectedRate}
                  originLine={originLine}
                  liveMode={buyerLiveMode}
                  easypostShipmentId={easypostShipmentId}
                  paying={paying}
                  onStartPay={() => setPaying(true)}
                  createIntent={createSellerIntent}
                  onPaymentSuccess={handleBuyerSuccess}
                  // While paying, Back returns to the review summary; otherwise
                  // to the rates step.
                  onBack={() => (paying ? setPaying(false) : setStep("rates"))}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ─── Progress bar (3 dots, non-clickable) ───────────────────

function BuyerProgressBar({ step }: { step: BuyerStep }) {
  const currentIdx = STEP_ORDER.indexOf(step);
  return (
    <nav aria-label="Progress" className="flex items-center justify-center gap-2 mb-6">
      {STEP_ORDER.map((s, i) => {
        const isDone = i < currentIdx;
        const isCurrent = i === currentIdx;
        return (
          <span
            key={s}
            aria-current={isCurrent ? "step" : undefined}
            className={
              "h-2 rounded-full transition-all " +
              (isCurrent ? "w-8 bg-primary" : isDone ? "w-2 bg-primary" : "w-2 bg-muted")
            }
          />
        );
      })}
    </nav>
  );
}

// ─── Step 1: destination address + receipt email ────────────

function AddressStep({
  linkData, originLine, address, onAddressChange, email, onEmailChange, tried, emailValid, onContinue,
}: {
  linkData: LinkData;
  originLine: string | null;
  address: AddressInput;
  onAddressChange: (v: AddressInput) => void;
  email: string;
  onEmailChange: (v: string) => void;
  tried: boolean;
  emailValid: boolean;
  onContinue: () => void;
}) {
  const emailError = tried && !emailValid;
  return (
    <div className="space-y-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Where should this ship?</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {originLine ? `Ships from ${originLine}.` : "Enter your delivery address to see shipping options."}
        </p>
      </div>

      {linkData.notes && (
        <p className="text-sm text-foreground rounded-xl bg-muted/40 border border-border px-4 py-3">
          {linkData.notes}
        </p>
      )}

      <AddressForm value={address} tried={tried} onChange={onAddressChange} />

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <label htmlFor="buyer-email" className="text-sm font-medium text-foreground mb-1.5 block">
          Your email <span className="text-destructive">*</span>
        </label>
        <input
          id="buyer-email"
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          className={`w-full rounded-xl border ${emailError ? "border-destructive" : "border-border"} bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`}
        />
        <p className="text-xs text-muted-foreground mt-1">
          We'll send your receipt and tracking here.
        </p>
        {emailError && <p className="text-xs text-destructive mt-1">Please enter a valid email.</p>}
      </div>

      <Button onClick={onContinue} className="w-full rounded-xl shadow-sm">
        See shipping options
        <ArrowRight className="w-4 h-4 ml-1" />
      </Button>
    </div>
  );
}

// ─── Step 2: PRICE-VISIBLE rate selection ───────────────────

function RatesStep({
  linkData, rates, loading, error, notice, selectedRate, onSelectRate, onContinue, onBack, onRetry,
}: {
  linkData: LinkData;
  rates: ShippingRate[];
  loading: boolean;
  error: string | null;
  notice: string | null;
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
          <h2 className="text-lg font-bold text-foreground mb-2">We couldn't get shipping rates</h2>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <div className="flex gap-3 justify-center">
            <Button variant="outline" onClick={onBack} className="rounded-xl">
              <ArrowLeft className="w-4 h-4 mr-1" /> Edit address
            </Button>
            <Button onClick={onRetry} className="rounded-xl">Try again</Button>
          </div>
        </div>
      </div>
    );
  }

  if (rates.length === 0) {
    return (
      <div className="space-y-5">
        <div className="bg-muted rounded-2xl p-6 text-center">
          <Package className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-2">No options for this address</h2>
          <p className="text-sm text-muted-foreground mb-3">
            We couldn't find a shipping option to that address. Double-check it and try again.
          </p>
          <Button variant="outline" onClick={onBack} className="rounded-xl mt-2">
            <ArrowLeft className="w-4 h-4 mr-1" /> Edit address
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Choose a shipping option</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          You pay for shipping — pick the speed and price that work for you.
        </p>
      </div>

      {notice && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className="space-y-3">
        {rates.map((rate) => {
          const isSelected = selectedRate?.id === rate.id;
          const preferred = isPreferredRate(rate, linkData);
          return (
            <button
              key={rate.id}
              type="button"
              onClick={() => onSelectRate(rate)}
              className={
                "w-full text-left rounded-2xl border-2 p-4 transition-all " +
                (isSelected
                  ? "border-primary bg-primary/5 shadow-sm"
                  : "border-border bg-card hover:border-muted-foreground/30")
              }
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-foreground">
                      {carrierDisplayName(rate.carrier)} {serviceDisplayName(rate.service)}
                    </p>
                    {preferred && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary whitespace-nowrap">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {rate.estimated_days
                      ? `${rate.estimated_days} business day${rate.estimated_days > 1 ? "s" : ""}`
                      : "Estimated delivery TBD"}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="font-semibold text-foreground tabular-nums">
                    {formatCents(rate.display_price_cents)}
                  </span>
                  <div className={"w-5 h-5 rounded-full border-2 " + (isSelected ? "border-primary" : "border-border")}>
                    {isSelected && <div className="w-full h-full rounded-full bg-primary scale-50" />}
                  </div>
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
        <Button onClick={onContinue} disabled={!selectedRate} className="flex-1 rounded-xl shadow-sm">
          Continue
          <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3: review + on-session pay ────────────────────────

function ReviewStep({
  buyerAddress, buyerEmail, selectedRate, originLine, liveMode, easypostShipmentId,
  paying, onStartPay, createIntent, onPaymentSuccess, onBack,
}: {
  buyerAddress: AddressInput;
  buyerEmail: string;
  selectedRate: ShippingRate;
  originLine: string | null;
  liveMode: boolean;
  easypostShipmentId: string;
  paying: boolean;
  onStartPay: () => void;
  createIntent: () => Promise<{ client_secret: string; payment_intent_id: string }>;
  onPaymentSuccess: (paymentIntentId: string) => Promise<void>;
  onBack: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Review your order</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          One last look before you pay.
        </p>
      </div>

      {/* Ship-to summary */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
          <MapPin className="w-4 h-4" /> Ship to
        </h3>
        <div className="text-sm text-foreground space-y-0.5">
          {buyerAddress.name && <p className="font-medium">{buyerAddress.name}</p>}
          <p>{buyerAddress.street}</p>
          <p>{buyerAddress.city}, {buyerAddress.state} {buyerAddress.zip}</p>
          <p className="text-muted-foreground">{buyerAddress.phone}</p>
          <p className="text-muted-foreground">{buyerEmail}</p>
        </div>
        {originLine && (
          <p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
            Ships from {originLine}
          </p>
        )}
      </div>

      {/* Shipping method + price */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
          <Truck className="w-4 h-4" /> Shipping method
        </h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              {carrierDisplayName(selectedRate.carrier)} {serviceDisplayName(selectedRate.service)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {selectedRate.estimated_days
                ? `${selectedRate.estimated_days} business day${selectedRate.estimated_days > 1 ? "s" : ""}`
                : "Estimated delivery TBD"}
            </p>
          </div>
          <span className="font-semibold text-foreground tabular-nums">
            {formatCents(selectedRate.display_price_cents)}
          </span>
        </div>
      </div>

      {/* Total */}
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium text-foreground">Total</span>
        <span className="text-lg font-bold text-foreground tabular-nums">
          {formatCents(selectedRate.display_price_cents)}
        </span>
      </div>

      {paying ? (
        <div className="space-y-4">
          {/* Mounting this creates the on-session PI (seller-checkout) and, once
              the card clears, calls onPaymentSuccess(paymentIntentId) → the
              label buy. The server derives the amount; totalCents is display
              only. accessToken=undefined — the buyer is anonymous. */}
          <StripePaymentForm
            liveMode={liveMode}
            totalCents={selectedRate.display_price_cents}
            easypostShipmentId={easypostShipmentId}
            receiptEmail={buyerEmail}
            accessToken={undefined}
            createIntent={createIntent}
            onSuccess={onPaymentSuccess}
          />
          <Button variant="outline" onClick={onBack} className="rounded-xl w-full">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      ) : (
        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack} className="rounded-xl">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <Button onClick={onStartPay} className="flex-1 rounded-xl shadow-sm">
            <Lock className="w-4 h-4 mr-1.5" />
            Pay &amp; get label
          </Button>
        </div>
      )}
    </div>
  );
}
