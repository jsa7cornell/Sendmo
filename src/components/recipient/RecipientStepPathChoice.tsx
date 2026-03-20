import { motion } from "framer-motion";
import {
  Package, Link2, Tag, Users, CheckCircle2,
  ArrowRight, Printer, Share2,
} from "lucide-react";
import type { RecipientPath } from "@/lib/types";

interface Props {
  onSelect: (path: RecipientPath) => void;
}

// ─── Mini scene illustration ─────────────────────────────────

function Scene({
  icons,
  iconBg,
  iconColor,
}: {
  icons: React.ElementType[];
  iconBg: string;
  iconColor: string;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      {icons.map((Icon, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`w-11 h-11 rounded-xl ${iconBg} flex items-center justify-center`}>
            <Icon className={`w-5 h-5 ${iconColor}`} />
          </div>
          {i < icons.length - 1 && (
            <ArrowRight className={`w-3.5 h-3.5 ${iconColor} opacity-50`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Card data ───────────────────────────────────────────────

const PATHS = [
  {
    id: "full_label" as RecipientPath,
    badge: "Recommended",
    badgeColor: "bg-primary text-primary-foreground",
    heroBg: "bg-gradient-to-br from-primary/15 via-primary/8 to-primary/3",
    iconBg: "bg-primary/20",
    iconColor: "text-primary",
    borderHover: "hover:border-primary/60",
    sceneIcons: [Package, Printer, Tag],
    title: "Full prepaid label",
    subtitle: "You know exactly what's being shipped",
    description:
      "Enter the package details now, pick a carrier, and get a real shipping label — ready to print immediately. Best when you have all the info on hand.",
    features: [
      { icon: Tag, text: "Exact price, no surprises" },
      { icon: Printer, text: "Label ready to print right away" },
      { icon: CheckCircle2, text: "Works with USPS, UPS, and FedEx" },
    ],
  },
  {
    id: "flexible" as RecipientPath,
    badge: null,
    badgeColor: "",
    heroBg: "bg-gradient-to-br from-violet-500/15 via-violet-500/8 to-violet-500/3",
    iconBg: "bg-violet-500/15",
    iconColor: "text-violet-600",
    borderHover: "hover:border-violet-400/60",
    sceneIcons: [Link2, Share2, Users],
    title: "Flexible shipping link",
    subtitle: "Your sender fills in the details",
    description:
      "Get a shareable link you can send to anyone. They enter the package info and print the label themselves. Perfect for marketplace sales, gifts, or multiple senders.",
    features: [
      { icon: Users, text: "No account needed for your sender" },
      { icon: Share2, text: "Share with anyone via text or email" },
      { icon: CheckCircle2, text: "You're only charged when they print" },
    ],
  },
];

// ─── Component ───────────────────────────────────────────────

export default function RecipientStepPathChoice({ onSelect }: Props) {
  return (
    <div className="space-y-5">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">How do you want to set this up?</h1>
        <p className="text-muted-foreground mt-2">Pick the option that fits what you're doing</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {PATHS.map((p) => (
          <motion.button
            key={p.id}
            type="button"
            whileTap={{ scale: 0.985 }}
            onClick={() => onSelect(p.id)}
            className={`
              text-left bg-card rounded-2xl border border-border shadow-sm
              overflow-hidden transition-all duration-150 group
              ${p.borderHover} hover:shadow-md
            `}
          >
            {/* Illustration hero */}
            <div className={`${p.heroBg} px-5 py-6 flex flex-col items-center gap-3`}>
              <Scene
                icons={p.sceneIcons}
                iconBg={p.iconBg}
                iconColor={p.iconColor}
              />
              {/* Caption below scene */}
              <p className={`text-xs font-medium ${p.iconColor} opacity-75`}>
                {p.id === "full_label"
                  ? "Enter details → pick carrier → get label"
                  : "Set preferences → share link → sender ships"}
              </p>
            </div>

            {/* Content */}
            <div className="p-5">
              {/* Title row */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <h3 className="font-semibold text-foreground leading-tight">{p.title}</h3>
                {p.badge && (
                  <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${p.badgeColor}`}>
                    {p.badge}
                  </span>
                )}
              </div>

              {/* Subtitle */}
              <p className="text-sm text-muted-foreground mb-3">{p.subtitle}</p>

              {/* Description */}
              <p className="text-xs text-muted-foreground leading-relaxed mb-4 border-t border-border/60 pt-3">
                {p.description}
              </p>

              {/* Feature list */}
              <ul className="space-y-1.5 mb-4">
                {p.features.map((f) => {
                  const Icon = f.icon;
                  return (
                    <li key={f.text} className="flex items-center gap-2 text-sm text-foreground">
                      <Icon className="w-3.5 h-3.5 text-success shrink-0" />
                      {f.text}
                    </li>
                  );
                })}
              </ul>

              {/* CTA hint */}
              <div className={`flex items-center gap-1 text-sm font-medium ${p.iconColor} group-hover:gap-2 transition-all`}>
                Select this option
                <ArrowRight className="w-3.5 h-3.5" />
              </div>
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
