import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Tag, ArrowLeft, ArrowRight, Package, MapPin,
  Loader2, AlertCircle, SlidersHorizontal, PackageCheck, Repeat, LogIn,
} from "lucide-react";
import AppHeader from "@/components/AppHeader";
import SiteFooter from "@/components/SiteFooter";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import ParcelQuestion from "@/components/shipment/ParcelQuestion";
import { type ParcelDraft, EMPTY_PARCEL_DRAFT } from "@/components/shipment/parcelDraft";
import SavedAddressPicker from "@/components/recipient/SavedAddressPicker";
import FlexPreferencesForm, { type FlexPreferencesValue } from "@/components/forms/FlexPreferencesForm";
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
 * A SELLER specs their ship-FROM origin + package (dims/weight) + an optional
 * carrier/speed constraint + single-use vs reusable, then creates a shareable
 * link. The BUYER later opens it, adds their destination, and pays.
 *
 * Deliberately its OWN page with local step state — NOT the recipient
 * RecipientFlowContext state machine (review N5). Mirrors the lightweight
 * local-`useState` step pattern in components/links/LinksEditor.tsx.
 *
 * The parcel question (Guestimator + fields) and the saved-address shortcut
 * are the shared components both other flows use — <ParcelQuestion> and
 * <SavedAddressPicker> — not seller-specific copies (2026-08-29 UI rework).
 */

type Step = "details" | "review" | "ready";

const PACKAGING_LABELS: Record<PackagingType, string> = {
  box: "Box / Rigid",
  envelope: "Envelope / Soft Pack",
  tube: "Tube / Irregular",
};

function defaultConstraint(): FlexPreferencesValue {
  return { speed_preference: "standard", preferred_carrier: "any", price_cap: 100 };
}

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

// ── "How it works" — the pitch, compressed to one card (2026-08-29) ──
const HOW_IT_WORKS: { title: string; desc: string }[] = [
  { title: "Describe your item", desc: "Package size, weight, and where it ships from." },
  { title: "Post your link", desc: "Marketplace, eBay, a DM — anywhere your buyer is." },
  { title: "Buyer pays, you ship", desc: "They cover shipping at checkout. You print the label and send it." },
];

