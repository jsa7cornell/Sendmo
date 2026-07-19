import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Tag, ArrowLeft, ArrowRight, Package, Mail, ScrollText, MapPin,
  Loader2, AlertCircle, SlidersHorizontal, PackageCheck, Repeat, LogIn,
} from "lucide-react";
import AppHeader from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import MagicGuestimator from "@/components/recipient/MagicGuestimator";
import FlexPreferencesForm, { type FlexPreferencesValue } from "@/components/forms/FlexPreferencesForm";
import LinkShareCard from "@/components/links/LinkShareCard";
import { useAuth } from "@/contexts/AuthContext";
import { createSellerLink } from "@/lib/api";
import type { CreateSellerLinkParams, CreateLinkResult } from "@/lib/api";
import type { AddressInput, GuestimatorResult, PackagingType } from "@/lib/types";
import { isUsablePhone } from "@/lib/phone";
import { emptyAddress } from "@/lib/utils";

/**
 * Seller-builder — the "Sell & Ship" (buyer-pays) link creator.
 *
 * Decided proposal: proposals/2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md
 *
 * A SELLER specs their ship-FROM origin + package (dims/weight) + an optional
 * carrier/speed/price constraint + single-use vs reusable, then creates a
 * shareable link. The BUYER later opens it, adds their destination, and pays.
 *
 * Deliberately its OWN page with local step state — NOT the recipient
 * RecipientFlowContext state machine (review N5). Mirrors the lightweight
 * local-`useState` step pattern in components/links/LinksEditor.tsx.
 */

type Step = "details" | "review" | "ready";

const PACKAGING_OPTIONS: { value: PackagingType; label: string; Icon: typeof Package }[] = [
  { value: "box", label: "Box / Rigid", Icon: Package },
  { value: "envelope", label: "Envelope / Soft", Icon: Mail },
  { value: "tube", label: "Tube / Irregular", Icon: ScrollText },
];

function defaultConstraint(): FlexPreferencesValue {
  return { speed_preference: "standard", preferred_carrier: "any", price_cap: 100 };
}

// ── Layout shell: emerald "Sell & Ship" branding + AppHeader ──
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">{children}</div>
    </div>
  );
}

function SellHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="text-center space-y-3">
      <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 flex items-center justify-center mx-auto">
        <Tag className="w-7 h-7 text-emerald-600" />
      </div>
      <h1 className="text-2xl font-bold text-foreground">Sell &amp; Ship</h1>
      <p className="text-muted-foreground max-w-md mx-auto">{subtitle}</p>
      <span className="inline-block text-xs font-semibold uppercase tracking-wide text-emerald-700 bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-full">
        Buyer pays
      </span>
    </div>
  );
}

