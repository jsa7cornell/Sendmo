import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, MapPin, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import PriceSummaryCard from "./PriceSummaryCard";
import SkipToggle from "./SkipToggle";
import DimmedWhenDeferred from "./DimmedWhenDeferred";
import { useAuth } from "@/contexts/AuthContext";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { AddressInput, SenderKind } from "@/lib/types";

// Step 10 (slug `origin`) — the ship-from address. Extracted from
// RecipientStepFullShipping's mode="address" branch when the step maps
// unified (2026-08-19). That file's in-code decision "one component rather
// than an extraction: the rate fetch needs both halves' values" was specific
// to the two-step shape where prices updated live beside the parcel fields;
// under the six-step map the rate fetch lives downstream on the Shipping
// step (RecipientStepShipping), so the co-location it protected no longer
// applies. Recorded in the 2026-08-19 flow-redesign proposal, amendment A1.

// Mirrors the origin half of step 10's validation (see getValidationErrors).
// The "Shipping from" confirm row may only replace the form when every field
// the form would have blocked on is already satisfied — otherwise collapsing
// it would hide a required field behind a "Change" button.
function isOriginComplete(addr: AddressInput): boolean {
  return (
    !!addr.verified &&
    !!addr.street &&
    !!addr.name &&
    (addr.phone ?? "").replace(/\D/g, "").length >= 10
  );
}

interface Props {
  state: RecipientFlowState;
  sender: SenderKind | null;
  errors: string[];
  tried: boolean;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  /** "Sender fills this in" — defers the origin to the sender. */
  onNoAddress: () => void;
  /** Clears the deferral without leaving the step ("I have it"). */
  onKeepIt: () => void;
}

