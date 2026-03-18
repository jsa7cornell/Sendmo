import { motion } from "framer-motion";
import { MapPin, ArrowLeft, Sliders } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";
import type { DistanceTier, SpeedTier } from "@/lib/types";

// ─── Option Data ─────────────────────────────────────────────

const DISTANCE_OPTIONS: { id: DistanceTier; label: string; desc: string }[] = [
  { id: "nearby", label: "Local", desc: "Same state or neighbor state" },
  { id: "regional", label: "Domestic", desc: "Same half of the country" },
  { id: "cross", label: "Cross-country", desc: "Coast to coast" },
];

const SIZE_OPTIONS: { id: "envelope" | "smallbox" | "largebox"; label: string; desc: string }[] = [
  { id: "envelope", label: "Envelope", desc: "Under 1 lb" },
  { id: "smallbox", label: "Small Box", desc: "2–5 lbs" },
  { id: "largebox", label: "Large Box", desc: "10–25 lbs" },
];

const SPEED_OPTIONS: { id: SpeedTier; label: string; desc: string; color: string }[] = [
  { id: "economy", label: "Economy", desc: "3–7 business days", color: "emerald" },
  { id: "standard", label: "Standard", desc: "1–3 business days", color: "blue" },
  { id: "express", label: "Express", desc: "1–2 business days", color: "amber" },
];

// ─── Radio Card Component ────────────────────────────────────

function RadioCard({
  selected,
  onClick,
  label,
  desc,
  accentColor,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  desc: string;
  accentColor?: string;
}) {
  const selectedBorder = accentColor
    ? `border-${accentColor}-400 bg-${accentColor}-50`
    : "border-primary bg-primary/5";
  const selectedDot = accentColor ? `border-${accentColor}-500` : "border-primary";
  const selectedDotInner = accentColor ? `bg-${accentColor}-500` : "bg-primary";

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`text-left w-full bg-card rounded-2xl border shadow-sm p-4 transition-all ${
        selected ? selectedBorder : "border-border hover:border-muted-foreground/30"
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
            selected ? selectedDot : "border-muted-foreground/30"
          }`}
        >
          {selected && <div className={`w-2 h-2 rounded-full ${selectedDotInner}`} />}
        </div>
        <div>
          <div className="font-medium text-foreground text-sm">{label}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
    </motion.button>
  );
}

// ─── Toggle Card (for package size — deselectable) ───────────

function ToggleCard({
  selected,
  onClick,
  label,
  desc,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  desc: string;
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`text-left w-full bg-card rounded-2xl border shadow-sm p-4 transition-all ${
        selected ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/30"
      }`}
    >
      <div className="font-medium text-foreground text-sm">{label}</div>
      <div className="text-xs text-muted-foreground">{desc}</div>
    </motion.button>
  );
}

// ─── Main Component ──────────────────────────────────────────

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
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sliders className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Shipping preferences</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Help us estimate costs. Your sender can still ship any size.
        </p>
      </div>

      {/* Destination display */}
      {state.destinationAddress.verified && (
        <div className="bg-muted rounded-xl px-4 py-3 flex items-center gap-2 text-sm">
          <MapPin className="w-4 h-4 text-primary shrink-0" />
          <span className="text-muted-foreground">Shipping to</span>
          <span className="font-medium text-foreground">
            {state.destinationAddress.city}, {state.destinationAddress.state} {state.destinationAddress.zip}
          </span>
        </div>
      )}

      {/* Distance selector */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Expected distance</h3>
        <div className="grid gap-2">
          {DISTANCE_OPTIONS.map((d) => (
            <RadioCard
              key={d.id}
              selected={state.distance_hint === d.id}
              onClick={() => onUpdate({ distance_hint: d.id })}
              label={d.label}
              desc={d.desc}
            />
          ))}
        </div>
      </div>

      {/* Package size hint */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Package size hint</h3>
        <p className="text-xs text-muted-foreground mb-3">Optional — helps estimate cost. Tap again to deselect.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {SIZE_OPTIONS.map((s) => (
            <ToggleCard
              key={s.id}
              selected={state.size_hint === s.id}
              onClick={() =>
                onUpdate({ size_hint: state.size_hint === s.id ? null : s.id })
              }
              label={s.label}
              desc={s.desc}
            />
          ))}
        </div>
      </div>

      {/* Speed tier */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Preferred speed</h3>
        <div className="grid gap-2">
          {SPEED_OPTIONS.map((s) => (
            <RadioCard
              key={s.id}
              selected={state.speed_preference === s.id}
              onClick={() => onUpdate({ speed_preference: s.id })}
              label={s.label}
              desc={s.desc}
              accentColor={s.color}
            />
          ))}
        </div>
      </div>

      {/* Price cap */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Maximum you'll pay per shipment</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Senders will only see shipping options under this cap.
        </p>
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold text-foreground">$</span>
          <Input
            type="number"
            min={5}
            max={500}
            value={state.price_cap}
            onChange={(e) => onUpdate({ price_cap: Math.max(0, Number(e.target.value)) })}
            className="w-28 rounded-xl text-center text-lg font-semibold"
          />
          <input
            type="range"
            min={5}
            max={500}
            step={5}
            value={state.price_cap}
            onChange={(e) => onUpdate({ price_cap: Number(e.target.value) })}
            className="flex-1 accent-primary"
          />
        </div>
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

      {/* Context note */}
      <div className="bg-muted rounded-xl px-4 py-3 text-xs text-muted-foreground">
        Prices are estimates and may vary based on actual package dimensions.
        Your card is not charged until a sender prints a label.
      </div>

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
    </div>
  );
}
