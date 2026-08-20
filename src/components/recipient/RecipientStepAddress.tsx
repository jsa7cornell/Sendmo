import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {AlertCircle, ArrowRight, Home, Tag} from "lucide-react";
import { SELLER_LINK_VISIBLE, SELLER_LINK_LIVE } from "@/lib/featureFlags";
import AddressForm from "@/components/forms/AddressForm";
import SkipToggle from "./SkipToggle";
import DimmedWhenDeferred from "./DimmedWhenDeferred";
import FirstSkipExplainer from "./FirstSkipExplainer";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import type { AddressInput, RecipientPath, SenderKind } from "@/lib/types";
import { prefillSlotFor } from "@/lib/recipientFlowStorage";

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
  // Auto-advance is for a fresh OAuth RETURN only. "User was null at mount"
  // stopped implying that on 2026-08-18: /onboarding now redirects straight
  // here, so this step mounts before auth finishes loading and EVERY signed-in
  // visitor briefly looks like a fresh sign-in — which made the form
  // auto-submit 2s after becoming valid. The discriminator is now explicit: a
  // flag written just before we leave for OAuth, consumed on return.
  // Saved address held for the "deliver to me" chip when `sender` is still
  // unresolved — never applied silently (that guess is the wrong-party bug).
  const [savedAddr, setSavedAddr] = useState<AddressInput | null>(null);
  // Which explainer to show for THIS skip, captured at click time. Reading
  // `seenSkipExplainer` at render time is too late: the defer handler marks it
  // seen, so the render that should show the one-time bubble already sees
  // `true` and shows the quiet link instead.
  const [explainerVariant, setExplainerVariant] = useState<"first" | "subsequent" | null>(null);

  // maybePrimeOtp and handleGoogle moved to the Contact step with the
  // identity block they served (2026-08-19). The OTP priming in particular
  // belongs next to the field that collects the address it primes.

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

  // The OAuth auto-advance is GONE from this step (2026-08-19). It existed to
  // carry a user straight through after returning from Google, and was
  // authorized by a sessionStorage flag written just before leaving — the
  // 2026-08-18 fix for a version that auto-submitted the form for every
  // signed-in visitor. Google now lives on the Contact step, so nothing here
  // writes that flag and the branch was unreachable. Removing it rather than
  // leaving it means this step can NEVER auto-submit, which is a stronger
  // guarantee than the one the flag bought.

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

      {/* Identity moved to its own step (design brief point 3, 2026-08-19).
          What stays here is one line for returning users — the saved-address
          chip above is the actual payoff, and it only appears once signed in.

          Consequence John accepted: nothing collects an email before the
          Contact step now, so a flow abandoned earlier leaves no way to reach
          that person. Reversible — restore this block and the step-1 email
          rule in getValidationErrors. */}
      {!user && (
        <p className="text-sm text-muted-foreground text-center">
          Returning?{" "}
          <a
            href="/login?redirectTo=/onboarding"
            className="font-medium text-primary underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sign in
          </a>{" "}
          to use your saved address.
        </p>
      )}

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
      <Button onClick={onContinue} className="w-full rounded-xl shadow-sm">
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
