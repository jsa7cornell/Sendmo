import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import StepQuestionHeader from "./StepQuestionHeader";
import SkipToSenderLink from "./SkipToSenderLink";
import DimmedWhenDeferred from "./DimmedWhenDeferred";
import SavedAddressPicker from "./SavedAddressPicker";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { AddressInput } from "@/lib/types";

// Step 10 (slug `origin`) — the ship-from address. Extracted from
// RecipientStepFullShipping's mode="address" branch when the step maps
// unified (2026-08-19). That file's in-code decision "one component rather
// than an extraction: the rate fetch needs both halves' values" was specific
// to the two-step shape where prices updated live beside the parcel fields;
// under the six-step map the rate fetch lives downstream on the Shipping
// step (RecipientStepShipping), so the co-location it protected no longer
// applies. Recorded in the 2026-08-19 flow-redesign proposal, amendment A1.


interface Props {
  state: RecipientFlowState;
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
  state, errors, tried, onUpdate, onContinue, onBack, onNoAddress, onKeepIt,
}: Props) {
  // The 'self' branch is gone (2026-08-23 review finding 1). Nothing writes
  // sender='self' any more: both "use my address" chips that used to claim it
  // were replaced by SavedAddressPicker, which deliberately infers nothing
  // about who is shipping. `deferToSender` is now the only writer and only
  // ever sets 'other', so every isSelfSender branch here was unreachable —
  // including the confirm-row collapse, which could never render.
  //
  // The collapse is not mourned: it existed so a returning user would not
  // retype an address we already held, and the picker does that job for ANY
  // saved address rather than only when we had guessed the user was the
  // sender. What went with it — `isOriginComplete`, the latched
  // `originWasCompleteOnOpen`, the Change button — was all scaffolding for the
  // guess.
  const showErrors = tried && errors.length > 0;

  return (
    <div className="space-y-5">

      {/* The question, asked once, with its one action beside it. */}
      <StepQuestionHeader
        question="Where's it shipping from?"
        action={
          <SkipToSenderLink
            deferred={state.deferredOrigin}
            onDefer={onNoAddress}
            onUndo={onKeepIt}
          />
        }
      />

      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <DimmedWhenDeferred deferred={state.deferredOrigin}>

        <SmartAddressInput
          label="origin"
          value={state.originAddress}
          onChange={(addr: AddressInput) => onUpdate({ originAddress: addr })}
          error={tried && !state.originAddress.verified ? "Origin address is required" : undefined}
          nameLabel="Sender's name"
          nameHint=""
          addressPlaceholder="Start typing the origin address…"
        />
        {tried && !state.originAddress.name && (
          <p className="text-xs text-destructive mt-1">
            Sender name is required for the shipping label
          </p>
        )}

        {/* The sender's email. Was hidden when sender='self', on the grounds
            that the labels function resolves the account holder's email
            server-side from the session (2026-06-27 OQ5-A) — but 'self' is
            unreachable now, so the field always shows. It stays optional. */}
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

        {/* Under the fields it fills, matching the destination step. NOT an
            answer to the skip question above — it is a prefill shortcut, and
            conflating the two put an identity claim inside a question about
            who supplies data.

            It no longer sets sender='self' either (2026-08-23). That was the
            last of the same inference: "use MY address" meant the account
            holder was shipping. With a list to choose from — which may hold a
            friend's address — picking one says nothing about who sends, and
            the label John chose ("Use a saved address") had already stopped
            claiming it did. */}
        <div className="mt-4">
          <SavedAddressPicker
            onSelect={(addr) => onUpdate({ originAddress: addr })}
          />
        </div>
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
          Continue
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
