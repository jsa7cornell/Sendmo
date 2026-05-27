import { AlertCircle, Clock, User, CheckCircle2 } from "lucide-react";

interface Props {
  cancelledAt: string | null;
  /** Server-derived actor from event_logs (cancel-label audit row). */
  actor: "admin" | "link_owner" | "session_token" | "email_token" | null;
  /** From tracking response — true when the signed-in viewer owns the link. */
  viewerIsRecipient: boolean;
  /** Refund sub-state from shipments.refund_status. */
  refundStatus: "none" | "submitted" | "refunded" | "rejected" | "not_applicable";
  /** Amount paid in cents; only meaningful when refundStatus='refunded' and paid=true. */
  amountPaidCents: number | null;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function actorLabel(
  actor: Props["actor"],
  viewerIsRecipient: boolean,
): string | null {
  if (!actor) return null;
  if (actor === "admin") return "Cancelled by SendMo admin";
  if (actor === "link_owner") {
    return viewerIsRecipient ? "Cancelled by you" : "Cancelled by the recipient";
  }
  // session_token + email_token both map to the anonymous sender path
  return "Cancelled by the sender";
}

function RefundChip({ status, amountPaidCents }: { status: Props["refundStatus"]; amountPaidCents: number | null }) {
  if (status === "refunded") {
    const dollars = amountPaidCents != null ? (amountPaidCents / 100).toFixed(2) : null;
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {dollars ? `Refund of $${dollars} issued` : "Refund issued"}
      </div>
    );
  }
  if (status === "submitted") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
        <Clock className="w-3.5 h-3.5" />
        Cancellation in progress — refund pending
      </div>
    );
  }
  if (status === "rejected") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive">
        <AlertCircle className="w-3.5 h-3.5" />
        Cancellation rejected — please contact support
      </div>
    );
  }
  if (status === "not_applicable") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
        No charge was made
      </div>
    );
  }
  return null;
}

function bodyCopy(status: Props["refundStatus"]): string {
  switch (status) {
    case "refunded":
      return "The shipment will not ship. Your refund has been issued — it typically appears on your statement within 5–10 business days.";
    case "submitted":
      return "The shipment will not ship. Your refund is being processed and will appear on your SendMo account within 1–2 weeks.";
    case "rejected":
      return "The shipment will not ship. We weren't able to issue a refund automatically — please contact support and we'll make it right.";
    case "not_applicable":
      return "The shipment will not ship. No charge was made for this label.";
    case "none":
    default:
      return "The shipment will not ship.";
  }
}

export default function CancelledShipmentBanner({
  cancelledAt,
  actor,
  viewerIsRecipient,
  refundStatus,
  amountPaidCents,
}: Props) {
  const who = actorLabel(actor, viewerIsRecipient);
  return (
    <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-5 space-y-3">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h2 className="text-base font-semibold text-foreground">This label was voided</h2>
          <p className="text-sm text-muted-foreground">{bodyCopy(refundStatus)}</p>
        </div>
      </div>

      {(cancelledAt || who) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground pl-8">
          {cancelledAt && (
            <span className="inline-flex items-center gap-1.5" title={absoluteTime(cancelledAt)}>
              <Clock className="w-3.5 h-3.5" />
              Cancelled {relativeTime(cancelledAt)} · {absoluteTime(cancelledAt)}
            </span>
          )}
          {who && (
            <span className="inline-flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" />
              {who}
            </span>
          )}
        </div>
      )}

      {refundStatus !== "none" && (
        <div className="pl-8">
          <RefundChip status={refundStatus} amountPaidCents={amountPaidCents} />
        </div>
      )}
    </div>
  );
}
