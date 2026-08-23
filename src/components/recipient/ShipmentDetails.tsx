import { Pencil } from "lucide-react";
import { formatCents } from "@/lib/api";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// The one place the flow summarises itself (2026-08-23).
//
// The progress bar, the path chip and the "this will be a shipping link"
// banner all went at once: three devices competing to say where you were,
// none of them saying what you had actually decided. This says the second
// thing, once, on the last screen before money moves — which is the only
// point in the flow where a summary is what the user wants.
//
// FROM sits left of TO because that is the direction a shipment travels, and
// the pairing is why this is a 2×2 rather than a list: the two addresses read
// as a route when they sit side by side.
//
// Every cell carries its own edit, because this replaced the progress bar and
// is now the only way back to an earlier question from the payment step.

/** Flow steps each cell edits. Mirrors stepRouting's numbering. */
const STEP = { destination: 1, origin: 10, package: 14, shipping: 20 } as const;

interface Cell {
  key: string;
  step: number;
  /** Undefined when the question was handed to the sender. */
  primary?: string;
  secondary?: string;
  /** Shown in place of primary/secondary when deferred. */
  deferred?: string;
}

interface Props {
  state: RecipientFlowState;
  /** Null while no concrete price exists — the flexible path caps instead. */
  totalCents?: number | null;
  /** Names what the number is: "Total" for a label, "Charged up to" for a cap. */
  totalLabel?: string;
  /** Jump back to the step a cell describes. */
  onEdit: (step: number) => void;
}

export default function ShipmentDetails({
  state, totalCents = null, totalLabel = "Total", onEdit,
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
  const speedLabel: Record<string, string> = {
    no_rush: "No rush · cheapest",
    standard: "Standard",
    express: "Express",
  };

  const cells: Cell[] = [
    {
      key: "from",
      step: STEP.origin,
      ...(state.deferredOrigin
        ? { deferred: "Sender fills in" }
        : { primary: origin.name || "—", secondary: origin.street || "" }),
    },
    {
      key: "to",
      step: STEP.destination,
      ...(state.deferredDestination
        ? { deferred: "Sender chooses" }
        : { primary: destination.name || "—", secondary: destination.street || "" }),
    },
    {
      key: "parcel",
      step: STEP.package,
      ...(state.deferredPackage
        ? { deferred: "Sender describes" }
        : { primary: parcelDims || "—", secondary: parcelWeight }),
    },
    {
      key: "via",
      step: STEP.shipping,
      ...(rate
        ? {
            primary: `${carrierDisplayName(rate.carrier)} ${serviceDisplayName(rate.service)}`,
            secondary: rate.estimated_days ? `${rate.estimated_days} days` : "",
          }
        : {
            // Speed only — no cap. The cap is priced material and belongs to
            // the Estimated shipping cost panel below, which states it once
            // and bounds its own range by it. Repeating it here produced two
            // numbers that disagreed ("Up to $25" over a $9–$38 range).
            primary: speedLabel[state.speed_preference] ?? "Standard",
            secondary: "",
          }),
    },
  ];

  // The chip, the bar, the banner and the row icons all went; this heading is
  // the only thing left that names what the user is about to pay for, so it
  // says which of the two products this is.
  const isLink = state.path === "flexible";

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden max-w-md">
      <h3 className="px-3 py-2 bg-muted border-b border-border text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
        {isLink ? "Shipping Link Details" : "Shipment Details"}
      </h3>

      {/* 2×2 on any screen wide enough for two addresses; one column below
          that, where a truncated street is worse than a taller card. */}
      <div className="grid grid-cols-1 min-[380px]:grid-cols-2">
        {cells.map((cell, i) => (
          <div
            key={cell.key}
            className={[
              "min-w-0 px-3 py-2 border-border",
              // Interior rules only — the card's own border closes the edges.
              "border-t",
              i % 2 === 0 ? "min-[380px]:border-r" : "",
              i < 2 ? "min-[380px]:border-t-0" : "",
              i === 0 ? "border-t-0" : "",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {cell.key}
              </span>
              <button
                type="button"
                onClick={() => onEdit(cell.step)}
                aria-label={`Edit ${cell.key}`}
                className="text-muted-foreground rounded p-0.5 -mr-0.5 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Pencil className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
            {cell.deferred ? (
              <p className="text-[12.5px] italic text-muted-foreground truncate">{cell.deferred}</p>
            ) : (
              <>
                <p className="text-[12.5px] truncate">{cell.primary}</p>
                {cell.secondary && (
                  <p className="text-[12.5px] text-muted-foreground truncate">{cell.secondary}</p>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {totalCents !== null && (
        <div className="flex items-baseline justify-between px-3 py-2 bg-muted border-t border-border">
          <span className="text-xs font-semibold">{totalLabel}</span>
          <span className="text-lg font-bold text-primary tabular-nums">{formatCents(totalCents)}</span>
        </div>
      )}
    </div>
  );
}
