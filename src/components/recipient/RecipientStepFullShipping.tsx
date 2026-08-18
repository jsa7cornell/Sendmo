import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Sparkles, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import PriceSummaryCard from "./PriceSummaryCard";
import ShippingMethodCard from "./ShippingMethodCard";
import MagicGuestimator from "./MagicGuestimator";
import { fetchRates, pickRecommendedRate, formatCents } from "@/lib/api";
import { cn } from "@/lib/utils";
import { getTotalPriceCents, getTotalWeightOz, canFetchRates } from "@/hooks/useRecipientFlow";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { AddressInput, GuestimatorResult, PackagingType, SenderKind, ShippingRate, SpeedTier } from "@/lib/types";

// Mirrors the origin half of step 10's validation (see getValidationErrors).
// The "Shipping from" confirm row may only replace the form when every field
// the form would have blocked on is already satisfied — otherwise collapsing
// it would hide a required field behind a "Change" button.
function isOriginComplete(addr: AddressInput): boolean {
  return (
    !!addr.verified &&
    !!addr.street &&
    !!addr.name &&
    (addr.phone ?? "").replace(/\D/g, "").length >= 10
  );
}

// ─── Packaging Options ──────────────────────────────────────

const PACKAGING_OPTIONS: { id: PackagingType; label: string; desc: string }[] = [
  { id: "box", label: "Box / Rigid", desc: "Standard cardboard box" },
  { id: "envelope", label: "Envelope / Soft Pack", desc: "Padded mailer or poly bag" },
  { id: "tube", label: "Tube / Irregular", desc: "Cylindrical or odd shape" },
];

// Title with the Magic Guestimator sparkle — signals these fields can be auto-filled.
function GuestimatorTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5">
      <Sparkles className="w-3.5 h-3.5 text-primary" />
      {children}
    </h3>
  );
}

// ─── Props ──────────────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  /**
   * Which half of the old combined step this render is. Split 2026-08-18 into
   * two discrete, independently skippable steps — deferring the ship-from
   * address must not also skip the package question (it did, and that was the
   * bug). One component rather than an extraction: the rate fetch needs both
   * halves' values and lives here either way.
   */
  mode: "address" | "package";
  sender: SenderKind | null;
  errors: string[];
  tried: boolean;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  /** "I don't have their address" — converts the flow to a shipping link. */
  onNoAddress: () => void;
  liveMode?: boolean;
}

