import { motion } from "framer-motion";
import { Package, Link2 } from "lucide-react";
import type { RecipientPath } from "@/lib/types";

interface Props {
  onSelect: (path: RecipientPath) => void;
}

const PATHS = [
  {
    id: "full_label" as RecipientPath,
    icon: Package,
    title: "Full prepaid label",
    badge: "Recommended",
    subtitle: "I know exactly what's being shipped",
    bullets: [
      "Enter the sender's address and package details",
      "Choose your preferred carrier and speed",
      "Get an exact price — no surprises",
      "Download a ready-to-print shipping label",
    ],
  },
  {
    id: "flexible" as RecipientPath,
    icon: Link2,
    title: "Flexible shipping link",
    badge: null,
    subtitle: "Details will be filled in by the sender",
    bullets: [
      "Set your shipping preferences (speed, distance, budget)",
      "Share a link with anyone who needs to send you something",
      "Sender enters package details and prints the label",
      "Your card is only charged when a label is printed",
    ],
  },
];

export default function RecipientStepPathChoice({ onSelect }: Props) {
  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-foreground">How would you like to ship?</h1>
        <p className="text-muted-foreground mt-2">Choose the option that fits your situation</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {PATHS.map((p) => {
          const Icon = p.icon;
          return (
            <motion.button
              key={p.id}
              type="button"
              whileTap={{ scale: 0.98 }}
              onClick={() => onSelect(p.id)}
              className="text-left bg-card rounded-2xl border border-border shadow-sm p-5 hover:border-primary/50 hover:shadow-md transition-all"
            >
              <div className="flex items-start gap-3 mb-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 text-primary shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-foreground">{p.title}</h3>
                    {p.badge && (
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        {p.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">{p.subtitle}</p>
                </div>
              </div>

              <ul className="space-y-2 ml-1">
                {p.bullets.map((b, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <span className="text-primary mt-0.5 shrink-0">•</span>
                    {b}
                  </li>
                ))}
              </ul>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
