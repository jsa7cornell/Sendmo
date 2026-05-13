import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Copy, Link2, MapPin, Zap, Shield, CreditCard,
  Package, Truck, CheckCircle2, ChevronRight,
  LogOut, User, AlertCircle, Pencil, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import SendMoLogo from "@/components/SendMoLogo";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";

// ─── Types ──────────────────────────────────────────────────

interface DashboardShipment {
  id: string;
  tracking_number: string | null;
  public_code: string | null;
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
  // PostgREST embeddings for sender + recipient on the shipment itself.
  // Aliases `sender_address` / `recipient_address` disambiguate the two
  // FKs to `addresses`. The shipment-level address is canonical — for flex
  // links the link's sender_name is null and only shipments.sender_address.name
  // tells us who actually shipped this particular parcel.
  sender_address: { name: string | null } | null;
  recipient_address: { name: string | null } | null;
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

// For each shipment status, pick the right "as of" date:
//   label_created → created_at (the label was made; nothing else has happened)
//   anything else → updated_at (the most recent transition)
// Pre-2026-05-13 this used updated_at uniformly and rendered "Shipped on …"
// for label_created shipments — a lie when the package hadn't actually moved.
function statusWithDate(status: string, createdAt: string, updatedAt: string): string {
  const dateStr = (iso: string) => new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
  switch (status) {
    case "label_created": return `Created on ${dateStr(createdAt)} · awaiting carrier scan`;
    case "in_transit": return `In transit since ${dateStr(updatedAt)}`;
    case "out_for_delivery": return `Out for delivery ${dateStr(updatedAt)}`;
    case "delivered": return `Delivered on ${dateStr(updatedAt)}`;
    case "return_to_sender": return `Returned on ${dateStr(updatedAt)}`;
    case "cancelled": return `Cancelled on ${dateStr(updatedAt)}`;
    default: return dateStr(updatedAt);
  }
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const updatedLinkId = searchParams.get("updated_link");
  const [showUpdatedBanner, setShowUpdatedBanner] = useState(!!updatedLinkId);
  // One-shot welcome banner triggered by ?welcome=1 — set by AuthContext's
  // emailRedirectTo/redirectTo for both the magic-link click and the Google
  // OAuth return, AND by the /login OTP-verify flow's programmatic navigate.
  // Strip the param on first paint so the banner doesn't reappear on refresh.
  const [showWelcome, setShowWelcome] = useState(searchParams.get("welcome") === "1");
  useEffect(() => {
    if (searchParams.get("welcome") === "1") {
      const next = new URLSearchParams(searchParams);
      next.delete("welcome");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const [copied, setCopied] = useState(false);
  const [shipments, setShipments] = useState<DashboardShipment[]>([]);
  const [loadingShipments, setLoadingShipments] = useState(true);
  const [link, setLink] = useState<DashboardLink | null>(null);
  const [loadingLink, setLoadingLink] = useState(true);
  const [showUserMenu, setShowUserMenu] = useState(false);
  // Cancel-target state retired 2026-05-13. All label management (Cancel,
  // Cancel & start over, Print, Download, Share) now lives at /t/<public_code>.
  // Click the SendMo Label ID column to manage a shipment.
  // accessToken state removed alongside CancelLabelModal — Dashboard no
  // longer authenticates any direct API calls beyond the existing supabase
  // client (which is already JWT-aware via AuthContext).

  useEffect(() => {
    async function fetchData() {
      if (!user) return;

      const shipmentsPromise = supabase
        .from("shipments")
        .select("id, tracking_number, public_code, carrier, service, status, refund_status, display_price_cents, rate_cents, is_test, easypost_shipment_id, created_at, updated_at, sendmo_links!inner(user_id, sender_name), sender_address:addresses!sender_address_id(name), recipient_address:addresses!recipient_address_id(name)")
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

  // handleCancelled() removed 2026-05-13. The /t/<public_code> page is the
  // single source of truth for shipment state after a cancel; the Dashboard
  // re-renders the latest status the next time it mounts or refetches.

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
            <Button className="rounded-xl gap-2 text-sm" onClick={() => navigate("/onboarding")}>
              <SendMoLogo className="w-4 h-4" />
              Create a new shipment
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

        {/* Welcome banner — one-shot, fires after magic-link click, Google
            OAuth return, or /login's OTP-verify path. */}
        <AnimatePresence>
          {showWelcome && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              className="mb-5 rounded-xl border border-success/30 bg-success/10 px-4 py-3 flex items-center gap-3"
            >
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
              <p className="text-sm text-foreground flex-1">
                Signed in{user?.email ? <> as <span className="font-medium">{user.email}</span></> : null}.
              </p>
              <button
                type="button"
                onClick={() => setShowWelcome(false)}
                className="w-7 h-7 rounded-lg hover:bg-success/10 flex items-center justify-center"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Updated-link confirmation banner */}
        <AnimatePresence>
          {showUpdatedBanner && updatedLinkId && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              className="mb-5 rounded-xl border border-success/30 bg-success/10 px-4 py-3 flex items-center gap-3"
            >
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
              <p className="text-sm text-foreground flex-1">Link updated.</p>
              <button
                type="button"
                onClick={() => {
                  setShowUpdatedBanner(false);
                  searchParams.delete("updated_link");
                  setSearchParams(searchParams, { replace: true });
                }}
                className="w-7 h-7 rounded-lg hover:bg-success/10 flex items-center justify-center"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top row: Link + Wallet */}
        <div className="grid gap-5 md:grid-cols-2 mb-8">
          <div className="bg-card rounded-2xl border border-border shadow-sm p-5 relative">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Link2 className="w-4 h-4 text-primary" />
                My Label Link
              </h2>
              <div className="flex items-center gap-2">
                {link && (
                  <Badge variant="outline" className="text-xs border-success/50 text-success bg-success/10">Active</Badge>
                )}
                {link && (
                  <button
                    type="button"
                    onClick={() => navigate(`/links/${link.id}/edit`)}
                    className="w-7 h-7 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
                    aria-label="Edit link"
                    title="Edit link"
                  >
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                )}
              </div>
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
                  onClick={() => navigate("/links/new")}
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
              {/* Single-surface model (decided 2026-05-13): the SendMo Label ID
                  is the only inline action. Clicking it lands on /t/<code>
                  where Print / Download / Share / Cancel / Cancel & start over
                  live. No more inline Void button — the /t/ page is the canonical
                  shipment-management surface. */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-5 py-3 font-medium">From</th>
                      <th className="px-5 py-3 font-medium">To</th>
                      <th className="px-5 py-3 font-medium">Carrier</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Amount</th>
                      <th className="px-5 py-3 font-medium">SendMo Label ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipments.map((s) => {
                      const statusCfg = STATUS_CONFIG[s.status as DisplayStatus] ?? STATUS_CONFIG.label_created;
                      const StatusIcon = statusCfg.icon;
                      // Prefer the per-shipment sender_address.name (set by labels
                      // RPC for both link types). Fall back to sendmo_links.sender_name
                      // (older full_label rows) then "Unknown".
                      const fromName = s.sender_address?.name || s.sendmo_links?.sender_name || "Unknown";
                      const toName = s.recipient_address?.name || "—";
                      return (
                        <tr key={s.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                          <td className="px-5 py-3 font-medium text-foreground">{fromName}</td>
                          <td className="px-5 py-3 text-foreground">{toName}</td>
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
                                {statusWithDate(s.status, s.created_at, s.updated_at)}
                              </span>
                              {refundBadge(s.refund_status)}
                            </div>
                          </td>
                          <td className="px-5 py-3 font-medium">{formatCents(s.display_price_cents)}</td>
                          <td className="px-5 py-3">
                            {s.public_code && s.tracking_number !== "TEST" ? (
                              <Link
                                to={`/t/${s.public_code}`}
                                className="text-primary text-xs font-mono flex items-center gap-1 hover:underline"
                                title={s.tracking_number ? `${s.carrier} #${s.tracking_number}` : undefined}
                              >
                                {s.public_code}
                                <ChevronRight className="w-3 h-3" />
                              </Link>
                            ) : (
                              <span className="text-muted-foreground text-xs">&mdash;</span>
                            )}
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
                  const fromName = s.sender_address?.name || s.sendmo_links?.sender_name || "Unknown";
                  const toName = s.recipient_address?.name || "—";
                  return (
                    <div key={s.id} className="p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-foreground">
                          <span className="font-medium">{fromName}</span>
                          <span className="text-muted-foreground"> → </span>
                          <span className="font-medium">{toName}</span>
                        </div>
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          statusCfg.color,
                        )}>
                          <StatusIcon className="w-3 h-3" />
                          {statusCfg.label}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{statusWithDate(s.status, s.created_at, s.updated_at)}</p>
                      {refundBadge(s.refund_status)}
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{s.carrier}</span>
                        <span className="font-medium text-foreground">{formatCents(s.display_price_cents)}</span>
                      </div>
                      {s.public_code && s.tracking_number !== "TEST" ? (
                        <Link
                          to={`/t/${s.public_code}`}
                          className="text-primary text-xs font-mono flex items-center gap-1 hover:underline"
                        >
                          SendMo Label ID: {s.public_code}
                          <ChevronRight className="w-3 h-3" />
                        </Link>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

    </motion.div>
  );
}