function HowItWorks() {
  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <h2 className="text-sm font-semibold text-foreground mb-4">How it works</h2>
      <ol className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {HOW_IT_WORKS.map((s, i) => (
          <li key={s.title} className="flex sm:flex-col items-start gap-3 sm:gap-2">
            <span className="w-7 h-7 rounded-full bg-emerald-500/15 text-emerald-700 text-sm font-bold flex items-center justify-center shrink-0">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">{s.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.desc}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function SellerBuilder() {
  const navigate = useNavigate();
  const { session, loading, isAdmin } = useAuth();

  // ── Step + form state (local; no shared flow context) ──
  const [step, setStep] = useState<Step>("details");
  const [origin, setOrigin] = useState<AddressInput>(emptyAddress());

  // One draft for the whole parcel question — the shared <ParcelQuestion>
  // shape, adapted to numbers only at submit (same boundary as SenderStepPackage).
  const [draft, setDraft] = useState<ParcelDraft>(EMPTY_PARCEL_DRAFT);

  const [singleUse, setSingleUse] = useState(true);
  const [constraintOn, setConstraintOn] = useState(false);
  const [constraint, setConstraint] = useState<FlexPreferencesValue>(defaultConstraint());

  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateLinkResult | null>(null);

  // Parsed parcel, or null if any dim is missing/zero. Envelope height → 1in.
  function computeParcel(): { length: number; width: number; height: number; weightOz: number } | null {
    const l = parseFloat(draft.length);
    const w = parseFloat(draft.width);
    const h = draft.packaging === "envelope" ? 1 : parseFloat(draft.height);
    const wt = (parseFloat(draft.weightLbs) || 0) * 16 + (parseFloat(draft.weightOz) || 0);
    if (!l || !w || !h || !wt) return null;
    return { length: l, width: w, height: h, weightOz: wt };
  }

  const addrComplete = !!origin.street && !!origin.city && !!origin.state && !!origin.zip;
  const phoneOk = isUsablePhone(origin.phone);
  const parcel = computeParcel();

  const weightMissing = !((parseFloat(draft.weightLbs) || 0) * 16 + (parseFloat(draft.weightOz) || 0));
  const addrIncomplete = tried && !addrComplete;
  const phoneIncomplete = tried && !phoneOk;
  const dimsIncomplete = tried &&
    (!draft.length || !draft.width || (draft.packaging !== "envelope" && !draft.height) || weightMissing);

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
      notes: draft.description.trim() || undefined,
    };
    if (constraintOn) {
      params.speed_preference = constraint.speed_preference;
      // No price cap on seller links (PR4, decided): the buyer pays their own
      // shipping on options they pick, so a cap protects nobody. The server
      // writes max_price_cents NULL; rates/ falls back to the platform-wide
      // MAX_DISPLAY_PRICE ($200) runaway guard.
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

  // The entry points advertise this as "Coming soon" while the buyer checkout
  // is still test-mode, but the route itself was never gated — a signed-in user
  // who guessed the URL got a working builder and could share a link whose
  // buyer's card is then declined. Admins keep access so the flow stays
  // testable; everyone else sees the same "coming soon" the buttons show.
  if (!SELLER_LINK_LIVE && !isAdmin) {
    return (
      <Shell>
        <SellHeader subtitle="A link you post so the buyer pays for shipping — you just print the label." />
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
        <SellHeader subtitle="Create a link, post it, and the buyer pays for shipping — you just print the label." />
        <HowItWorks />
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
            // price_cap omitted — seller links carry no cap (PR4).
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
            <div className="text-foreground font-medium">{PACKAGING_LABELS[draft.packaging]}</div>
            <div>{parcel.length}″ × {parcel.width}″ × {parcel.height}″ · {formatWeight(parcel.weightOz)}</div>
            {draft.description.trim() && <div className="text-muted-foreground">{draft.description.trim()}</div>}
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
                    ? constraint.preferred_carrier.toUpperCase()
                    : "Any carrier"}
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

      <SellHeader subtitle="Describe what you're selling and where it ships from — your buyer does the rest." />

      <HowItWorks />

      {/* Single-use vs reusable — the first decision, because it frames the
          rest: is this ONE listing or a stack of identical ones? (2026-08-29) */}
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

      {/* The parcel question — Guestimator + fields as ONE step, the same
          shared <ParcelQuestion> the sender and creator flows use, replacing
          the page's separate Guestimator card + hand-rolled fields (2026-08-29). */}
      <ParcelQuestion
        value={draft}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        showErrors={dimsIncomplete}
        invalid={{
          length: tried && !parseFloat(draft.length),
          width: tried && !parseFloat(draft.width),
          height: tried && draft.packaging !== "envelope" && !parseFloat(draft.height),
          weight: tried && weightMissing,
        }}
      />

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

      {/* Optional carrier/speed constraint */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
              <SlidersHorizontal className="w-4.5 h-4.5 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">Set a shipping limit</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Optional — limit the carrier &amp; speed the buyer can pick. Off means the buyer chooses freely. The buyer always sees the price before paying.
              </p>
            </div>
          </div>
          <Switch checked={constraintOn} onCheckedChange={setConstraintOn} />
        </div>
        {constraintOn && (
          <div className="mt-5">
            <FlexPreferencesForm value={constraint} onChange={setConstraint} hideCap />
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
            {tried && !draft.length && <li>Length</li>}
            {tried && !draft.width && <li>Width</li>}
            {tried && draft.packaging !== "envelope" && !draft.height && <li>Height</li>}
            {tried && weightMissing && <li>Weight</li>}
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
