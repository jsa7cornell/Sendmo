import SmartAddressInput from "@/components/ui/SmartAddressInput";
import type { AddressInput } from "@/lib/types";

interface Props {
  value: AddressInput;
  tried: boolean;
  onChange: (v: AddressInput) => void;
}

export default function AddressForm({ value, tried, onChange }: Props) {
  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <SmartAddressInput
        label="destination"
        value={value}
        onChange={onChange}
        addressLabel="Destination address"
        error={tried && !value.verified ? "Select an address from the dropdown" : undefined}
      />
    </div>
  );
}
