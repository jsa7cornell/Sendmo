import { MapPin, Package, CreditCard, Tag } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { icon: MapPin, label: "Destination" },
  { icon: Package, label: "Shipment Details" },
  { icon: CreditCard, label: "Payment" },
  { icon: Tag, label: "Label & Link" },
];

interface Props {
  activeIndex: number;       // 0-3 progress index
  completedIndexes: number[];
  onClickIndex?: (index: number) => void;
}

export default function ProgressBar({ activeIndex, completedIndexes, onClickIndex }: Props) {
  return (
    <div className="flex items-center justify-between w-full max-w-lg mx-auto mb-8">
      {STEPS.map((step, i) => {
        const isCompleted = completedIndexes.includes(i);
        const isActive = i === activeIndex;
        const isFuture = !isCompleted && !isActive;
        const canClick = isCompleted && onClickIndex;

        const Icon = step.icon;

        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            {/* Step circle */}
            <button
              type="button"
              disabled={!canClick}
              onClick={() => canClick && onClickIndex(i)}
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-colors",
                isCompleted && "bg-primary text-primary-foreground cursor-pointer hover:bg-primary/90",
                isActive && "border-2 border-primary text-primary bg-primary/5",
                isFuture && "border-2 border-muted text-muted-foreground bg-muted/30",
                !canClick && "cursor-default",
              )}
            >
              <Icon className="w-4 h-4" />
            </button>

            {/* Label (hidden on mobile) */}
            <span
              className={cn(
                "hidden sm:inline ml-2 text-xs font-medium whitespace-nowrap",
                (isCompleted || isActive) ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>

            {/* Connector line */}
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-3",
                  isCompleted ? "bg-primary" : "bg-muted",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
