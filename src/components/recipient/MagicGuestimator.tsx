import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchGuestimate } from "@/lib/api";
import type { GuestimatorResult } from "@/lib/types";

interface Props {
  onResult: (result: GuestimatorResult, meta: { confidence: "high" | "medium" | "low"; notes: string }) => void;
}

export default function MagicGuestimator({ onResult }: Props) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "fail"; text: string } | null>(null);

  async function handleGuestimate() {
    if (!input.trim() || loading) return;
    setLoading(true);
    setFeedback(null);
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
      const tag = est.confidence === "high" ? "" : ` (${est.confidence} confidence)`;
      setFeedback({ type: "success", text: `Filled from: ${est.itemName}${tag}` });
    } catch (err) {
      setFeedback({
        type: "fail",
        text: err instanceof Error ? err.message : "Couldn't estimate — please fill in details manually",
      });
    } finally {
      setLoading(false);
      setTimeout(() => setFeedback(null), 5000);
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Magic Guestimator</h3>
      </div>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Describe what's being shipped (e.g., a hardcover cookbook, no rush)"
        rows={2}
        disabled={loading}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors placeholder:text-muted-foreground resize-none disabled:opacity-60"
      />

      <div className="flex items-center gap-3 mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleGuestimate}
          disabled={!input.trim() || loading}
          className="rounded-xl gap-1.5"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {loading ? "Thinking…" : "Guestimate it"}
        </Button>

        <AnimatePresence>
          {feedback && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className={`text-xs font-medium ${
                feedback.type === "success" ? "text-success" : "text-muted-foreground"
              }`}
            >
              {feedback.text}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
