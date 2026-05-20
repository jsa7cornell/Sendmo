import FlexPaymentStep, { type FlexPaymentInput } from "@/components/flex/FlexPaymentStep";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// Pattern D step 22. Thin wrapper around the shared <FlexPaymentStep>; the
// inline SetupIntent, polling, and rate-table logic all live in the shared
// component now (so the dashboard /links/new flow uses the same pattern).
// Onboarding shows the per-shipment cost panel; /links/new does not.

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  onEditDestination: () => void;
  onEditShipping: () => void;
}

export default function RecipientStepFlexPayment({
  state,
  onUpdate,
  onContinue,
  onBack,
  onEditDestination,
  onEditShipping,
}: Props) {
  const input: FlexPaymentInput = {
    recipient_address: {
      name: state.destinationAddress.name,
      street1: state.destinationAddress.street,
      city: state.destinationAddress.city,
      state: state.destinationAddress.state,
      zip: state.destinationAddress.zip,
      phone: state.destinationAddress.phone,
      verified: state.destinationAddress.verified,
    },
    speed_preference: state.speed_preference,
    preferred_carrier: state.preferred_carrier,
    price_cap_dollars: state.price_cap,
    size_hint: state.size_hint,
    distance_hint: state.distance_hint,
  };

  return (
    <FlexPaymentStep
      input={input}
      linkId={state.linkId || null}
      onLinkCreated={(id, short_code) => onUpdate({ linkId: id, short_code })}
      showCostEstimate
      onContinue={() => {
        onUpdate({ paymentStatus: "succeeded" });
        onContinue();
      }}
      onBack={onBack}
      onEditDestination={onEditDestination}
      onEditShipping={onEditShipping}
    />
  );
}
