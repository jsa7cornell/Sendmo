import { Loader2 } from "lucide-react";
import LinkShareCard from "@/components/links/LinkShareCard";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { SpeedTier } from "@/lib/types";

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
}

// Phase E (2026-05-14): link is now created at step 22 (RecipientStepFlexPayment),
// before the hold is authorized. This step is purely presentational — render the
// LinkShareCard for the short_code that's already in state. The webhook flips
// sendmo_links.status from 'draft' → 'active' once the hold is authorized.
export default function RecipientStepLinkReady({ state }: Props) {
  if (!state.short_code) {
    return (
      <div className="space-y-5 text-center py-12">
        <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto" />
        <p className="text-lg font-semibold text-foreground">Activating your link…</p>
        <p className="text-sm text-muted-foreground">This only takes a moment</p>
      </div>
    );
  }

  return (
    <LinkShareCard
      shortCode={state.short_code}
      value={{
        speed_preference: state.speed_preference as SpeedTier,
        preferred_carrier: state.preferred_carrier,
        price_cap: state.price_cap,
        address: state.destinationAddress,
      }}
      onDone={() => (window.location.href = "/dashboard")}
    />
  );
}
