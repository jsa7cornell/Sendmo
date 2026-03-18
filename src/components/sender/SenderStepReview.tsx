import { motion } from "framer-motion";
import { Package, Truck, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { carrierDisplayName, serviceDisplayName, classifySpeedTier, SPEED_TIER_COLORS } from "@/lib/utils";
import type { SenderFlowState } from "@/hooks/useSenderFlow";

interface Props {
  state: SenderFlowState;
  onConfirm: () => void;
  onBack: () => void;
  onEditPackage: () => void;
  onEditShipping: () => void;
}

const PACKAGING_LABELS: Record<string, string> = {
  box: "Box / Rigid",
  envelope: "Envelope / Soft Pack",
  tube: "Tube / Irregular",
};

export default function SenderStepReview({
  state, onConfirm, onBack, onEditPackage, onEditShipping,
}: Props) {
  const rate = state.selectedRate!;
  const recipientName = state.link?.recipient_name || "the recipient";
  // PRIVACY: Only show recipient city + state, NEVER full address
  const recipientLocation = [state.link?.recipient_city, state.link?.recipient_state]
    .filter(Boolean)
    .join(", ");

  const tier = classifySpeedTier(rate.service);
  const colors = SPEED_TIER_COLORS[tier];

  const lbs = parseFloat(state.weight.lbs) || 0;
  const oz = parseFloat(state.weight.oz) || 0;
  const weightStr = lbs > 0
    ? oz > 0 ? `${lbs} lbs ${oz} oz` : `${lbs} lbs`
    : `${oz} oz`;

  const dimsStr = state.packagingType === "envelope"
    ? `${state.dimensions.length}" × ${state.dimensions.width}"`
    : `${state.dimensions.length}" × ${state.dimensions.width}" × ${state.dimensions.height}"`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Review your shipment</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Make sure everything looks right before generating your label.
        </p>
      </div>

      {/* Package details card */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Package Details</h3>
          </div>
          <button type="button" onClick={onEditPackage} className="text-xs text-primary hover:underline underline-offset-2">
            Edit
          </button>
        </div>

        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-muted-foreground">From</span>
          <span className="text-foreground font-medium">{state.fromAddress.name}</span>

          <span className="text-muted-foreground">To</span>
          <span className="text-foreground font-medium">
            {recipientName}{recipientLocation ? ` — ${recipientLocation}` : ""}
          </span>

          <span className="text-muted-foreground">Type</span>
          <span className="text-foreground">{PACKAGING_LABELS[state.packagingType]}</span>

          <span className="text-muted-foreground">Dimensions</span>
          <span className="text-foreground">{dimsStr}</span>

          <span className="text-muted-foreground">Weight</span>
          <span className="text-foreground">{weightStr}</span>

          {state.itemDescription && (
            <>
              <span className="text-muted-foreground">Contents</span>
              <span className="text-foreground">{state.itemDescription}</span>
            </>
          )}
        </div>
      </div>

      {/* Shipping method card */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Shipping Method</h3>
          </div>
          <button type="button" onClick={onEditShipping} className="text-xs text-primary hover:underline underline-offset-2">
            Edit
          </button>
        </div>

        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-muted-foreground">Carrier</span>
          <span className="text-foreground font-medium">{carrierDisplayName(rate.carrier)}</span>

          <span className="text-muted-foreground">Service</span>
          <span className="text-foreground">{serviceDisplayName(rate.service)}</span>

          <span className="text-muted-foreground">Speed</span>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium w-fit ${colors.bg} ${colors.text}`}>
            {colors.label}
          </span>

          {rate.estimated_days && (
            <>
              <span className="text-muted-foreground">Delivery</span>
              <span className="text-foreground">
                {rate.estimated_days === 1 ? "1 business day" : `${rate.estimated_days} business days`}
              </span>
            </>
          )}
        </div>
      </div>

      {/* No payment note */}
      <div className="bg-muted rounded-xl px-4 py-3">
        <p className="text-xs text-muted-foreground text-center">
          No payment required — <span className="font-medium text-foreground">{recipientName}</span> covers the shipping cost.
        </p>
      </div>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <motion.div className="flex-1" whileTap={{ scale: 0.98 }}>
          <Button onClick={onConfirm} className="w-full rounded-xl shadow-sm text-base py-5" size="lg">
            Confirm & Print Label
          </Button>
        </motion.div>
      </div>
    </div>
  );
}
