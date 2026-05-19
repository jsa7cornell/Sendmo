import { useState, useEffect, useMemo } from "react";
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
import LinksTab from "@/components/dashboard/LinksTab";
import AddCardModal from "@/components/dashboard/AddCardModal";
import AdminModeToolbar from "@/components/AdminModeToolbar";
import { removePaymentMethod, rotateLinkUrl } from "@/lib/api";

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
  // link_id used to group shipments by parent link in the Links tab (decided
  // 2026-05-13). The select grabs it directly off shipments rather than the
  // embedded link object so the grouping can happen client-side without
  // re-traversing the join.
  link_id: string;
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

// Phase B saved card row — direct PostgREST read from payment_methods.
// RLS filters by user_id; mode separation is enforced client-side at the
// query level (per Phase B N7: RLS doesn't include a mode predicate).
interface PaymentMethodRow {
  id: string;
  stripe_payment_method_id: string;
  mode: "test" | "live";
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
  created_at: string;
}

// Links-tab row — one per `sendmo_links` row owned by the user, with up to
// 5 child shipments rendered inline. Decided 2026-05-13.
interface DashboardLinkRow {
  id: string;
  short_code: string;
  link_type: "flexible" | "full_label";
  status: "active" | "in_use" | "completed" | "used" | string;
  created_at: string;
  updated_at: string;
  recipient_address: {
    name: string | null;
    city: string | null;
    state: string | null;
  } | null;
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
  // Pattern D (Phase F): no longer joined on holds. isFunded is computed
  // client-side from the user's saved payment_methods rows (paymentMethods
  // state). Active iff at least one default PM exists and its stored
  // exp_year/exp_month hasn't passed.
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
  const { user, session, signOut, isAdmin, liveMode } = useAuth();
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
  // 2026-05-13: Dashboard splits into two tabs (Shipments | Links). Shipments
  // is the default per John's call — high-volume use case is "where's my
  // package?" not "what links do I own?". Tab state syncs to ?tab= so refresh
  // preserves it.
  const tabParam = searchParams.get("tab");
  const initialTab: "shipments" | "links" = tabParam === "links" ? "links" : "shipments";
  const [tab, setTab] = useState<"shipments" | "links">(initialTab);
  const [allLinks, setAllLinks] = useState<DashboardLinkRow[]>([]);
  const [loadingAllLinks, setLoadingAllLinks] = useState(true);
  // Phase B saved cards. Mode follows the auth-context liveMode (admin only;
  // non-admins always see test-mode cards which is fine — they save nothing
  // in live until Phase C/D opens the floodgates).
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodRow[]>([]);
  const [loadingPaymentMethods, setLoadingPaymentMethods] = useState(true);
  const [showAddCard, setShowAddCard] = useState(false);
  const [removingPmId, setRemovingPmId] = useState<string | null>(null);
  function switchTab(next: "shipments" | "links") {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    if (next === "shipments") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  }
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
        .select("id, link_id, tracking_number, public_code, carrier, service, status, refund_status, display_price_cents, rate_cents, is_test, easypost_shipment_id, created_at, updated_at, sendmo_links!inner(user_id, sender_name), sender_address:addresses!sender_address_id(name), recipient_address:addresses!recipient_address_id(name)")
        .eq("sendmo_links.user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      // Most recent active flexible link (the user's reusable shareable link).
      // Pattern D (Phase F): isFunded is computed below from local
      // paymentMethods state (DB-only, no Stripe call). No holds join.
      const linkPromise = supabase
        .from("sendmo_links")
        .select("id, short_code, max_price_cents, preferred_speed, recipient_address:addresses!recipient_address_id(name, street1, street2, city, state, zip)")
        .eq("user_id", user.id)
        .eq("link_type", "flexible")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // 2026-05-13: All user-owned links for the Links tab. No status/type
      // filter here — we want active, in_use, completed, full_label, and
      // flexible all represented so the user sees their full inventory.
      const allLinksPromise = supabase
        .from("sendmo_links")
        .select("id, short_code, link_type, status, created_at, updated_at, recipient_address:addresses!recipient_address_id(name, city, state)")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(50);

      const [shipmentsRes, linkRes, allLinksRes] = await Promise.all([shipmentsPromise, linkPromise, allLinksPromise]);

      if (!shipmentsRes.error && shipmentsRes.data) {
        setShipments(shipmentsRes.data as unknown as DashboardShipment[]);
      }
      setLoadingShipments(false);

      if (!linkRes.error && linkRes.data) {
        setLink(linkRes.data as unknown as DashboardLink);
      }
      setLoadingLink(false);

      if (!allLinksRes.error && allLinksRes.data) {
        setAllLinks(allLinksRes.data as unknown as DashboardLinkRow[]);
      }
      setLoadingAllLinks(false);
    }

