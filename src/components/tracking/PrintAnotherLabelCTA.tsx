// F3 cancelled-only — forward-looking CTA so users aren't stuck on a dead-end
// page after voiding. Decided 2026-05-13.
//
// Notably does NOT set `sendmo_just_voided_for_change` — that flag is reserved
// for the mid-cancel "let's try again" flow (TrackingPage.handleCancelConfirm).
// A cold-landing user clicking this is a *fresh start*, not a continuation;
// the SenderFlow "Previous label voided" banner should not show.
//
// Does NOT render for return_to_sender shipments (PP4) — printing another
// label doesn't help when a physical package is being returned.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** When null/undefined, the CTA falls back to "Start a new shipment" linking home. */
  linkShortCode: string | null;
  /** Only render when status === 'cancelled' (not return_to_sender). */
  status: string;
}

export default function PrintAnotherLabelCTA({ linkShortCode, status }: Props) {
  if (status !== "cancelled") return null;

  if (linkShortCode) {
    return (
      <div>
        <Link to={`/s/${linkShortCode}`} className="block">
          <Button className="w-full rounded-xl shadow-md py-6 text-base">
            Print another label
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </Link>
        <p className="text-xs text-muted-foreground text-center mt-2">
          Uses your existing SendMo link.
        </p>
      </div>
    );
  }

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
