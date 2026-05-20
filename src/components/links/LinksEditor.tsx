import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, MapPin, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import AddressForm from "@/components/forms/AddressForm";
import NotificationEmailField from "@/components/forms/NotificationEmailField";
import FlexPreferencesForm from "@/components/forms/FlexPreferencesForm";
import LinkShareCard from "@/components/links/LinkShareCard";
import FlexPaymentStep, { type FlexPaymentInput } from "@/components/flex/FlexPaymentStep";
import { useAuth } from "@/contexts/AuthContext";
import { updateFlexLink } from "@/lib/api";
import type { AddressInput, SpeedTier } from "@/lib/types";
import { cn, emptyAddress } from "@/lib/utils";
import { isUsablePhone } from "@/lib/phone";

export interface FlexFormValue {
  address: AddressInput;
  email: string;
  speed_preference: SpeedTier;
  preferred_carrier: string;
  price_cap: number;
  size_hint: "envelope" | "smallbox" | "largebox" | null;
}

export function defaultFlexValue(): FlexFormValue {
  return {
    address: emptyAddress(),
    email: "",
    speed_preference: "standard",
    preferred_carrier: "any",
    price_cap: 100,
    size_hint: null,
  };
}

interface Props {
  mode: "create" | "edit";
  initialValue: FlexFormValue | null;
  linkId: string | null;
}

type CreateStep = "details" | "payment" | "ready";

