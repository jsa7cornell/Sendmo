import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchGuestimate } from "@/lib/api";
import type { GuestimatorResult } from "@/lib/types";

interface Props {
  onResult: (result: GuestimatorResult, meta: { confidence: "high" | "medium" | "low"; notes: string }) => void;
}

export default function MagicGuestimator({ onResult }: Props) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  async function handleGuestimate() {
    if (!input.trim() || loading) return;
    setLoading(true);
    setError(null);
    setNote(null);
    setCompleted(false);
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
      setCompleted(true);
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
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Magic Guestimator</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Describe what you're shipping and we'll fill in everything else.
      </p>

      <textarea
        value={input}
        onChange={(e) => { setInput(e.target.value); if (completed) setCompleted(false); }}
        onKeyDown={handleKeyDown}
        placeholder="e.g., a hardcover cookbook, no rush"
        rows={1}
        disabled={loading}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors placeholder:text-muted-foreground resize-none disabled:opacity-60"
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
        <span className="text-xs text-muted-foreground">
          Auto-fill packaging, dims, weight, and pick a shipping method
        </span>
      </div>

      <AnimatePresence>
        {completed && !error && (
          <motion.div
            key="completed"
            initial={{ opacity: 0, y: -4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 24 }}
            className="mt-3 flex items-center gap-1.5 rounded-xl bg-success/10 border border-success/30 px-3 py-2 text-xs text-success"
          >
            <motion.span
              initial={{ rotate: -30, scale: 0.6 }}
              animate={{ rotate: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 18 }}
              className="inline-flex"
            >
              <CheckCircle2 className="w-4 h-4" />
            </motion.span>
            <span className="font-medium">Auto-filled packaging, dimensions & weight</span>
          </motion.div>
        )}
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