export default function SellerBuilder() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();

  // ── Step + form state (local; no shared flow context) ──
  const [step, setStep] = useState<Step>("details");
  const [origin, setOrigin] = useState<AddressInput>(emptyAddress());

  const [packaging, setPackaging] = useState<PackagingType>("box");
  const [length, setLength] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [weightLbs, setWeightLbs] = useState("");
  const [description, setDescription] = useState("");

  const [singleUse, setSingleUse] = useState(true);
  const [constraintOn, setConstraintOn] = useState(false);
  const [constraint, setConstraint] = useState<FlexPreferencesValue>(defaultConstraint());

  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateLinkResult | null>(null);

  function handleGuestimate(r: GuestimatorResult) {
    setPackaging(r.packaging);
    setLength(String(r.length));
    setWidth(String(r.width));
    if (r.packaging !== "envelope") setHeight(String(r.height));
    setWeightLbs(String(r.weightLbs));
    setDescription(r.itemName);
  }

  // Parsed parcel, or null if any dim is missing/zero. Envelope height → 1in.
  function computeParcel(): { length: number; width: number; height: number; weightOz: number } | null {
    const l = parseFloat(length);
    const w = parseFloat(width);
    const h = packaging === "envelope" ? 1 : parseFloat(height);
    const wt = parseFloat(weightLbs);
    if (!l || !w || !h || !wt) return null;
    return { length: l, width: w, height: h, weightOz: wt * 16 };
  }

  const addrComplete = !!origin.street && !!origin.city && !!origin.state && !!origin.zip;
  const phoneOk = isUsablePhone(origin.phone);
  const parcel = computeParcel();

  const addrIncomplete = tried && !addrComplete;
  const phoneIncomplete = tried && !phoneOk;
  const dimsIncomplete = tried && (!length || !width || (packaging !== "envelope" && !height) || !weightLbs);

  function handleReview() {
    setTried(true);
    if (!addrComplete || !phoneOk || !computeParcel()) return;
    setError(null);
    setStep("review");
  }

  async function handleCreate() {
    const p = computeParcel();
    if (!p) { setStep("details"); return; }
    if (!session?.access_token) {
      setError("You're signed out — please sign in again.");
      return;
    }
    const params: CreateSellerLinkParams = {
      origin_address: {
        name: origin.name,
        street1: origin.street,
        city: origin.city,
        state: origin.state,
        zip: origin.zip,
        phone: origin.phone,
        verified: origin.verified,
      },
      length_in: p.length,
      width_in: p.width,
      height_in: p.height,
      weight_oz: p.weightOz,
      // single-use → closes after the first sale; reusable → omit (stays open).
      max_shipments: singleUse ? 1 : undefined,
      notes: description.trim() || undefined,
    };
    if (constraintOn) {
      params.speed_preference = constraint.speed_preference;
      params.price_cap_dollars = constraint.price_cap;
      // "any" carrier = no carrier constraint — omit it.
      if (constraint.preferred_carrier !== "any") {
        params.preferred_carrier = constraint.preferred_carrier;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await createSellerLink(params, session.access_token);
      setResult(res);
      setStep("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create your link");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Auth gate: /sell is an unprotected route, so handle sign-out in-page ──
  if (loading) {
    return (
      <Shell>
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-600" />
        </div>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <SellHeader subtitle="Create a link, post it, and the buyer pays for shipping — you just print the label." />
        <div className="bg-card rounded-2xl border border-border shadow-sm p-6 text-center space-y-4">
          <p className="text-sm text-muted-foreground">
            Sign in to create your Sell &amp; Ship link — we attach it to your account so you can manage it and print labels.
          </p>
          <Button onClick={() => navigate("/login")} className="rounded-xl gap-2">
            <LogIn className="w-4 h-4" /> Sign in to continue
          </Button>
        </div>
      </Shell>
    );
  }

  // ── Step 3: ready ──────────────────────────────────────────
  if (step === "ready" && result) {
    return (
      <Shell>
        <SellHeader subtitle="Share your link — the buyer adds their address and pays, then you print the label." />
        <LinkShareCard
          shortCode={result.short_code}
          value={{
            speed_preference: constraint.speed_preference,
            preferred_carrier: constraintOn ? constraint.preferred_carrier : "any",
            price_cap: constraint.price_cap,
            // Only surface the ship-from + constraint summary when the seller
            // actually set a constraint (LinkShareCard couples them in one line).
            address: constraintOn ? origin : undefined,
          }}
          onDone={() => navigate("/dashboard")}
          doneLabel="Go to dashboard"
        />
      </Shell>
    );
  }

  // ── Step 2: review ─────────────────────────────────────────
  if (step === "review" && parcel) {
    const packagingLabel = PACKAGING_OPTIONS.find((o) => o.value === packaging)?.label ?? packaging;
    return (
      <Shell>
        <SellHeader subtitle="Double-check the details — the buyer will ship to their own address from here." />

        <div className="bg-card rounded-2xl border border-border shadow-sm divide-y divide-border">
          <ReviewRow icon={MapPin} label="Ships from">
            <div className="text-foreground font-medium">{origin.name || "—"}</div>
            <div>{origin.street}</div>
            <div>{origin.city}, {origin.state} {origin.zip}</div>
            <div className="text-muted-foreground">{origin.phone}</div>
          </ReviewRow>

          <ReviewRow icon={Package} label="Package">
            <div className="text-foreground font-medium">{packagingLabel}</div>
            <div>{parcel.length}″ × {parcel.width}″ × {parcel.height}″ · {weightLbs} lb</div>
            {description.trim() && <div className="text-muted-foreground">{description.trim()}</div>}
          </ReviewRow>

          <ReviewRow icon={singleUse ? PackageCheck : Repeat} label="Availability">
            <div className="text-foreground font-medium">{singleUse ? "Single-use" : "Reusable"}</div>
            <div>{singleUse ? "One item — closes after it sells" : "Multiple identical items — stays open"}</div>
          </ReviewRow>

          <ReviewRow icon={SlidersHorizontal} label="Shipping options">
            {constraintOn ? (
              <>
                <div className="text-foreground font-medium capitalize">{constraint.speed_preference}</div>
                <div>
                  {constraint.preferred_carrier !== "any"
                    ? `${constraint.preferred_carrier.toUpperCase()} · `
                    : "Any carrier · "}
                  up to ${constraint.price_cap}
                </div>
              </>
            ) : (
              <div>Buyer picks the carrier &amp; speed</div>
            )}
          </ReviewRow>
        </div>

        {error && (
          <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setStep("details")} disabled={submitting} className="rounded-xl">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <Button onClick={handleCreate} disabled={submitting} className="flex-1 rounded-xl shadow-sm gap-1.5">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />}
            {submitting ? "Creating…" : "Create link"}
          </Button>
        </div>
      </Shell>
    );
  }

  // ── Step 1: details (default) ──────────────────────────────
  return (
    <Shell>
      <button
        type="button"
        onClick={() => navigate("/onboarding")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to shipping options
      </button>

      <SellHeader subtitle="Tell us where it ships from and the box size & weight — the Guesstimator can fill this in." />

      {/* Origin (ship-from) address */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Where does it ship from?</h3>
        <SmartAddressInput
          label="Origin"
          nameLabel="Your name"
          nameHint="your name"
          addressLabel="Ship-from address"
          value={origin}
          onChange={setOrigin}
          error={addrIncomplete ? "Please enter a complete address" : undefined}
        />
      </div>

      {/* Magic Guestimator */}
      <MagicGuestimator onResult={handleGuestimate} />

      {/* Package details */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <div>
          <label className="text-sm font-medium text-foreground mb-2 block">Packaging type</label>
          <div className="grid grid-cols-3 gap-2">
            {PACKAGING_OPTIONS.map(({ value, label, Icon }) => {
              const selected = packaging === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPackaging(value)}
                  className={
                    "flex flex-col items-center gap-1.5 rounded-xl border-2 p-3 transition " +
                    (selected
                      ? "border-emerald-500 bg-emerald-500/5 text-foreground"
                      : "border-border bg-background hover:border-muted-foreground/30 text-muted-foreground")
                  }
                >
                  <Icon className={"w-5 h-5 " + (selected ? "text-emerald-600" : "")} />
                  <span className="text-xs font-medium">{label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Item description <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            type="text"
            placeholder="e.g. ceramic mug"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Dimensions <span className="font-normal text-muted-foreground">(inches)</span>
          </label>
          <div className={packaging === "envelope" ? "grid grid-cols-2 gap-3" : "grid grid-cols-3 gap-3"}>
            <input type="number" inputMode="numeric" placeholder="Length" value={length} onChange={(e) => setLength(e.target.value)}
              className={`rounded-xl border ${tried && !length ? "border-destructive" : "border-border"} bg-background px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500`} />
            <input type="number" inputMode="numeric" placeholder="Width" value={width} onChange={(e) => setWidth(e.target.value)}
              className={`rounded-xl border ${tried && !width ? "border-destructive" : "border-border"} bg-background px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500`} />
            {packaging !== "envelope" && (
              <input type="number" inputMode="numeric" placeholder="Height" value={height} onChange={(e) => setHeight(e.target.value)}
                className={`rounded-xl border ${tried && !height ? "border-destructive" : "border-border"} bg-background px-3 py-2.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500`} />
            )}
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-foreground mb-1.5 block">
            Weight <span className="font-normal text-muted-foreground">(lbs)</span>
          </label>
          <input type="number" inputMode="numeric" placeholder="e.g. 5" value={weightLbs} onChange={(e) => setWeightLbs(e.target.value)}
            className={`w-full rounded-xl border ${tried && !weightLbs ? "border-destructive" : "border-border"} bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500`} />
        </div>
      </div>

      {/* Single-use vs reusable */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <label className="text-sm font-semibold text-foreground mb-3 block">How many can sell through this link?</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setSingleUse(true)}
            className={
              "text-left rounded-xl border-2 p-3.5 transition " +
              (singleUse ? "border-emerald-500 bg-emerald-500/5" : "border-border bg-background hover:border-muted-foreground/30")
            }
          >
            <div className="flex items-center gap-2 mb-0.5">
              <PackageCheck className={"w-4 h-4 " + (singleUse ? "text-emerald-600" : "text-muted-foreground")} />
              <span className="text-sm font-semibold text-foreground">One item</span>
            </div>
            <p className="text-xs text-muted-foreground">Closes after it sells</p>
          </button>
          <button
            type="button"
            onClick={() => setSingleUse(false)}
            className={
              "text-left rounded-xl border-2 p-3.5 transition " +
              (!singleUse ? "border-emerald-500 bg-emerald-500/5" : "border-border bg-background hover:border-muted-foreground/30")
            }
          >
            <div className="flex items-center gap-2 mb-0.5">
              <Repeat className={"w-4 h-4 " + (!singleUse ? "text-emerald-600" : "text-muted-foreground")} />
              <span className="text-sm font-semibold text-foreground">Multiple identical items</span>
            </div>
            <p className="text-xs text-muted-foreground">Stays open</p>
          </button>
        </div>
      </div>

      {/* Optional carrier/speed/price constraint */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
              <SlidersHorizontal className="w-4.5 h-4.5 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Set a shipping limit</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Optional — cap the carrier, speed &amp; price the buyer can pick. Off means the buyer chooses freely.
              </p>
            </div>
          </div>
          <Switch checked={constraintOn} onCheckedChange={setConstraintOn} />
        </div>
        {constraintOn && (
          <div className="mt-5">
            <FlexPreferencesForm value={constraint} onChange={setConstraint} />
          </div>
        )}
      </div>

      {/* Validation summary */}
      {(addrIncomplete || phoneIncomplete || dimsIncomplete) && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive space-y-1">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span className="font-medium">Please fix these before continuing:</span>
          </div>
          <ul className="list-disc list-inside text-xs ml-1">
            {addrIncomplete && <li>Complete ship-from address</li>}
            {phoneIncomplete && <li>Phone number — the shipping carriers require it</li>}
            {tried && !length && <li>Length</li>}
            {tried && !width && <li>Width</li>}
            {tried && packaging !== "envelope" && !height && <li>Height</li>}
            {tried && !weightLbs && <li>Weight</li>}
          </ul>
        </div>
      )}

      <Button onClick={handleReview} className="w-full rounded-xl shadow-sm gap-1.5">
        Review your link <ArrowRight className="w-4 h-4" />
      </Button>
    </Shell>
  );
}

// ─── Review row ──────────────────────────────────────────────
function ReviewRow({
  icon: Icon, label, children,
}: { icon: typeof Package; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
        <Icon className="w-4.5 h-4.5 text-emerald-600" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</p>
        <div className="text-sm text-muted-foreground space-y-0.5">{children}</div>
      </div>
    </div>
  );
}
