import { useEffect, useMemo, useRef, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Loader2, X, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { getStripeForMode } from "@/lib/stripeClient";
import { createSetupIntent } from "@/lib/api";

// Add Card modal — Phase B saved-cards flow.
//
// On open: POST /payment-methods → returns { client_secret, setup_intent_id }
// for a Stripe SetupIntent in the server-resolved mode. Mounts Stripe Elements
// against that client_secret; the user enters a card; on success, the actual
// payment_methods row is written by stripe-webhook → payment_method.attached
// (which carries brand/last4/exp inline — Phase B B1 fix).
//
// onSuccess is called *after* Stripe confirms the SetupIntent succeeded;
// caller is responsible for the optimistic-refetch retry loop (the row may
// not have landed yet because the webhook hasn't fired).

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function AddCardModal({ open, onClose, onSuccess }: Props) {
  // isAdmin: mode badge + test-card hint are admin dogfood affordances —
  // customers see a plain add-card form (customer-live-payments review N1).
  const { session, liveMode, isAdmin } = useAuth();
  const [retryTrigger, setRetryTrigger] = useState(0);
  const idempotencyNonceRef = useRef<number>(0);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch SetupIntent client_secret each time the modal opens. The idempotency
  // nonce is regenerated per fetch so reopening the modal never collides with
  // a SetupIntent from a previous attempt now in a terminal state (2026-05-14
  // BUG A: prior implementation seeded retry_n=0 at mount and persisted across
  // opens, so Stripe replayed yesterday's `succeeded` SI and Elements 400'd).
  // retryTrigger bumps on confirmError to force a fresh SI within an open.
  useEffect(() => {
    if (!open || !session?.access_token) return;
    let cancelled = false;
    idempotencyNonceRef.current = Date.now();
    const nonce = idempotencyNonceRef.current;
    setClientSecret(null);
    setError(null);
    (async () => {
      try {
        const result = await createSetupIntent(session.access_token, nonce);
        if (cancelled) return;
        setClientSecret(result.client_secret);
        setSetupIntentId(result.setup_intent_id);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to start card setup");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, session?.access_token, retryTrigger]);

  const elementsOptions = useMemo(
    () =>
      clientSecret
        ? {
            clientSecret,
            appearance: {
              theme: "flat" as const,
              variables: {
                colorPrimary: "hsl(214 89% 52%)",
                borderRadius: "12px",
                fontFamily: "Inter, system-ui, sans-serif",
              },
            },
          }
        : undefined,
    [clientSecret],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-card w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary" />
            <h2 className="text-base font-semibold">Add a card</h2>
            {isAdmin && (
              <Badge
                variant="outline"
                className={`text-[10px] ml-1 ${
                  liveMode
                    ? "border-destructive/50 text-destructive bg-destructive/10"
                    : "border-amber-300 text-amber-700 bg-amber-50"
                }`}
              >
                {liveMode ? "LIVE" : "Test"}
              </Badge>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="px-5 py-5 overflow-y-auto">
          {error ? (
            <div className="space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRetryTrigger((n) => n + 1)}
              >
                Try again
              </Button>
            </div>
          ) : !clientSecret || !setupIntentId || !elementsOptions ? (
            <div className="h-48 rounded-xl bg-muted animate-pulse" />
          ) : (
            <Elements stripe={getStripeForMode(liveMode)} options={elementsOptions}>
              <SetupForm
                onSuccess={onSuccess}
                onRetry={() => setRetryTrigger((n) => n + 1)}
              />
            </Elements>
          )}

          {isAdmin && !liveMode && (
            <p className="text-[11px] text-muted-foreground mt-3">
              Test mode — use card <code className="font-mono">4242 4242 4242 4242</code>, any future expiry, any 3-digit CVC.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function SetupForm({
  onSuccess,
  onRetry,
}: {
  onSuccess: () => void;
  onRetry: () => void;
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
      setError(submitError.message ?? "Card details are incomplete");
      setSubmitting(false);
      return;
    }

    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      confirmParams: {
        // Task #13: return_url so 3DS redirect bounces back to this page
        // instead of Stripe's default, preserving modal state.
        return_url: window.location.href,
        // Task #14: mark this card as always-redisplayable so it surfaces
        // in the PaymentElement saved-card picker on the checkout flow.
        payment_method_data: {
          allow_redisplay: "always",
        },
      },
    });

    if (confirmError) {
      setError(confirmError.message ?? "Card setup failed");
      setSubmitting(false);
      // Bump retry so the next attempt creates a fresh SetupIntent (the
      // current one is in a terminal-ish failed state).
      onRetry();
      return;
    }

    if (setupIntent?.status !== "succeeded") {
      setError(`Card status: ${setupIntent?.status ?? "unknown"} — please try again`);
      setSubmitting(false);
      return;
    }

    onSuccess();
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
          "Save card"
        )}
      </Button>
    </div>
  );
}
