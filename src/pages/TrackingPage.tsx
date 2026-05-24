import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import AppHeader from "@/components/AppHeader";
import { useState, useEffect } from "react";
import { Package, Truck, CheckCircle2, AlertCircle, Clock, ArrowLeft, MapPin, ExternalLink, FlaskConical, Printer, Download, Check } from "lucide-react";
import { carrierTrackingUrl } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as supabaseClient } from "@/lib/supabase";
import ShipAgainCTA from "@/components/tracking/ShipAgainCTA";
import CancelLabelDialog from "@/components/tracking/CancelLabelDialog";
import CancelledShipmentBanner from "@/components/tracking/CancelledShipmentBanner";
import DetailsCard from "@/components/tracking/DetailsCard";
import HowToShipStrip from "@/components/tracking/HowToShipStrip";
import PrintAnotherLabelCTA from "@/components/tracking/PrintAnotherLabelCTA";
import AdminDebugPanel from "@/components/tracking/AdminDebugPanel";
import StateHero from "@/components/tracking/StateHero";
import EtaBanner from "@/components/tracking/EtaBanner";
import ReceiptBlock from "@/components/tracking/ReceiptBlock";
import PaidByRecipientBlock from "@/components/tracking/PaidByRecipientBlock";
import HelpLink from "@/components/tracking/HelpLink";
import { Button } from "@/components/ui/button";
import { cancelShipment, logLabelPrint } from "@/lib/api";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

interface TrackingEvent {
  message: string;
  status: string;
  datetime: string;
  location: string | null;
}

interface TrackingData {
  tracking_number: string;        // carrier's number (e.g. USPS 22-digit)
  public_code: string;            // SendMo's canonical short code
  carrier: string;
  service: string;
  status: string;
  estimated_delivery: string | null;
  events: TrackingEvent[];
  created_at: string;
  updated_at: string;
  promised_delivery_date: string | null;
  delivered_at: string | null;
  // Round 2 additions (proposal §11):
  label_url: string | null;
  link_short_code: string | null;
  // Parent link status — added 2026-05-13 evening alongside dashboard tabs.
  // Surfaced on F3 cancelled so users know whether the link is still reusable.
  link_status?: string | null;
  link_type?: string | null;
  viewer_is_recipient: boolean;
  // New server fields from 2026-05-19_unify-confirmation-into-tracking.
  // Optional — old responses without them fall back to legacy viewer_is_recipient.
  viewerRole?: "payer" | "sender_flex" | "anonymous";
  recipient_first_name?: string | null;
  // Cancel-flow Phase A additions (decided 2026-05-12):
  refund_status?: "none" | "submitted" | "refunded" | "rejected" | "not_applicable";
  paid?: boolean;
  amount_paid_cents?: number | null;
  // Test-mode flag — surface to UI so viewers know the tracking is synthetic.
  is_test?: boolean;
  // Cancelled-state metadata (populated server-side when status='cancelled')
  cancelled_at?: string | null;
  cancelled_by_actor?: "admin" | "link_owner" | "session_token" | "email_token" | null;
  // tracking-page-ia-polish (decided 2026-05-13)
  item_description?: string | null;
  from_city?: string | null;
  from_state?: string | null;
  to_city?: string | null;
  to_state?: string | null;
  print_count?: number;
  last_printed_at?: string | null;
  /** Only populated when caller is admin (server-side gate per B4). */
  shipment_id?: string;
}

// Persisted cancel-token storage. The token can arrive via two transports:
//   (a) inline from SenderFlow on label-buy success (Sender pushes it after Confirm).
//   (b) query-param ?cancel=<hex> from the sender's "Label ready" email.
// Both land in sessionStorage keyed by public_code so the cancel-button
// derivation and the cancel call both read the same place.
function cancelTokenKey(publicCode: string) {
  return `sendmo:cancel_token:${publicCode}`;
}
function readCancelToken(publicCode: string): string | null {
  try {
    return sessionStorage.getItem(cancelTokenKey(publicCode));
  } catch { return null; }
}
function writeCancelToken(publicCode: string, token: string): void {
  try {
    sessionStorage.setItem(cancelTokenKey(publicCode), token);
  } catch { /* sessionStorage unavailable — graceful no-op */ }
}
function clearCancelToken(publicCode: string): void {
  try {
    sessionStorage.removeItem(cancelTokenKey(publicCode));
  } catch { /* noop */ }
}