export default function RecipientStepOrigin({
  state, sender, errors, tried, onUpdate, onContinue, onBack, onNoAddress, onKeepIt,
}: Props) {
  const { user } = useAuth();
  // 'self' → this address is the account holder's own; it was prefilled from
  // their saved address, so it collapses to a confirmable row.
  // 'other' → it belongs to the person shipping to them, and is the one thing
  // they may not know — hence the skip answer.
  const isSelfSender = sender === "self";
  // LATCHED at mount, never re-derived. If the saved address was already
  // complete when this step opened, collapse it to the confirm row; if it
  // wasn't, the user is filling the form in and it must stay a form for this
  // visit. Deriving this live meant the whole SmartAddressInput — including the
  // phone field being typed into — unmounted on the keystroke that completed
  // the last missing field, destroying focus mid-entry. Common trigger: a saved
  // address with no phone (anything predating the 2026-05-19 phone requirement).
  // Re-latches on the next visit to this step, so a completed address does
  // collapse once the user moves on and comes back.
  const [originWasCompleteOnOpen] = useState(() => isSelfSender && isOriginComplete(state.originAddress));
  const [editingOrigin, setEditingOrigin] = useState(false);
  const originConfirmable = originWasCompleteOnOpen && !editingOrigin;
  const showErrors = tried && errors.length > 0;

  return (
    <div className="space-y-5">
      {/* Sticky price card — no rate is selectable yet on this step, so it
          shows the destination with the price pending. */}
      <PriceSummaryCard
        destinationAddress={state.destinationAddress}
        priceCents={null}
        estimatedDays={null}
      />

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        {/* Who supplies the sender's address — the question that decides
            whether this is a finished label or a shipping link. Framed as two
            answers to a question the user can actually answer, rather than a
            choice between product names they have no context for.

            "I have their address" is pre-selected on purpose: the label path
            has produced every shipment to date, so it must not gain a click to
            advertise the link path. First-class means named, weighted and
            visible before the user can fail — not unavoidable. */}
        {!isSelfSender && (
          <>
            <SkipToggle
              legend="Where's it shipping from?"
              choice={
                state.deferredOrigin
                  ? "deferred"
                  : (state.originAddress.street || state.originAddress.name ? "kept" : null)
              }
              onKeepIt={onKeepIt}
              onDefer={onNoAddress}
            keptCaption="Enter their name, address, and phone — you'll get an exact price now."
              deferredCaption="They'll add the ship-from address when they use your link."
            />
          </>
        )}

        {/* The account holder claiming the sender role. Not a third answer to
            the toggle — it is a prefill affordance, and conflating the two put
            an identity claim inside a question about who supplies data. */}
        {!isSelfSender && sender === null && user && !state.deferredOrigin && (
          <button
            type="button"
            onClick={() => onUpdate({ sender: "self" })}
            className="w-full flex items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-muted-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 mb-4"
          >
            <Send className="w-4 h-4 text-primary shrink-0 mt-0.5" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">I'm the sender — I'm mailing this out myself</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                It ships from your address — we'll fill in your saved one if you have it
              </span>
            </span>
          </button>
        )}

        <div className="flex items-center justify-between mb-3">
          {/* Only the 'self' branch needs a heading here: the 'other' branch is
              already headed by the fieldset legend above, and rendering an
              empty <h3> for it left a bare landmark in the a11y tree. */}
          {isSelfSender ? (
            <h3 className="text-sm font-semibold text-foreground">Shipping from</h3>
          ) : (
            <span />
          )}
          {originConfirmable && (
            <button
              type="button"
              onClick={() => setEditingOrigin(true)}
              className="text-xs font-medium text-primary rounded-lg px-2 py-1 transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Change
            </button>
          )}
        </div>

        <DimmedWhenDeferred deferred={state.deferredOrigin}>
        {originConfirmable ? (
          /* Confirm row — the generic outbound case is faster than a form when
             we already know the account holder's address. Only rendered when
             every field step-10 validation requires is present. */
          <div className="flex items-start gap-2.5 rounded-xl bg-muted px-4 py-3">
            <MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{state.originAddress.name}</p>
              <p className="text-sm text-muted-foreground">
                {state.originAddress.street}, {state.originAddress.city}, {state.originAddress.state} {state.originAddress.zip}
              </p>
            </div>
          </div>
        ) : (
          <>
            <SmartAddressInput
              label="origin"
              value={state.originAddress}
              onChange={(addr: AddressInput) => onUpdate({ originAddress: addr })}
              error={tried && !state.originAddress.verified ? "Origin address is required" : undefined}
              nameLabel={isSelfSender ? "Your name" : "Sender's name"}
              nameHint=""
              addressPlaceholder={isSelfSender ? "Start typing your address…" : "Start typing the origin address…"}
            />
            {tried && !state.originAddress.name && (
              <p className="text-xs text-destructive mt-1">
                {isSelfSender
                  ? "Your name is required for the shipping label"
                  : "Sender name is required for the shipping label"}
              </p>
            )}
          </>
        )}

        {/* The sender's email is only worth asking for when the sender is
            someone else. When it's the account holder, the labels function
            resolves their email server-side from the session (decided
            2026-06-27 OQ5-A), so a field here would be asking twice. */}
        {!isSelfSender && (
          <div className="mt-4">
            <label htmlFor="sender-email" className="text-sm font-medium text-foreground">
              Sender's email <span className="text-muted-foreground font-normal">(optional — they'll get tracking updates)</span>
            </label>
            <Input
              id="sender-email"
              type="email"
              value={state.senderEmail}
              onChange={(e) => onUpdate({ senderEmail: e.target.value })}
              placeholder="sender@example.com"
              className="mt-1.5 rounded-xl"
            />
          </div>
        )}
        </DimmedWhenDeferred>
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

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          Continue to package details
        </Button>
      </div>

      {/* Page-level T&C */}
      <p className="text-[11px] text-muted-foreground text-center leading-snug pt-1">
        By continuing you agree to SendMo's{" "}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Terms</a>
        {" "}and{" "}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Privacy Policy</a>.
        Shipping rates include carrier price plus SendMo's service fee. Final cost may be adjusted by the carrier
        if package dimensions or weight differ from what was declared.
      </p>
    </div>
  );
}
