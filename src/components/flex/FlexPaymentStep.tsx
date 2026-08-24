import { useEffect, useMemo, useRef, useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { CreditCard, ArrowLeft, Loader2, Shield, Info, CheckCircle2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import { getStripeForMode } from "@/lib/stripeClient";
import type { FlexPaymentInput } from "@/lib/flexEstimate";
import {
  activateLinkWithExistingPm,
  createFlexLink,
  createSetupIntent,
  fetchLinkStatusById,
  updateFlexLink,
} from "@/lib/api";

interface SavedPm {
  id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
}

// ─── Component ───────────────────────────────────────────────

/** Re-exported for the many call sites that import it alongside this component. */
export type { FlexPaymentInput };

interface Props {
  /**
   * Overrides the "Add your card" heading. The onboarding flow names this step
   * "Confirm your payment information"; LinksEditor, where the card is being
   * added rather than confirmed, keeps the original.
   */
  heading?: string;
  /**
   * Replaces the built-in "Delivering to" card. The onboarding flow supplies a
   * Shipment Details card that covers all four decisions, not just the
   * destination; LinksEditor passes nothing and keeps the original.
   */
  summary?: React.ReactNode;
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
  // Onboarding-only: jump back to the destination step (step 1) to edit it.
  // Omitted by the dashboard +New Link flow, which has no such step — the
  // Edit link then hides. Shipping preferences are edited from the Shipping
  // Link Details card's own pencils (see ShipmentDetails).
  onEditDestination?: () => void;
}

export default function FlexPaymentStep({
  heading,
  summary,
  input,
  linkId: initialLinkId,
  onLinkCreated,
  showCostEstimate = false,
  onContinue,
  onBack,
  onEditDestination,
}: Props) {
  // isAdmin: mode badge + test-card hint are admin dogfood affordances —
  // customers see a plain checkout (customer-live-payments review N1).
  const { session, liveMode, isAdmin } = useAuth();
  const [linkId, setLinkId] = useState<string | null>(initialLinkId);
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [showCostInfo, setShowCostInfo] = useState(false);
  // Saved-PM state: when a usable default PM exists for the current mode, we
  // show a "Use Visa ending 4242 [Activate]" card instead of Stripe Elements.
  // `useNewCard` lets the user expand the Stripe Elements form to add a
  // different card; when there's no saved PM, `useNewCard` starts true so the
  // form renders immediately (same UX as before this surface existed).
  const [savedPm, setSavedPm] = useState<SavedPm | null>(null);
  const [pmLoading, setPmLoading] = useState(true);
  const [useNewCard, setUseNewCard] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  // ─── Card-save recovery (2026-08-16) ───
  // Every failure path in the card form used to be a dead end: the user saw
  // Stripe's error text and had no way forward, so one account resubmitted the
  // identical failing form four times in fourteen minutes before giving up.
  //
  // `retryN` drives the Elements remount on a recovery click. It is NOT the
  // idempotency value — see idempotencyNonceRef below for why that distinction
  // matters. `bypassLink` re-mounts the form with the Link wallet off.
  //
  // Suppressing Link is the substantive half, not just a reset. Link autofill
  // can attach a stale name from the user's wallet to their card; a name the
  // issuer can't match to the cardholder makes 3DS fail authentication
  // outright, with no challenge shown and nothing the user can do about it.
  // Typing the card in manually sidesteps the bad autofill entirely.
  const [retryN, setRetryN] = useState(0);
  const [bypassLink, setBypassLink] = useState(false);
  // The SetupIntent idempotency nonce, regenerated per fetch.
  //
  // It must NOT be a counter seeded at mount. The server key is
  // `seti_create:<user>:<mode>:retry-<n>` (payment-methods/index.ts) with no
  // time component, so `retry-0` is the same key forever for a given user and
  // mode — a counter that restarts at 0 on every mount makes Stripe replay
  // whatever SetupIntent that key already created, including a `succeeded`
  // one, which then 400s Elements and leaves the user unable to add a card.
  //
  // That is the 2026-05-14 BUG A, and AddCardModal already fixed it exactly
  // this way; this component kept the counter until 2026-08-18. A counter is
  // still correct *within* one mount, but only a nonce survives remounts.
  const idempotencyNonceRef = useRef<number>(0);

  function restartCardCollection() {
    setBypassLink(true);
    setRetryN((n) => n + 1);
    setSetupError(null);
    setSetupIntentId(null);
    setClientSecret(null); // re-opens the SetupIntent effect below
  }

  // Keep local state in sync if the parent supplies a linkId mid-flow
  // (e.g., onboarding restores from useRecipientFlow state).
  useEffect(() => {
    if (initialLinkId && initialLinkId !== linkId) setLinkId(initialLinkId);
  }, [initialLinkId, linkId]);

  // Fetch the user's default PM in the link's mode. If found, render the
  // saved-card row instead of Stripe Elements. RLS scopes the read to the
  // current user; we filter mode + is_default + not-deleted to mirror the
  // server-side is_funded logic in supabase/functions/links/index.ts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mode = liveMode ? "live" : "test";
      const { data, error } = await supabase
        .from("payment_methods")
        .select("id, brand, last4, exp_month, exp_year")
        .eq("mode", mode)
        .eq("is_default", true)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setSavedPm(null);
        setUseNewCard(true); // no saved card → expand Stripe Elements by default
      } else {
        // Reject expired cards client-side; the server enforces the same
        // check at activate time, but hiding the "Activate" CTA is the
        // cleaner UX.
        const now = new Date();
        const yr = data.exp_year ?? null;
        const mo = data.exp_month ?? null;
        const isExpired = yr !== null && mo !== null && (
          yr < now.getFullYear() ||
          (yr === now.getFullYear() && mo < now.getMonth() + 1)
        );
        if (isExpired) {
          setSavedPm(null);
          setUseNewCard(true);
        } else {
          setSavedPm(data as SavedPm);
          setUseNewCard(false);
        }
      }
      setPmLoading(false);
    })();
    return () => { cancelled = true; };
  }, [liveMode]);

  async function handleActivateWithSavedPm() {
    if (!linkId || !session?.access_token) return;
    setActivating(true);
    setActivateError(null);
    try {
      const result = await activateLinkWithExistingPm(linkId, session.access_token);
      onContinue(result.id, result.short_code ?? shortCode ?? "");
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : "Failed to activate link");
      setActivating(false);
    }
  }

  // Step 1: ensure a link row exists. If parent passed linkId, reuse it.
  // Always create the link as a draft when there's no linkId — the user
  // must explicitly confirm the payment method (saved or new) before the
  // link activates. This preserves the payment-step UX rather than
  // auto-bouncing returning users past it.
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
          { ...input, initial_status: "draft" },
          session.access_token,
        );
        if (cancelled) return;
        setLinkId(result.id);
        setShortCode(result.short_code);
        onLinkCreated?.(result.id, result.short_code);
      } catch (err) {
        if (cancelled) return;
        setLinkError(err instanceof Error ? err.message : "Failed to create link");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkId, session?.access_token]);

  // Step 1b: if the user returned to this step with a draft link already
  // created (they clicked Edit/Back from here and may have changed the
  // destination or shipping preferences), sync the draft link with the
  // current input so it activates with the corrected values. A first-time
  // visitor mounts with no link, so this is skipped — the effect above
  // creates the link instead.
  const returnedWithLink = useRef(initialLinkId != null).current;
  const draftSyncedRef = useRef(false);
  useEffect(() => {
    if (!returnedWithLink || draftSyncedRef.current) return;
    if (!initialLinkId || !session?.access_token) return;
    draftSyncedRef.current = true;
    updateFlexLink(
      initialLinkId,
      {
        // Explicit null when the creator deferred the destination after this
        // draft was created with one — undefined would be dropped by
        // JSON.stringify and the PATCH would leave the abandoned address on
        // the link (review finding 1, Phase 3).
        recipient_address: input.recipient_address ?? null,
        speed_preference: input.speed_preference,
        preferred_carrier: input.preferred_carrier,
        price_cap_dollars: input.price_cap_dollars,
        size_hint: input.size_hint,
      },
      session.access_token,
    ).catch(() => {
      /* Best-effort — if the sync fails the link keeps its last-saved values. */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnedWithLink, initialLinkId, session?.access_token]);

  // Step 2: once the link exists AND we know the user wants to enter a new
  // card (no saved PM, or they explicitly clicked "Use a different card"),
  // request a SetupIntent. Same /payment-methods endpoint the Dashboard
  // "Add a card" modal uses. Gating on useNewCard avoids burning a
  // SetupIntent for returning users who never expand the card form.
  useEffect(() => {
    if (!linkId || clientSecret) return;
    if (!session?.access_token) return;
    if (!useNewCard) return;
    let cancelled = false;
    idempotencyNonceRef.current = Date.now();
    const nonce = idempotencyNonceRef.current;
    (async () => {
      try {
        const result = await createSetupIntent(session.access_token, nonce);
        if (cancelled) return;
        setClientSecret(result.client_secret);
        setSetupIntentId(result.setup_intent_id);
      } catch (err) {
        if (cancelled) return;
        setSetupError(err instanceof Error ? err.message : "Failed to set up card collection");
      }
    })();
    return () => { cancelled = true; };
  }, [linkId, clientSecret, session?.access_token, useNewCard, retryN]);

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
          <h1 className="text-2xl font-bold text-foreground">{heading ?? "Add your card"}</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          We'll charge your card each time a sender uses your link.
        </p>
      </div>

      {/* The onboarding flow passes its own Shipment Details card here; the
          built-in destination summary below is what LinksEditor still gets. */}
      {summary}

      {/* Only when no `summary` was supplied — i.e. LinksEditor. The
          onboarding flow's Shipment Details card carries its own per-row
          edits, so `onEditDestination` is not wired there and nothing on this
          branch can fire for it. */}
      {showCostEstimate && !summary && (
        /* Destination summary — lets the recipient confirm and edit where
           their shipments will be delivered before saving a card. */
        <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MapPin className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-foreground">Delivering to</h3>
            </div>
            {onEditDestination && (
              <button
                type="button"
                onClick={onEditDestination}
                className="text-xs text-primary hover:underline"
              >
                Edit
              </button>
            )}
          </div>
          {input.recipient_address ? (
            <div className="text-sm space-y-0.5">
              {input.recipient_address.name && (
                <p className="font-medium text-foreground">{input.recipient_address.name}</p>
              )}
              <p className="text-muted-foreground">{input.recipient_address.street1}</p>
              <p className="text-muted-foreground">
                {input.recipient_address.city}, {input.recipient_address.state} {input.recipient_address.zip}
              </p>
              {input.recipient_address.phone && (
                <p className="text-muted-foreground">{input.recipient_address.phone}</p>
              )}
            </div>
          ) : (
            /* Destination deferred (Phase 3): the sender picks it. */
            <p className="text-sm text-muted-foreground">
              The sender chooses the delivery address when they use your link.
            </p>
          )}
        </div>
      )}

      {!showCostEstimate && (
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
          {isAdmin && (
            <Badge
              variant="outline"
              className={`text-xs ${liveMode ? "border-destructive/50 text-destructive bg-destructive/10" : "border-amber-300 text-amber-700 bg-amber-50"}`}
            >
              {liveMode ? "LIVE" : "Test Mode"}
            </Badge>
          )}
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : pmLoading || !linkId ? (
          <div className="space-y-3">
            <div className="h-32 rounded-xl bg-muted animate-pulse" />
            <p className="text-xs text-muted-foreground">Loading payment options…</p>
          </div>
        ) : savedPm && !useNewCard ? (
          /* Saved-card row: returning user with default PM. One click
             activates the link via the new /links/:id/activate endpoint;
             no Stripe iframe involved. "Use a different card" expands to
             the Stripe Elements form below. */
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
              <CreditCard className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground capitalize">
                  {(savedPm.brand ?? "Card")} ending in {savedPm.last4 ?? "••••"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {savedPm.exp_month != null && savedPm.exp_year != null
                    ? `Expires ${String(savedPm.exp_month).padStart(2, "0")}/${savedPm.exp_year} · Primary card on file`
                    : "Primary card on file"}
                </p>
              </div>
              <CheckCircle2 className="w-5 h-5 text-primary flex-shrink-0" />
            </div>
            {activateError && (
              <p className="text-sm text-destructive">{activateError}</p>
            )}
            <Button
              onClick={handleActivateWithSavedPm}
              disabled={activating || !linkId}
              className="w-full rounded-xl"
            >
              {activating ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Activating link…</>
              ) : (
                <>Activate link with {savedPm.brand ?? "saved card"} ending in {savedPm.last4 ?? "••••"}</>
              )}
            </Button>
            <button
              type="button"
              onClick={() => setUseNewCard(true)}
              className="text-xs text-primary hover:underline w-full text-center"
            >
              Or use a different card
            </button>
          </div>
        ) : !clientSecret || !setupIntentId || !elementsOptions ? (
          <div className="space-y-3">
            <div className="h-32 rounded-xl bg-muted animate-pulse" />
            <p className="text-xs text-muted-foreground">Setting up card collection…</p>
          </div>
        ) : (
          <div className="space-y-3">
            {savedPm && (
              <button
                type="button"
                onClick={() => setUseNewCard(false)}
                className="text-xs text-primary hover:underline"
              >
                ← Use saved {savedPm.brand ?? "card"} ending in {savedPm.last4 ?? "••••"} instead
              </button>
            )}
            {/* `key` forces a full remount on retry so Stripe re-initialises
                against the new client secret with Link suppressed — changing
                the option alone would not rebuild the mounted iframe. */}
            <Elements
              key={`seti-${retryN}`}
              stripe={getStripeForMode(liveMode)}
              options={elementsOptions}
            >
              <FlexSetupForm
                linkId={linkId}
                accessToken={session?.access_token ?? null}
                bypassLink={bypassLink}
                onRestart={restartCardCollection}
                onActivated={() => {
                  onContinue(linkId, shortCode ?? "");
                }}
              />
            </Elements>
          </div>
        )}

        {isAdmin && !liveMode && !error && useNewCard && (
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
  bypassLink,
  onRestart,
  onActivated,
}: {
  linkId: string;
  accessToken: string | null;
  bypassLink: boolean;
  onRestart: () => void;
  onActivated: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the bank specifically refused to authenticate the card, which
  // earns different copy: the user cannot fix it by retrying the same way,
  // because no challenge was ever presented for them to complete.
  const [authFailed, setAuthFailed] = useState(false);
  const pollIntervalRef = useRef<number | null>(null);

  function fail(message: string, opts?: { authFailed?: boolean }) {
    setError(message);
    setAuthFailed(opts?.authFailed ?? false);
    setSubmitting(false);
  }

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
      fail(submitError.message ?? "Card details are incomplete");
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
      // setup_intent_authentication_failure covers both a failed 3DS challenge
      // and an issuer that rejected authentication without presenting one.
      // Stripe's own copy ("unable to authenticate your payment method") reads
      // as user error in the second case, so we replace it rather than echo it.
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
        {/* A handleRefresh failure used to set `error` that this branch never
            rendered, leaving the user on a Refresh button that silently did
            nothing. */}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="button" onClick={handleRefresh} className="w-full rounded-xl">
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PaymentElement
        options={{
          layout: { type: "tabs", defaultCollapsed: false },
          // On a recovery attempt the Link wallet is suppressed, so the user
          // types the card themselves and no stored profile can attach a
          // mismatched name to it.
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
              resubmitting the same form, which is exactly what one account did
              four times in fourteen minutes on 2026-08-16 before giving up.
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
          "Save card & activate link"
        )}
      </Button>
    </div>
  );
}
