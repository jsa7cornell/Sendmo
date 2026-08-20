import { Package, Link2 } from "lucide-react";
import { formatCents } from "@/lib/api";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import { displayName } from "@/lib/name";
import { senderTodoSentence, CHARGE_NOTE } from "@/lib/senderTodo";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// The summary above the card field — the last thing a creator reads before
// paying, on BOTH paths (John, 2026-08-19). The handoff specced it only for
// the link path; the label path is 100% of revenue to date and had no summary
// at all before the charge, which is the worse gap of the two.
//
// Layout note: Total is a row in the list, not a separate emphasised block
// (John). On the link path it reads "Up to $100" — the cap is scoped to one
// shipment, which is the only place a cap figure is truthful. See senderTodo
// for why the old "never more" phrasing was removed rather than reworded.

// Dimensions and weight are what the carrier actually quoted, so they stay on
// the screen where the quote is charged even when the creator also typed a
// description. Envelopes have no meaningful height.
function parcelLine(state: RecipientFlowState): string {
  const { length, width, height } = state.dimensions;
  const size = state.packagingType === "envelope"
    ? `${length}×${width} in`
    : `${length}×${width}×${height} in`;
  return `${size} · ${state.weight.lbs || 0} lb ${state.weight.oz || 0} oz`;
}

interface Props {
  state: RecipientFlowState;
  /**
   * Exact total for a prepaid label; unused on the link path, where the Total
   * row shows the cap instead. A discriminated union cannot express this —
   * which arm applies depends on `state.path`, which the types cannot see —
   * so the guard is at render: a missing total shows "—", never "$0.00".
   * A confident zero above the field that charges the real amount is the one
   * failure this row must not have.
   */
  totalCents?: number;
}

export default function RecipientStepPaymentSummary({ state, totalCents }: Props) {
  const isLink = state.path === "flexible";
  const deferred = {
    destination: state.deferredDestination,
    origin: state.deferredOrigin,
    package: state.deferredPackage,
  };
  const todo = senderTodoSentence(deferred);

  const toName = displayName(state.destinationAddress.name) || state.destinationAddress.name;
  const fromName = displayName(state.originAddress.name) || state.originAddress.name;

  // "Sender fills this in" repeats the words of the toggle the creator used
  // two steps earlier, so the row reads as the answer they gave rather than
  // as missing data.
  const pending = <span className="text-muted-foreground italic">Sender fills this in</span>;

  const carrier = state.selectedRate
    ? `${carrierDisplayName(state.selectedRate.carrier)} ${serviceDisplayName(state.selectedRate.service)}`
    : state.preferred_carrier && state.preferred_carrier !== "any"
      ? `${carrierDisplayName(state.preferred_carrier)} preferred · ${state.speed_preference} speed`
      : `Sender picks · ${state.speed_preference} speed`;

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <div className="mb-4">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary border border-primary/20 px-3 py-1 text-xs font-medium">
          {isLink ? (
            <><Link2 className="w-3 h-3" aria-hidden="true" /> Shipping link</>
          ) : (
            <><Package className="w-3 h-3" aria-hidden="true" /> Prepaid label</>
          )}
        </span>
      </div>

      <dl className="text-sm">
        <div className="flex gap-3 py-1">
          <dt className="text-muted-foreground w-20 shrink-0">To</dt>
          <dd className="min-w-0 flex-1">
            {state.deferredDestination ? pending : (
              <>
                {toName}
                {state.destinationAddress.city && (
                  <span className="text-muted-foreground">
                    {" "}· {state.destinationAddress.city}, {state.destinationAddress.state}
                  </span>
                )}
              </>
            )}
          </dd>
        </div>

        <div className="flex gap-3 py-1">
          <dt className="text-muted-foreground w-20 shrink-0">From</dt>
          <dd className="min-w-0 flex-1">
            {state.deferredOrigin ? pending : (
              <>
                {fromName}
                {state.originAddress.city && (
                  <span className="text-muted-foreground">
                    {" "}· {state.originAddress.city}, {state.originAddress.state}
                  </span>
                )}
              </>
            )}
          </dd>
        </div>

        <div className="flex gap-3 py-1">
          <dt className="text-muted-foreground w-20 shrink-0">Package</dt>
          <dd className="min-w-0 flex-1">
            {state.deferredPackage ? pending : (
              <>
                {state.itemDescription && <>{state.itemDescription}<br /></>}
                <span className="text-muted-foreground">{parcelLine(state)}</span>
              </>
            )}
          </dd>
        </div>

        <div className="flex gap-3 py-1">
          <dt className="text-muted-foreground w-20 shrink-0">Carrier</dt>
          <dd className="min-w-0 flex-1">{carrier}</dd>
        </div>

        {/* Insurance is a real +$2.50 on the total. The card it replaced showed
            it; dropping it would leave the Total unexplainable by the rows
            above it, which on a payment screen is the one thing a summary
            must never do. */}
        {state.insurance && (
          <div className="flex gap-3 py-1">
            <dt className="text-muted-foreground w-20 shrink-0">Insurance</dt>
            <dd className="min-w-0 flex-1">Included · $2.50</dd>
          </div>
        )}

        <div className="flex gap-3 py-1 mt-1 border-t border-border pt-2">
          <dt className="text-muted-foreground w-20 shrink-0">Total</dt>
          <dd className="min-w-0 flex-1 font-medium">
            {isLink
              ? `Up to $${state.price_cap} per shipment`
              : totalCents === undefined ? "—" : formatCents(totalCents)}
          </dd>
        </div>
      </dl>

      {(todo || isLink) && (
        <p className="text-sm leading-relaxed mt-4 pt-3 border-t border-border">
          {todo && <>{todo} </>}
          <span className="text-muted-foreground">{CHARGE_NOTE}</span>
        </p>
      )}
    </div>
  );
}
