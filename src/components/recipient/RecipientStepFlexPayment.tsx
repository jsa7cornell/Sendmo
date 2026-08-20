import FlexPaymentStep, { type FlexPaymentInput } from "@/components/flex/FlexPaymentStep";
import RecipientStepPaymentSummary from "./RecipientStepPaymentSummary";
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
  // All-or-nothing: a partial parcel produces junk rates, so a half-filled
  // package is treated as not answered.
  const l = parseFloat(state.dimensions.length);
  const w = parseFloat(state.dimensions.width);
  const h = parseFloat(state.dimensions.height);
  const wtOz = (parseFloat(state.weight.lbs) || 0) * 16 + (parseFloat(state.weight.oz) || 0);
  const parsedDims =
    l > 0 && w > 0 && wtOz > 0
      ? { length_in: l, width_in: w, height_in: h > 0 ? h : 1, weight_oz: wtOz }
      : null;

  const input: FlexPaymentInput = {
    // Destination deferred (Phase 3): the sender enters it — the link carries
    // no recipient address (migration 042 permits this for flexible).
    ...(state.deferredDestination
      ? {}
      : {
          recipient_address: {
            name: state.destinationAddress.name,
            street1: state.destinationAddress.street,
            city: state.destinationAddress.city,
            state: state.destinationAddress.state,
            zip: state.destinationAddress.zip,
            phone: state.destinationAddress.phone,
            verified: state.destinationAddress.verified,
          },
        }),
    speed_preference: state.speed_preference,
    preferred_carrier: state.preferred_carrier,
    price_cap_dollars: state.price_cap,
    size_hint: state.size_hint,
    distance_hint: state.distance_hint,
    // Carry anything the creator actually answered (2026-08-18). Only the
    // deferred questions are left for the sender — previously an address the
    // creator had typed was discarded the moment they deferred the parcel, and
    // the sender was asked to retype their own address.
    ...(!state.deferredOrigin && state.originAddress.verified && state.originAddress.street
      ? {
          origin_address: {
            name: state.originAddress.name,
            street1: state.originAddress.street,
            city: state.originAddress.city,
            state: state.originAddress.state,
            zip: state.originAddress.zip,
            phone: state.originAddress.phone ?? "",
            verified: state.originAddress.verified,
          },
        }
      : {}),
    ...(!state.deferredPackage && parsedDims
      ? {
          length_in: parsedDims.length_in,
          width_in: parsedDims.width_in,
          height_in: parsedDims.height_in,
          weight_oz: parsedDims.weight_oz,
        }
      : {}),
  };

  return (
    <FlexPaymentStep
      input={input}
      linkId={state.linkId || null}
      onLinkCreated={(id, short_code) => onUpdate({ linkId: id, short_code })}
      showCostEstimate
      summary={<RecipientStepPaymentSummary state={state} />}
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
