import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Tag, ArrowLeft, ArrowRight, Package, MapPin,
  Loader2, AlertCircle, SlidersHorizontal, PackageCheck, Repeat, LogIn,
} from "lucide-react";
import AppHeader from "@/components/AppHeader";
import SiteFooter from "@/components/SiteFooter";
import { Button } from "@/components/ui/button";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import StepQuestionHeader from "@/components/recipient/StepQuestionHeader";
import SavedAddressPicker from "@/components/recipient/SavedAddressPicker";
import SenderStepPackage from "@/components/sender/SenderStepPackage";
import type { SenderParcel } from "@/components/sender/senderState";
import LinkShareCard from "@/components/links/LinkShareCard";
import { useAuth } from "@/contexts/AuthContext";
import { SELLER_LINK_LIVE } from "@/lib/featureFlags";
import { createSellerLink } from "@/lib/api";
import type { CreateSellerLinkParams, CreateLinkResult } from "@/lib/api";
import type { AddressInput, PackagingType } from "@/lib/types";
import { isUsablePhone } from "@/lib/phone";
import { emptyAddress } from "@/lib/utils";

/**
 * Seller-builder — the "Sell & Ship" (buyer-pays) link creator.
 *
 * Decided proposal: proposals/2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md
 *
 * A SELLER specs their ship-FROM origin + package (dims/weight) + single-use
 * vs reusable, then creates a shareable link. The BUYER later opens it, adds
 * their destination, and pays. The carrier/speed limit control was removed
 * 2026-08-29 ("for now" — the server still accepts the params if it returns).
 *
 * Stepped like the sender flow (2026-08-29, John's second-pass feedback):
 *   1. setup  — link type + ship-from origin
 *   2. item   — the shared <SenderStepPackage> (Guestimator + parcel fields),
 *               the exact step the sender flow uses, not a copy
 *   3. review — confirm, then create
 * The big icon/subtitle/how-it-works header is gone; the intro is one line.
 *
 * Still deliberately its OWN page with local step state — NOT the recipient
 * RecipientFlowContext state machine (review N5).
 */

type Step = "setup" | "item" | "review" | "ready";

const PACKAGING_LABELS: Record<PackagingType, string> = {
  box: "Box / Rigid",
  envelope: "Envelope / Soft Pack",
  tube: "Tube / Irregular",
};

function formatWeight(weightOz: number): string {
  const lbs = Math.floor(weightOz / 16);
  const oz = Math.round(weightOz % 16);
  if (lbs && oz) return `${lbs} lb ${oz} oz`;
  if (lbs) return `${lbs} lb`;
  return `${oz} oz`;
}

// ── Layout shell: emerald "Sell & Ship" branding + AppHeader ──
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader />
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6 w-full">{children}</div>
      <SiteFooter />
    </div>
  );
}

// One compact line, not a hero (2026-08-29): title + the pitch. No badge, and
// rendered only on the FIRST screen a visitor sees — later steps go straight
// to their content (John's third-pass feedback).
function SellHeader() {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2.5">
        <Tag className="w-5 h-5 text-emerald-600" />
        <h1 className="text-xl font-bold text-foreground">Checkout Link</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Your buyer picks the shipping speed and pays for it. You print the label and hand it over.
      </p>
    </div>
  );
}

