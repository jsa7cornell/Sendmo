import { useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchGuestimate } from "@/lib/api";
import type { GuestimatorResult } from "@/lib/types";

interface Props {
  onResult: (result: GuestimatorResult, meta: { confidence: "high" | "medium" | "low"; notes: string }) => void;
  /**
   * Copy overrides. All optional and defaulted to what this component has
   * always rendered, because it serves four surfaces (recipient Package,
   * sender Package, SellerBuilder, SenderPreview) and only the recipient
   * Package step takes the 2026-08-22 treatment.
   */
  title?: string;
  /** Pass null to drop the explainer line entirely. */
  subtitle?: string | null;
  placeholder?: string;
  /**
   * The sparkle badge. On by default — it is the Guestimator's identity on the
   * three surfaces that present it as a named feature. The recipient Package
   * step turns it off: there the card is simply the step's first question
   * ("Describe the product"), not a feature being advertised.
   */
  icon?: boolean;
  /**
   * Rendered beside the button, replacing the default hint text. The recipient
   * Package step puts its "or fill in manually" escape here — the fields that
   * escape reveals are the ones this component fills, so the two belong on the
   * same row.
   */
  action?: ReactNode;
}

export default function MagicGuestimator({
  onResult,
  title = "Magic Guestimator",
  subtitle = "Describe what you're shipping and we'll fill in everything else.",
  placeholder = "e.g., a hardcover cookbook, no rush",
  icon = true,
  action,
}: Props) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGuestimate() {
    if (!input.trim() || loading) return;
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      const est = await fetchGuestimate(input);
      const result: GuestimatorResult = {
        packaging: est.packaging,
        length: est.length_in,
        width: est.width_in,
        height: est.packaging === "envelope" ? 1 : est.height_in,
        weightLbs: est.weight_lbs,
        speedHint: est.speedHint ?? undefined,
        itemName: est.itemName,
      };
      onResult(result, { confidence: est.confidence, notes: est.notes });
      if (est.notes && est.confidence !== "high") {
        setNote(est.notes);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't estimate — please fill in details manually");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGuestimate();
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <div className="flex items-center gap-2 mb-1">
        {icon && <Sparkles className="w-4 h-4 text-primary" />}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {subtitle && (
        <p className="text-xs text-muted-foreground mb-3">{subtitle}</p>
      )}

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        disabled={loading}
        className="w-full mt-2 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors placeholder:text-muted-foreground resize-none disabled:opacity-60"
      />

      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={handleGuestimate}
          disabled={!input.trim() || loading}
          className="rounded-xl gap-1.5"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {loading ? "Thinking…" : "I'm Feeling Lucky"}
        </Button>
        {/* No default caption (John, 2026-08-19: "no green, just keep it
            normal. limit the text to only what is needed"). It restated the
            subtitle two lines above it, and the green "Auto-filled packaging,
            dimensions & weight" banner that followed a run restated the fields
            themselves — which the user can now see, filled in. */}
        {action}
      </div>

      <AnimatePresence>
        {note && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-xs text-muted-foreground mt-2 flex items-start gap-1"
          >
            <Sparkles className="w-3 h-3 text-primary shrink-0 mt-0.5" />
            <span>{note}</span>
          </motion.p>
        )}
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-xs text-destructive mt-2"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
