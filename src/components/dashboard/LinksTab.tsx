// Dashboard "Links" tab — decided 2026-05-13.
//
// One card per parent link the user owns. Each card surfaces:
//   - link short_code (mono, clickable to share via /s/<short_code>)
//   - link status badge (Active / In Use / Used Up)
//   - link type (full_label vs flexible — they behave differently)
//   - recipient city/state (street1 hidden per PLAYBOOK Rule 7)
//   - up to 5 child shipments, each clickable to /t/<public_code>
//   - "View all N shipments" link when count > 5 (target page is a stub
//     for now — link routes to /dashboard?tab=shipments&link=<short_code>
//     so the Shipments tab can filter to that link when we build it).
//
// The link-row data + the user's full shipment list are fetched in Dashboard
// itself and passed in; this component is pure rendering. Keeps the fetch
// shape consistent with the existing Shipments tab.
import { Link } from "react-router-dom";
import { Link2, ChevronRight, Package, Truck, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChildShipment {
  id: string;
  public_code: string | null;
  tracking_number: string | null;
  status: string;
  is_test: boolean;
  created_at: string;
}

interface LinkWithShipments {
  id: string;
  short_code: string;
  link_type: string;
  status: string;
  created_at: string;
  recipient_address: {
    name: string | null;
    city: string | null;
    state: string | null;
  } | null;
  shipments: ChildShipment[];   // already sorted by created_at DESC
  total_shipments: number;
}

interface Props {
  links: LinkWithShipments[];
  loading: boolean;
}

const LINK_STATUS: Record<string, { label: string; tone: string }> = {
  active:    { label: "Active",    tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  in_use:    { label: "In use",    tone: "bg-amber-50 text-amber-800 border-amber-200" },
  completed: { label: "Used up",   tone: "bg-muted text-muted-foreground border-border" },
  used:      { label: "Used up",   tone: "bg-muted text-muted-foreground border-border" },
};

const SHIPMENT_ICON: Record<string, { Icon: typeof Package; color: string }> = {
  label_created:    { Icon: Clock,        color: "text-muted-foreground" },
  in_transit:       { Icon: Truck,        color: "text-primary" },
  out_for_delivery: { Icon: Truck,        color: "text-success" },
  delivered:        { Icon: CheckCircle2, color: "text-success" },
  cancelled:        { Icon: AlertCircle,  color: "text-destructive" },
  return_to_sender: { Icon: AlertCircle,  color: "text-destructive" },
};

function shortStatus(status: string): string {
  switch (status) {
    case "label_created": return "Ready to ship";
    case "in_transit": return "In transit";
    case "out_for_delivery": return "Out for delivery";
    case "delivered": return "Delivered";
    case "cancelled": return "Cancelled";
    case "return_to_sender": return "Returned";
    default: return status;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function LinksTab({ links, loading }: Props) {
  if (loading) {
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm p-12 text-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">Loading links...</p>
      </div>
    );
  }

  if (links.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm p-12 text-center">
        <Link2 className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No links yet</p>
        <p className="text-xs text-muted-foreground mt-1">Create a SendMo link from the onboarding flow to share with senders.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {links.map((l) => {
        const statusCfg = LINK_STATUS[l.status] ?? { label: l.status, tone: "bg-muted text-muted-foreground border-border" };
        const recipient = l.recipient_address;
        const recipientLine = recipient
          ? [recipient.name, [recipient.city, recipient.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
          : null;
        const hasMore = l.total_shipments > l.shipments.length;
        return (
          <div key={l.id} className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
            {/* Link header */}
            <div className="p-5 border-b border-border/60">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <Link2 className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="font-mono text-base font-semibold text-foreground">{l.short_code}</span>
                    <Badge variant="outline" className={cn("text-[10px]", statusCfg.tone)}>{statusCfg.label}</Badge>
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {l.link_type === "full_label" ? "Full label" : "Flexible"}
                    </Badge>
                  </div>
                  {recipientLine && (
                    <p className="text-xs text-muted-foreground">For {recipientLine}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Created {formatDate(l.created_at)} · sendmo.co/s/{l.short_code}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button asChild variant="outline" size="sm" className="rounded-lg text-xs">
                    <Link to={`/links/${l.id}/edit`}>Manage</Link>
                  </Button>
                </div>
              </div>
            </div>

            {/* Child shipments — up to 5 */}
            {l.shipments.length === 0 ? (
              <div className="px-5 py-4 text-xs text-muted-foreground italic">
                No shipments yet. Share <span className="font-mono">sendmo.co/s/{l.short_code}</span> with a sender.
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {l.shipments.map((s) => {
                  const icon = SHIPMENT_ICON[s.status] ?? SHIPMENT_ICON.label_created;
                  const { Icon } = icon;
                  return (
                    <li key={s.id}>
                      <Link
                        to={s.public_code ? `/t/${s.public_code}` : "#"}
                        className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Icon className={cn("w-4 h-4 flex-shrink-0", icon.color)} />
                          <span className="text-sm text-foreground">{shortStatus(s.status)}</span>
                          {s.is_test && (
                            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 uppercase tracking-wide flex-shrink-0">
                              Test
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {s.public_code && (
                            <span className="font-mono text-xs text-primary">{s.public_code}</span>
                          )}
                          <span className="text-[11px] text-muted-foreground">{formatDate(s.created_at)}</span>
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Overflow link when total > 5. Target page is stubbed for now —
                routes to ?tab=shipments&link=<short_code> so the Shipments
                tab can filter when that feature lands. */}
            {hasMore && (
              <div className="px-5 py-2.5 border-t border-border/60 bg-muted/20">
                <Link
                  to={`/dashboard?tab=shipments&link=${l.short_code}`}
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  View all {l.total_shipments} shipments
                  <ChevronRight className="w-3 h-3" />
                </Link>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
