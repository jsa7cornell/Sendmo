import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AddressInput } from "@/lib/types";

export default function AddressFields({
    label,
    value,
    onChange,
}: {
    label: string;
    value: AddressInput;
    onChange: (v: AddressInput) => void;
}) {
    return (
        <div className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                {label}
            </h3>
            <div>
                <Label htmlFor={`${label}-name`}>Name</Label>
                <Input
                    id={`${label}-name`}
                    value={value.name}
                    onChange={(e) => onChange({ ...value, name: e.target.value })}
                    placeholder="Full Name"
                />
            </div>
            <div>
                <Label htmlFor={`${label}-street`}>Street</Label>
                <Input
                    id={`${label}-street`}
                    value={value.street}
                    onChange={(e) => onChange({ ...value, street: e.target.value })}
                    placeholder="123 Main St"
                />
            </div>
            <div className="grid grid-cols-3 gap-3">
                <div>
                    <Label htmlFor={`${label}-city`}>City</Label>
                    <Input
                        id={`${label}-city`}
                        value={value.city}
                        onChange={(e) => onChange({ ...value, city: e.target.value })}
                        placeholder="City"
                    />
                </div>
                <div>
                    <Label htmlFor={`${label}-state`}>State</Label>
                    <Input
                        id={`${label}-state`}
                        value={value.state}
                        onChange={(e) => onChange({ ...value, state: e.target.value })}
                        placeholder="CA"
                        maxLength={2}
                    />
                </div>
                <div>
                    <Label htmlFor={`${label}-zip`}>Zip</Label>
                    <Input
                        id={`${label}-zip`}
                        value={value.zip}
                        onChange={(e) => onChange({ ...value, zip: e.target.value })}
                        placeholder="94107"
                        maxLength={10}
                    />
                </div>
            </div>
        </div>
    );
}
