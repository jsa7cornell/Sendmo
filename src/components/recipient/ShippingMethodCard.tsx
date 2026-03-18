import { motion } from "framer-motion";
import { cn, carrierDisplayName, serviceDisplayName, classifySpeedTier, SPEED_TIER_COLORS } from "@/lib/utils";
import { formatCents } from "@/lib/api";
import type { ShippingRate } from "@/lib/types";

interface Props {
  rate: ShippingRate;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
}

export default function ShippingMethodCard({ rate, selected, disabled, disabledReason, onSelect }: Props) {
  const tier = classifySpeedTier(rate.service);
  const colors = SPEED_TIER_COLORS[tier];

  return (
    <motion.button
      type="button"
      whileTap={disabled ? undefined : { scale: 0.98 }}
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      className={cn(
        "w-full text-left rounded-2xl border p-4 transition-all",
        selected && "border-primary bg-primary/5 shadow-sm",
        !selected && !disabled && "border-border hover:border-muted-foreground/30 bg-card",
        disabled && "opacity-50 cursor-not-allowed bg-muted/30 border-border",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Radio dot */}
          <div className={cn(
            "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0",
            selected ? "border-primary" : "border-muted-foreground/40",
          )}>
            {selected && <div className="w-2 h-2 rounded-full bg-primary" />}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-foreground">
                {carrierDisplayName(rate.carrier)}
              </span>
              <span className="text-sm text-muted-foreground">
                {serviceDisplayName(rate.service)}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                colors.bg, colors.text,
              )}>
                {colors.label}
              </span>
              {rate.estimated_days && (
                <span className="text-xs text-muted-foreground">
                  {rate.estimated_days === 1 ? "1 day" : `${rate.estimated_days} days`}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Price */}
        <div className="text-right shrink-0">
          <span className={cn(
            "text-lg font-bold",
            selected ? "text-primary" : "text-foreground",
          )}>
            {formatCents(rate.display_price_cents)}
          </span>
          {disabled && disabledReason && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{disabledReason}</p>
          )}
        </div>
      </div>
    </motion.button>
  );
}
