import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { CreditCard, ArrowLeft, Loader2, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { getStripeForMode } from "@/lib/stripeClient";
import { createFlexLink, createFlexHold } from "@/lib/api";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// ─── Rate estimate lookup (from PRD Section 7.1) ────────────

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

function getEstimate(state: RecipientFlowState): RangeEstimate {
  const size: SizeKey = state.size_hint ?? "default";
  return RATE_TABLE[size]?.[state.distance_hint]?.[state.speed_preference]
    ?? RATE_TABLE.default.regional.standard;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Main Component ──────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepFlexPayment({ state, onUpdate, onContinue, onBack }: Props) {
  const { session, liveMode } = useAuth();
  const estimate = getEstimate(state);
  const holdAmount = Math.round(estimate.high * 1.1);

  const [linkError, setLinkError] = useState<string | null>(null);
  const [piError, setPiError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [customerSessionClientSecret, setCustomerSessionClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);

  // Step 1: ensure a draft link exists. Creates one if state.linkId is empty.
  // Idempotent re-run guard: gated on state.linkId being empty.
  useEffect(() => {
    if (state.linkId) return;
    if (!session?.access_token) {
      setLinkError("You must be signed in. Please sign in and try again.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await createFlexLink({
          recipient_address: {
            name: state.destinationAddress.name,
            street1: state.destinationAddress.street,
            city: state.destinationAddress.city,
            state: state.destinationAddress.state,
            zip: state.destinationAddress.zip,
            verified: state.destinationAddress.verified,
          },
          speed_preference: state.speed_preference,
          preferred_carrier: state.preferred_carrier,
          price_cap_dollars: state.price_cap,
          size_hint: state.size_hint,
          distance_hint: state.distance_hint,
          initial_status: "draft",
        }, session.access_token);
        if (cancelled) return;
        onUpdate({ linkId: result.id, short_code: result.short_code });
      } catch (err) {
        if (cancelled) return;
        setLinkError(err instanceof Error ? err.message : "Failed to create link");
      }
    })();
    return () => { cancelled = true; };
  }, [state.linkId, session?.access_token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 2: once we have a linkId, request the flex_hold PaymentIntent.
  useEffect(() => {
    if (!state.linkId || clientSecret) return;
    if (!session?.access_token) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await createFlexHold({
          link_id: state.linkId,
          amount_cents: holdAmount,
          live_mode: liveMode,
          access_token: session.access_token,
        });
        if (cancelled) return;
        setClientSecret(result.client_secret);
        setPaymentIntentId(result.payment_intent_id);
        setCustomerSessionClientSecret(result.customer_session_client_secret);
      } catch (err) {
        if (cancelled) return;
        setPiError(err instanceof Error ? err.message : "Failed to set up payment");
      }
    })();
    return () => { cancelled = true; };
  }, [state.linkId, holdAmount, liveMode, clientSecret, session?.access_token]);

  const elementsOptions = useMemo(
    () => clientSecret ? {
      clientSecret,
      ...(customerSessionClientSecret ? { customerSessionClientSecret } : {}),
      appearance: {
        theme: "flat" as const,
        variables: {
          colorPrimary: "hsl(214 89% 52%)",
          borderRadius: "12px",
          fontFamily: "Inter, system-ui, sans-serif",
        },
      },
    } : undefined,
    [clientSecret, customerSessionClientSecret],
  );

  const error = linkError || piError;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Shield className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Authorize payment</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          A temporary hold ensures your link is ready when your sender needs it.
        </p>
      </div>

      {/* Estimated cost range */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Estimated shipping cost</h3>
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
            <dd className="font-medium text-foreground capitalize">{state.speed_preference}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Distance</dt>
            <dd className="font-medium text-foreground capitalize">
              {state.distance_hint === "cross" ? "Cross-country" : state.distance_hint}
            </dd>
          </div>
          {state.size_hint && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Size hint</dt>
              <dd className="font-medium text-foreground capitalize">
                {state.size_hint === "smallbox" ? "Small box" : state.size_hint === "largebox" ? "Large box" : "Envelope"}
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Price cap</dt>
            <dd className="font-medium text-foreground">${state.price_cap}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-2">
            <dt className="font-semibold text-foreground">Hold amount</dt>
            <dd className="font-bold text-primary text-lg">{formatCents(holdAmount)}</dd>
          </div>
        </dl>
      </div>

      {/* Payment form (Stripe Elements) */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Payment</h3>
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
        ) : !clientSecret || !paymentIntentId || !elementsOptions ? (
          <div className="space-y-3">
            <div className="h-32 rounded-xl bg-muted animate-pulse" />
            <p className="text-xs text-muted-foreground">Setting up your link…</p>
          </div>
        ) : (
          <Elements stripe={getStripeForMode(liveMode)} options={elementsOptions}>
            <FlexHoldForm
              holdAmount={holdAmount}
              liveMode={liveMode}
              onAuthorized={(piId) => {
                onUpdate({ paymentStatus: "authorized" });
                onContinue();
                // No further work needed — webhook flips link status to 'active'
                // and step 23 just reads short_code from state.
                void piId;
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
        We'll hold up to {formatCents(holdAmount)} on your card. You'll only be charged the actual
        shipping cost when your sender prints a label. Any excess hold is automatically released.
      </div>

      <Button variant="outline" onClick={onBack} className="rounded-xl">
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back
      </Button>
    </div>
  );
}

function FlexHoldForm({
  holdAmount,
  liveMode,
  onAuthorized,
}: {
  holdAmount: number;
  liveMode: boolean;
  onAuthorized: (paymentIntentId: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message ?? "Payment details are incomplete");
      setSubmitting(false);
      return;
    }

    // Manual-capture PI: confirmation moves status to 'requires_capture'
    // (not 'succeeded'). The webhook fires payment_intent.amount_capturable_updated
    // which flips the link to 'active' and creates the holds row.
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: {
        // Keep the user on this page if 3DS triggers a redirect.
        return_url: window.location.href,
      },
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed");
      setSubmitting(false);
      return;
    }

    // For manual-capture, the success state is 'requires_capture'.
    if (paymentIntent && (paymentIntent.status === "requires_capture" || paymentIntent.status === "succeeded")) {
      onAuthorized(paymentIntent.id);
      return;
    }

    setError(`Payment status: ${paymentIntent?.status ?? "unknown"} — please try again`);
    setSubmitting(false);
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
            Authorizing…
          </>
        ) : (
          `Authorize Hold — ${formatCents(holdAmount)}`
        )}
      </Button>
      <p className="text-[10px] text-muted-foreground text-center">
        {liveMode ? "Live mode — your card will be authorized for the hold amount." : "Test mode — no real charge."}
      </p>
    </div>
  );
}
