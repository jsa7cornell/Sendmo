import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import AppHeader from "@/components/AppHeader";
import { useState, useEffect } from "react";
import { Package, Truck, CheckCircle2, AlertCircle, Clock, ArrowLeft, MapPin, Calendar, ExternalLink, Sparkles, FlaskConical } from "lucide-react";
import { carrierTrackingUrl } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { supabase as supabaseClient } from "@/lib/supabase";
import ShipmentLabelSection from "@/components/tracking/ShipmentLabelSection";
import ShipAgainCTA from "@/components/tracking/ShipAgainCTA";
import CancelLabelDialog from "@/components/tracking/CancelLabelDialog";
import CancelledShipmentBanner from "@/components/tracking/CancelledShipmentBanner";
import DetailsCard from "@/components/tracking/DetailsCard";
import HowToShipStrip from "@/components/tracking/HowToShipStrip";
import PrintAnotherLabelCTA from "@/components/tracking/PrintAnotherLabelCTA";
import AdminAffordanceFooter from "@/components/tracking/AdminAffordanceFooter";
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

export default function TrackingPage() {
  const { code } = useParams<{ code: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();

  // ?fresh=1 → just landed here from the sender flow's Confirm.
  // ?cancel=<hex> → tokenized cancel link from the sender's "Label ready"
  //   email. Captured to sessionStorage on mount, then stripped from the
  //   URL. Per author-response B3 — React Router primitives only.
  const [showCelebration, setShowCelebration] = useState(() => searchParams.get("fresh") === "1");
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

  // Fire the print-log POST on Print click + optimistically bump the chip.
  // Rollback on failure (N3) — silent revert, no toast; the user's primary
  // task (opening the PDF) succeeded in parallel via target="_blank".
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
    } catch {
      // Rollback the optimistic bump. Refetch isn't necessary — server state
      // didn't move, so the next tracking GET will return the same count.
      setOptimisticPrintBump(b => Math.max(0, b - 1));
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
      // Surface as a cancel-specific banner above the label section. Do NOT
      // touch the page-level `error` — that's reserved for "tracking GET
      // itself failed" and rendering that here wipes out the whole page
      // (the cancel succeeded server-side or didn't — either way, the
      // tracking data is still valid to show).
      setCancelError(err instanceof Error ? err.message : "Cancel failed");
      setConfirmMode(null);
    }
  }

  const config = data ? STATUS_CONFIG[data.status] || STATUS_CONFIG.label_created : null;
  const StatusIcon = config?.icon || Package;
  const currentStepIndex = data ? TIMELINE_STEPS.indexOf(data.status) : -1;

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

        {data && config && (
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

            {/* Celebration banner — first paint only when ?fresh=1 was in URL */}
            {showCelebration && (
              <div className="bg-success/10 border border-success/30 rounded-2xl p-5 flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h2 className="text-base font-semibold text-foreground">Label ready!</h2>
                  <p className="text-sm text-muted-foreground">
                    Print it, tape it to the package, and drop it off.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCelebration(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                  aria-label="Dismiss"
                >
                  Dismiss
                </button>
              </div>
            )}

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

            {/* Cancel / Change confirmation dialog (modal — position-agnostic) */}
            <CancelLabelDialog
              open={confirmMode !== null}
              onOpenChange={(o) => !o && setConfirmMode(null)}
              mode={confirmMode ?? "cancel"}
              paid={data.paid ?? false}
              amountPaidCents={data.amount_paid_cents ?? null}
              onConfirm={handleCancelConfirm}
            />

            {/* Status hero — F1 + F2 only. F3 is handled by CancelledShipmentBanner
                above and doesn't need a status card (the banner carries
                state + timestamp + actor + refund chip). Per the IA pivot:
                each family has one hero, not two stacked. */}
            {data.status !== "cancelled" && data.status !== "return_to_sender" && (
              <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-4">
                  <div className={`w-14 h-14 rounded-xl ${config.bgColor} flex items-center justify-center`}>
                    <StatusIcon className={`w-7 h-7 ${config.color}`} />
                  </div>
                  <div>
                    <h1 className="text-xl font-bold text-foreground">{config.label}</h1>
                    {data.estimated_delivery && data.status !== "delivered" && (
                      <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Calendar className="w-3.5 h-3.5" />
                        Expected {formatDeliveryDate(data.estimated_delivery)}
                      </p>
                    )}
                    {data.status === "delivered" && (() => {
                      const perf = deliveryPerformance(data.promised_delivery_date, data.delivered_at);
                      return perf ? (
                        <span className={`inline-flex items-center gap-1 mt-1 rounded-full border px-2 py-0.5 text-xs font-medium ${perf.color}`}>
                          <span>{perf.emoji}</span>
                          {perf.label}
                        </span>
                      ) : null;
                    })()}
                  </div>
                </div>

                {/* F2 only: carrier-site deep-link. F1 hides it because USPS
                    hasn't scanned the package yet (would 404). Test-mode
                    hides it too — synthetic tracking number isn't real. */}
                {(data.status === "in_transit" || data.status === "out_for_delivery" || data.status === "delivered") && !data.is_test && (() => {
                  const carrierUrl = carrierTrackingUrl(data.carrier, data.tracking_number);
                  return carrierUrl ? (
                    <a
                      href={carrierUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary mt-4"
                    >
                      View on {data.carrier} site
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : null;
                })()}
              </div>
            )}

            {/* F1 — Ready to Ship. Label section + HowToShipStrip rendered
                after the status hero so users see state first, then action,
                then instructions. The `label_url` gate is INSIDE
                ShipmentLabelSection (orphan-recovered shipments without a
                PDF still surface Cancel + Share). */}
            {data.status === "label_created" && (
              <>
                <ShipmentLabelSection
                  labelUrl={data.label_url}
                  trackingNumber={data.tracking_number}
                  carrier={data.carrier}
                  shareUrl={typeof window !== "undefined" ? `${window.location.origin}/t/${data.public_code}` : `/t/${data.public_code}`}
                  canCancel={canCancel}
                  onCancelClick={() => setConfirmMode("cancel")}
                  onChangeClick={() => setConfirmMode("change")}
                  printCount={(data.print_count ?? 0) + optimisticPrintBump}
                  onPrintClick={handlePrintClick}
                />
                <HowToShipStrip carrier={data.carrier} />
              </>
            )}

            {/* Per-family Details card — uniform across F1/F2/F3 with field
                set determined by family prop. Replaces the legacy 2x2 grid
                that duplicated state across status-card + progress + events. */}
            <DetailsCard
              family={
                data.status === "label_created" ? 1 :
                (data.status === "cancelled" || data.status === "return_to_sender") ? 3 : 2
              }
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

            {/* F3 cancelled — parent link reference + forward CTA so the user
                isn't stuck on a dead-end AND knows whether the link is still
                reusable. */}
            <PrintAnotherLabelCTA
              linkShortCode={data.link_short_code}
              linkStatus={data.link_status ?? null}
              status={data.status}
            />

            {/* Progress bar — F2 only. F1 has nothing to progress (label not
                yet scanned); F3 is terminal. */}
            {(data.status === "in_transit" || data.status === "out_for_delivery" || data.status === "delivered") && (
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

            )}

            {/* Live tracking events */}
            {data.events.length > 0 && (
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

            {/* Admin-only footer affordance. Deep-link target only present
                when caller is admin (server-side gate per B4) → falls back
                to /admin if shipment_id is absent. Full inline panel is
                Ask 4 — separate proposal. */}
            {isAdmin && <AdminAffordanceFooter shipmentId={data.shipment_id} />}
          </div>
        )}
      </main>
    </div>
  );
}
