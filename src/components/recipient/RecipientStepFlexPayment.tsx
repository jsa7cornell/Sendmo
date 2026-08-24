import FlexPaymentStep from "@/components/flex/FlexPaymentStep";
import { getFlexEstimate, type FlexPaymentInput } from "@/lib/flexEstimate";
import ShipmentDetails from "./ShipmentDetails";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// Pattern D step 22. Thin wrapper around the shared <FlexPaymentStep>; the
// inline SetupIntent, polling, and rate-table logic all live in the shared
// component now (so the dashboard /links/new flow uses the same pattern).
// Onboarding folds the per-shipment cost range into the Shipping Link Details
// card; /links/new shows only the compact "See typical costs" disclosure.

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  /** Jump back to the step a Shipment Details row describes. */
  onEditStep: (step: number) => void;
}

export default function RecipientStepFlexPayment({
  state,
  onUpdate,
  onContinue,
  onBack,
  onEditStep,
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

  // The cost range lives in the Shipping Link Details card now, not in a
  // second panel below it (2026-08-23) — the two said the same thing, and the
  // card was already the place the user reads their decisions back.
  const estimate = getFlexEstimate(input);

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
      heading="Confirm your payment information"
      summary={
        /* Replaces FlexPaymentStep's own "Delivering to" card. On this path
           three of the four rows can read "Sender …", which that card could
           not show — it only ever described the destination. */
        <div className="space-y-2">
          <ShipmentDetails
            state={state}
            estimate={estimate}
            priceCapDollars={state.price_cap}
            totalCents={null}
            onEdit={onEditStep}
          />
          {/* Not clamped away with the range: a cap under the cheapest rate
              means no shipment this size is likely to go through, and the user
              needs to know before saving a card. */}
          {!estimate.capCovers && (
            <p className="max-w-md rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              A ${state.price_cap} cap is below the cheapest rate we expect for
              this shipment. Senders may not be able to buy a label until you
              raise it.
            </p>
          )}
        </div>
      }
    />
  );
}
