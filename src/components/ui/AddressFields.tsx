/**
 * AddressFields – now delegates the address field to SmartAddressInput
 * (Google Places Autocomplete) while the Name field remains a plain input.
 */
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import type { AddressInput } from "@/lib/types";

export default function AddressFields({
    label,
    value,
    onChange,
    errors = {},
}: {
    label: string;
    value: AddressInput;
    onChange: (v: AddressInput) => void;
    errors?: Partial<Record<keyof AddressInput, string>>;
}) {
    return (
        <div className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                {label}
            </h3>
            <SmartAddressInput
                label={label}
                value={value}
                onChange={onChange}
                error={errors.street}
            />
        </div>
    );
}
