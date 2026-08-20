import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, ArrowRight, CheckCircle2, Home, Loader2, Tag } from "lucide-react";
import { SELLER_LINK_VISIBLE, SELLER_LINK_LIVE } from "@/lib/featureFlags";
import AddressForm from "@/components/forms/AddressForm";
import SkipToggle from "./SkipToggle";
import DimmedWhenDeferred from "./DimmedWhenDeferred";
import FirstSkipExplainer from "./FirstSkipExplainer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import type { AddressInput, RecipientPath, SenderKind } from "@/lib/types";
import { prefillSlotFor } from "@/lib/recipientFlowStorage";

// Set immediately before redirecting to Google; its presence on return is
// what authorizes the post-OAuth auto-advance.
const OAUTH_PENDING_KEY = "sendmo:oauth_pending";

interface Props {
  address: AddressInput;
  email: string;
  path: RecipientPath | null;
  sender: SenderKind | null;
  errors: string[];
  tried: boolean;
  onAddressChange: (addr: AddressInput) => void;
  onEmailChange: (email: string) => void;
  /**
   * Resolves the still-null `sender` (2026-08-18: the who's-sending step is
   * gone). Fired by the "deliver to me" chip — claiming the destination as
   * your own address IS the answer step 0 used to ask for.
   */
  onSenderResolved: (sender: SenderKind) => void;
  /** Phase 3: "the sender picks the destination" — skippable like every question. */
  deferredDestination: boolean;
  onDeferDestination: () => void;
  onUndoDeferDestination: () => void;
  seenSkipExplainer: boolean;
  onContinue: () => void;
}

