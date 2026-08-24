import { Pencil } from "lucide-react";

// The one place a flow summarises itself — shared by BOTH sides of a shipment
// (2026-08-24). The creator sees it on the payment step; the sender sees it on
// the review step, right before the label is generated. Same block, same
// reading order, so the two halves of one shipment describe it identically.
//
// Presentational only: it takes cells, not flow state. Each side builds its
// own cells (recipient/ShipmentDetails.tsx from RecipientFlowState;
// sender/SenderStepReview.tsx from the link + what the sender entered),
// which is what lets the sender omit the price cells — the sender never sees
// what the shipment costs (PLAYBOOK Rule 7's sibling: the payer's money is
// not the sender's business).
//
// FROM sits left of TO because that is the direction a shipment travels, and
// the pairing is why this is a 2×2 rather than a list: the two addresses read
// as a route when they sit side by side.

export interface DetailCell {
  /** Cell label, lowercase — "from", "to", "parcel", "via". */
  key: string;
  /** Overrides `key` as the cell's label when the key is too terse. */
  label?: string;
  /** Full width — used by the price range, which needs the room. */
  wide?: boolean;
  primary?: string;
  secondary?: string;
  /** Shown in place of primary/secondary when the question was handed on. */
  deferred?: string;
  /** Omit to render the cell without an edit affordance. */
  onEdit?: () => void;
}

interface Props {
  /** "Shipment Details" for a label, "Shipping Link Details" for a link. */
  title: string;
  cells: DetailCell[];
  /** Footer row. Null hides it — no concrete total exists yet. */
  total?: { label: string; text: string } | null;
}

export default function ShipmentDetailsCard({ title, cells, total = null }: Props) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden max-w-md">
      <h3 className="px-3 py-2 bg-muted border-b border-border text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
        {title}
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
              cell.wide ? "min-[380px]:col-span-2" : "",
              !cell.wide && i % 2 === 0 ? "min-[380px]:border-r" : "",
              i < 2 ? "min-[380px]:border-t-0" : "",
              i === 0 ? "border-t-0" : "",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {cell.label ?? cell.key}
              </span>
              {cell.onEdit && (
                <button
                  type="button"
                  onClick={cell.onEdit}
                  aria-label={`Edit ${cell.label ?? cell.key}`}
                  className="text-muted-foreground rounded p-0.5 -mr-0.5 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Pencil className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
            </div>
            {cell.deferred ? (
              <p className="text-[12.5px] italic text-muted-foreground truncate">{cell.deferred}</p>
            ) : (
              <>
                <p className={cell.wide
                  ? "text-[15px] font-bold text-primary tabular-nums truncate"
                  : "text-[12.5px] truncate"}>{cell.primary}</p>
                {cell.secondary && (
                  <p className="text-[12.5px] text-muted-foreground truncate">{cell.secondary}</p>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {total && (
        <div className="flex items-baseline justify-between px-3 py-2 bg-muted border-t border-border">
          <span className="text-xs font-semibold">{total.label}</span>
          <span className="text-lg font-bold text-primary tabular-nums">{total.text}</span>
        </div>
      )}
    </div>
  );
}
