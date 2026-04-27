import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import AddressForm from "@/components/forms/AddressForm";
import NotificationEmailField from "@/components/forms/NotificationEmailField";
import FlexPreferencesForm from "@/components/forms/FlexPreferencesForm";
import LinkShareCard from "@/components/links/LinkShareCard";
import { useAuth } from "@/contexts/AuthContext";
import { createFlexLink, updateFlexLink } from "@/lib/api";
import type { AddressInput, SpeedTier } from "@/lib/types";
import { emptyAddress } from "@/lib/utils";

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

export default function LinksEditor({ mode, initialValue, linkId }: Props) {
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState<FlexFormValue>(initialValue ?? defaultFlexValue());
  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdShortCode, setCreatedShortCode] = useState<string | null>(null);

  const errors: string[] = [];
  if (tried && !value.address.verified) {
    errors.push("Select a destination address from the dropdown");
  }

  async function handleSubmit() {
    setTried(true);
    if (!value.address.verified) return;
    if (!session?.access_token) {
      setError("You're signed out — please sign in again.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "create") {
        const result = await createFlexLink(
          {
            recipient_address: {
              name: value.address.name,
              street1: value.address.street,
              city: value.address.city,
              state: value.address.state,
              zip: value.address.zip,
              verified: value.address.verified,
            },
            speed_preference: value.speed_preference,
            preferred_carrier: value.preferred_carrier,
            price_cap_dollars: value.price_cap,
            size_hint: value.size_hint,
          },
          session.access_token,
        );
        setCreatedShortCode(result.short_code);
      } else {
        if (!linkId) throw new Error("Missing link id");
        await updateFlexLink(
          linkId,
          {
            recipient_address: {
              name: value.address.name,
              street1: value.address.street,
              city: value.address.city,
              state: value.address.state,
              zip: value.address.zip,
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
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  if (createdShortCode) {
    return (
      <main className="max-w-xl mx-auto px-4 py-8">
        <LinkShareCard
          shortCode={createdShortCode}
          value={{
            speed_preference: value.speed_preference,
            preferred_carrier: value.preferred_carrier,
            price_cap: value.price_cap,
          }}
          onDone={() => navigate("/dashboard")}
          doneLabel="Go to dashboard"
        />
      </main>
    );
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {mode === "create" ? "Create your shipping link" : "Edit your shipping link"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {mode === "create"
            ? "Share one link — anyone can use it to send you a package."
            : "Update where packages are delivered or your shipping preferences."}
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
        <Button onClick={handleSubmit} disabled={submitting} className="flex-1 rounded-xl shadow-sm">
          {submitting ? "Saving…" : mode === "create" ? "Create link" : "Save changes"}
        </Button>
      </div>
    </main>
  );
}
