import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Copy, Link2, MapPin, Zap, Shield, CreditCard,
  Package, Truck, CheckCircle2, ExternalLink,
  LogOut, User, AlertCircle, Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import CancelLabelModal from "@/components/CancelLabelModal";

// ─── Types ──────────────────────────────────────────────────

interface DashboardShipment {
  id: string;
  tracking_number: string | null;
  carrier: string;
  service: string;
  status: string;
  refund_status: string;
  display_price_cents: number;
  rate_cents: number;
  is_test: boolean;
  easypost_shipment_id: string | null;
  created_at: string;
  updated_at: string;
  sendmo_links: {
    sender_name: string | null;
  };
}

interface DashboardLink {
  id: string;
  short_code: string;
  max_price_cents: number;
  preferred_speed: string | null;
  recipient_address: {
    name: string;
    street1: string;
    street2: string | null;
    city: string;
    state: string;
    zip: string;
  } | null;
}

const SPEED_LABEL: Record<string, string> = {
  economy: "Economy",
  standard: "Standard",
  express: "Express",
};

// ─── Status config ──────────────────────────────────────────

type DisplayStatus = "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "return_to_sender" | "cancelled";

const STATUS_CONFIG: Record<DisplayStatus, { label: string; color: string; icon: typeof Package }> = {
  label_created: { label: "Label Created", color: "bg-purple-100 text-purple-700 border-purple-200", icon: Package },
  in_transit: { label: "In Transit", color: "bg-blue-100 text-blue-700 border-blue-200", icon: Truck },
  out_for_delivery: { label: "Out for Delivery", color: "bg-blue-100 text-blue-700 border-blue-200", icon: Truck },
  delivered: { label: "Delivered", color: "bg-green-100 text-green-700 border-green-200", icon: CheckCircle2 },
  return_to_sender: { label: "Returned", color: "bg-orange-100 text-orange-700 border-orange-200", icon: AlertCircle },
  cancelled: { label: "Cancelled", color: "bg-red-100 text-red-700 border-red-200", icon: AlertCircle },
};

function statusWithDate(status: string, updatedAt: string): string {
  const date = new Date(updatedAt).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
  switch (status) {
    case "label_created": return `Shipped on ${date}`;
    case "in_transit": return `In transit since ${date}`;
    case "out_for_delivery": return `Out for delivery ${date}`;
    case "delivered": return `Delivered on ${date}`;
    case "return_to_sender": return `Returned on ${date}`;
    case "cancelled": return `Cancelled on ${date}`;
    default: return date;
  }
}

function canVoidLabel(s: DashboardShipment): boolean {
  return (
    !s.is_test &&
    s.easypost_shipment_id !== null &&
    s.status === "label_created" &&
    s.refund_status === "none"
  );
}

function refundBadge(refundStatus: string) {
  if (refundStatus === "none") return null;
  const cfg: Record<string, { label: string; className: string }> = {
    submitted: { label: "Refund Pending", className: "bg-blue-100 text-blue-700 border-blue-200" },
    refunded: { label: "Refunded", className: "bg-green-100 text-green-700 border-green-200" },
    rejected: { label: "Refund Rejected", className: "bg-red-100 text-red-700 border-red-200" },
    not_applicable: { label: "No Refund", className: "bg-gray-100 text-gray-600 border-gray-200" },
  };
  const c = cfg[refundStatus];
  if (!c) return null;
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium", c.className)}>
      {c.label}
    </span>
  );
}

