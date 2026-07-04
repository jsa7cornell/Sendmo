import { useEffect, useState, useMemo } from "react";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { CreditCard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCents, createPaymentIntent } from "@/lib/api";
import { getStripeForMode } from "@/lib/stripeClient";
import { useAuth } from "@/contexts/AuthContext";

interface StripePaymentFormProps {
  totalCents: number;
  easypostShipmentId: string;
  liveMode: boolean;
  receiptEmail?: string;
  onSuccess: (paymentIntentId: string) => Promise<void>;
  // Optional user JWT — when present, the payments fn stamps PI metadata.user_id
  // off auth.uid() (proposal 2026-05-11_account-creation-timing, §7 step 5).
  accessToken?: string;
}

// Outer component creates the PaymentIntent + mounts Stripe Elements.
export default function StripePaymentForm(props: StripePaymentFormProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [customerSessionClientSecret, setCustomerSessionClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create the PaymentIntent once we have the shipment id + amount.
  // Uses easypost_shipment_id as idempotency key server-side, so re-runs
  // (e.g., from React StrictMode double-effect) return the same PI.
  useEffect(() => {
    if (!props.easypostShipmentId || props.totalCents <= 0) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await createPaymentIntent({
          easypost_shipment_id: props.easypostShipmentId,
          amount_cents: props.totalCents,
          live_mode: props.liveMode,
          receipt_email: props.receiptEmail,
          access_token: props.accessToken,
        });
        if (cancelled) return;
        setClientSecret(result.client_secret);
        setPaymentIntentId(result.payment_intent_id);
        setCustomerSessionClientSecret(result.customer_session_client_secret ?? null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to initialize payment");
      }
    })();
    return () => { cancelled = true; };
  }, [props.easypostShipmentId, props.totalCents, props.liveMode, props.receiptEmail, props.accessToken]);

  const elementsOptions = useMemo(
    () => clientSecret ? {
      clientSecret,
      // Required by dahlia for PaymentElement to render saved PMs; falls
      // back to bare new-card form when the server didn't issue one.
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

  if (error) {
    return (
      <div className="bg-card rounded-2xl border border-destructive/30 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-2">
          <CreditCard className="w-4 h-4 text-destructive" />
          <h3 className="text-sm font-semibold text-foreground">Payment</h3>
        </div>
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!clientSecret || !paymentIntentId || !elementsOptions) {
    return (
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <CreditCard className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Payment</h3>
        </div>
        <div className="h-32 rounded-xl bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <Elements stripe={getStripeForMode(props.liveMode)} options={elementsOptions}>
      <InnerPaymentForm
        totalCents={props.totalCents}
        liveMode={props.liveMode}
        paymentIntentId={paymentIntentId}
        onSuccess={props.onSuccess}
      />
    </Elements>
  );
}

// Inner form has access to Stripe + Elements via hooks.
function InnerPaymentForm({
  totalCents,
  liveMode,
  paymentIntentId,
  onSuccess,
}: {
  totalCents: number;
  liveMode: boolean;
  paymentIntentId: string;
  onSuccess: (paymentIntentId: string) => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  // Mode badge + test-card hint are admin dogfood affordances — customers
  // see a plain checkout (customer-live-payments review N1).
  const { isAdmin } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);

    // Validate the form before confirming. PaymentElement's submit() runs
    // its own validation pass; if anything's invalid, it surfaces inline
    // errors and we don't proceed.
    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message ?? "Payment details are incomplete");
      setSubmitting(false);
      return;
    }

    // Confirm the PaymentIntent. `redirect: 'if_required'` keeps us on-page
    // for cards (no 3DS redirect needed in test mode); 3DS flows would
    // redirect briefly and come back. We disabled redirect-based methods
    // server-side via automatic_payment_methods.allow_redirects=never, so
    // this is a no-redirect path in practice.
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed");
      setSubmitting(false);
      return;
    }

    if (paymentIntent?.status !== "succeeded") {
      setError(`Payment status: ${paymentIntent?.status ?? "unknown"} — please try again`);
      setSubmitting(false);
      return;
    }

    // Hand off to the parent so it can buy the EasyPost label using the
    // captured PaymentIntent id. The parent surfaces success state.
    try {
      await onSuccess(paymentIntent.id);
    } catch (err) {
      // Parent's buyLabel call failed AFTER charging the card. The labels
      // function will have auto-refunded if EasyPost rejected the buy.
      // Surface the message; the user is safe (refund issued) unless the
      // refund itself failed (in which case the message includes a
      // support reference).
      setError(err instanceof Error ? err.message : "Label generation failed after payment");
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Payment</h3>
        </div>
        {isAdmin && (
          <Badge
            variant="outline"
            className={`text-xs ${liveMode ? "border-destructive/50 text-destructive bg-destructive/10" : "border-amber-300 text-amber-700 bg-amber-50"}`}
          >
            {liveMode ? "LIVE" : "Test Mode"}
          </Badge>
        )}
      </div>

      <PaymentElement
        options={{
          layout: { type: "tabs", defaultCollapsed: false },
        }}
      />

      {/* H2 D1: save-card consent disclosure. The PI now sets
          setup_future_usage='off_session' for authenticated buyers so we can
          handle post-pickup carrier adjustments (reweighs etc.) without a
          re-prompt. This line is the consent. Decided proposal:
          2026-05-22_reconciliation-and-carrier-adjustments §Decision D1. */}
      <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
        We'll save your card to handle any carrier adjustments after delivery — usually a few dollars.
      </p>

      {isAdmin && !liveMode && (
        <p className="text-[11px] text-muted-foreground mt-3">
          Test mode — use card <code className="font-mono">4242 4242 4242 4242</code>, any future expiry, any 3-digit CVC.
        </p>
      )}

      {error && (
        <p className="text-xs text-destructive mt-3">{error}</p>
      )}

      <Button
        type="button"
        onClick={handleSubmit}
        disabled={!stripe || !elements || submitting}
        className="w-full rounded-xl shadow-sm text-base py-5 mt-4"
      >
        {submitting ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Processing…
          </>
        ) : (
          `Pay ${formatCents(totalCents)} & generate label`
        )}
      </Button>

      <p className="text-[10px] text-muted-foreground mt-3 text-center">
        Payment ID: {paymentIntentId.slice(0, 14)}…
      </p>
    </div>
  );
}
