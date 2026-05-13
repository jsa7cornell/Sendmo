// F3 cancelled-only — forward-looking CTA so users aren't stuck on a dead-end
// page after voiding. Decided 2026-05-13. Now also surfaces the parent link's
// short_code + current status (added 2026-05-13 evening) so the user can see
// the link is alive and reusable — answers the "the shipment cancelled but is
// my prepaid link still good?" question without a Dashboard round-trip.
//
// Notably does NOT set `sendmo_just_voided_for_change` — that flag is reserved
// for the mid-cancel "let's try again" flow (TrackingPage.handleCancelConfirm).
// A cold-landing user clicking this is a *fresh start*, not a continuation;
// the SenderFlow "Previous label voided" banner should not show.
//
// Does NOT render for return_to_sender shipments (PP4) — printing another
// label doesn't help when a physical package is being returned.
import { Link } from "react-router-dom";
import { ArrowRight, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** When null/undefined, the CTA falls back to "Start a new shipment" linking home. */
  linkShortCode: string | null;
  /** Current status of the parent link (`active` / `in_use` / `completed` / …).
   *  Surfaced as a small badge above the CTA so the user can see whether the
   *  link is still reusable. Null when tracking response didn't carry it. */
  linkStatus?: string | null;
  /** Only render when status === 'cancelled' (not return_to_sender). */
  status: string;
}

// Maps the link's lifecycle status to user-facing copy + a coarse color tier.
function linkStatusDisplay(linkStatus: string | null | undefined): { label: string; tone: "active" | "in_use" | "completed" | "unknown" } {
  switch (linkStatus) {
    case "active":    return { label: "Active — you can reuse it",       tone: "active" };
    case "in_use":    return { label: "In use on another label",         tone: "in_use" };
    case "completed": return { label: "Used up — start a new shipment",  tone: "completed" };
    default:          return { label: linkStatus ?? "Unknown",            tone: "unknown" };
  }
}

const TONE_CLASSES: Record<string, string> = {
  active:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  in_use:    "bg-amber-50 text-amber-800 border-amber-200",
  completed: "bg-muted text-muted-foreground border-border",
  unknown:   "bg-muted text-muted-foreground border-border",
};

export default function PrintAnotherLabelCTA({ linkShortCode, linkStatus, status }: Props) {
  if (status !== "cancelled") return null;

  // No link short_code → orphan or admin cancel without a parent link.
  // Fall back to a generic "start a new shipment" CTA.
  if (!linkShortCode) {
    return (
      <div>
        <Link to="/" className="block">
          <Button variant="outline" className="w-full rounded-xl py-5">
            Start a new shipment
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </Link>
      </div>
    );
  }

  const display = linkStatusDisplay(linkStatus);
  // The CTA button only routes back to /s/<short_code> when the link is
  // currently reusable (`active`). In other states we surface the link
  // reference for context but downgrade the button so the user doesn't
  // hit an unhelpful sender wizard.
  const ctaUsable = linkStatus === "active";

  return (
    <div className="space-y-2">
      {/* Parent link reference + status — only on cancelled state, per the
          IA decision (F1/F2 don't show parent; F3 does). Short_code is
          intentionally surfaced so users can recognize / reference it. */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Link2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <span className="text-xs text-muted-foreground">From link</span>
          <span className="font-mono text-sm font-semibold text-foreground truncate">{linkShortCode}</span>
        </div>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[display.tone]}`}>
          {display.label}
        </span>
      </div>

      {ctaUsable ? (
        <>
          <Link to={`/s/${linkShortCode}`} className="block">
            <Button className="w-full rounded-xl shadow-md py-6 text-base">
              Print another label
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </Link>
          <p className="text-xs text-muted-foreground text-center">
            Uses your existing SendMo link.
          </p>
        </>
      ) : (
        <Link to="/" className="block">
          <Button variant="outline" className="w-full rounded-xl py-5">
            Start a new shipment
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </Link>
      )}
    </div>
  );
}