// ─── Component ──────────────────────────────────────────────

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const [copied, setCopied] = useState(false);
  const [shipments, setShipments] = useState<DashboardShipment[]>([]);
  const [loadingShipments, setLoadingShipments] = useState(true);
  const [link, setLink] = useState<DashboardLink | null>(null);
  const [loadingLink, setLoadingLink] = useState(true);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<DashboardShipment | null>(null);
  const [accessToken, setAccessToken] = useState<string>("");

  useEffect(() => {
    async function fetchData() {
      if (!user) return;

      // Get access token for authenticated API calls
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) setAccessToken(session.access_token);

      const shipmentsPromise = supabase
        .from("shipments")
        .select("id, tracking_number, carrier, service, status, refund_status, display_price_cents, rate_cents, is_test, easypost_shipment_id, created_at, updated_at, sendmo_links!inner(user_id, sender_name)")
        .eq("sendmo_links.user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      // Most recent active flexible link (the user's reusable shareable link)
      const linkPromise = supabase
        .from("sendmo_links")
        .select("id, short_code, max_price_cents, preferred_speed, recipient_address:addresses!recipient_address_id(name, street1, street2, city, state, zip)")
        .eq("user_id", user.id)
        .eq("link_type", "flexible")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const [shipmentsRes, linkRes] = await Promise.all([shipmentsPromise, linkPromise]);

      if (!shipmentsRes.error && shipmentsRes.data) {
        setShipments(shipmentsRes.data as unknown as DashboardShipment[]);
      }
      setLoadingShipments(false);

      if (!linkRes.error && linkRes.data) {
        setLink(linkRes.data as unknown as DashboardLink);
      }
      setLoadingLink(false);
    }

    fetchData();
  }, [user]);

  function handleCancelled(shipmentId: string) {
    setShipments((prev) =>
      prev.map((s) =>
        s.id === shipmentId ? { ...s, status: "cancelled", refund_status: "submitted" } : s,
      ),
    );
  }

  const shortUrl = link ? `sendmo.co/s/${link.short_code}` : null;

  function handleCopy() {
    if (!shortUrl) return;
    navigator.clipboard.writeText(`https://${shortUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="min-h-screen bg-gradient-to-b from-background to-muted/50"
    >
      <div className="container max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          {/* Me / profile identity */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-semibold text-sm shrink-0">
              {user?.email?.charAt(0).toUpperCase() ?? "?"}
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground truncate max-w-[200px]">{user?.email}</p>
              <p className="text-xs text-muted-foreground">Your shipments, links & wallet</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" className="rounded-xl gap-2 text-sm" onClick={() => window.location.href = "/onboarding"}>
              <Link2 className="w-4 h-4" />
              New Link
            </Button>

            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center justify-center w-9 h-9 rounded-xl border border-border bg-card hover:bg-muted/50 transition-colors"
                title="Account options"
              >
                <User className="w-4 h-4 text-muted-foreground" />
              </button>

              {showUserMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowUserMenu(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute right-0 top-full mt-1 z-20 w-48 bg-card rounded-xl border border-border shadow-lg p-1"
                  >
                    <button
                      onClick={signOut}
                      className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/5 rounded-lg transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign out
                    </button>
                  </motion.div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Top row: Link + Wallet */}
        <div className="grid gap-5 md:grid-cols-2 mb-8">
          <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Link2 className="w-4 h-4 text-primary" />
                My Label Link
              </h2>
              {link && (
                <Badge variant="outline" className="text-xs border-success/50 text-success bg-success/10">Active</Badge>
              )}
            </div>

            {loadingLink ? (
              <div className="h-24 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : link && shortUrl ? (
              <>
                <div className="flex items-center gap-2 bg-muted/50 rounded-xl px-3 py-2.5 mb-4">
                  <span className="text-sm font-mono text-foreground flex-1 truncate">{shortUrl}</span>
                  <Button variant="ghost" size="sm" onClick={handleCopy} className="rounded-lg gap-1.5 shrink-0">
                    <Copy className="w-3.5 h-3.5" />
                    {copied ? "Copied!" : "Copy"}
                  </Button>
                </div>

                {link.recipient_address && (
                  <div className="bg-muted/30 rounded-xl px-3 py-2.5 mb-3 flex items-start gap-2">
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0 text-xs">
                      <p className="font-medium text-foreground truncate">{link.recipient_address.name}</p>
                      <p className="text-muted-foreground truncate">
                        {[link.recipient_address.street1, link.recipient_address.street2].filter(Boolean).join(", ")}
                      </p>
                      <p className="text-muted-foreground truncate">
                        {link.recipient_address.city}, {link.recipient_address.state} {link.recipient_address.zip}
                      </p>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {link.preferred_speed && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                      <Zap className="w-3 h-3" /> {SPEED_LABEL[link.preferred_speed] ?? link.preferred_speed}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    <Shield className="w-3 h-3" /> Cap: {formatCents(link.max_price_cents)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center text-center py-4">
                <Link2 className="w-8 h-8 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground mb-3">
                  You don't have a shareable link yet
                </p>
                <Button
                  size="sm"
                  className="rounded-xl gap-1.5"
                  onClick={() => window.location.href = "/onboarding?path=flexible"}
                >
                  <Link2 className="w-3.5 h-3.5" />
                  Create my link
                </Button>
              </div>
            )}
          </div>

          <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-primary" />
                My Wallet
              </h2>
              <Badge variant="outline" className="text-xs">Coming Soon</Badge>
            </div>
            <div className="bg-muted/30 rounded-xl px-4 py-5 text-center">
              <CreditCard className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-foreground font-medium">Saved cards & balance</p>
              <p className="text-xs text-muted-foreground mt-1">
                We'll add your payment methods and SendMo balance here when payments launch.
              </p>
            </div>
          </div>
        </div>

        {/* Shipments Table */}
        <div className="bg-card rounded-2xl border border-border shadow-sm">
          <div className="p-5 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Package className="w-4 h-4 text-primary" />
              Shipments
            </h2>
          </div>

          {loadingShipments ? (
            <div className="p-12 text-center">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Loading shipments...</p>
            </div>
          ) : shipments.length === 0 ? (
            <div className="p-12 text-center">
              <Package className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No shipments yet</p>
              <p className="text-xs text-muted-foreground mt-1">When someone uses your label link, shipments will appear here</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-5 py-3 font-medium">Sender</th>
                      <th className="px-5 py-3 font-medium">Carrier</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Amount</th>
                      <th className="px-5 py-3 font-medium">Tracking</th>
                      <th className="px-5 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipments.map((s) => {
                      const statusCfg = STATUS_CONFIG[s.status as DisplayStatus] ?? STATUS_CONFIG.label_created;
                      const StatusIcon = statusCfg.icon;
                      const senderName = (s.sendmo_links as any)?.sender_name || "Unknown";
                      return (
                        <tr key={s.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                          <td className="px-5 py-3 font-medium text-foreground">{senderName}</td>
                          <td className="px-5 py-3 text-muted-foreground">{s.carrier}</td>
                          <td className="px-5 py-3">
                            <div className="flex flex-col gap-0.5">
                              <span className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium w-fit",
                                statusCfg.color,
                              )}>
                                <StatusIcon className="w-3 h-3" />
                                {statusCfg.label}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {statusWithDate(s.status, s.updated_at)}
                              </span>
                              {refundBadge(s.refund_status)}
                            </div>
                          </td>
                          <td className="px-5 py-3 font-medium">{formatCents(s.display_price_cents)}</td>
                          <td className="px-5 py-3">
                            {s.tracking_number && s.tracking_number !== "TEST" ? (
                              <Link
                                to={`/track/${s.tracking_number}`}
                                className="text-primary text-xs font-mono flex items-center gap-1 hover:underline"
                              >
                                {s.tracking_number.slice(0, 14)}...
                                <ExternalLink className="w-3 h-3" />
                              </Link>
                            ) : (
                              <span className="text-muted-foreground text-xs">&mdash;</span>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            {canVoidLabel(s) ? (
                              <button
                                onClick={() => setCancelTarget(s)}
                                className="inline-flex items-center gap-1 text-xs text-destructive hover:underline"
                              >
                                <Ban className="w-3 h-3" />
                                Void Label
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden divide-y divide-border/50">
                {shipments.map((s) => {
                  const statusCfg = STATUS_CONFIG[s.status as DisplayStatus] ?? STATUS_CONFIG.label_created;
                  const StatusIcon = statusCfg.icon;
                  const senderName = (s.sendmo_links as any)?.sender_name || "Unknown";
                  return (
                    <div key={s.id} className="p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-foreground">{senderName}</span>
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          statusCfg.color,
                        )}>
                          <StatusIcon className="w-3 h-3" />
                          {statusCfg.label}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{statusWithDate(s.status, s.updated_at)}</p>
                      {refundBadge(s.refund_status)}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{s.carrier}</span>
                        <span className="font-medium text-foreground">{formatCents(s.display_price_cents)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        {s.tracking_number && s.tracking_number !== "TEST" ? (
                          <Link
                            to={`/track/${s.tracking_number}`}
                            className="text-primary text-xs font-mono flex items-center gap-1 hover:underline"
                          >
                            Track: {s.tracking_number.slice(0, 18)}...
                            <ExternalLink className="w-3 h-3" />
                          </Link>
                        ) : <span />}
                        {canVoidLabel(s) && (
                          <button
                            onClick={() => setCancelTarget(s)}
                            className="inline-flex items-center gap-1 text-xs text-destructive hover:underline"
                          >
                            <Ban className="w-3 h-3" />
                            Void
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Cancel Label Modal */}
      {cancelTarget && (
        <CancelLabelModal
          open={!!cancelTarget}
          onClose={() => setCancelTarget(null)}
          shipment={{
            shipmentId: cancelTarget.id,
            easypostShipmentId: cancelTarget.easypost_shipment_id || "",
            carrier: cancelTarget.carrier,
            trackingNumber: cancelTarget.tracking_number || "",
            rateCents: cancelTarget.rate_cents,
            createdAt: cancelTarget.created_at,
            isTest: cancelTarget.is_test,
          }}
          onCancelled={handleCancelled}
          accessToken={accessToken}
        />
      )}
    </motion.div>
  );
}
