import SmartAddressInput from "@/components/ui/SmartAddressInput";
import type { AddressInput } from "@/lib/types";

interface Props {
  value: AddressInput;
  tried: boolean;
  onChange: (v: AddressInput) => void;
}

// 10-digit minimum after stripping non-digits. Looser than a full E.164
// regex on purpose — carriers (EasyPost passes to FedEx/UPS/USPS) accept
// loosely-formatted US phones; we just need a real US-shaped number that
// won't trip PHONENUMBEREMPTY at label-purchase time.
function hasUsablePhone(phone: string): boolean {
  return phone.replace(/\D/g, "").length >= 10;
}

export default function AddressForm({ value, tried, onChange }: Props) {
  const phoneError = tried && !hasUsablePhone(value.phone)
    ? "FedEx and UPS require a phone number for delivery (USPS doesn't, but it's required for any link that might use FedEx or UPS)."
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
