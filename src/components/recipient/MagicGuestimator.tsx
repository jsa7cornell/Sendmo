import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GuestimatorResult, PackagingType, SpeedTier } from "@/lib/types";

// ─── Item Database ──────────────────────────────────────────

interface ItemDef {
  keywords: string[];
  packaging: PackagingType;
  length: number;
  width: number;
  height: number;
  weightLbs: number;
  name: string;
}

const ITEMS: ItemDef[] = [
  { keywords: ["laptop", "notebook", "macbook", "chromebook"], packaging: "box", length: 13, width: 10, height: 3, weightLbs: 5, name: "Laptop" },
  { keywords: ["phone", "iphone", "android", "samsung", "pixel"], packaging: "box", length: 7, width: 4, height: 2, weightLbs: 1, name: "Phone" },
  { keywords: ["book", "textbook", "novel"], packaging: "envelope", length: 10, width: 7, height: 2, weightLbs: 2, name: "Book" },
  { keywords: ["clothes", "shirt", "pants", "dress", "jacket", "sweater", "clothing"], packaging: "envelope", length: 14, width: 10, height: 4, weightLbs: 2, name: "Clothes" },
  { keywords: ["skis", "ski"], packaging: "tube", length: 80, width: 10, height: 5, weightLbs: 15, name: "Skis" },
  { keywords: ["shoes", "sneakers", "boots"], packaging: "box", length: 14, width: 10, height: 6, weightLbs: 4, name: "Shoes" },
  { keywords: ["document", "documents", "papers", "paperwork", "contract"], packaging: "envelope", length: 12, width: 9, height: 1, weightLbs: 0.5, name: "Documents" },
  { keywords: ["headphones", "earbuds", "airpods"], packaging: "box", length: 8, width: 6, height: 4, weightLbs: 1, name: "Headphones" },
  { keywords: ["tablet", "ipad"], packaging: "box", length: 11, width: 8, height: 2, weightLbs: 2, name: "Tablet" },
  { keywords: ["poster", "print", "art print"], packaging: "tube", length: 36, width: 6, height: 6, weightLbs: 2, name: "Poster" },
  { keywords: ["wine", "bottle", "bottles"], packaging: "box", length: 14, width: 5, height: 5, weightLbs: 4, name: "Wine Bottle" },
  { keywords: ["camera", "dslr"], packaging: "box", length: 10, width: 8, height: 6, weightLbs: 3, name: "Camera" },
  { keywords: ["guitar"], packaging: "box", length: 48, width: 18, height: 6, weightLbs: 10, name: "Guitar" },
  { keywords: ["keyboard", "mechanical keyboard"], packaging: "box", length: 18, width: 7, height: 3, weightLbs: 3, name: "Keyboard" },
  { keywords: ["monitor", "display", "screen"], packaging: "box", length: 28, width: 18, height: 6, weightLbs: 12, name: "Monitor" },
];

// Order matters: check longer/multi-word phrases first to avoid false matches
// (e.g., "no rush" must match economy before "rush" matches express)
const SPEED_KEYWORDS: { keywords: string[]; speed: SpeedTier }[] = [
  { keywords: ["no rush", "cheapest", "cheap", "affordable", "budget", "slow", "economy", "whenever"], speed: "economy" },
  { keywords: ["next week", "soon", "standard", "normal"], speed: "standard" },
  { keywords: ["urgent", "rush", "asap", "overnight", "express", "fast", "immediately"], speed: "express" },
];

export function parseGuestimation(input: string): GuestimatorResult | null {
  const lower = input.toLowerCase().trim();
  if (!lower) return null;

  // Match item
  let matchedItem: ItemDef | null = null;
  for (const item of ITEMS) {
    if (item.keywords.some((kw) => lower.includes(kw))) {
      matchedItem = item;
      break;
    }
  }

  if (!matchedItem) return null;

  // Match speed
  let speedHint: SpeedTier | undefined;
  for (const group of SPEED_KEYWORDS) {
    if (group.keywords.some((kw) => lower.includes(kw))) {
      speedHint = group.speed;
      break;
    }
  }

  return {
    packaging: matchedItem.packaging,
    length: matchedItem.length,
    width: matchedItem.width,
    height: matchedItem.height,
    weightLbs: matchedItem.weightLbs,
    speedHint,
    itemName: matchedItem.name,
  };
}

// ─── Component ──────────────────────────────────────────────

interface Props {
  onResult: (result: GuestimatorResult) => void;
}

export default function MagicGuestimator({ onResult }: Props) {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "fail"; text: string } | null>(null);

  function handleGuestimate() {
    const result = parseGuestimation(input);
    if (result) {
      setFeedback({ type: "success", text: `Filled from: ${result.itemName}` });
      onResult(result);
    } else {
      setFeedback({ type: "fail", text: "Couldn't match — please fill in details manually" });
    }
    setTimeout(() => setFeedback(null), 3000);
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
        placeholder="Describe what's being shipped (e.g., Skis in a large box, shipped affordably)"
        rows={2}
        className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors placeholder:text-muted-foreground resize-none"
      />

      <div className="flex items-center gap-3 mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleGuestimate}
          disabled={!input.trim()}
          className="rounded-xl gap-1.5"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Guestimate it
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
