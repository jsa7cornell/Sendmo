import type { ReactNode } from "react";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import DimmedWhenDeferred from "@/components/recipient/DimmedWhenDeferred";
import type { AddressInput } from "@/lib/types";
import { isUsablePhone } from "@/lib/phone";

interface Props {
  value: AddressInput;
  tried: boolean;
  onChange: (v: AddressInput) => void;
  /**
   * Whether the person at this destination is the account holder. Drives the
   * name hint, which otherwise reads "(probably your name!)" — true when
   * someone is shipping TO you, and actively misleading when you're the one
   * mailing something out and this is the other party.
   */
  destinationIsSelf?: boolean;
  /** Shortcuts that fill this form, e.g. "Use my saved address". */
  footer?: ReactNode;
  /**
   * Deferred to the sender: the fields dim and go inert. Scoped to the fields
   * on purpose — the step's own "Enter it myself" link lives OUTSIDE this
   * card, beside the question, and must stay reachable. An earlier cut wrapped
   * that link too, which made a deferred destination unrecoverable (caught by
   * skip-toggle.spec, which asserts the fields are inert but the undo works).
   */
  dimmed?: boolean;
}

export default function AddressForm({
  value, tried, onChange, destinationIsSelf = true, footer, dimmed = false,
}: Props) {
  const phoneError = tried && !isUsablePhone(value.phone)
    ? "We need a phone number here — the shipping carriers require one to make the delivery (not our rule, theirs!)."
    : undefined;
  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <DimmedWhenDeferred deferred={dimmed}>
        <SmartAddressInput
          label="destination"
          value={value}
          onChange={onChange}
          addressLabel="Destination address"
          nameHint={destinationIsSelf ? undefined : "who you're mailing it to"}
          error={tried && !value.verified ? "Select an address from the dropdown" : undefined}
        />
        {phoneError && (
          <p className="mt-2 text-xs text-destructive">{phoneError}</p>
        )}
        {footer && <div className="mt-4">{footer}</div>}
      </DimmedWhenDeferred>
    </div>
  );
}