export default function RecipientStepAddress({
  address, email, path, sender, errors, tried,
  onAddressChange, onEmailChange, onSenderResolved,
  deferredDestination, onDeferDestination, onUndoDeferDestination, seenSkipExplainer, onContinue,
}: Props) {
  const navigate = useNavigate();
  const showErrors = tried && errors.length > 0;
  // On the 'self' branch this screen collects the OTHER party's address, so the
  // account holder's own saved address must not be prefilled into it.
  const destinationIsSelf = prefillSlotFor(sender) === "destination";
  const { user } = useAuth();
  const prefillAttempted = useRef(false);
  // Track the last email we primed an OTP for — keeps on-blur idempotent and
  // avoids burning through Supabase's 60s OTP rate limit.
  const lastPrimedEmail = useRef<string | null>(null);
  const lastPrimedAt = useRef<number>(0);
  // Auto-advance is for a fresh OAuth RETURN only. "User was null at mount"
  // stopped implying that on 2026-08-18: /onboarding now redirects straight
  // here, so this step mounts before auth finishes loading and EVERY signed-in
  // visitor briefly looks like a fresh sign-in — which made the form
  // auto-submit 2s after becoming valid. The discriminator is now explicit: a
  // flag written just before we leave for OAuth, consumed on return.
  const oauthReturnRef = useRef(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(OAUTH_PENDING_KEY) === "1") {
        oauthReturnRef.current = true;
        sessionStorage.removeItem(OAUTH_PENDING_KEY);
      }
    } catch { /* storage unavailable — no auto-advance, which is the safe side */ }
  }, []);
  const autoAdvanceFiredRef = useRef(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [autoAdvancing, setAutoAdvancing] = useState(false);
  // Saved address held for the "deliver to me" chip when `sender` is still
  // unresolved — never applied silently (that guess is the wrong-party bug).
  const [savedAddr, setSavedAddr] = useState<AddressInput | null>(null);
  // Which explainer to show for THIS skip, captured at click time. Reading
  // `seenSkipExplainer` at render time is too late: the defer handler marks it
  // seen, so the render that should show the one-time bubble already sees
  // `true` and shows the quiet link instead.
  const [explainerVariant, setExplainerVariant] = useState<"first" | "subsequent" | null>(null);

  const maybePrimeOtp = useCallback((candidate: string) => {
    const cleaned = candidate.trim().toLowerCase();
    if (!cleaned || !/^.+@.+\..+$/.test(cleaned)) return;
    if (user?.email && user.email.toLowerCase() === cleaned) return;
    if (lastPrimedEmail.current === cleaned && Date.now() - lastPrimedAt.current < 60_000) return;
    lastPrimedEmail.current = cleaned;
    lastPrimedAt.current = Date.now();
    // Flex uses its own verify URL so the email link lands on the right step.
    const redirectTo = path === "flexible"
      ? `${window.location.origin}/onboarding/flexible/verify?confirmed=1`
      : `${window.location.origin}/onboarding/full-label/verify?confirmed=1`;
    supabase.auth
      .signInWithOtp({ email: cleaned, options: { emailRedirectTo: redirectTo } })
      .catch(() => {});
  }, [path, user?.email]);

  async function handleGoogle() {
    setAuthError(null);
    setGoogleLoading(true);
    try {
      sessionStorage.setItem(OAUTH_PENDING_KEY, "1");
    } catch { /* best-effort; only the auto-advance nicety is lost */ }
    // Redirect back to this exact step so flow state (stored in sessionStorage)
    // is restored automatically and the rest of the flow proceeds with a session.
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
    if (oauthErr) {
      // No redirect happened, so the pending flag must not survive to
      // authorize an auto-advance on some later ordinary visit.
      try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch { /* noop */ }
      setGoogleLoading(false);
      setAuthError(oauthErr.message || "Google sign-in failed");
    }
  }

  // Lock email to the Google identity when OAuth returns. The verify step is
  // skipped for Google users because the session itself is the verification.
  useEffect(() => {
    if (!user?.email) return;
    if (email && email.toLowerCase() === user.email.toLowerCase()) return;
    onEmailChange(user.email);
  }, [user?.email, email, onEmailChange]);

  // Silent prefill: returning signed-in user with empty fields gets their most
  // recent address and profile email pre-populated. User can still edit freely.
  //
  // The ADDRESS half is skipped when the account holder is the one shipping out
  // ('self'), because this screen is then the other party's address — filling
  // it with the user's own saved address, pre-verified, is how a user ends up
  // mailing a package to themselves. The EMAIL half still applies in both
  // branches (it's the account holder's email either way). Its sibling prefill
  // in RecipientFlowContext routes the saved address to originAddress instead.
  useEffect(() => {
    if (!user || prefillAttempted.current) return;
    if (address.verified || address.street || email) return;
    prefillAttempted.current = true;

    (async () => {
      const [{ data: profile }, { data: recentAddr }] = await Promise.all([
        supabase.from("profiles").select("email, full_name, phone").eq("id", user.id).single(),
        supabase
          .from("addresses")
          .select("name, street1, street2, city, state, zip, phone, is_verified")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const fetched = recentAddr?.street1
        ? {
            name: recentAddr.name || profile?.full_name || "",
            street: recentAddr.street1,
            city: recentAddr.city,
            state: recentAddr.state,
            zip: recentAddr.zip,
            phone: recentAddr.phone || profile?.phone || "",
            verified: !!recentAddr.is_verified,
          }
        : null;
      if (fetched && destinationIsSelf) {
        // sender='other' is already resolved — the destination is known to be
        // the account holder's, so the silent prefill is safe.
        onAddressChange(fetched);
      } else if (fetched) {
        // Unresolved: hold it for the chip below instead.
        setSavedAddr(fetched);
      }

      const fillEmail = profile?.email ?? user.email ?? "";
      if (fillEmail) onEmailChange(fillEmail);
    })();
  }, [user, address.verified, address.street, email, destinationIsSelf, onAddressChange, onEmailChange]);

  // Auto-advance after OAuth return when the address is already filled.
  // Fires only for fresh OAuth returns (wasNullOnMount=true), not for users
  // who were already signed in when this step mounted.
  useEffect(() => {
    if (!user || !oauthReturnRef.current || autoAdvanceFiredRef.current) return;
    // Gate on the FULL step-1 validation, not a hand-picked subset of address
    // fields. `errors` is the same getValidationErrors output tryAdvance
    // checks — so the auto-advance only fires when tryAdvance will actually
    // succeed. Previously this checked street/city/state/zip only; when the
    // phone requirement landed (2026-05-19) an OAuth return with no phone
    // would fire the auto-advance, tryAdvance(1) would silently reject, and
    // the "Continuing…" spinner spun forever.
    if (errors.length > 0) return;
    autoAdvanceFiredRef.current = true;
    setAutoAdvancing(true);
    const timer = setTimeout(onContinue, 2000);
    return () => clearTimeout(timer);
  }, [user, errors, onContinue]);

  const displayName = user?.user_metadata?.full_name as string | undefined;
  const avatarInitial = (displayName || user?.email || "?")[0].toUpperCase();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">
          {destinationIsSelf ? "Where should the package be delivered?" : "Where's it going?"}
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          {destinationIsSelf
            ? "Enter the destination address and your email"
            : sender === "self"
              ? // Carriers reject label buys with no phone on the delivery address
                // (FedEx/UPS PHONENUMBER.EMPTY), and on this branch it's someone
                // else's — say so before they're stuck mid-form without it.
                "The address you're mailing to, plus your email. Carriers need a phone number for the delivery address, so have theirs handy."
              : // Unresolved sender: neutral phrasing that is true whichever
                // party the account holder turns out to be.
                "Where the package should be delivered, plus your email. Carriers need a phone number for the delivery address."}
        </p>
      </div>

      {/* "Deliver to me" chip — the identity claim that replaces the deleted
          who's-sending step. Tapping it both fills the destination AND
          resolves sender='other' (someone else ships to the account holder).
          Never applied automatically: an unresolved sender means we don't
          know which party the saved address belongs to. */}
      {sender === null && savedAddr && !address.street && (
        <button
          type="button"
          onClick={() => {
            onAddressChange(savedAddr);
            onSenderResolved("other");
          }}
          className="w-full flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Home className="w-4 h-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              Deliver to me — use my saved address
            </span>
            <span className="block text-xs text-muted-foreground mt-0.5 truncate">
              {savedAddr.street}, {savedAddr.city}, {savedAddr.state} {savedAddr.zip}
            </span>
          </span>
        </button>
      )}

      {/* The question's answer control sits ABOVE the fields (brief point 1),
          and the fields DIM rather than being replaced — the panel-swap this
          replaces changed the card's height, moving the Continue button the
          user was reaching for. Hidden on the 'self' branch: if YOU are the
          sender there is no link user to pick the destination. */}
      {sender !== "self" && (
        <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
          <SkipToggle
            legend="Where's it going?"
            showLegend={false}
            choice={deferredDestination ? "deferred" : (address.street || address.name ? "kept" : null)}
            onKeepIt={() => { setExplainerVariant(null); onUndoDeferDestination(); }}
            onDefer={() => {
              // Read `seen` BEFORE the handler marks it — otherwise the
              // component re-renders with seen=true and shows the quiet
              // variant, so the one-time bubble is never displayed at all.
              setExplainerVariant(seenSkipExplainer ? "subsequent" : "first");
              onDeferDestination();
            }}
            keptCaption="Enter their name, address, and phone."
            deferredCaption="They'll enter the delivery address when they use your link — you set a cap and pay when they ship."
          />
          {deferredDestination && explainerVariant && (
            <FirstSkipExplainer
              variant={explainerVariant}
              onUndo={() => { setExplainerVariant(null); onUndoDeferDestination(); }}
            />
          )}
        </div>
      )}

      <DimmedWhenDeferred deferred={deferredDestination}>
        <AddressForm
          value={address}
          tried={tried}
          onChange={onAddressChange}
          destinationIsSelf={destinationIsSelf}
        />
      </DimmedWhenDeferred>

      {/* Identity / auth card. Google leads — if the user picks it, email
          auto-fills from OAuth and the verify step is skipped entirely. */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        {user ? (
          /* ── Signed-in identity pill ── */
          <div className="flex items-start gap-3">
            <div
              className="w-9 h-9 rounded-full bg-primary/10 text-primary font-semibold text-sm flex items-center justify-center shrink-0"
              aria-hidden="true"
            >
              {avatarInitial}
            </div>
            <div className="flex-1 min-w-0">
              {displayName && (
                <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
              )}
              <p className={`text-sm truncate ${displayName ? "text-muted-foreground" : "font-medium text-foreground"}`}>
                {user.email}
              </p>
              {autoAdvancing ? (
                <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  Continuing…
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  We'll send shipping updates to this address.
                </p>
              )}
            </div>
            <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" aria-label="Verified" />
          </div>
        ) : (
          /* ── Auth options: Google-first, email secondary ── */
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleGoogle}
              disabled={googleLoading}
              className="w-full rounded-xl shadow-sm gap-2"
            >
              {googleLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 18 18" aria-hidden="true">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                  <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
                </svg>
              )}
              {googleLoading ? "Redirecting…" : "Continue with Google"}
            </Button>
            <p className="text-[11px] text-muted-foreground text-center -mt-2">
              We'll use the email on your Google account. No confirmation needed.
            </p>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-card px-2 text-xs text-muted-foreground">or use your email</span>
              </div>
            </div>

            <div>
              <Input
                id="recipient-email"
                type="email"
                value={email}
                onChange={(e) => onEmailChange(e.target.value)}
                onBlur={() => maybePrimeOtp(email)}
                placeholder="Email address"
                aria-label="Email address"
                className={`rounded-xl ${
                  tried && (!email.trim() || !/^.+@.+\..+$/.test(email.trim()))
                    ? "border-destructive"
                    : ""
                }`}
              />
              {path === "full_label" ? (
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  We'll send a confirmation link and a 6-digit code. Use either one.
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  We'll send shipping updates and a confirmation code to this address.
                </p>
              )}
            </div>

            {authError && (
              <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {authError}
              </div>
            )}
          </>
        )}
      </div>

      {/* Validation summary */}
      <AnimatePresence>
        {showErrors && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3"
          >
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="w-4 h-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Please fix the following:</span>
            </div>
            <ul className="text-sm text-destructive space-y-0.5 ml-6">
              {errors.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Buttons. No Back: this is the flow's first step (2026-08-18 — the
          who's-sending picker it used to return to is gone). */}
      <Button onClick={onContinue} disabled={autoAdvancing} className="w-full rounded-xl shadow-sm">
        {path === "full_label" ? "Continue to shipment details" : "Continue to shipping preferences"}
      </Button>

      {/* Seller link-out. Lived on the deleted who's-sending step; this is the
          only onboarding surface a signed-in seller still passes through (the
          other doors are the homepage and Dashboard CTAs). Inert while the
          buyer checkout is test-mode — see SELLER_LINK_MODE. */}
      {SELLER_LINK_VISIBLE && (
        <div className="text-center border-t border-border pt-5">
          {SELLER_LINK_LIVE ? (
            <button
              type="button"
              onClick={() => navigate("/sell")}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground rounded-xl px-3 py-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Tag className="w-3.5 h-3.5" aria-hidden="true" />
              Selling something? Create a link the buyer pays for
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground px-3 py-2">
              <Tag className="w-3.5 h-3.5" aria-hidden="true" />
              Selling something? A link the buyer pays for
              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground bg-muted border border-border rounded-full px-2 py-0.5">
                Coming soon
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
