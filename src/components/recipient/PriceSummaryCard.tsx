import { motion } from "framer-motion";
import { MapPin } from "lucide-react";
import { formatCents } from "@/lib/api";
import type { AddressInput } from "@/lib/types";

interface Props {
  destinationAddress: AddressInput;
  priceCents: number | null;
  estimatedDays: number | null;
  onChangeAddress?: () => void;
}

function formatFullAddress(addr: AddressInput): string {
  if (!addr.verified || !addr.street) return "...";
  const parts = [addr.street, addr.city, addr.state ? `${addr.state} ${addr.zip}` : addr.zip]
    .filter(Boolean);
  return parts.join(", ");
}

export default function PriceSummaryCard({ destinationAddress, priceCents, estimatedDays, onChangeAddress }: Props) {
  const fullAddress = formatFullAddress(destinationAddress);

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5 sticky top-4 z-10">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-start gap-2 text-sm text-muted-foreground min-w-0">
          <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="min-w-0">
            Shipping to{" "}
            <span className="font-medium text-foreground break-words">{fullAddress}</span>
          </span>
        </div>
        {onChangeAddress && (
          <button
            type="button"
            onClick={onChangeAddress}
            className="text-xs text-primary hover:underline underline-offset-2 shrink-0"
          >
            Change
          </button>
        )}
      </div>

      {priceCents !== null && (
        <motion.div
          key={priceCents}
          animate={{ scale: [1, 1.02, 1] }}
          transition={{ duration: 0.3 }}
        >
          <span className="text-3xl font-bold text-primary">{formatCents(priceCents)}</span>
          {estimatedDays && (
            <p className="text-sm text-muted-foreground mt-1">
              Estimated arrival: {estimatedDays === 1 ? "1 day" : `${estimatedDays} days`}
            </p>
          )}
        </motion.div>
      )}
    </div>
  );
}
