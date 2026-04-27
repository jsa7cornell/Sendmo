import { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import LinkShareCard from "@/components/links/LinkShareCard";
import { createFlexLink } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { SpeedTier } from "@/lib/types";

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
}

export default function RecipientStepLinkReady({ state, onUpdate }: Props) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { session } = useAuth();

  // Persist the link to the database on first mount
  useEffect(() => {
    if (state.short_code) return;
    if (creating) return;

    async function persistLink() {
      setCreating(true);
      setError(null);

      const token = session?.access_token;
      if (!token) {
        setError("You must be signed in to create a link. Please sign in and try again.");
        setCreating(false);
        return;
      }

      try {
        const result = await createFlexLink({
          recipient_address: {
            name: state.destinationAddress.name,
            street1: state.destinationAddress.street,
            city: state.destinationAddress.city,
            state: state.destinationAddress.state,
            zip: state.destinationAddress.zip,
            verified: state.destinationAddress.verified,
          },
          speed_preference: state.speed_preference,
          preferred_carrier: state.preferred_carrier,
          price_cap_dollars: state.price_cap,
          size_hint: state.size_hint,
          distance_hint: state.distance_hint,
        }, token);

        onUpdate({ short_code: result.short_code });
      } catch (err) {
        console.error("Failed to create link:", err);
        setError(err instanceof Error ? err.message : "Failed to create link. Please try again.");
      } finally {
        setCreating(false);
      }
    }

    persistLink();
  }, [state.short_code]); // eslint-disable-line react-hooks/exhaustive-deps

  if (creating) {
    return (
      <div className="space-y-5 text-center py-12">
        <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto" />
        <p className="text-lg font-semibold text-foreground">Creating your shipping link…</p>
        <p className="text-sm text-muted-foreground">This only takes a moment</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-5">
        <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
          <AlertCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-bold text-foreground mb-2">Something went wrong</h2>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <Button
            onClick={() => {
              setError(null);
              setCreating(false);
              onUpdate({ short_code: "" });
            }}
            className="rounded-xl"
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!state.short_code) return null;

  return (
    <LinkShareCard
      shortCode={state.short_code}
      value={{
        speed_preference: state.speed_preference as SpeedTier,
        preferred_carrier: state.preferred_carrier,
        price_cap: state.price_cap,
      }}
      onDone={() => (window.location.href = "/dashboard")}
    />
  );
}