    fetchData();
  }, [user]);

  // Phase B saved cards — direct PostgREST read filtered by current mode.
  // Refetched on liveMode flip (admin toggles in header). Optimistic refetch
  // after Add Card success runs in handleCardAdded() below.
  // Returns the fetched rows so callers can decide whether to keep polling.
  const fetchPaymentMethods = async (): Promise<PaymentMethodRow[]> => {
    if (!user) return [];
    const mode = liveMode ? "live" : "test";
    setLoadingPaymentMethods(true);
    const { data, error } = await supabase
      .from("payment_methods")
      .select("id, stripe_payment_method_id, mode, brand, last4, exp_month, exp_year, is_default, created_at")
      .eq("user_id", user.id)
      .eq("mode", mode)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    setLoadingPaymentMethods(false);
    if (error || !data) return [];
    const rows = data as PaymentMethodRow[];
    setPaymentMethods(rows);
    return rows;
  };

  useEffect(() => {
    fetchPaymentMethods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, liveMode]);

  // After Add Card succeeds, the payment_methods row arrives via webhook —
  // may not be present immediately. Poll with 500ms/1s/2s backoff, exiting
  // early as soon as the row count exceeds the pre-add baseline (review
  // I1 fix, 2026-05-13: prior version walked all three delays even on the
  // happy path, costing ~3.5s of latency every time).
  async function handleCardAdded() {
    setShowAddCard(false);
    const baseline = paymentMethods.length;
    const delays = [500, 1000, 2000];
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      const rows = await fetchPaymentMethods();
      if (rows.length > baseline) return;
    }
    // Three retries exhausted; webhook is unusually delayed. The next
    // Dashboard mount or mode-flip will refetch and surface the card.
  }

  async function handleRemoveCard(pm: PaymentMethodRow) {
    if (!session?.access_token) return;
    if (!window.confirm(`Remove ${pm.brand ?? "card"} ending in ${pm.last4 ?? "????"}?`)) return;
    setRemovingPmId(pm.id);
    try {
      await removePaymentMethod(session.access_token, pm.stripe_payment_method_id);
      await fetchPaymentMethods();
    } catch (err) {
      console.error("[Dashboard] removeCard failed:", err);
    } finally {
      setRemovingPmId(null);
    }
  }

  // handleCancelled() removed 2026-05-13. The /t/<public_code> page is the
  // single source of truth for shipment state after a cancel; the Dashboard
  // re-renders the latest status the next time it mounts or refetches.

  const shortUrl = link ? `sendmo.co/s/${link.short_code}` : null;

  // Pattern D (Phase F): isFunded = has a default PM that hasn't expired.
  // Computed client-side from local paymentMethods state — server's
  // links Edge Function uses the same logic at GET /links?code=. Used to
  // render the Active/Inactive badge and the Reactivate/Update button label.
  const sortedPaymentMethods = useMemo(() => {
    return [...paymentMethods].sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      // Within is_default group, newest first
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [paymentMethods]);

  const defaultPm = sortedPaymentMethods.find((pm) => pm.is_default);
  const isFunded = useMemo(() => {
    if (!defaultPm) return false;
    if (defaultPm.exp_year == null || defaultPm.exp_month == null) return true;
    const now = new Date();
    if (defaultPm.exp_year > now.getFullYear()) return true;
    if (defaultPm.exp_year === now.getFullYear() && defaultPm.exp_month >= now.getMonth() + 1) return true;
    return false;
  }, [defaultPm]);

  // Pattern D (Phase F): if recipient followed a decline email's
  // /dashboard?reactivate=<link_id> deep link, auto-open AddCardModal so
  // they can update payment in one click. The webhook flips the link
  // active once a new PM lands.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("reactivate")) {
      setShowAddCard(true);
      // Clean the URL so a subsequent refresh doesn't re-trigger
      const url = new URL(window.location.href);
      url.searchParams.delete("reactivate");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  // URL rotation
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  async function handleRotate() {
    if (!link || !session?.access_token) return;
    if (!window.confirm("Rotate this link's URL? The old URL will stop working immediately and senders with the old link will see an error.")) {
      return;
    }
    setRotating(true);
    setRotateError(null);
    try {
      const result = await rotateLinkUrl(link.id, session.access_token);
      // Update local state to the new short_code; refetch links list
      setLink({ ...link, short_code: result.short_code, id: result.id });
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : "Rotate failed");
    } finally {
      setRotating(false);
    }
  }

  function handleCopy() {
    if (!shortUrl) return;
    navigator.clipboard.writeText(`https://${shortUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  // Group the user's recent shipments by parent link_id so the Links tab
  // can render up to 5 children per link card. The shipments list is
  // already ordered by created_at DESC, so the slice keeps the most recent.
  // Total counts use the full grouped count so the "View all N" overflow
  // affordance shows the true number.
  const linksWithChildren = allLinks.map((l) => {
    const children = shipments.filter((s) => s.link_id === l.id);
    return {
      id: l.id,
      short_code: l.short_code,
      link_type: l.link_type,
      status: l.status,
      created_at: l.created_at,
      recipient_address: l.recipient_address,
      shipments: children.slice(0, 5).map((s) => ({
        id: s.id,
        public_code: s.public_code,
        tracking_number: s.tracking_number,
        status: s.status,
        is_test: s.is_test,
        created_at: s.created_at,
      })),
      total_shipments: children.length,
    };
  });

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

          <div className="flex items-center gap-3">
            <AdminModeToolbar />
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
                  isFunded ? (
                    <Badge variant="outline" className="text-xs border-success/50 text-success bg-success/10">Active</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 bg-amber-50">Inactive</Badge>
                  )
                )}
                {link && !isFunded && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setShowAddCard(true)}
                    className="rounded-lg text-xs h-7 px-2.5"
                    title={defaultPm ? "Update your payment information to reactivate this link" : "Add payment information to activate this link"}
                  >
                    {defaultPm ? "Update payment information" : "Add payment information"}
                  </Button>
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

                {/* Pattern D (Phase F): URL rotation. No grace window — the
                    old URL stops working immediately. Use as a safety primitive
                    when a link has been over-shared or leaked. */}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {rotateError ? <span className="text-destructive">{rotateError}</span> : "Need a new URL?"}
                  </span>
                  <button
                    type="button"
                    onClick={handleRotate}
                    disabled={rotating}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline disabled:opacity-50"
                  >
                    {rotating ? "Rotating…" : "Rotate URL"}
                  </button>
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
              {isAdmin && (
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    liveMode
                      ? "border-destructive/50 text-destructive bg-destructive/10"
                      : "border-amber-300 text-amber-700 bg-amber-50"
                  }`}
                >
                  {liveMode ? "LIVE" : "Test"}
                </Badge>
              )}
            </div>

            {loadingPaymentMethods ? (
              <div className="h-20 rounded-xl bg-muted/40 animate-pulse" />
            ) : paymentMethods.length === 0 ? (
              <div className="bg-muted/30 rounded-xl px-4 py-5 text-center">
                <CreditCard className="w-7 h-7 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-foreground font-medium">No saved cards yet</p>
                <p className="text-xs text-muted-foreground mt-1 mb-3">
                  Save a card to speed up checkout next time.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  onClick={() => setShowAddCard(true)}
                >
                  Add card
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {sortedPaymentMethods.map((pm) => (
                  <div
                    key={pm.id}
                    className="flex items-center justify-between bg-muted/20 rounded-xl px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <CreditCard className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <div className="text-sm min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-foreground capitalize">
                            {pm.brand ?? "Card"}
                          </span>
                          <span className="text-muted-foreground">•••• {pm.last4 ?? "????"}</span>
                          {pm.is_default && (
                            <Badge variant="outline" className="text-[10px] ml-1 border-primary/30 text-primary bg-primary/5">
                              Primary
                            </Badge>
                          )}
                        </div>
                        {pm.exp_month && pm.exp_year && (
                          <div className="text-[11px] text-muted-foreground">
                            Exp {String(pm.exp_month).padStart(2, "0")}/{String(pm.exp_year).slice(-2)}
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveCard(pm)}
                      disabled={removingPmId === pm.id}
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors p-1.5 rounded-md hover:bg-muted disabled:opacity-50"
                      aria-label="Remove card"
                    >
                      {removingPmId === pm.id ? "…" : <X className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full rounded-xl mt-2"
                  onClick={() => setShowAddCard(true)}
                >
                  Add another card
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Tabs — Shipments default, Links second (decided 2026-05-13). High-
            volume use case is "where's my package?"; Links is one click away. */}
        <div className="flex items-center gap-1 mb-3 border-b border-border">
          <button
            type="button"
            onClick={() => switchTab("shipments")}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-2",
              tab === "shipments"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={tab === "shipments"}
          >
            <Package className="w-4 h-4" />
            Shipments
            {shipments.length > 0 && (
              <span className="text-[10px] text-muted-foreground font-normal">({shipments.length})</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => switchTab("links")}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-2",
              tab === "links"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={tab === "links"}
          >
            <Link2 className="w-4 h-4" />
            Links
            {allLinks.length > 0 && (
              <span className="text-[10px] text-muted-foreground font-normal">({allLinks.length})</span>
            )}
          </button>
        </div>

        {/* Links tab content — gated by tab state */}
        {tab === "links" && (
          <LinksTab links={linksWithChildren} loading={loadingAllLinks} />
        )}

        {/* Shipments Table — gated by tab state */}
        {tab === "shipments" && (
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
                              <div className="flex items-center gap-2">
                                <Link
                                  to={`/t/${s.public_code}`}
                                  className="text-primary text-xs font-mono flex items-center gap-1 hover:underline"
                                  title={s.tracking_number ? `${s.carrier} #${s.tracking_number}` : undefined}
                                >
                                  {s.public_code}
                                  <ChevronRight className="w-3 h-3" />
                                </Link>
                                {s.is_test && (
                                  <span
                                    className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 uppercase tracking-wide"
                                    title="Test-mode label — synthetic tracking number; not a real shipment"
                                  >
                                    Test
                                  </span>
                                )}
                              </div>
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
                        <div className="flex items-center gap-2">
                          <Link
                            to={`/t/${s.public_code}`}
                            className="text-primary text-xs font-mono flex items-center gap-1 hover:underline"
                          >
                            SendMo Label ID: {s.public_code}
                            <ChevronRight className="w-3 h-3" />
                          </Link>
                          {s.is_test && (
                            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 uppercase tracking-wide">
                              Test
                            </span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        )}
      </div>

      <AddCardModal
        open={showAddCard}
        onClose={() => setShowAddCard(false)}
        onSuccess={handleCardAdded}
      />
    </motion.div>
  );
}