// Terminal statuses get a banner instead of the lifecycle card (per B5).
const TERMINAL_BANNERS: Record<string, { title: string; body: string }> = {
  cancelled: {
    title: "This label was voided",
    body: "The shipment will not ship. If a refund is due, it'll appear on your SendMo account within 2–4 weeks.",
  },
  return_to_sender: {
    title: "The package is being returned",
    body: "The carrier couldn't deliver and is returning the package to the sender.",
  },
};

/**
 * Compare delivered date vs promised date (both DATEs, no time component).
 * Returns null if either input is missing or unparseable.
 */
function deliveryPerformance(
  promisedDate: string | null,
  deliveredAt: string | null,
): { days: number; label: string; emoji: string; color: string } | null {
  if (!promisedDate || !deliveredAt) return null;
  // Both compared at midnight UTC to avoid off-by-one from local TZ
  const promisedMs = Date.parse(promisedDate + "T00:00:00Z");
  const delivered = new Date(deliveredAt);
  const deliveredMs = Date.UTC(
    delivered.getUTCFullYear(),
    delivered.getUTCMonth(),
    delivered.getUTCDate(),
  );
  if (Number.isNaN(promisedMs) || Number.isNaN(deliveredMs)) return null;
  const days = Math.round((deliveredMs - promisedMs) / 86_400_000);
  if (days <= -1) {
    return {
      days,
      label: `${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} early`,
      emoji: "✨",
      color: "bg-emerald-50 text-emerald-700 border-emerald-200",
    };
  }
  if (days === 0) {
    return { days, label: "Right on time", emoji: "🎯", color: "bg-blue-50 text-blue-700 border-blue-200" };
  }
  return {
    days,
    label: `${days} ${days === 1 ? "day" : "days"} late`,
    emoji: "🐢",
    color: "bg-amber-50 text-amber-700 border-amber-200",
  };
}

const STATUS_CONFIG: Record<string, { label: string; icon: typeof Package; color: string; bgColor: string }> = {
  label_created: { label: "Label Created", icon: Clock, color: "text-muted-foreground", bgColor: "bg-muted" },
  in_transit: { label: "In Transit", icon: Truck, color: "text-primary", bgColor: "bg-primary/10" },
  out_for_delivery: { label: "Out for Delivery", icon: Truck, color: "text-success", bgColor: "bg-success/10" },
  delivered: { label: "Delivered", icon: CheckCircle2, color: "text-success", bgColor: "bg-success/10" },
  return_to_sender: { label: "Returned", icon: AlertCircle, color: "text-destructive", bgColor: "bg-destructive/10" },
  cancelled: { label: "Cancelled", icon: AlertCircle, color: "text-destructive", bgColor: "bg-destructive/10" },
};

const TIMELINE_STEPS = ["label_created", "in_transit", "out_for_delivery", "delivered"];

function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function formatDeliveryDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

/** Lifecycle bucket derived from shipment status.
 *  Returns null for terminal statuses (handled by the F3 path). */
type LifecycleState = "pre-dropoff" | "post-dropoff" | "post-delivery";

function deriveLifecycleState(status: string): LifecycleState | null {
  if (status === "label_created") return "pre-dropoff";
  if (status === "in_transit" || status === "out_for_delivery") return "post-dropoff";
  if (status === "delivered") return "post-delivery";
  return null; // terminal or unknown
}

/** Whether the status is terminal (F3 family). */
function isTerminalStatus(status: string): boolean {
  return status === "cancelled" || status === "return_to_sender";
}

