import { MapPin, Package, Truck, CheckCircle, Printer } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { icon: Package, label: "Welcome" },
  { icon: MapPin, label: "Package" },
  { icon: Truck, label: "Shipping" },
  { icon: CheckCircle, label: "Review" },
  { icon: Printer, label: "Label" },
];

interface Props {
  activeIndex: number; // 0-4
  completedIndexes: number[];
}

// PRD: Progress bar is NOT clickable for sender flow
export default function SenderProgressBar({ activeIndex, completedIndexes }: Props) {
  return (
    <div className="flex items-center justify-between w-full max-w-lg mx-auto mb-8">
      {STEPS.map((step, i) => {
        const isCompleted = completedIndexes.includes(i);
        const isActive = i === activeIndex;
        const isFuture = !isCompleted && !isActive;
        const Icon = step.icon;

        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <div
              className={cn(
                "flex items-center justify-center w-10 h-10 rounded-full shrink-0 transition-colors cursor-default",
                isCompleted && "bg-primary text-primary-foreground",
                isActive && "border-2 border-primary text-primary bg-primary/5",
                isFuture && "border-2 border-muted text-muted-foreground bg-muted/30",
              )}
            >
              <Icon className="w-4 h-4" />
            </div>

            <span
              className={cn(
                "hidden sm:inline ml-2 text-xs font-medium whitespace-nowrap",
                (isCompleted || isActive) ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>

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