export default function SellerBuilder() {
  const navigate = useNavigate();
  const { session, loading, isAdmin } = useAuth();

  // ── Step + form state (local; no shared flow context) ──
  const [step, setStep] = useState<Step>("setup");
  const [origin, setOrigin] = useState<AddressInput>(emptyAddress());
  const [parcel, setParcel] = useState<SenderParcel | null>(null);

  const [singleUse, setSingleUse] = useState(true);

  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateLinkResult | null>(null);

  const addrComplete = !!origin.street && !!origin.city && !!origin.state && !!origin.zip;
  const phoneOk = isUsablePhone(origin.phone);
  const addrIncomplete = tried && !addrComplete;
  const phoneIncomplete = tried && !phoneOk;

  function handleSetupContinue() {
    setTried(true);
    if (!addrComplete || !phoneOk) return;
    setError(null);
    setStep("item");
  }

  function handleParcelSubmit(p: SenderParcel) {
    setParcel(p);
    setStep("review");
  }

  async function handleCreate() {
    if (!parcel) { setStep("item"); return; }
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
      length_in: parcel.length,
      width_in: parcel.width,
      height_in: parcel.height,
      weight_oz: parcel.weightOz,
      // single-use → closes after the first sale; reusable → omit (stays open).
      max_shipments: singleUse ? 1 : undefined,
      notes: parcel.description.trim() || undefined,
      // No speed/carrier constraint and no price cap (PR4, decided): the buyer
      // pays their own shipping on options they pick. The server writes
      // max_price_cents NULL; rates/ falls back to the platform-wide
      // MAX_DISPLAY_PRICE ($200) runaway guard.
    };

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

  // The entry points advertise this as "Coming soon" while the buyer checkout
  // is still test-mode, but the route itself was never gated — a signed-in user
  // who guessed the URL got a working builder and could share a link whose
  // buyer's card is then declined. Admins keep access so the flow stays
  // testable; everyone else sees the same "coming soon" the buttons show.
  if (!SELLER_LINK_LIVE && !isAdmin) {
    return (
      <Shell>
        <SellHeader />
        <div className="bg-card rounded-2xl border border-border shadow-sm p-6 text-center space-y-4">
          <span className="inline-block text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-muted border border-border rounded-full px-2 py-0.5">
            Coming soon
          </span>
          <p className="text-sm text-muted-foreground">
            SendMo for Sellers isn't open yet. We're finishing the buyer checkout so your
            buyers can actually pay — until then, creating a link would leave them stuck.
          </p>
          <Button onClick={() => navigate("/onboarding")} className="rounded-xl">
            Send or receive a package instead
          </Button>
        </div>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <SellHeader />
        <div className="bg-card rounded-2xl border border-border shadow-sm p-6 text-center space-y-4">
          <p className="text-sm text-muted-foreground">
            Sign in to create your checkout link — we attach it to your account so you can manage it and print labels.
          </p>
          <Button onClick={() => navigate("/login")} className="rounded-xl gap-2">
            <LogIn className="w-4 h-4" /> Sign in to continue
          </Button>
        </div>
      </Shell>
    );
  }

  // ── Step 4: ready ──────────────────────────────────────────
  if (step === "ready" && result) {
    return (
      <Shell>
        <LinkShareCard
          shortCode={result.short_code}
          variant="seller"
          itemLabel={parcel?.description.trim() || undefined}
          singleUse={singleUse}
          value={{
            // No constraint UI (removed 2026-08-29): the buyer picks freely.
            // price_cap omitted — seller links carry no cap (PR4).
            speed_preference: "standard",
            preferred_carrier: "any",
            address: origin,
          }}
          onDone={() => navigate("/dashboard")}
          doneLabel="Go to dashboard"
        />
      </Shell>
    );
  }

  // ── Step 3: review ─────────────────────────────────────────
  if (step === "review" && parcel) {
    return (
      <Shell>
        <StepQuestionHeader question="Everything look right?" />

        <div className="bg-card rounded-2xl border border-border shadow-sm divide-y divide-border">
          <ReviewRow icon={MapPin} label="Ships from">
            <div className="text-foreground font-medium">{origin.name || "—"}</div>
            <div>{origin.street}</div>
            <div>{origin.city}, {origin.state} {origin.zip}</div>
            <div className="text-muted-foreground">{origin.phone}</div>
          </ReviewRow>

          <ReviewRow icon={Package} label="Package">
            <div className="text-foreground font-medium">{PACKAGING_LABELS[parcel.packaging]}</div>
            <div>{parcel.length}″ × {parcel.width}″ × {parcel.height}″ · {formatWeight(parcel.weightOz)}</div>
            {parcel.description.trim() && <div className="text-muted-foreground">{parcel.description.trim()}</div>}
          </ReviewRow>

          <ReviewRow icon={singleUse ? PackageCheck : Repeat} label="Link type">
            <div className="text-foreground font-medium">{singleUse ? "Single use" : "Reusable link"}</div>
            <div>{singleUse ? "Just one item — closes after it sells" : "Multiple identical items — stays open"}</div>
          </ReviewRow>

          <ReviewRow icon={SlidersHorizontal} label="Shipping options">
            <div>Buyer picks the carrier &amp; speed</div>
          </ReviewRow>
        </div>

        {error && (
          <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button variant="outline" onClick={() => setStep("item")} disabled={submitting} className="rounded-xl">
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

  // ── Step 2: item — the sender flow's package step, reused as-is ──
  if (step === "item") {
    return (
      <Shell>
        <SenderStepPackage
          initialParcel={parcel}
          onSubmit={handleParcelSubmit}
          onBack={() => setStep("setup")}
          continueLabel="Review your link"
        />
      </Shell>
    );
  }

  // ── Step 1: setup — quantity + ship-from (default) ─────────
  return (
    <Shell>
      <button
        type="button"
        onClick={() => navigate("/onboarding")}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to shipping options
      </button>

      <SellHeader />

      {/* Link type — first decision: one listing or a stack of identical ones.
          Copy is John's exact wording (2026-08-29). */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
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
              <span className="text-sm font-semibold text-foreground">Single use</span>
            </div>
            <p className="text-xs text-muted-foreground">I'm shipping just one item</p>
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
              <span className="text-sm font-semibold text-foreground">Reusable link</span>
            </div>
            <p className="text-xs text-muted-foreground">Shipping multiple identical items</p>
          </button>
        </div>
      </div>

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
        {/* Same prefill shortcut as the other flows' address steps. */}
        <div className="mt-4">
          <SavedAddressPicker onSelect={(addr) => setOrigin(addr)} />
        </div>
      </div>

      {/* Validation summary */}
      {(addrIncomplete || phoneIncomplete) && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive space-y-1">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span className="font-medium">Please fix these before continuing:</span>
          </div>
          <ul className="list-disc list-inside text-xs ml-1">
            {addrIncomplete && <li>Complete ship-from address</li>}
            {phoneIncomplete && <li>Phone number — the shipping carriers require it</li>}
          </ul>
        </div>
      )}

      <Button onClick={handleSetupContinue} className="w-full rounded-xl shadow-sm gap-1.5">
        Continue <ArrowRight className="w-4 h-4" />
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
