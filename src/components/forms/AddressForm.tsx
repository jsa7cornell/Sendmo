import SmartAddressInput from "@/components/ui/SmartAddressInput";
import type { AddressInput } from "@/lib/types";
import { isUsablePhone } from "@/lib/phone";

interface Props {
  value: AddressInput;
  tried: boolean;
  onChange: (v: AddressInput) => void;
}

export default function AddressForm({ value, tried, onChange }: Props) {
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
        error={tried && !value.verified ? "Select an address from the dropdown" : undefined}
      />
      {phoneError && (
        <p className="mt-2 text-xs text-destructive">{phoneError}</p>
      )}
    </div>
  );
}
