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
  /**
   * Card header (2026-08-22 design paradigm): a title on the left, one action
   * on the right — the skip lives ON the field group it skips instead of in a
   * separate control above it. Optional, so the other two callers (LinksEditor,
   * BuyerFlow) keep the bare card they already render.
   */
  title?: ReactNode;
  action?: ReactNode;
  /** Shortcuts that fill this form, e.g. "Use my saved address". */
  footer?: ReactNode;
  /**
   * Deferred to the sender: the FIELDS dim and go inert, the header does not.
   * The header is where `action` renders, and on the destination step that
   * action is "Enter it myself" — the only way to take the question back. An
   * earlier cut wrapped the whole card, which put the undo inside the inert
   * subtree and made a deferred destination unrecoverable (caught by
   * skip-toggle.spec, which asserts the fields are inert but the undo works).
   */
  dimmed?: boolean;
}

export default function AddressForm({
  value, tried, onChange, destinationIsSelf = true, title, action, footer, dimmed = false,
}: Props) {
  const phoneError = tried && !isUsablePhone(value.phone)
    ? "We need a phone number here — the shipping carriers require one to make the delivery (not our rule, theirs!)."
    : undefined;
  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          {title ? <h3 className="text-base font-bold text-foreground">{title}</h3> : <span />}
          {action}
        </div>
      )}
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
