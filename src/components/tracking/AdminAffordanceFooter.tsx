// Admin-only footer link at the bottom of /t/<public_code>. Decided 2026-05-13.
//
// Scaffolding for "Ask 4" — the full inline admin debug panel (identifiers,
// ledger table, event log, refetch button) lives in a follow-up proposal.
// This affordance preserves the seam so admins can context-switch to the
// admin report without redesign when Ask 4 lands.
//
// Gated by `isAdmin` in the caller. The `shipmentId` prop is only populated
// for admin callers (tracking response server-side branches per B4) — if
// somehow rendered without it, falls back to /admin (no deep-link).
import { Settings } from "lucide-react";
import { Link } from "react-router-dom";

interface Props {
  shipmentId: string | undefined;
}

export default function AdminAffordanceFooter({ shipmentId }: Props) {
  const href = shipmentId ? `/admin?shipment=${encodeURIComponent(shipmentId)}` : "/admin";
  return (
    <div className="border-t border-border mt-8 pt-4 flex justify-center">
      <Link
        to={href}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
      >
        <Settings className="w-3.5 h-3.5" />
        Admin debug
      </Link>
    </div>
  );
}
