import { formatCents } from "@/lib/api";
import { carrierDisplayName, serviceDisplayName, speedDisplayName } from "@/lib/utils";
import ShipmentDetailsCard, { type DetailCell } from "@/components/shipment/ShipmentDetailsCard";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// The creator's half of the shipment summary (2026-08-23).
//
// The progress bar, the path chip and the "this will be a shipping link"
// banner all went at once: three devices competing to say where you were,
// none of them saying what you had actually decided. This says the second
// thing, once, on the last screen before money moves — which is the only
// point in the flow where a summary is what the user wants.
//
// Every cell carries its own edit, because this replaced the progress bar and
// is now the only way back to an earlier question from the payment step.
//
// The card itself is shared with the sender flow (2026-08-24) — see
// components/shipment/ShipmentDetailsCard. This file is the adapter that
// turns flow state into its cells; the sender has its own.

/** Flow steps each cell edits. Mirrors stepRouting's numbering. */
const STEP = { destination: 1, origin: 10, package: 14, shipping: 20 } as const;

interface Props {
  state: RecipientFlowState;
  /**
   * Per-shipment cost range for the link path. Supplying it adds the days
   * range to VIA and an ESTIMATED COST cell; this card is then the only place
   * the flow states cost, which is why the separate "Estimated shipping cost"
   * panel below it is gone (2026-08-23).
   */
  estimate?: { low: number; high: number; days: string } | null;
  /** Cap in dollars, shown under the range. Omit to hide that line. */
  priceCapDollars?: number | null;
  /** Null while no concrete price exists — the flexible path caps instead. */
  totalCents?: number | null;
  /** Names what the number is: "Total" for a label, "Charged up to" for a cap. */
  totalLabel?: string;
  /** Jump back to the step a cell describes. */
  onEdit: (step: number) => void;
}

export default function ShipmentDetails({
  state, estimate = null, priceCapDollars = null,
  totalCents = null, totalLabel = "Total", onEdit,
}: Props) {
  const origin = state.originAddress;
  const destination = state.destinationAddress;

  const parcelDims = state.dimensions.length && state.dimensions.width
    ? `${state.dimensions.length}×${state.dimensions.width}${
        state.packagingType !== "envelope" && state.dimensions.height
          ? `×${state.dimensions.height}` : ""} in`
    : "";
  const lbs = parseFloat(state.weight.lbs) || 0;
  const oz = parseFloat(state.weight.oz) || 0;
  const parcelWeight = lbs || oz
    ? [lbs ? `${lbs} lb` : "", oz ? `${oz} oz` : ""].filter(Boolean).join(" ")
    : "";

  // The shipping cell reads differently per path: a chosen rate on the label
  // path, the speed-and-cap preference on the link path, because no rate is
  // computable until the sender fills in what was skipped.
  const rate = state.selectedRate;

  const cells: DetailCell[] = [
    {
      key: "from",
      onEdit: () => onEdit(STEP.origin),
      ...(state.deferredOrigin
        ? { deferred: "Sender fills in" }
        : { primary: origin.name || "—", secondary: origin.street || "" }),
    },
    {
      key: "to",
      onEdit: () => onEdit(STEP.destination),
      ...(state.deferredDestination
        ? { deferred: "Sender chooses" }
        : { primary: destination.name || "—", secondary: destination.street || "" }),
    },
    {
      key: "parcel",
      onEdit: () => onEdit(STEP.package),
      ...(state.deferredPackage
        ? { deferred: "Sender describes" }
        : { primary: parcelDims || "—", secondary: parcelWeight }),
    },
    {
      key: "via",
      onEdit: () => onEdit(STEP.shipping),
      ...(rate
        ? {
            primary: `${carrierDisplayName(rate.carrier)} ${serviceDisplayName(rate.service)}`,
            secondary: rate.estimated_days ? `${rate.estimated_days} days` : "",
          }
        : {
            // Speed plus how long it takes — never the cap. The cap is priced
            // material and belongs to the estimated-cost cell, which states it
            // once and bounds its own range by it. Repeating it here produced
            // two numbers that disagreed ("Up to $25" over a $9–$38 range).
            primary: speedDisplayName(state.speed_preference),
            secondary: estimate ? `${estimate.days} business days` : "",
          }),
    },
  ];

  // Last, and full width: a range needs more room than half a card, and the
  // cost is the thing the user is deciding about on this screen.
  if (estimate) {
    cells.push({
      key: "price",
      label: "estimated cost",
      wide: true,
      onEdit: () => onEdit(STEP.shipping),
      primary: `${formatCents(estimate.low)} – ${formatCents(estimate.high)}`,
      secondary: priceCapDollars
        ? `Capped at $${priceCapDollars} · you're charged the actual rate`
        : "",
    });
  }

  // The chip, the bar, the banner and the row icons all went; this heading is
  // the only thing left that names what the user is about to pay for, so it
  // says which of the two products this is.
  const isLink = state.path === "flexible";

  return (
    <ShipmentDetailsCard
      title={isLink ? "Shipping Link Details" : "Shipment Details"}
      cells={cells}
      total={totalCents !== null ? { label: totalLabel, text: formatCents(totalCents) } : null}
    />
  );
}
