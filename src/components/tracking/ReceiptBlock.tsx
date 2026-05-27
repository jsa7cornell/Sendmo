// Receipt summary block for /t/<public_code> — payer-only.
// Proposal: 2026-05-19_unify-confirmation-into-tracking — Key design decision #5.
// Full mode: shipping + optional insurance + charged-to total row + timestamp.
// Condensed mode: single-line summary for payer-returning visits.

import { Download } from "lucide-react";
import { formatCents } from "@/lib/api";

interface ReceiptBlockProps {
  mode: "full" | "condensed";
  shippingCents?: number;       // required for "full"
  insuranceCents?: number;      // optional for "full"; omit row if missing
  totalCents: number;
  paymentMethodLast4?: string;  // e.g. "4242" — displayed as "•••• 4242"
  chargedAt: string;            // ISO date or formatted string
  receiptPdfUrl?: string;
  /** When set to 'refunded', the receipt renders refund-aware copy ("Refunded
   *  $X.XX on …" instead of "Charged $X.XX") and adds a Refund line in full
   *  mode. Other states are treated as no-refund (charge as-is). */
  refundStatus?: "none" | "submitted" | "refunded" | "rejected" | "not_applicable";
}

/** Returns "Month Day" (e.g. "May 19") if the string parses as a valid Date;
 *  otherwise passes through the original string unchanged. */
function formatMonthDay(value: string): string {
  const d = new Date(value);
  if (!isNaN(d.getTime())) {
    return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  }
  return value;
}

/** Returns "Month Day, Year · H:MM AM/PM" when the string is a parseable ISO date;
 *  otherwise passes through the original string. */
function formatChargedAt(value: string): string {
  const d = new Date(value);
  if (!isNaN(d.getTime())) {
    return d.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return value;
}

function maskedCard(last4: string | undefined): string {
  return last4 ? `•••• ${last4}` : "card on file";
}

export default function ReceiptBlock({
  mode,
  shippingCents,
  insuranceCents,
  totalCents,
  paymentMethodLast4,
  chargedAt,
  receiptPdfUrl,
  refundStatus,
}: ReceiptBlockProps) {
  const card = maskedCard(paymentMethodLast4);
  const isRefunded = refundStatus === "refunded";

  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm p-4 mb-3">
      {/* Header row: "Receipt" + optional PDF link */}
      <h3 className="text-xs font-semibold m-0 mb-2 flex justify-between items-center">
        Receipt
        {receiptPdfUrl && (
          <a
            href={receiptPdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary font-medium hover:underline inline-flex items-center gap-1"
          >
            <Download size={12} />
            PDF
          </a>
        )}
      </h3>

      {mode === "full" && (
        <>
          <dl style={{ margin: 0 }}>
            {/* Shipping row — always present in full mode */}
            {shippingCents !== undefined && (
              <div className="flex justify-between items-baseline text-[13px] py-[3px]">
                <dt className="text-muted-foreground m-0">Shipping</dt>
                <dd className="m-0 font-medium">{formatCents(shippingCents)}</dd>
              </div>
            )}

            {/* Insurance row — omitted when not provided */}
            {insuranceCents !== undefined && (
              <div className="flex justify-between items-baseline text-[13px] py-[3px]">
                <dt className="text-muted-foreground m-0">Insurance</dt>
                <dd className="m-0 font-medium">{formatCents(insuranceCents)}</dd>
              </div>
            )}

            {/* Charged-to total — bordered top. Renders the original charge
                even when refunded (the refund is shown as a separate row). */}
            <div className="flex justify-between items-baseline text-[13px] border-t border-border mt-[6px] pt-2">
              <dt className="text-muted-foreground m-0">Charged to {card}</dt>
              <dd className="m-0 font-semibold">{formatCents(totalCents)}</dd>
            </div>

            {/* Refund row — only when refund completed */}
            {isRefunded && (
              <>
                <div className="flex justify-between items-baseline text-[13px] py-[3px]">
                  <dt className="text-emerald-700 m-0">Refunded</dt>
                  <dd className="m-0 font-medium text-emerald-700">−{formatCents(totalCents)}</dd>
                </div>
                <div className="flex justify-between items-baseline text-[13px] border-t border-border mt-[6px] pt-2">
                  <dt className="text-muted-foreground m-0">Net</dt>
                  <dd className="m-0 font-semibold">{formatCents(0)}</dd>
                </div>
              </>
            )}
          </dl>

          {/* Timestamp */}
          <p className="text-xs text-muted-foreground mt-1.5 m-0">
            {formatChargedAt(chargedAt)}
            {isRefunded && " · refund issued"}
          </p>
        </>
      )}

      {mode === "condensed" && (
        <p className="text-[13px] text-foreground m-0">
          {isRefunded ? (
            <>
              <span className="text-emerald-700 font-medium">Refunded {formatCents(totalCents)}</span>
              {" · "}back to {card}
              {" · "}
              {formatMonthDay(chargedAt)}
            </>
          ) : (
            <>
              {formatCents(totalCents)}
              {" · "}charged to {card}
              {" · "}
              {formatMonthDay(chargedAt)}
            </>
          )}
        </p>
      )}
    </div>
  );
}
