import { motion } from "framer-motion";
import { MapPin } from "lucide-react";
import { formatCents } from "@/lib/api";

interface Props {
  cityState: string;
  priceCents: number | null;
  estimatedDays: number | null;
  onChangeAddress?: () => void;
}

export default function PriceSummaryCard({ cityState, priceCents, estimatedDays, onChangeAddress }: Props) {
  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5 sticky top-4 z-10">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="w-4 h-4" />
          <span>Shipping to <span className="font-medium text-foreground">{cityState || "..."}</span></span>
        </div>
        {onChangeAddress && (
          <button
            type="button"
            onClick={onChangeAddress}
            className="text-xs text-primary hover:underline underline-offset-2"
          >
            Change
          </button>
        )}
      </div>

      {priceCents !== null ? (
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
      ) : (
        <div>
          <span className="text-lg text-muted-foreground">Complete details to see cost</span>
        </div>
      )}
    </div>
  );
}