export default function RecipientStepFullShipping({
  state, mode, sender, errors, tried, onUpdate, onContinue, onBack, onNoAddress, liveMode = false,
}: Props) {
  const isAddressStep = mode === "address";
  // 'self' → this address is the account holder's own; it was prefilled from
  // their saved address, so it collapses to a confirmable row.
  // 'other' → it belongs to the person shipping to them, and is the one thing
  // they may not know — hence the escape.
  const isSelfSender = sender === "self";
  // LATCHED at mount, never re-derived. If the saved address was already
  // complete when this step opened, collapse it to the confirm row; if it
  // wasn't, the user is filling the form in and it must stay a form for this
  // visit. Deriving this live meant the whole SmartAddressInput — including the
  // phone field being typed into — unmounted on the keystroke that completed
  // the last missing field, destroying focus mid-entry. Common trigger: a saved
  // address with no phone (anything predating the 2026-05-19 phone requirement).
  // Re-latches on the next visit to step 10, so a completed address does
  // collapse once the user moves on and comes back.
  const [originWasCompleteOnOpen] = useState(() => isSelfSender && isOriginComplete(state.originAddress));
  const [editingOrigin, setEditingOrigin] = useState(false);
  const originConfirmable = originWasCompleteOnOpen && !editingOrigin;
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [usedGuestimator, setUsedGuestimator] = useState(false);
  const fetchRef = useRef(0);
  const showErrors = tried && errors.length > 0;

  // ── Stable ref for onUpdate to avoid re-fetch loops ───────
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveModeRef = useRef(liveMode);
  liveModeRef.current = liveMode;

  // ── Rate-triggering values (only these should cause a re-fetch) ──
  // Phone is included: canFetchRates() requires a usable phone on both
  // addresses (FedEx/UPS PHONENUMBEREMPTY), so a phone change can flip the
  // gate open/closed and MUST re-run the fetch effect. Omitting it stranded
  // users who filled dimensions/weight before adding the phone — the gate
  // opened but nothing re-evaluated it. See 2026-05-20 phone-flow audit.
  const originVerified = state.originAddress.verified;
  const originStreet = state.originAddress.street;
  const originPhone = state.originAddress.phone;
  const destVerified = state.destinationAddress.verified;
  const destStreet = state.destinationAddress.street;
  const destPhone = state.destinationAddress.phone;
  const dimL = state.dimensions.length;
  const dimW = state.dimensions.width;
  const dimH = state.dimensions.height;
  const wtLbs = state.weight.lbs;
  const wtOz = state.weight.oz;
  const pkgType = state.packagingType;

  // ── Rate fetching with debounce ───────────────────────────
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);

    const s = stateRef.current;
    if (!canFetchRates(s)) return;

    fetchDebounceRef.current = setTimeout(async () => {
      const id = ++fetchRef.current;
      setRatesLoading(true);
      setRatesError(null);

      try {
        const wt = getTotalWeightOz(s);
        const h = s.packagingType === "envelope" ? 1 : parseFloat(s.dimensions.height) || 0;

        const { rates, easypost_shipment_id } = await fetchRates(
          s.originAddress,
          s.destinationAddress,
          {
            length: parseFloat(s.dimensions.length),
            width: parseFloat(s.dimensions.width),
            height: h,
            weight: wt,
          },
          liveModeRef.current,
        );

        if (id !== fetchRef.current) return; // stale

        // Apply the AI-recommended rate when a speed hint is set; otherwise default
        // to the cheapest "best value" rate (≤5 day delivery, fall back to cheapest).
        const hint = stateRef.current.recommendedSpeedHint;
        const recommended = pickRecommendedRate(rates, hint);

        onUpdateRef.current({
          availableRates: rates,
          easypostShipmentId: easypost_shipment_id,
          selectedRate: recommended,
        });
      } catch (err) {
        if (id !== fetchRef.current) return;
        setRatesError(err instanceof Error ? err.message : "Failed to fetch rates");
        onUpdateRef.current({ availableRates: [], selectedRate: null });
      } finally {
        if (id === fetchRef.current) setRatesLoading(false);
      }
    }, 600);

    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    };
    // Only re-trigger when actual package/address values change — NOT when rates/selectedRate update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originVerified, originStreet, originPhone, destVerified, destStreet, destPhone, dimL, dimW, dimH, wtLbs, wtOz, pkgType]);

  // ── Guestimator handler ───────────────────────────────────

  function handleGuestimation(result: GuestimatorResult) {
    setUsedGuestimator(true);
    onUpdate({
      packagingType: result.packaging,
      dimensions: {
        length: String(result.length),
        width: String(result.width),
        height: String(result.height),
      },
      weight: {
        lbs: String(Math.floor(result.weightLbs)),
        oz: String(Math.round((result.weightLbs % 1) * 16)),
      },
      itemDescription: result.itemName,
      recommendedSpeedHint: (result.speedHint ?? null) as SpeedTier | null,
    });
  }

  const totalCents = getTotalPriceCents(state);

  return (
    <div className="space-y-5">
      {/* Sticky price card */}
      <PriceSummaryCard
        destinationAddress={state.destinationAddress}
        priceCents={state.selectedRate ? totalCents : null}
        estimatedDays={state.selectedRate?.estimated_days ?? null}
      />

      {/* Origin Address — step 10 only */}
      {isAddressStep && (
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        {/* Who supplies the sender's address — the ONE question that decides
            whether this is a finished label or a shipping link. Framed as two
            answers to a question the user can actually answer, rather than a
            choice between product names they have no context for.

            "I have their address" is pre-selected on purpose: the label path
            has produced every shipment to date, so it must not gain a click to
            advertise the link path. First-class means named, weighted and
            visible before the user can fail — not unavoidable. */}
        {!isSelfSender && (
          <fieldset className="mb-4">
            <legend className="text-sm font-semibold text-foreground mb-3">
              Where's it shipping from?
            </legend>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => { /* already the current answer */ }}
                className={cn(
                  "w-full flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all",
                  "border-primary bg-primary/5",
                )}
              >
                <span className={cn(
                  "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5",
                  "border-primary",
                )}>
                  <span className="w-2 h-2 rounded-full bg-primary" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">I have their address</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">You enter it and get an exact price now</span>
                </span>
              </button>

              <button
                type="button"
                onClick={onNoAddress}
                className={cn(
                  "w-full flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all",
                  "border-border hover:border-muted-foreground/30",
                )}
              >
                <span className={cn(
                  "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5",
                  "border-muted-foreground/40",
                )}>

                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">The sender will fill this in</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    We'll send them a shipping link — they add their address and print the label
                  </span>
                </span>
              </button>
            </div>
          </fieldset>
        )}

        <div className="flex items-center justify-between mb-3">
          {/* Only the 'self' branch needs a heading here: the 'other' branch is
              already headed by the fieldset legend above, and rendering an
              empty <h3> for it left a bare landmark in the a11y tree. */}
          {isSelfSender ? (
            <h3 className="text-sm font-semibold text-foreground">Shipping from</h3>
          ) : (
            <span />
          )}
          {originConfirmable && (
            <button
              type="button"
              onClick={() => setEditingOrigin(true)}
              className="text-xs font-medium text-primary rounded-lg px-2 py-1 transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Change
            </button>
          )}
        </div>

        {originConfirmable ? (
          /* Confirm row — the generic outbound case is faster than a form when
             we already know the account holder's address. Only rendered when
             every field step-10 validation requires is present. */
          <div className="flex items-start gap-2.5 rounded-xl bg-muted px-4 py-3">
            <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{state.originAddress.name}</p>
              <p className="text-sm text-muted-foreground">
                {state.originAddress.street}, {state.originAddress.city}, {state.originAddress.state} {state.originAddress.zip}
              </p>
            </div>
          </div>
        ) : (
          <>
            <SmartAddressInput
              label="origin"
              value={state.originAddress}
              onChange={(addr: AddressInput) => onUpdate({ originAddress: addr })}
              error={tried && !state.originAddress.verified ? "Origin address is required" : undefined}
              nameLabel={isSelfSender ? "Your name" : "Sender's name"}
              nameHint=""
              addressPlaceholder={isSelfSender ? "Start typing your address…" : "Start typing the origin address…"}
            />
            {tried && !state.originAddress.name && (
              <p className="text-xs text-destructive mt-1">
                {isSelfSender
                  ? "Your name is required for the shipping label"
                  : "Sender name is required for the shipping label"}
              </p>
            )}
          </>
        )}

        {/* The sender's email is only worth asking for when the sender is
            someone else. When it's the account holder, the labels function
            resolves their email server-side from the session (decided
            2026-06-27 OQ5-A), so a field here would be asking twice. */}
        {!isSelfSender && (
          <div className="mt-4">
            <label htmlFor="sender-email" className="text-sm font-medium text-foreground">
              Sender's email <span className="text-muted-foreground font-normal">(optional — they'll get tracking updates)</span>
            </label>
            <Input
              id="sender-email"
              type="email"
              value={state.senderEmail}
              onChange={(e) => onUpdate({ senderEmail: e.target.value })}
              placeholder="sender@example.com"
              className="mt-1.5 rounded-xl"
            />
          </div>
        )}

      </div>

      )}

      {/* ── Package details + carrier — step 14 only ── */}
      {!isAddressStep && (<>
      {/* Magic Guestimator — primary input */}
      <MagicGuestimator onResult={handleGuestimation} />

      {/* Item description (auto-filled by guestimator, but editable) */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <label htmlFor="item-desc" className="text-sm font-medium text-foreground">
          Item description <span className="text-muted-foreground font-normal">(optional — for the shipping label)</span>
        </label>
        <Input
          id="item-desc"
          value={state.itemDescription}
          onChange={(e) => onUpdate({ itemDescription: e.target.value })}
          placeholder="e.g., Hardcover cookbook"
          className="mt-1.5 rounded-xl"
        />
      </div>

      {/* Packaging type */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <GuestimatorTitle>Packaging type</GuestimatorTitle>
        <div className="grid grid-cols-3 gap-2">
          {PACKAGING_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onUpdate({ packagingType: opt.id })}
              className={cn(
                "rounded-xl border p-3 text-left transition-all",
                state.packagingType === opt.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30",
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={cn(
                  "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center",
                  state.packagingType === opt.id ? "border-primary" : "border-muted-foreground/40",
                )}>
                  {state.packagingType === opt.id && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
                </div>
                <span className="text-sm font-medium text-foreground">{opt.label}</span>
              </div>
              <p className="text-xs text-muted-foreground ml-5.5">{opt.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Dimensions */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <GuestimatorTitle>Package dimensions (inches)</GuestimatorTitle>
        <div className={cn("grid gap-3", state.packagingType === "envelope" ? "grid-cols-2" : "grid-cols-3")}>
          <div>
            <label className="text-xs text-muted-foreground">Length</label>
            <Input
              inputMode="numeric"
              value={state.dimensions.length}
              onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, length: e.target.value } })}
              placeholder="L"
              className={cn("mt-1 rounded-xl", tried && !parseFloat(state.dimensions.length) && "border-destructive")}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Width</label>
            <Input
              inputMode="numeric"
              value={state.dimensions.width}
              onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, width: e.target.value } })}
              placeholder="W"
              className={cn("mt-1 rounded-xl", tried && !parseFloat(state.dimensions.width) && "border-destructive")}
            />
          </div>
          {state.packagingType !== "envelope" && (
            <div>
              <label className="text-xs text-muted-foreground">Height</label>
              <Input
                inputMode="numeric"
                value={state.dimensions.height}
                onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, height: e.target.value } })}
                placeholder="H"
                className={cn("mt-1 rounded-xl", tried && !parseFloat(state.dimensions.height) && "border-destructive")}
              />
            </div>
          )}
        </div>
      </div>

      {/* Weight */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <GuestimatorTitle>Package weight</GuestimatorTitle>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Pounds</label>
            <Input
              inputMode="numeric"
              value={state.weight.lbs}
              onChange={(e) => onUpdate({ weight: { ...state.weight, lbs: e.target.value } })}
              placeholder="lbs"
              className={cn("mt-1 rounded-xl", tried && getTotalWeightOz(state) <= 0 && "border-destructive")}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Ounces</label>
            <Input
              inputMode="numeric"
              value={state.weight.oz}
              onChange={(e) => onUpdate({ weight: { ...state.weight, oz: e.target.value } })}
              placeholder="oz"
              className="mt-1 rounded-xl"
            />
          </div>
        </div>
      </div>

      {/* Shipping method */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <GuestimatorTitle>Shipping method</GuestimatorTitle>

        {ratesLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-2xl bg-muted animate-pulse" />
            ))}
          </div>
        )}

        {ratesError && (
          <p className="text-sm text-destructive">{ratesError}</p>
        )}

        {!ratesLoading && !ratesError && state.availableRates.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {canFetchRates(state)
              ? "No rates available for this route"
              : "Fill in addresses, dimensions, and weight to see available shipping options"}
          </p>
        )}

        {!ratesLoading && state.availableRates.length > 0 && (
          <div className="space-y-2">
            {state.availableRates.map((rate: ShippingRate) => (
              <ShippingMethodCard
                key={rate.id}
                rate={rate}
                selected={state.selectedRate?.id === rate.id}
                onSelect={() => onUpdate({ selectedRate: rate, recommendedSpeedHint: null })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Insurance toggle — HIDDEN 2026-05-24 pending real insurance build.
          The toggle was phantom: collected $2.50 from customers but never
          passed `insurance` to EasyPost's /buy → customers paid for no
          coverage. Toggle disappears from UI until the real build lands.

          State field (state.insurance) intentionally preserved — downstream
          renderers (RecipientStepPayment, ReceiptBlock, useRecipientFlow
          total math) all check `if (state.insurance)` which now uniformly
          evaluates false since the toggle can never be set true. When real
          insurance ships, restore this block + wire the buy-side.

          See: WISHLIST → "Real shipping insurance build" +
          previews/insurance-product-brief.html (product brief) +
          proposals/2026-05-12_shipping-insurance.md (implementation design).

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Add shipping insurance</h3>
            <p className="text-xs text-muted-foreground mt-0.5">+$2.50 — covers up to $100 in damage or loss</p>
          </div>
          <Switch
            checked={state.insurance}
            onCheckedChange={(checked: boolean) => onUpdate({ insurance: checked })}
          />
        </div>
      </div>
      */}

      </>)}

      {/* The same answer, for the parcel. Present on its own step so deferring
          the address no longer skips this question — that was the bug. */}
      {!isAddressStep && !isSelfSender && (
        <button
          type="button"
          onClick={onNoAddress}
          className="w-full flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-muted-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span className="w-4 h-4 rounded-full border-2 border-muted-foreground/40 shrink-0 mt-0.5" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">The sender will fill this in</span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              They describe the package when they use your link — you'll set a spending cap instead
            </span>
          </span>
        </button>
      )}

      {/* Validation summary */}
      <AnimatePresence>
        {showErrors && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Please fix the following:</span>
            </div>
            <ul className="text-sm text-destructive space-y-0.5 ml-6">
              {errors.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Estimated cost — always shown right above the payment button */}
      <div className="bg-primary/5 border border-primary/20 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Estimated cost</h3>
        </div>
        {state.selectedRate ? (
          <>
            <div className="text-sm text-foreground">
              <span className="font-medium">{state.selectedRate.carrier} {state.selectedRate.service}</span>
              {state.selectedRate.estimated_days && (
                <span className="text-muted-foreground">
                  {" "}· arrives in ~{state.selectedRate.estimated_days} {state.selectedRate.estimated_days === 1 ? "day" : "days"}
                </span>
              )}
            </div>
            <div className="text-2xl font-bold text-primary mt-1">
              {formatCents(totalCents)}
              {state.insurance && (
                <span className="text-xs text-muted-foreground font-normal ml-2">includes insurance</span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Fill in addresses, dimensions, and weight to see your estimated cost.
          </p>
        )}

        {usedGuestimator && (
          <p className="text-[11px] text-muted-foreground mt-3 leading-snug">
            Magic Guestimator is in beta. The estimated cost shown is based on the AI's predicted package
            dimensions and weight — actual cost may differ if the carrier measures differently at the warehouse.
          </p>
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          {isAddressStep ? "Continue to package details" : "Continue to payment"}
        </Button>
      </div>

      {/* Page-level T&C */}
      <p className="text-[11px] text-muted-foreground text-center leading-snug pt-1">
        By continuing you agree to SendMo's{" "}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Terms</a>
        {" "}and{" "}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Privacy Policy</a>.
        Shipping rates include carrier price plus SendMo's service fee. Final cost may be adjusted by the carrier
        if package dimensions or weight differ from what was declared.
      </p>
    </div>
  );
}
