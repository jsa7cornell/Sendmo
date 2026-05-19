import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { CreditCard, ArrowLeft, Loader2, Shield, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { getStripeForMode } from "@/lib/stripeClient";
import {
  createFlexLink,
  createSetupIntent,
  fetchLinkStatusById,
  type CreateLinkParams,
} from "@/lib/api";

// ─── Rate estimate lookup (onboarding only) ───────────────────
// Shown to recipients in step 22 so they get a sense of per-shipment cost
// before saving a card. The /links/new dashboard flow suppresses this panel
// in favor of a small "See typical costs" disclosure (`showCostEstimate=false`).

interface RangeEstimate {
  low: number;
  high: number;
  days: string;
}

type SizeKey = "envelope" | "smallbox" | "largebox" | "default";

const RATE_TABLE: Record<string, Record<string, Record<string, RangeEstimate>>> = {
  envelope: {
    nearby:  { economy: { low: 500, high: 600, days: "2–3" }, standard: { low: 800, high: 1000, days: "1–2" }, express: { low: 2800, high: 3000, days: "Next day" } },
    regional: { economy: { low: 600, high: 700, days: "3–4" }, standard: { low: 900, high: 1200, days: "2–3" }, express: { low: 2900, high: 3200, days: "1–2" } },
    cross:   { economy: { low: 700, high: 900, days: "4–5" }, standard: { low: 1100, high: 1400, days: "2–3" }, express: { low: 3000, high: 3400, days: "1–2" } },
  },
  smallbox: {
    nearby:  { economy: { low: 700, high: 1000, days: "2–4" }, standard: { low: 1000, high: 1400, days: "1–3" }, express: { low: 3200, high: 4200, days: "1–2" } },
    regional: { economy: { low: 1000, high: 1500, days: "3–5" }, standard: { low: 1400, high: 1900, days: "2–3" }, express: { low: 3600, high: 4800, days: "1–2" } },
    cross:   { economy: { low: 1400, high: 2000, days: "5–7" }, standard: { low: 1800, high: 2400, days: "2–3" }, express: { low: 4200, high: 5600, days: "1–2" } },
  },
  largebox: {
    nearby:  { economy: { low: 1400, high: 2000, days: "2–4" }, standard: { low: 1800, high: 2600, days: "1–3" }, express: { low: 4800, high: 6800, days: "1–2" } },
    regional: { economy: { low: 2000, high: 3000, days: "3–5" }, standard: { low: 2600, high: 3800, days: "2–3" }, express: { low: 5800, high: 8200, days: "1–2" } },
    cross:   { economy: { low: 2800, high: 4000, days: "5–7" }, standard: { low: 3400, high: 4800, days: "2–3" }, express: { low: 7200, high: 10000, days: "1–2" } },
  },
  default: {
    nearby:  { economy: { low: 500, high: 2000, days: "2–5" }, standard: { low: 800, high: 2600, days: "1–3" }, express: { low: 2800, high: 6800, days: "1–2" } },
    regional: { economy: { low: 600, high: 3000, days: "3–5" }, standard: { low: 900, high: 3800, days: "2–3" }, express: { low: 2900, high: 8200, days: "1–2" } },
    cross:   { economy: { low: 700, high: 4000, days: "4–7" }, standard: { low: 1100, high: 4800, days: "2–3" }, express: { low: 3000, high: 10000, days: "1–2" } },
  },
};

function getEstimate(input: FlexPaymentInput): RangeEstimate {
  const size: SizeKey = (input.size_hint as SizeKey | null) ?? "default";
  const distance = input.distance_hint ?? "regional";
  return RATE_TABLE[size]?.[distance]?.[input.speed_preference]
    ?? RATE_TABLE.default.regional.standard;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Component ───────────────────────────────────────────────

export type FlexPaymentInput = Omit<CreateLinkParams, "initial_status" | "notes">;

interface Props {
  input: FlexPaymentInput;
  // Pre-existing draft link (e.g., user clicked Back from this step). When
  // present, FlexPaymentStep skips link creation and goes straight to the
  // SetupIntent. When null, it creates the link itself (initial_status='auto').
  linkId: string | null;
  // Notifies the parent when a link is created so it can persist the linkId
  // across Back/Continue. Called once on creation, with both `id` and `short_code`.
  onLinkCreated?: (linkId: string, shortCode: string) => void;
  // Toggles the per-shipment rate-estimate panel above the card form.
  // Onboarding shows this; the dashboard +New Link flow does not (it shows a
  // smaller "See typical costs" disclosure instead).
  showCostEstimate?: boolean;
  onContinue: (linkId: string, shortCode: string) => void;
  onBack: () => void;
}

export default function FlexPaymentStep({
  input,
  linkId: initialLinkId,
  onLinkCreated,
  showCostEstimate = false,
  onContinue,
  onBack,
}: Props) {
  const { session, liveMode } = useAuth();
  const estimate = getEstimate(input);

  const [linkId, setLinkId] = useState<string | null>(initialLinkId);
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [showCostInfo, setShowCostInfo] = useState(false);

  // Keep local state in sync if the parent supplies a linkId mid-flow
  // (e.g., onboarding restores from useRecipientFlow state).
  useEffect(() => {
    if (initialLinkId && initialLinkId !== linkId) setLinkId(initialLinkId);
  }, [initialLinkId, linkId]);

  // Step 1: ensure a link row exists. If parent passed linkId, reuse it.
  // Otherwise create with initial_status='auto' — the server checks for a
  // usable PM and either returns 'active' (skip SI) or 'draft' (proceed).
  useEffect(() => {
    if (linkId) return;
    if (!session?.access_token) {
      setLinkError("You must be signed in. Please sign in and try again.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await createFlexLink(
          { ...input, initial_status: "auto" },
          session.access_token,
        );
        if (cancelled) return;
        setLinkId(result.id);
        setShortCode(result.short_code);
        onLinkCreated?.(result.id, result.short_code);
        if (result.status === "active") {
          // Returning user with a usable saved PM — server already activated
          // the link. Skip the card form entirely.
          onContinue(result.id, result.short_code);
        }
      } catch (err) {
        if (cancelled) return;
        setLinkError(err instanceof Error ? err.message : "Failed to create link");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkId, session?.access_token]);

  // Step 2: once the link exists (as a draft), request a SetupIntent. Same
  // /payment-methods endpoint the Dashboard "Add a card" modal uses.
  useEffect(() => {
    if (!linkId || clientSecret) return;
    if (!session?.access_token) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await createSetupIntent(session.access_token);
        if (cancelled) return;
        setClientSecret(result.client_secret);
        setSetupIntentId(result.setup_intent_id);
      } catch (err) {
        if (cancelled) return;
        setSetupError(err instanceof Error ? err.message : "Failed to set up card collection");
      }
    })();
    return () => { cancelled = true; };
  }, [linkId, clientSecret, session?.access_token]);

  const elementsOptions = useMemo(
    () => clientSecret ? {
      clientSecret,
      appearance: {
        theme: "flat" as const,
        variables: {
          colorPrimary: "hsl(214 89% 52%)",
          borderRadius: "12px",
          fontFamily: "Inter, system-ui, sans-serif",
        },
      },
    } : undefined,
    [clientSecret],
  );

  const error = linkError || setupError;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Shield className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Add your card</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          We'll charge your card each time a sender uses your link.
        </p>
      </div>

      {showCostEstimate ? (
        /* Estimated cost range — informational only under Pattern D */
        <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Estimated shipping cost (per shipment)</h3>
          <div className="text-center mb-4">
            <motion.div
              animate={{ scale: [1, 1.02, 1] }}
              transition={{ duration: 0.3 }}
              className="text-3xl font-bold text-primary"
            >
              {formatCents(estimate.low)} – {formatCents(estimate.high)}
            </motion.div>
            <p className="text-xs text-muted-foreground mt-1">
              {estimate.days} business days
            </p>
          </div>
          <dl className="space-y-2 text-sm border-t border-border pt-3">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Speed</dt>
              <dd className="font-medium text-foreground capitalize">{input.speed_preference}</dd>
            </div>
            {input.distance_hint && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Distance</dt>
                <dd className="font-medium text-foreground capitalize">
                  {input.distance_hint === "cross" ? "Cross-country" : input.distance_hint}
                </dd>
              </div>
            )}
            {input.size_hint && (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Size hint</dt>
                <dd className="font-medium text-foreground capitalize">
                  {input.size_hint === "smallbox" ? "Small box" : input.size_hint === "largebox" ? "Large box" : "Envelope"}
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Price cap per shipment</dt>
              <dd className="font-medium text-foreground">${input.price_cap_dollars}</dd>
            </div>
          </dl>
        </div>
      ) : (
        /* Compact "See typical costs" disclosure — dashboard +New Link flow */
        <div className="bg-muted/50 rounded-xl px-4 py-3">
          <button
            type="button"
            onClick={() => setShowCostInfo((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Info className="w-3.5 h-3.5" />
            See typical costs
          </button>
          {showCostInfo && (
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              Envelopes $5–15, small boxes $10–30, large boxes $20–50. Actual cost
              depends on distance, weight, and carrier. We cap each shipment at
              ${input.price_cap_dollars}.
            </p>
          )}
        </div>
      )}

      {/* Card collection (Stripe Elements SetupIntent) */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Payment method</h3>
          </div>
          <Badge
            variant="outline"
            className={`text-xs ${liveMode ? "border-destructive/50 text-destructive bg-destructive/10" : "border-amber-300 text-amber-700 bg-amber-50"}`}
          >
            {liveMode ? "LIVE" : "Test Mode"}
          </Badge>
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !clientSecret || !setupIntentId || !elementsOptions || !linkId ? (
          <div className="space-y-3">
            <div className="h-32 rounded-xl bg-muted animate-pulse" />
            <p className="text-xs text-muted-foreground">Setting up card collection…</p>
          </div>
        ) : (
          <Elements stripe={getStripeForMode(liveMode)} options={elementsOptions}>
            <FlexSetupForm
              linkId={linkId}
              accessToken={session?.access_token ?? null}
              onActivated={() => {
                onContinue(linkId, shortCode ?? "");
              }}
            />
          </Elements>
        )}

        {!liveMode && !error && (
          <p className="text-[11px] text-muted-foreground mt-3">
            Test mode — use card <code className="font-mono">4242 4242 4242 4242</code>, any future expiry, any 3-digit CVC.
          </p>
        )}
      </div>

      {/* Explainer */}
      <div className="bg-muted rounded-xl px-4 py-3 text-xs text-muted-foreground">
        You'll be charged the actual shipping cost each time a sender uses your link.
        We cap each shipment at ${input.price_cap_dollars}. Update or remove your card anytime from your dashboard.
      </div>

      <Button variant="outline" onClick={onBack} className="rounded-xl">
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back
      </Button>
    </div>
  );
}

// ─── Inner form (SetupIntent confirm + activation polling) ───

function FlexSetupForm({
  linkId,
  accessToken,
  onActivated,
}: {
  linkId: string;
  accessToken: string | null;
  onActivated: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // Poll the link's status server-side after SetupIntent confirms. The
  // payment_method.attached webhook flips status draft→active; this poll
  // lets the parent advance as soon as that happens. Falls back to a Refresh
  // button after 30s if the webhook is delayed.
  function startPolling() {
    if (!accessToken || !linkId) return;
    setPolling(true);
    setPollTimedOut(false);
    const started = Date.now();
    const intervalId = window.setInterval(async () => {
      if (document.visibilityState === "hidden") {
        if (Date.now() - started > 30_000) {
          window.clearInterval(intervalId);
          pollIntervalRef.current = null;
          setPolling(false);
          setPollTimedOut(true);
        }
        return;
      }
      try {
        const status = await fetchLinkStatusById(linkId, accessToken);
        if (status.status === "active") {
          window.clearInterval(intervalId);
          pollIntervalRef.current = null;
          setPolling(false);
          onActivated();
          return;
        }
      } catch {
        // Network blip; keep polling
      }
      if (Date.now() - started > 30_000) {
        window.clearInterval(intervalId);
        pollIntervalRef.current = null;
        setPolling(false);
        setPollTimedOut(true);
      }
    }, 2_000);
    pollIntervalRef.current = intervalId;
  }

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) window.clearInterval(pollIntervalRef.current);
    };
  }, []);

  async function handleRefresh() {
    if (!accessToken || !linkId) return;
    setPollTimedOut(false);
    try {
      const status = await fetchLinkStatusById(linkId, accessToken);
      if (status.status === "active") {
        onActivated();
      } else {
        startPolling();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check link status");
    }
  }

  async function handleSubmit() {
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message ?? "Card details are incomplete");
      setSubmitting(false);
      return;
    }

    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      confirmParams: {
        return_url: window.location.href,
        payment_method_data: { allow_redisplay: "always" },
      },
    });

    if (confirmError) {
      setError(confirmError.message ?? "Card setup failed");
      setSubmitting(false);
      return;
    }

    if (setupIntent?.status !== "succeeded") {
      setError(`Card status: ${setupIntent?.status ?? "unknown"} — please try again`);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    startPolling();
  }

  if (polling) {
    return (
      <div className="space-y-3 text-center py-6">
        <Loader2 className="w-6 h-6 text-primary animate-spin mx-auto" />
        <p className="text-sm font-medium text-foreground">Activating your link…</p>
        <p className="text-xs text-muted-foreground">This usually takes a few seconds.</p>
      </div>
    );
  }

  if (pollTimedOut) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-foreground">
          Your card is saved. We're still confirming with our payment processor — refresh in a moment to continue.
        </p>
        <Button type="button" onClick={handleRefresh} className="w-full rounded-xl">
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PaymentElement options={{ layout: { type: "tabs", defaultCollapsed: false } }} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        type="button"
        onClick={handleSubmit}
        disabled={!stripe || !elements || submitting}
        className="w-full rounded-xl shadow-sm text-base py-5"
      >
        {submitting ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Saving…
          </>
        ) : (
          "Save card & activate link"
        )}
      </Button>
    </div>
  );
}
