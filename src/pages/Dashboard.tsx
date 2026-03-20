import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Copy, Link2, MapPin, Zap, Shield, CreditCard,
  Package, Truck, CheckCircle2, ExternalLink, Settings,
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
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<DashboardShipment | null>(null);
  const [accessToken, setAccessToken] = useState<string>("");

  useEffect(() => {
    async function fetchShipments() {
      if (!user) return;

      // Get access token for authenticated API calls
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) setAccessToken(session.access_token);

      const { data, error } = await supabase
        .from("shipments")
        .select("id, tracking_number, carrier, service, status, refund_status, display_price_cents, rate_cents, is_test, easypost_shipment_id, created_at, updated_at, sendmo_links!inner(user_id, sender_name)")
        .eq("sendmo_links.user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (!error && data) {
        setShipments(data as unknown as DashboardShipment[]);
      }
      setLoadingShipments(false);
    }

    fetchShipments();
  }, [user]);

  function handleCancelled(shipmentId: string) {
    setShipments((prev) =>
      prev.map((s) =>
        s.id === shipmentId ? { ...s, status: "cancelled", refund_status: "submitted" } : s,
      ),
    );
  }

  const shortUrl = "sendmo.co/s/k8Hj2mNp4x"; // placeholder

  function handleCopy() {
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
          <div>
            <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage your label links, payments, and shipments</p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" className="rounded-xl gap-2" onClick={() => window.location.href = "/onboarding"}>
              <Link2 className="w-4 h-4" />
              New Link
            </Button>

            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
              >
                <User className="w-4 h-4 text-muted-foreground" />
                <span className="hidden sm:inline text-muted-foreground max-w-[160px] truncate">
                  {user?.email}
                </span>
              </button>

              {showUserMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowUserMenu(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute right-0 top-full mt-1 z-20 w-56 bg-card rounded-xl border border-border shadow-lg p-1"
                  >
                    <div className="px-3 py-2 border-b border-border mb-1">
                      <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                    </div>
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
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs border-success/50 text-success bg-success/10">Active</Badge>
                <button className="text-muted-foreground hover:text-foreground transition-colors">
                  <Settings className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 bg-muted/50 rounded-xl px-3 py-2.5 mb-4">
              <span className="text-sm font-mono text-foreground flex-1 truncate">{shortUrl}</span>
              <Button variant="ghost" size="sm" onClick={handleCopy} className="rounded-lg gap-1.5 shrink-0">
                <Copy className="w-3.5 h-3.5" />
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"><MapPin className="w-3 h-3" /> San Francisco, CA</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"><Zap className="w-3 h-3" /> Standard</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"><Shield className="w-3 h-3" /> Cap: $100</span>
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4">
              <CreditCard className="w-4 h-4 text-primary" />
              My Wallet
            </h2>
            <div className="flex items-center gap-3 bg-muted/50 rounded-xl px-4 py-3 mb-3">
              <div className="w-10 h-7 rounded bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center">
                <span className="text-[10px] font-bold text-white">VISA</span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">&bull;&bull;&bull;&bull; 4242</p>
                <p className="text-xs text-muted-foreground">Expires 12/29</p>
              </div>
            </div>
            <div className="flex items-center justify-between bg-muted/50 rounded-xl px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground">SendMo Balance</p>
                <p className="text-lg font-bold text-foreground">$0.00</p>
              </div>
              <Badge variant="outline" className="text-xs">Coming Soon</Badge>
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
