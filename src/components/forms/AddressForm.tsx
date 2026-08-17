import SmartAddressInput from "@/components/ui/SmartAddressInput";
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
}

export default function AddressForm({ value, tried, onChange, destinationIsSelf = true }: Props) {
  const phoneError = tried && !isUsablePhone(value.phone)
    ? "We need a phone number here — the shipping carriers require one to make the delivery (not our rule, theirs!)."
    : undefined;
  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
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
    </div>
  );
}
