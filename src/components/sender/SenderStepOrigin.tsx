import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SmartAddressInput from "@/components/ui/SmartAddressInput";
import { cn } from "@/lib/utils";
import type { SenderFlowState } from "@/hooks/useSenderFlow";
import type { PackagingType } from "@/lib/types";

// ─── Packaging Options ──────────────────────────────────────

const PACKAGING_OPTIONS: { id: PackagingType; label: string; desc: string }[] = [
  { id: "box", label: "Box / Rigid", desc: "Standard cardboard box" },
  { id: "envelope", label: "Envelope / Soft Pack", desc: "Padded mailer or poly bag" },
  { id: "tube", label: "Tube / Irregular", desc: "Cylindrical or odd shape" },
];

// ─── Props ──────────────────────────────────────────────────

interface Props {
  state: SenderFlowState;
  recipientName: string;
  tried: boolean;
  errors: string[];
  onUpdate: (partial: Partial<SenderFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function SenderStepOrigin({
  state, recipientName, tried, errors, onUpdate, onContinue, onBack,
}: Props) {
  const showErrors = tried && errors.length > 0;

  return (
    <div className="space-y-6">
      {/* Destination display — NEVER show full address, only name */}
      <div className="bg-muted rounded-xl px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Shipping to <span className="font-medium text-foreground">{recipientName}</span>
        </p>
      </div>

      {/* Ship from */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <h2 className="text-base font-semibold text-foreground">Ship from</h2>
        <SmartAddressInput
          label="sender-origin"
          value={state.fromAddress}
          onChange={(addr) => onUpdate({ fromAddress: addr })}
          error={tried && !state.fromAddress.verified ? "Verify your address" : undefined}
        />
      </div>

      {/* Item description */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-3">
        <label className="text-sm font-medium text-foreground">
          What's inside? <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <Input
          value={state.itemDescription}
          onChange={(e) => onUpdate({ itemDescription: e.target.value })}
          placeholder="e.g., Books, clothes, electronics"
          className="rounded-xl"
        />
      </div>

      {/* Packaging type */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Packaging type</h2>
        <div className="grid grid-cols-3 gap-2">
          {PACKAGING_OPTIONS.map((opt) => (
            <motion.button
              key={opt.id}
              type="button"
              whileTap={{ scale: 0.98 }}
              onClick={() => onUpdate({ packagingType: opt.id })}
              className={cn(
                "rounded-xl border p-3 text-left transition-all",
                state.packagingType === opt.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30 bg-card",
              )}
            >
              <p className="text-xs font-medium text-foreground">{opt.label}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{opt.desc}</p>
            </motion.button>
          ))}
        </div>
      </div>

      {/* Package dimensions */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Package dimensions (inches)</h2>
        <div className={cn(
          "grid gap-3",
          state.packagingType === "envelope" ? "grid-cols-2" : "grid-cols-3",
        )}>
          <div>
            <label className="text-xs text-muted-foreground">Length</label>
            <Input
              type="number"
              min={0}
              value={state.dimensions.length}
              onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, length: e.target.value } })}
              placeholder="L"
              className={cn("rounded-xl mt-1", tried && !(parseFloat(state.dimensions.length) > 0) && "border-destructive")}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Width</label>
            <Input
              type="number"
              min={0}
              value={state.dimensions.width}
              onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, width: e.target.value } })}
              placeholder="W"
              className={cn("rounded-xl mt-1", tried && !(parseFloat(state.dimensions.width) > 0) && "border-destructive")}
            />
          </div>
          {state.packagingType !== "envelope" && (
            <div>
              <label className="text-xs text-muted-foreground">Height</label>
              <Input
                type="number"
                min={0}
                value={state.dimensions.height}
                onChange={(e) => onUpdate({ dimensions: { ...state.dimensions, height: e.target.value } })}
                placeholder="H"
                className={cn("rounded-xl mt-1", tried && !(parseFloat(state.dimensions.height) > 0) && "border-destructive")}
              />
            </div>
          )}
        </div>
      </div>

      {/* Package weight */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Package weight</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Pounds</label>
            <Input
              type="number"
              min={0}
              value={state.weight.lbs}
              onChange={(e) => onUpdate({ weight: { ...state.weight, lbs: e.target.value } })}
              placeholder="lbs"
              className={cn(
                "rounded-xl mt-1",
                tried && !((parseFloat(state.weight.lbs) || 0) + (parseFloat(state.weight.oz) || 0) > 0) && "border-destructive",
              )}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Ounces</label>
            <Input
              type="number"
              min={0}
              max={15}
              value={state.weight.oz}
              onChange={(e) => onUpdate({ weight: { ...state.weight, oz: e.target.value } })}
              placeholder="oz"
              className="rounded-xl mt-1"
            />
          </div>
        </div>
      </div>

      {/* Validation errors */}
      <AnimatePresence>
        {showErrors && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <ul className="text-xs text-destructive space-y-1">
                {errors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Buttons */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          Back
        </Button>
        <Button onClick={onContinue} className="flex-1 rounded-xl shadow-sm">
          See Rates
        </Button>
      </div>
    </div>
  );
}