export default function LinksEditor({ mode, initialValue, linkId }: Props) {
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState<FlexFormValue>(initialValue ?? defaultFlexValue());
  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<CreateStep>("details");
  // Persist linkId + short_code across Back/Continue so re-entering Step 2
  // reuses the same draft link instead of creating a second one.
  const [createdLinkId, setCreatedLinkId] = useState<string | null>(null);
  const [createdShortCode, setCreatedShortCode] = useState<string | null>(null);

  const addressComplete =
    !!value.address.street &&
    !!value.address.city &&
    !!value.address.state &&
    !!value.address.zip;
  // Phone is a hard requirement — the links Edge Function 400s without a
  // usable phone (FedEx/UPS PHONENUMBEREMPTY). The onboarding flow gates this
  // in useRecipientFlow.getValidationErrors step 1; the dashboard /links/new
  // flow must gate it here too, or the failure surfaces as an ugly server
  // error on the "Add your card" step instead of an inline field error.
  const phoneOk = isUsablePhone(value.address.phone);

  const errors: string[] = [];
  if (tried && !value.address.verified) {
    errors.push("Select a destination address from the dropdown");
  } else if (tried && value.address.verified && !addressComplete) {
    errors.push(
      "The selected address is missing details (street, city, state, or ZIP). Please re-pick it from the dropdown.",
    );
  }
  if (tried && !phoneOk) {
    errors.push("Add a phone number for the delivery address — the shipping carriers require it");
  }

  function handleContinueToPayment() {
    setTried(true);
    if (!value.address.verified || !addressComplete || !phoneOk) return;
    if (!session?.access_token) {
      setError("You're signed out — please sign in again.");
      return;
    }
    setError(null);
    setStep("payment");
  }

  async function handleEditSubmit() {
    setTried(true);
    if (!value.address.verified || !addressComplete || !phoneOk) return;
    if (!session?.access_token) {
      setError("You're signed out — please sign in again.");
      return;
    }
    if (!linkId) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateFlexLink(
        linkId,
        {
          recipient_address: {
            name: value.address.name,
            street1: value.address.street,
            city: value.address.city,
            state: value.address.state,
            zip: value.address.zip,
            phone: value.address.phone,
            verified: value.address.verified,
          },
          speed_preference: value.speed_preference,
          preferred_carrier: value.preferred_carrier,
          price_cap_dollars: value.price_cap,
          size_hint: value.size_hint,
        },
        session.access_token,
      );
      navigate(`/dashboard?updated_link=${encodeURIComponent(linkId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Step 3: link ready ────────────────────────────────────────
  if (mode === "create" && step === "ready" && createdShortCode) {
    return (
      <main className="max-w-xl mx-auto px-4 py-8">
        <LinkShareCard
          shortCode={createdShortCode}
          value={{
            speed_preference: value.speed_preference,
            preferred_carrier: value.preferred_carrier,
            price_cap: value.price_cap,
            address: value.address,
          }}
          onDone={() => navigate("/dashboard")}
          doneLabel="Go to dashboard"
          onBack={() => navigate(-1)}
        />
      </main>
    );
  }

  // ── Step 2: payment ──────────────────────────────────────────
  if (mode === "create" && step === "payment") {
    const flexInput: FlexPaymentInput = {
      recipient_address: {
        name: value.address.name,
        street1: value.address.street,
        city: value.address.city,
        state: value.address.state,
        zip: value.address.zip,
        phone: value.address.phone,
        verified: value.address.verified,
      },
      speed_preference: value.speed_preference,
      preferred_carrier: value.preferred_carrier,
      price_cap_dollars: value.price_cap,
      size_hint: value.size_hint,
    };
    return (
      <main className="max-w-xl mx-auto px-4 py-8 space-y-6">
        <StepIndicator activeStep="payment" />
        <FlexPaymentStep
          input={flexInput}
          linkId={createdLinkId}
          onLinkCreated={(id, short_code) => {
            setCreatedLinkId(id);
            setCreatedShortCode(short_code);
          }}
          showCostEstimate={false}
          onContinue={(id, short_code) => {
            setCreatedLinkId(id);
            setCreatedShortCode(short_code);
            setStep("ready");
          }}
          onBack={() => setStep("details")}
        />
      </main>
    );
  }

  // ── Step 1: details (default) ────────────────────────────────
  const isEdit = mode === "edit";
  return (
    <main className="max-w-xl mx-auto px-4 py-8 space-y-6">
      {!isEdit && <StepIndicator activeStep="details" />}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {isEdit ? "Edit your shipping link" : "Create your shipping link"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isEdit
            ? "Update where packages are delivered or your shipping preferences."
            : "Tell us where to ship — next you'll add the card we charge per shipment."}
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Where should packages be delivered?</h2>
        <AddressForm
          value={value.address}
          tried={tried}
          onChange={(address) => setValue((v) => ({ ...v, address }))}
        />
      </section>

      <section className="space-y-3">
        <NotificationEmailField
          defaultEmail={user?.email ?? ""}
          value={value.email}
          onChange={(email) => setValue((v) => ({ ...v, email }))}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">How fast and what's your max price?</h2>
        <FlexPreferencesForm
          value={{
            speed_preference: value.speed_preference,
            preferred_carrier: value.preferred_carrier,
            price_cap: value.price_cap,
          }}
          onChange={(prefs) => setValue((v) => ({ ...v, ...prefs }))}
        />
      </section>

      {tried && errors.length > 0 && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle className="w-4 h-4 text-destructive" />
            <span className="text-sm font-medium text-destructive">Please fix the following:</span>
          </div>
          <ul className="text-sm text-destructive space-y-0.5 ml-6">
            {errors.map((e, i) => <li key={i}>• {e}</li>)}
          </ul>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate("/dashboard")} className="rounded-xl">
          Cancel
        </Button>
        {isEdit ? (
          <Button onClick={handleEditSubmit} disabled={submitting} className="flex-1 rounded-xl shadow-sm">
            {submitting ? "Saving…" : "Save changes"}
          </Button>
        ) : (
          <Button onClick={handleContinueToPayment} className="flex-1 rounded-xl shadow-sm">
            Continue to payment
          </Button>
        )}
      </div>
    </main>
  );
}

// ─── 2-step indicator (create flow only) ─────────────────────

function StepIndicator({ activeStep }: { activeStep: "details" | "payment" }) {
  const steps = [
    { key: "details" as const, label: "Details", icon: MapPin },
    { key: "payment" as const, label: "Payment", icon: CreditCard },
  ];
  const activeIdx = steps.findIndex((s) => s.key === activeStep);
  return (
    <div className="flex items-center justify-between w-full max-w-md mx-auto">
      {steps.map((s, i) => {
        const Icon = s.icon;
        const isActive = i === activeIdx;
        const isCompleted = i < activeIdx;
        return (
          <div key={s.key} className="flex items-center flex-1 last:flex-none">
            <div
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-colors",
                isCompleted && "bg-primary text-primary-foreground",
                isActive && "border-2 border-primary text-primary bg-primary/5",
                !isActive && !isCompleted && "border-2 border-muted text-muted-foreground bg-muted/30",
              )}
            >
              <Icon className="w-4 h-4" />
            </div>
            <span
              className={cn(
                "ml-2 text-xs font-medium whitespace-nowrap",
                (isCompleted || isActive) ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-3",
                  isCompleted ? "bg-primary" : "bg-muted",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