export default function TrackingPage() {
  const { code } = useParams<{ code: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, isAdmin, profileLoaded } = useAuth();
  const navigate = useNavigate();

  // ?fresh=1 → just landed here from the sender/recipient flow's Confirm.
  // ?cancel=<hex> → tokenized cancel link from the sender's "Label ready"
  //   email. Captured to sessionStorage on mount, then stripped from the
  //   URL. Per author-response B3 — React Router primitives only.
  //
  // The ?fresh=1 flag is a PRESENTATION HINT ONLY, never an identity claim.
  // Captured to state on mount so it survives the URL strip. Gate receipt
  // visibility on viewerRole, not on this flag.
  const [showCelebration] = useState(() => searchParams.get("fresh") === "1");
  useEffect(() => {
    const cancelParam = searchParams.get("cancel");
    if (cancelParam && code) {
      writeCancelToken(code, cancelParam);
    }
    if (searchParams.get("fresh") === "1" || cancelParam) {
      searchParams.delete("fresh");
      searchParams.delete("cancel");
      setSearchParams(searchParams, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [data, setData] = useState<TrackingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Cancel-failure surface kept separate from the page-level `error` (which
  // means "the tracking GET itself failed"). Conflating them caused a
  // ReferenceError in cancel-label to wipe out the whole tracking page with
  // a "Tracking not found" block — fixed 2026-05-13 evening.
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Optimistic bump for the print-count chip. The server count comes back on
  // the next tracking refetch; in the meantime the chip says what the user
  // expects. Rollback on POST failure (N3).
  const [optimisticPrintBump, setOptimisticPrintBump] = useState(0);
  // Dialog state for Cancel + Change. Single state with a mode discriminator
  // so we don't render two dialogs.
  const [confirmMode, setConfirmMode] = useState<"cancel" | "change" | null>(null);

  // Refetch cadence: bump after a successful cancel so the page re-reads the
  // (now-cancelled) shipment + flips into the terminal-banner branch.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    // Tracking fn is verify_jwt=false at the gateway, but we still attach the
    // user's session token (if signed in) so the server can derive
    // viewer_is_recipient. Anonymous viewers omit the header.
    (async () => {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const headers: Record<string, string> = {};
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      return fetch(`${BASE_URL}/functions/v1/tracking?code=${encodeURIComponent(code)}`, { headers });
    })()
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Tracking number not found");
        }
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [code, refetchTick]);

  // Auth-derive: who can see the Cancel/Change buttons?
  //   - admin (JWT) — always
  //   - link owner (JWT + viewer_is_recipient) — always
  //   - anonymous with a cancel-token for this public_code in sessionStorage
  //     (set by SenderFlow on Confirm, or by ?cancel=<hex> from the email)
  // Plus: test-mode shipments are guarded server-side (cancel-label rejects
  // is_test=true). Hide the buttons rather than offering a click that 422s —
  // the proper way to dogfood Cancel is via Live Comp, not test mode.
  const canCancel = Boolean(
    data &&
    data.status === "label_created" &&
    !data.is_test &&
    (
      isAdmin ||
      data.viewer_is_recipient ||
      (code ? readCancelToken(code) : null) !== null
    )
  );

  // Derive effective viewerRole. Trust the server-returned value when present;
  // fall back to the legacy viewer_is_recipient boolean for old server responses.
  // Sender_flex cannot be inferred client-side, so falls back to anonymous.
  const effectiveViewerRole: "payer" | "sender_flex" | "anonymous" = (() => {
    if (!data) return "anonymous";
    if (data.viewerRole) return data.viewerRole;
    // Legacy fallback: viewer_is_recipient boolean from old server response
    return data.viewer_is_recipient ? "payer" : "anonymous";
  })();

  // Fire the print-log POST on Print click + optimistically bump the chip,
  // then refetch tracking data so data.print_count reflects truth (the
  // optimistic bump was unreliable across new-tab + back-navigation flows).
  async function handlePrintClick() {
    if (!code) return;
    setOptimisticPrintBump(b => b + 1);
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const cancelToken = readCancelToken(code);
      await logLabelPrint(code, {
        accessToken: session?.access_token,
        cancelToken: cancelToken ?? undefined,
      });
      // Refetch tracking to pick up the new server-side print_count.
      // Reset optimistic bump on the next data load so we don't double-count.
      setRefetchTick(t => t + 1);
      setOptimisticPrintBump(0);
    } catch {
      // Rollback the optimistic bump. Server state didn't move; no refetch.
      setOptimisticPrintBump(b => Math.max(0, b - 1));
    }
  }

  // Download the label as a true file download (cross-origin = the HTML5
  // <a download> attribute is ignored by browsers, so we fetch the PDF as a
  // blob and trigger download from a same-origin blob URL).
  async function handleDownloadClick(labelUrl: string, publicCode: string) {
    try {
      const res = await fetch(labelUrl);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `sendmo-${publicCode}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Fallback: open in a new tab so the user can save via browser menu.
      window.open(labelUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function handleCancelConfirm() {
    if (!data || !code) return;
    const reason: "user_cancel" | "user_change" = confirmMode === "change" ? "user_change" : "user_cancel";
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const cancelToken = readCancelToken(code);
      const result = await cancelShipment(code, reason, {
        cancelToken: cancelToken ?? undefined,
        accessToken: session?.access_token,
      });
      clearCancelToken(code);
      setConfirmMode(null);
      if (reason === "user_change" && result.link_short_code) {
        // Flag for SenderFlow to show "Previous label voided. Let's try again."
        try { sessionStorage.setItem("sendmo_just_voided_for_change", "1"); } catch { /* noop */ }
        navigate(`/s/${result.link_short_code}`, { replace: true });
      } else {
        // Re-fetch the (now-cancelled) shipment; terminal banner renders.
        setRefetchTick(t => t + 1);
      }
    } catch (err) {
      // Set cancelError + leave the modal OPEN so the error renders inline
      // inside the dialog (the user sees the result in the same place they
      // took the action). Previously the modal closed and a banner appeared
      // at the top of the page — the user often missed it because they were
      // scrolled to the modal area. Modal still renders the top-of-page
      // banner too as a backup once they close.
      setCancelError(err instanceof Error ? err.message : "Cancel failed");
      // Do NOT setConfirmMode(null) here — keep the modal open.
    }
  }

  const currentStepIndex = data ? TIMELINE_STEPS.indexOf(data.status) : -1;

  // ── Viewer-conditional bottom block ───────────────────────────────────────
  // Rendered below DetailsCard in all non-terminal lifecycle states.
  // payer → ReceiptBlock (full when just-bought, condensed otherwise)
  // sender_flex → PaidByRecipientBlock ("Jane has paid for shipping")
  // anonymous → nothing
  function ViewerBlock() {
    if (!data) return null;
    if (effectiveViewerRole === "payer") {
      // Gate receipt on payer role (server-side enforced — amount_paid_cents
      // is gated by viewerRole === "payer" in tracking/index.ts). Show $0 /
      // comp copy when amount_paid_cents is null (comp shipments).
      const totalCents = data.amount_paid_cents ?? 0;
      const chargedAt = data.created_at;
      const receiptMode = showCelebration ? "full" : "condensed";
      return (
        <ReceiptBlock
          mode={receiptMode}
          totalCents={totalCents}
          chargedAt={chargedAt}
        />
      );
    }
    if (effectiveViewerRole === "sender_flex") {
      const firstName = data.recipient_first_name ?? "the recipient";
      return <PaidByRecipientBlock recipientFirstName={firstName} />;
    }
    return null;
  }

  // ── DetailsCard footer row (cancel + help) ───────────────────────────────
  // Wraps the DetailsCard render + appends a footer row with cancel link
  // (payer-only, F1 only) and HelpLink (universal). Uses flexbox:
  //   justify-between when both are present, justify-end when help only.
  // Per proposal: when cancel is ineligible, the slot is simply omitted —
  // no inert grey note (John directive #4, 2026-05-19).
  function DetailsCardWithFooter({
    family,
    showCancel,
  }: {
    family: 1 | 2 | 3;
    showCancel: boolean;
  }) {
    if (!data) return null;

    const helpContext = {
      trackingNumber: data.tracking_number,
      fromCity: data.from_city ?? undefined,
      fromState: data.from_state ?? undefined,
      toCity: data.to_city ?? undefined,
      toState: data.to_state ?? undefined,
      status: STATUS_CONFIG[data.status]?.label,
      deliveredAt: data.delivered_at ?? undefined,
    };

    return (
      <div>
        <DetailsCard
          family={family}
          data={{
            public_code: data.public_code,
            tracking_number: data.tracking_number,
            carrier: data.carrier,
            service: data.service,
            item_description: data.item_description ?? null,
            from_city: data.from_city ?? null,
            from_state: data.from_state ?? null,
            to_city: data.to_city ?? null,
            to_state: data.to_state ?? null,
            created_at: data.created_at,
            cancelled_at: data.cancelled_at,
            is_test: data.is_test,
          }}
        />
        {/* Footer row: Cancel (when eligible) + Need help */}
        <div className={`flex items-center mt-2 px-1 ${showCancel ? "justify-between" : "justify-end"}`}>
          {showCancel && (
            <button
              type="button"
              onClick={() => setConfirmMode("cancel")}
              className="text-xs text-destructive hover:underline font-medium"
            >
              Cancel this label
            </button>
          )}
          <HelpLink shipmentContext={helpContext} />
        </div>
      </div>
    );
  }

  // ── Action buttons row (Print + Download) — pre-dropoff only ─────────────
  // Equal-width buttons, no chip inside the button.
  // Print button gets soft-green tint when print_count > 0.
  // Count surfaces as a small line BELOW the row.
  function ActionButtonsRow() {
    if (!data || !data.label_url) return null;
    const printCount = (data.print_count ?? 0) + optimisticPrintBump;
    const printed = printCount > 0;
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          {/* Print button — soft-green tint when printed */}
          <a
            href={data.label_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handlePrintClick}
            className="block"
          >
            <Button
              className={`w-full rounded-xl py-5 text-sm font-semibold ${
                printed
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                  : ""
              }`}
              variant={printed ? "outline" : "default"}
            >
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
          </a>

          {/* Download button — fetches PDF as blob to force download
              (cross-origin <a download> attribute is ignored by browsers). */}
          <Button
            variant="outline"
            className="w-full rounded-xl py-5 text-sm font-semibold"
            onClick={() => data.label_url && code && handleDownloadClick(data.label_url, code)}
          >
            <Download className="w-4 h-4 mr-2" />
            Download
          </Button>
        </div>

        {/* Print-count line below the row */}
        <p className={`text-center text-xs ${printed ? "text-emerald-600" : "text-muted-foreground"}`}>
          {printed ? (
            <>
              <Check className="w-3 h-3 inline mr-0.5" />
              {`Printed ${printCount}× · tap again to reprint`}
            </>
          ) : (
            "Not printed yet"
          )}
        </p>
      </div>
    );
  }

  // ── Lifecycle progress (F2 — post-dropoff and post-delivery) ─────────────
  function LifecycleProgressCard() {
    if (!data) return null;
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Progress</h2>
        <div className="space-y-0">
          {TIMELINE_STEPS.map((step, i) => {
            const stepConfig = STATUS_CONFIG[step];
            const StepIcon = stepConfig.icon;
            const isComplete = i <= currentStepIndex;
            const isCurrent = i === currentStepIndex;
            return (
              <div key={step} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    isComplete ? "bg-primary text-white" : "bg-muted text-muted-foreground"
                  } ${isCurrent ? "ring-2 ring-primary/30" : ""}`}>
                    <StepIcon className="w-4 h-4" />
                  </div>
                  {i < TIMELINE_STEPS.length - 1 && (
                    <div className={`w-0.5 h-8 ${i < currentStepIndex ? "bg-primary" : "bg-border"}`} />
                  )}
                </div>
                <div className="pt-1">
                  <p className={`text-sm font-medium ${isComplete ? "text-foreground" : "text-muted-foreground"}`}>
                    {stepConfig.label}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Tracking events ───────────────────────────────────────────────────────
  function TrackingEventsCard() {
    if (!data || data.events.length === 0) return null;
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">Tracking History</h2>
        <div className="space-y-0">
          {data.events.map((event, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="flex flex-col items-center">
                <div className={`w-2.5 h-2.5 rounded-full mt-1.5 ${
                  i === 0 ? "bg-primary" : "bg-border"
                }`} />
                {i < data.events.length - 1 && (
                  <div className="w-0.5 h-10 bg-border" />
                )}
              </div>
              <div className="pb-4">
                <p className={`text-sm ${i === 0 ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                  {event.message}
                </p>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                  <span>{formatEventDate(event.datetime)}</span>
                  {event.location && (
                    <span className="flex items-center gap-0.5">
                      <MapPin className="w-3 h-3" />
                      {event.location}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* AppHeader renders its default UserMenu / Sign In affordance — don't
          override `actions`. The page body already labels itself; the prior
          "Track Package" header label was duplicative and hid the user menu. */}
      <AppHeader />

      <main className="max-w-2xl mx-auto px-4 py-8">
        {loading && (
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center">
            <div className="animate-pulse text-muted-foreground">Looking up tracking information...</div>
          </div>
        )}

        {error && (
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center space-y-4">
            <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">Tracking not found</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ArrowLeft className="w-4 h-4" /> Back to SendMo
            </Link>
          </div>
        )}

        {data && (() => {
          const lifecycleState = deriveLifecycleState(data.status);
          const isTerminal = isTerminalStatus(data.status);

          // ── Derive subtitle for post-dropoff / post-delivery ────────────
          let heroSubtitle: string | undefined;
          if (lifecycleState === "post-dropoff") {
            const parts: string[] = [];
            if (data.estimated_delivery) {
              parts.push(`Arrives ${formatDeliveryDate(data.estimated_delivery)}`);
            }
            const lastEvent = data.events[0];
            if (lastEvent?.location) {
              parts.push(`last scan ${lastEvent.location}`);
            }
            if (parts.length > 0) heroSubtitle = parts.join(" · ");
          } else if (lifecycleState === "post-delivery") {
            const parts: string[] = [];
            if (data.delivered_at) {
              parts.push(`Delivered ${formatDeliveryDate(data.delivered_at)}`);
            }
            const lastEvent = data.events[0];
            if (lastEvent?.location) {
              parts.push(lastEvent.location);
            }
            if (parts.length > 0) heroSubtitle = parts.join(" · ");
          }

          return (
            <div className="space-y-6">
              {/* Cancel-failure banner — surfaces when handleCancelConfirm
                  threw. Dismissible. The rest of the page stays intact. */}
              {cancelError && (
                <div className="bg-destructive/5 border border-destructive/30 rounded-2xl p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h2 className="text-sm font-semibold text-foreground">Couldn't cancel this label</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">{cancelError}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      The label itself is unchanged — try again, or contact support if it keeps failing.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCancelError(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    aria-label="Dismiss"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Test-mode banner — synthetic tracking number from the EasyPost
                  test API. Renders above everything else so viewers can't miss
                  it. Carrier-site link is hidden below in the status card. */}
              {data.is_test && (
                <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex items-start gap-3">
                  <FlaskConical className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h2 className="text-sm font-semibold text-amber-900">Test label — not a real shipment</h2>
                    <p className="text-xs text-amber-800 mt-0.5">
                      This was generated against EasyPost's test API. The tracking number
                      looks real but USPS has never seen it. Statuses on this page
                      auto-advance and aren't tied to anything physical.
                    </p>
                  </div>
                </div>
              )}

              {/* Cancel / Change confirmation dialog (modal — position-agnostic) */}
              <CancelLabelDialog
                open={confirmMode !== null}
                onOpenChange={(o) => {
                  if (!o) {
                    setConfirmMode(null);
                    // Clear the error when the user closes the modal — they've
                    // acknowledged it. The top-of-page banner already renders
                    // the same error for users who scroll up.
                    setCancelError(null);
                  }
                }}
                mode={confirmMode ?? "cancel"}
                paid={data.paid ?? false}
                amountPaidCents={data.amount_paid_cents ?? null}
                onConfirm={handleCancelConfirm}
                errorMessage={cancelError}
              />

              {/* ── TERMINAL (F3): cancelled / return_to_sender ────────────
                  Preserved unchanged from the decided 2026-05-13 IA-polish spec.
                  Only additions: HelpLink in the DetailsCard footer + payer-only
                  condensed ReceiptBlock at the bottom.
                  Per proposal: 2026-05-19_unify-confirmation-into-tracking
                  Author response → blocking finding #1. */}
              {isTerminal && (
                <>
                  {/* Cancelled state: rich banner with timestamp, actor, refund chip */}
                  {data.status === "cancelled" && (
                    <CancelledShipmentBanner
                      cancelledAt={data.cancelled_at ?? null}
                      actor={data.cancelled_by_actor ?? null}
                      viewerIsRecipient={data.viewer_is_recipient}
                      refundStatus={data.refund_status ?? "none"}
                      amountPaidCents={data.amount_paid_cents ?? null}
                    />
                  )}

                  {/* Return-to-sender: simple terminal banner */}
                  {data.status === "return_to_sender" && (
                    <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-5 flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h2 className="text-base font-semibold text-foreground">{TERMINAL_BANNERS.return_to_sender.title}</h2>
                        <p className="text-sm text-muted-foreground">{TERMINAL_BANNERS.return_to_sender.body}</p>
                      </div>
                    </div>
                  )}

                  {/* F3 DetailsCard — family=3. Cancel not shown (terminal).
                      HelpLink is the sole footer item. */}
                  <DetailsCardWithFooter family={3} showCancel={false} />

                  {/* F3 — parent link reference + forward CTA so the user
                      isn't stuck on a dead-end AND knows whether the link is
                      still reusable. */}
                  <PrintAnotherLabelCTA
                    linkShortCode={data.link_short_code}
                    linkStatus={data.link_status ?? null}
                    status={data.status}
                  />

                  {/* Payer-only condensed receipt at bottom of F3 */}
                  {effectiveViewerRole === "payer" && (
                    <ReceiptBlock
                      mode="condensed"
                      totalCents={data.amount_paid_cents ?? 0}
                      chargedAt={data.created_at}
                    />
                  )}
                </>
              )}

              {/* ── PRE-DROP-OFF (F1): status = label_created ───────────── */}
              {lifecycleState === "pre-dropoff" && (
                <>
                  {/* State hero */}
                  <StateHero lifecycleState="pre-dropoff" />

                  {/* ETA banner — hides itself when promised_delivery_date is null */}
                  <EtaBanner
                    promisedDeliveryDate={data.promised_delivery_date}
                    carrier={data.carrier}
                    service={data.service}
                  />

                  {/* Action buttons row (Print + Download) + print-count line */}
                  <ActionButtonsRow />

                  {/* How to ship strip */}
                  <HowToShipStrip
                    carrier={data.carrier}
                    printDone={(data.print_count ?? 0) + optimisticPrintBump > 0}
                  />

                  {/* DetailsCard (family=1) + footer: Cancel (when eligible) + Help */}
                  <DetailsCardWithFooter family={1} showCancel={canCancel} />

                  {/* Viewer-conditional bottom block */}
                  <ViewerBlock />
                </>
              )}

              {/* ── POST-DROP-OFF (F2): status = in_transit / out_for_delivery */}
              {lifecycleState === "post-dropoff" && (
                <>
                  {/* State hero with last-scan subtitle */}
                  <StateHero lifecycleState="post-dropoff" subtitle={heroSubtitle} />

                  {/* Lifecycle progress card */}
                  <LifecycleProgressCard />

                  {/* Carrier-site deep-link (not shown in test mode) */}
                  {!data.is_test && (() => {
                    const carrierUrl = carrierTrackingUrl(data.carrier, data.tracking_number);
                    return carrierUrl ? (
                      <a
                        href={carrierUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                      >
                        View on {data.carrier} site
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : null;
                  })()}

                  {/* Tracking events */}
                  <TrackingEventsCard />

                  {/* DetailsCard (family=2) + footer: no cancel (ineligible — slot hidden) + Help */}
                  <DetailsCardWithFooter family={2} showCancel={false} />

                  {/* Viewer-conditional bottom block (condensed receipt for payer) */}
                  <ViewerBlock />
                </>
              )}

              {/* ── POST-DELIVERY (F2'): status = delivered ──────────────── */}
              {lifecycleState === "post-delivery" && (
                <>
                  {/* State hero with delivered-at subtitle */}
                  <StateHero lifecycleState="post-delivery" subtitle={heroSubtitle} />

                  {/* Lifecycle progress card (all states checked) */}
                  <LifecycleProgressCard />

                  {/* Delivery performance badge */}
                  {(() => {
                    const perf = deliveryPerformance(data.promised_delivery_date, data.delivered_at);
                    return perf ? (
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${perf.color}`}>
                        <span>{perf.emoji}</span>
                        {perf.label}
                      </span>
                    ) : null;
                  })()}

                  {/* Carrier-site deep-link (not shown in test mode) */}
                  {!data.is_test && (() => {
                    const carrierUrl = carrierTrackingUrl(data.carrier, data.tracking_number);
                    return carrierUrl ? (
                      <a
                        href={carrierUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                      >
                        View on {data.carrier} site
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : null;
                  })()}

                  {/* Tracking events */}
                  <TrackingEventsCard />

                  {/* DetailsCard (family=2) + footer: no cancel + Help */}
                  <DetailsCardWithFooter family={2} showCancel={false} />

                  {/* Viewer-conditional bottom block */}
                  <ViewerBlock />
                </>
              )}

              {/* ── UNKNOWN STATUS FALLBACK ───────────────────────────────
                  Status doesn't map to any known lifecycle state or terminal
                  bucket. Render a minimal status card + DetailsCard so
                  something useful shows rather than blank. */}
              {lifecycleState === null && !isTerminal && (
                <>
                  <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
                    <div className="flex items-center gap-4">
                      <div className={`w-14 h-14 rounded-xl ${STATUS_CONFIG[data.status]?.bgColor ?? "bg-muted"} flex items-center justify-center`}>
                        {(() => {
                          const cfg = STATUS_CONFIG[data.status];
                          const Icon = cfg?.icon ?? Package;
                          return <Icon className={`w-7 h-7 ${cfg?.color ?? "text-muted-foreground"}`} />;
                        })()}
                      </div>
                      <div>
                        <h1 className="text-xl font-bold text-foreground">
                          {STATUS_CONFIG[data.status]?.label ?? data.status}
                        </h1>
                      </div>
                    </div>
                  </div>
                  <DetailsCardWithFooter family={2} showCancel={false} />
                </>
              )}

              {/* Ship-Again upsell — visibility per the layered signal in ShipAgainCTA */}
              <ShipAgainCTA
                isFresh={showCelebration}
                isAuthenticated={!!user}
                viewerIsRecipient={data.viewer_is_recipient}
                linkShortCode={data.link_short_code}
                recipientName={null}
              />

              <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <ArrowLeft className="w-4 h-4" /> Back to SendMo
              </Link>

              {/* Admin-only inline debug panel (Ask 4, decided 2026-05-13).
                  Replaces the earlier AdminAffordanceFooter stub. Collapsible,
                  lazy-fetches on first expand via the role-gated
                  tracking-admin edge function.
                  Layer 2 guard: profileLoaded must be true so the panel never
                  flashes during the stale-state window after an account switch
                  (isAdmin could still be true from the previous admin session
                  while ensureProfile hasn't resolved for the new user yet). */}
              {profileLoaded && isAdmin && <AdminDebugPanel publicCode={data.public_code} />}
            </div>
          );
        })()}
      </main>
    </div>
  );
}
