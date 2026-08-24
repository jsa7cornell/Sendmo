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

  // ─── Card-save recovery (2026-08-16) ───
  // A failure no longer bumps retryTrigger on its own. It used to, which nulled
  // clientSecret and unmounted <SetupForm/> mid-error — so the message the user
  // needed to read was discarded and the form silently reset itself.
  //
  // The failed SetupIntent is reusable (it lands back in
  // requires_payment_method; the 2026-08-16 incident confirmed this, with four
  // confirm attempts against one intent), so the form can simply stay put and
  // show the error. Only an explicit recovery click rebuilds it.
  //
  // `bypassLink` then re-mounts with the Link wallet off, which is the
  // substantive part: Link autofill can attach a stale name from the user's
  // wallet to their card, and a name the issuer can't match makes 3DS fail
  // authentication outright, with no challenge for the user to complete.
  const [bypassLink, setBypassLink] = useState(false);

  function restartCardCollection() {
    setBypassLink(true);
    setRetryTrigger((n) => n + 1);
  }

  // Link suppression lasts one modal session, no longer. This modal is never
  // unmounted — Dashboard renders it unconditionally and it returns null while
  // closed — so `bypassLink` would otherwise survive every close and disable
  // Link autofill for the rest of the page, including later card-adds that
  // never failed. Reset on the way out rather than in an effect keyed on
  // `open`, which would be a setState-in-effect (lint) for no benefit.
  //
  // These are the only two exits; a third would need the same reset.
  function closeAndReset() {
    setBypassLink(false);
    onClose();
  }

  function succeedAndReset() {
    setBypassLink(false);
    onSuccess();
  }

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale SetupIntent state before the async fetch is the point of this effect; do NOT restructure casually (BUG A regression magnet, see comment above).
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
            onClick={closeAndReset}
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
            <Elements
              key={`seti-${retryTrigger}`}
              stripe={getStripeForMode(liveMode)}
              options={elementsOptions}
            >
              <SetupForm
                onSuccess={succeedAndReset}
                onRestart={restartCardCollection}
                bypassLink={bypassLink}
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
  onRestart,
  bypassLink,
}: {
  onSuccess: () => void;
  onRestart: () => void;
  bypassLink: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the bank specifically refused to authenticate, which earns
  // different copy: retrying the same way cannot help, because no challenge was
  // ever presented for the user to complete.
  const [authFailed, setAuthFailed] = useState(false);

  function fail(message: string, opts?: { authFailed?: boolean }) {
    setError(message);
    setAuthFailed(opts?.authFailed ?? false);
    setSubmitting(false);
  }

  async function handleSubmit() {
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      fail(submitError.message ?? "Card details are incomplete");
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
      // setup_intent_authentication_failure covers both a failed 3DS challenge
      // and an issuer that rejected authentication without presenting one.
      // Stripe's copy ("unable to authenticate your payment method") reads as
      // user error in the second case, so we replace it rather than echo it.
      const isAuthFailure = confirmError.code === "setup_intent_authentication_failure";
      fail(
        isAuthFailure
          ? "Your bank couldn't verify this card."
          : confirmError.message ?? "Card setup failed",
        { authFailed: isAuthFailure },
      );
      return;
    }

    if (setupIntent?.status !== "succeeded") {
      fail(`Card status: ${setupIntent?.status ?? "unknown"} — please try again`);
      return;
    }

    onSuccess();
  }

  return (
    <div className="space-y-4">
      <PaymentElement
        options={{
          layout: { type: "tabs", defaultCollapsed: false },
          // After a failure the Link wallet is suppressed, so the user types
          // the card themselves and no stored profile can attach a mismatched
          // name to it.
          wallets: { link: bypassLink ? "never" : "auto" },
          // No defaultValues for billingDetails.name, deliberately. Prefilling
          // the account holder's name is wrong whenever the cardholder differs
          // — a spouse's or business card, or an OAuth profile carrying a
          // nickname — and an already-filled field is one users skip past. That
          // is the same mismatched-name condition Link suppression above exists
          // to avoid. LOG 2026-08-16 also falsified the premise: the 22:49
          // attempt sent billing_details.name = null with no Link and drew a
          // byte-identical rejection, so the name was never the cause.
        }}
      />
      {error && (
        <div className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-xs text-destructive">{error}</p>
          {authFailed && (
            <p className="text-xs text-muted-foreground">
              Your bank wouldn't approve this card for automatic charges. That's decided
              by the bank, so retrying the same card usually won't help — a different
              card is the quickest fix.
            </p>
          )}
          {/* Every failure gets a way forward. Without this the only move was
              resubmitting the same form — which is what one account did four
              times in fourteen minutes on 2026-08-16 before giving up.
              The copy above deliberately points at a different card rather than
              at re-entering the same one: on 2026-08-16 the same card was
              rejected identically across two accounts, with and without Link
              autofill, so "type it in manually" is not a fix. */}
          <button
            type="button"
            onClick={onRestart}
            className="text-xs font-medium text-primary hover:underline"
          >
            {authFailed ? "Try a different card" : "Start over with a new card form"}
          </button>
        </div>
      )}
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
