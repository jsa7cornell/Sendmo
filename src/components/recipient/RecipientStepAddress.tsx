import { useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, ArrowRight, LogIn, Tag } from "lucide-react";
import { SELLER_LINK_VISIBLE, SELLER_LINK_LIVE } from "@/lib/featureFlags";
import AddressForm from "@/components/forms/AddressForm";
import StepQuestionHeader from "./StepQuestionHeader";
import SkipToSenderLink from "./SkipToSenderLink";
import SavedAddressPicker from "./SavedAddressPicker";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import type { AddressInput, SenderKind } from "@/lib/types";
import { prefillSlotFor } from "@/lib/recipientFlowStorage";

// The skip is a link beside the question (StepQuestionHeader +
// SkipToSenderLink, shared with the Origin and Package steps since
// 2026-08-22); the saved-address shortcut sits under the fields it fills.
// Both replace cards that used to stack above the form — a control in its own
// card read as a second question on a screen that asks one.

interface Props {
  address: AddressInput;
  sender: SenderKind | null;
  errors: string[];
  tried: boolean;
  onAddressChange: (addr: AddressInput) => void;
  /** Phase 3: "the sender picks the destination" — skippable like every question. */
  deferredDestination: boolean;
  onDeferDestination: () => void;
  onUndoDeferDestination: () => void;
  onContinue: () => void;
}

export default function RecipientStepAddress({
  address, sender, errors, tried,
  onAddressChange,
  deferredDestination, onDeferDestination, onUndoDeferDestination, onContinue,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const showErrors = tried && errors.length > 0;
  // On the 'self' branch this screen collects the OTHER party's address, so the
  // account holder's own saved address must not be prefilled into it.
  const destinationIsSelf = prefillSlotFor(sender) === "destination";
  const { user } = useAuth();

  // The silent single-address prefill went with the picker (2026-08-23). It
  // read the most recent row and, on the sender='other' branch, dropped it
  // into the form unannounced — which is indistinguishable from a picker that
  // guessed, and wrong the moment a user has two saved addresses. Choosing is
  // now explicit; SavedAddressPicker below offers the deduped list.

  // Hidden on the 'self' branch: if YOU are the sender there is no link user
  // to hand the destination to.
  const skipAction = sender === "self" ? null : (
    <SkipToSenderLink
      deferred={deferredDestination}
      onDefer={onDeferDestination}
      onUndo={onUndoDeferDestination}
    />
  );

  // ── The saved-address shortcut, under the fields it fills ─────────────
  // Signed in: the picker. It no longer resolves `sender` — see
  // SavedAddressPicker for why picking from a list implies nothing about who
  // is shipping, where picking THE one saved address arguably did.
  //
  // Signed out: the same offer, gated. /login returns here rather than to the
  // dashboard so the draft in progress survives the round trip.
  const shortcutClasses =
    "inline-flex items-center gap-1.5 text-sm font-semibold text-primary rounded-lg px-2 py-1 -ml-2 transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  const savedAddressShortcut = address.street ? null : !user ? (
    <button
      type="button"
      onClick={() => navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`)}
      className={shortcutClasses}
    >
      <LogIn className="w-4 h-4" aria-hidden="true" />
      Log in to use your saved address
    </button>
  ) : (
    <SavedAddressPicker onSelect={(addr) => onAddressChange(addr)} />
  );

  return (
    <div className="space-y-6">
      <StepQuestionHeader
        question={destinationIsSelf ? "Where should the package be delivered?" : "Where's it going?"}
        action={skipAction}
      />

      <AddressForm
        value={address}
        tried={tried}
        onChange={onAddressChange}
        destinationIsSelf={destinationIsSelf}
        footer={savedAddressShortcut}
        dimmed={deferredDestination}
      />

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
      <Button onClick={onContinue} className="w-full rounded-xl shadow-sm">
        Continue
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
