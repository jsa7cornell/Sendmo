import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, Truck, Leaf, ChevronDown, ChevronUp,
  DollarSign, X, Package, ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { SpeedTier } from "@/lib/types";

// ─── Speed data ─────────────────────────────────────────────

const SPEEDS = [
  {
    id: "economy" as SpeedTier,
    label: "Economy",
    time: "5–8 business days",
    icon: Leaf,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    activeBg: "bg-emerald-600",
    exampleCost: "$5.50",
    tagline: "Cheapest option",
  },
  {
    id: "standard" as SpeedTier,
    label: "Standard",
    time: "3–5 business days",
    icon: Truck,
    color: "text-primary",
    bg: "bg-blue-50",
    border: "border-blue-200",
    activeBg: "bg-primary",
    exampleCost: "$9.25",
    tagline: "Best balance of speed & cost",
  },
  {
    id: "express" as SpeedTier,
    label: "Express",
    time: "1–3 business days",
    icon: Zap,
    color: "text-orange-600",
    bg: "bg-orange-50",
    border: "border-orange-200",
    activeBg: "bg-orange-600",
    exampleCost: "$18.75",
    tagline: "Fastest delivery",
  },
];

// ─── Price cap options ──────────────────────────────────────

const PRICE_CAPS = [
  { value: 25, label: "$25", desc: "Small & slow shipments" },
  { value: 50, label: "$50", desc: "Most standard shipments" },
  { value: 100, label: "$100", desc: "Large or express shipments" },
  { value: 150, label: "$150", desc: "Covers 99% of shipments" },
];

const CARRIERS = [
  { id: "any", label: "Any carrier" },
  { id: "usps", label: "USPS" },
  { id: "ups", label: "UPS" },
  { id: "fedex", label: "FedEx" },
];

// ─── Price grid data ────────────────────────────────────────

const PRICE_DATA: Record<SpeedTier, { small: number[]; medium: number[]; large: number[] }> = {
  economy:  { small: [3.50, 4.75, 6.25],  medium: [5.50, 7.50, 10.00],  large: [8.75, 12.50, 16.75] },
  standard: { small: [5.25, 7.00, 9.50],  medium: [9.25, 12.00, 15.50], large: [14.50, 19.00, 25.00] },
  express:  { small: [12.00, 15.50, 19.00], medium: [18.75, 24.00, 30.00], large: [28.00, 36.00, 45.00] },
};

const DISTANCES = ["Nearby", "Regional", "Cross-country"];
const DISTANCE_RANGES = ["< 150 mi", "150–800 mi", "800+ mi"];
const SIZES = [
  { key: "small" as const, label: "Small", desc: "Envelope / 1 lb" },
  { key: "medium" as const, label: "Medium", desc: "Shoebox / 5 lbs" },
  { key: "large" as const, label: "Large", desc: "Moving box / 20 lbs" },
];

// ─── Price Grid Modal ───────────────────────────────────────

function PriceGridModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SpeedTier>("standard");
  const data = PRICE_DATA[tab];
  const speedInfo = SPEEDS.find((s) => s.id === tab)!;
  const SIcon = speedInfo.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="relative bg-card rounded-2xl border border-border shadow-lg max-w-lg w-full overflow-hidden max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-foreground">Shipping cost grid</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Typical SendMo prices including all fees</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Pill tabs */}
        <div className="px-5 pt-4 pb-2">
          <div className="bg-muted rounded-xl p-1 flex gap-1">
            {SPEEDS.map((s) => {
              const SI = s.icon;
              const isActive = tab === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setTab(s.id)}
                  className={`
                    flex-1 rounded-lg py-2 text-center text-sm font-medium transition-all flex items-center justify-center gap-1.5
                    ${isActive ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}
                  `}
                >
                  <SI className={`w-3.5 h-3.5 ${isActive ? s.color : ""}`} />
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="text-center text-xs text-muted-foreground mt-2">
            <SIcon className={`w-3 h-3 inline ${speedInfo.color}`} /> {speedInfo.time}
          </p>
        </div>

        {/* Card grid */}
        <div className="px-5 pb-5 space-y-3">
          {/* Distance headers */}
          <div className="grid grid-cols-3 gap-3 mt-2">
            {DISTANCES.map((d, i) => (
              <div key={d} className="text-center">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{d}</p>
                <p className="text-[10px] text-muted-foreground">{DISTANCE_RANGES[i]}</p>
              </div>
            ))}
          </div>

          {SIZES.map((size) => (
            <div key={size.key}>
              <div className="flex items-center gap-2 mb-1.5">
                <Package className={`w-3.5 h-3.5 ${speedInfo.color}`} />
                <span className="text-xs font-semibold text-foreground">{size.label}</span>
                <span className="text-[10px] text-muted-foreground">({size.desc})</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {data[size.key].map((price, ci) => (
                  <div
                    key={ci}
                    className={`rounded-xl ${speedInfo.bg} border ${speedInfo.border} py-3 text-center`}
                  >
                    <span className={`text-lg font-bold ${speedInfo.color}`}>
                      ${price.toFixed(0)}
                    </span>
                    <span className={`text-xs ${speedInfo.color} opacity-70`}>
                      .{price.toFixed(2).split(".")[1]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <p className="text-xs text-muted-foreground text-center pt-2">
            Example estimates. Actual costs can vary.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  errors: string[];
  tried: boolean;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepFlexPreferences({
  state,
  errors,
  tried,
  onUpdate,
  onContinue,
  onBack,
}: Props) {
  const [showOptional, setShowOptional] = useState(false);
  const [showPriceGrid, setShowPriceGrid] = useState(false);

  const selected = SPEEDS.find((s) => s.id === state.speed_preference)!;
  const SelectedIcon = selected.icon;

  return (
    <div className="space-y-5">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-foreground">How fast should it get there?</h1>
        <p className="text-muted-foreground mt-2">Just pick a speed — your sender handles the rest</p>
      </div>

      {/* Pill selector */}
      <div className="bg-muted rounded-2xl p-1.5 flex gap-1">
        {SPEEDS.map((s) => {
          const SIcon = s.icon;
          const isActive = state.speed_preference === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onUpdate({ speed_preference: s.id })}
              className={`
                flex-1 rounded-xl py-3 px-2 text-center transition-all duration-200
                ${isActive ? "bg-card shadow-sm" : "hover:bg-card/50"}
              `}
            >
              <SIcon className={`w-5 h-5 mx-auto mb-1 ${isActive ? s.color : "text-muted-foreground"}`} />
              <p className={`text-sm font-semibold ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                {s.label}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{s.time}</p>
            </button>
          );
        })}
      </div>

      {/* Cost spotlight */}
      <div className={`rounded-2xl ${selected.bg} border ${selected.border} p-5 text-center`}>
        <div className="flex items-center justify-center gap-2 mb-2">
          <SelectedIcon className={`w-5 h-5 ${selected.color}`} />
          <span className={`text-sm font-semibold ${selected.color}`}>{selected.label}</span>
        </div>
        <p className={`text-4xl font-bold ${selected.color} mb-1`}>{selected.exampleCost}</p>
        <p className="text-sm text-muted-foreground">typical cost for a medium package within California</p>
        <p className="text-xs text-muted-foreground mt-2">Actual price depends on weight, size, and distance</p>
      </div>

      {/* Optional settings */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setShowOptional(!showOptional)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mx-auto"
        >
          {showOptional ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          {showOptional ? "Hide" : "Show"} optional settings
        </button>

        <AnimatePresence>
          {showOptional && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-5 bg-muted/30 rounded-2xl border border-border/60 p-5">
                {/* Preferred carrier */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Preferred carrier</label>
                  <div className="flex gap-2 flex-wrap">
                    {CARRIERS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => onUpdate({ preferred_carrier: c.id })}
                        className={`
                          px-3 py-1.5 rounded-lg text-sm border transition-all
                          ${state.preferred_carrier === c.id
                            ? "border-primary bg-primary/10 text-primary font-medium"
                            : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40"
                          }
                        `}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Your sender will only see options from this carrier
                  </p>
                </div>

                {/* Max shipping cost */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Maximum shipping cost</label>
                  <div className="grid grid-cols-2 gap-2">
                    {PRICE_CAPS.map((cap) => (
                      <button
                        key={cap.value}
                        type="button"
                        onClick={() => onUpdate({ price_cap: cap.value })}
                        className={`
                          text-left rounded-xl border p-3 transition-all
                          ${state.price_cap === cap.value
                            ? "border-primary bg-primary/10"
                            : "border-border bg-card hover:border-muted-foreground/40"
                          }
                        `}
                      >
                        <span className={`text-base font-bold ${state.price_cap === cap.value ? "text-primary" : "text-foreground"}`}>
                          {cap.label}
                        </span>
                        <p className="text-xs text-muted-foreground mt-0.5">{cap.desc}</p>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Your sender won't see options above this price
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Price grid link */}
      <div className="text-center">
        <button
          type="button"
          onClick={() => setShowPriceGrid(true)}
          className="text-sm text-primary hover:underline inline-flex items-center gap-1"
        >
          <DollarSign className="w-3.5 h-3.5" />
          See our shipping cost grid
        </button>
      </div>

      {/* Validation errors */}
      {tried && errors.length > 0 && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3">
          <ul className="space-y-1 text-sm text-destructive">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          Continue
        </Button>
      </div>

      {/* Price grid modal */}
      <AnimatePresence>
        {showPriceGrid && <PriceGridModal onClose={() => setShowPriceGrid(false)} />}
      </AnimatePresence>
    </div>
  );
}
