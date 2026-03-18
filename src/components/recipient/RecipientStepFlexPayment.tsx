import { useState } from "react";
import { motion } from "framer-motion";
import { CreditCard, ArrowLeft, Loader2, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { RecipientFlowState } from "@/hooks/useRecipientFlow";

// ─── Rate estimate lookup (from PRD Section 7.1) ────────────

interface RangeEstimate {
  low: number;
  high: number;
  days: string;
}

type SizeKey = "envelope" | "smallbox" | "largebox" | "default";

const RATE_TABLE: Record<string, Record<string, Record<string, RangeEstimate>>> = {
  envelope: {
    nearby:  { economy: { low: 500, high: 600, days: "2–3" }, standard: { low: 800, high: 1000, days: "1–2" }, express: { low: 2800, high: 3000, days: "Next day" } },
    regional: { economy: { low: 600, high: 700, days: "3–4" }, standard: { low: 900, high: 1200, days: "2–3" }, express: { low: 2900, high: 3200, days: "1–2" } },
    cross:   { economy: { low: 700, high: 900, days: "4–5" }, standard: { low: 1100, high: 1400, days: "2–3" }, express: { low: 3000, high: 3400, days: "1–2" } },
  },
  smallbox: {
    nearby:  { economy: { low: 700, high: 1000, days: "2–4" }, standard: { low: 1000, high: 1400, days: "1–3" }, express: { low: 3200, high: 4200, days: "1–2" } },
    regional: { economy: { low: 1000, high: 1500, days: "3–5" }, standard: { low: 1400, high: 1900, days: "2–3" }, express: { low: 3600, high: 4800, days: "1–2" } },
    cross:   { economy: { low: 1400, high: 2000, days: "5–7" }, standard: { low: 1800, high: 2400, days: "2–3" }, express: { low: 4200, high: 5600, days: "1–2" } },
  },
  largebox: {
    nearby:  { economy: { low: 1400, high: 2000, days: "2–4" }, standard: { low: 1800, high: 2600, days: "1–3" }, express: { low: 4800, high: 6800, days: "1–2" } },
    regional: { economy: { low: 2000, high: 3000, days: "3–5" }, standard: { low: 2600, high: 3800, days: "2–3" }, express: { low: 5800, high: 8200, days: "1–2" } },
    cross:   { economy: { low: 2800, high: 4000, days: "5–7" }, standard: { low: 3400, high: 4800, days: "2–3" }, express: { low: 7200, high: 10000, days: "1–2" } },
  },
  default: {
    nearby:  { economy: { low: 500, high: 2000, days: "2–5" }, standard: { low: 800, high: 2600, days: "1–3" }, express: { low: 2800, high: 6800, days: "1–2" } },
    regional: { economy: { low: 600, high: 3000, days: "3–5" }, standard: { low: 900, high: 3800, days: "2–3" }, express: { low: 2900, high: 8200, days: "1–2" } },
    cross:   { economy: { low: 700, high: 4000, days: "4–7" }, standard: { low: 1100, high: 4800, days: "2–3" }, express: { low: 3000, high: 10000, days: "1–2" } },
  },
};

function getEstimate(state: RecipientFlowState): RangeEstimate {
  const size: SizeKey = state.size_hint ?? "default";
  return RATE_TABLE[size]?.[state.distance_hint]?.[state.speed_preference]
    ?? RATE_TABLE.default.regional.standard;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Main Component ──────────────────────────────────────────

interface Props {
  state: RecipientFlowState;
  onUpdate: (partial: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export default function RecipientStepFlexPayment({ state, onUpdate, onContinue, onBack }: Props) {
  const [loading, setLoading] = useState(false);
  const estimate = getEstimate(state);
  const holdAmount = Math.round(estimate.high * 1.1);

  async function handleAuthorize() {
    setLoading(true);
    // TODO: Replace with real Stripe PaymentIntent (manual capture)
    await new Promise((r) => setTimeout(r, 1500));
    setLoading(false);
    onUpdate({ paymentStatus: "authorized" });
    onContinue();
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Shield className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Authorize payment</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          A temporary hold ensures your link is ready when your sender needs it.
        </p>
      </div>

      {/* Estimated cost range */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Estimated shipping cost</h3>
        <div className="text-center mb-4">
          <motion.div
            animate={{ scale: [1, 1.02, 1] }}
            transition={{ duration: 0.3 }}
            className="text-3xl font-bold text-primary"
          >
            {formatCents(estimate.low)} – {formatCents(estimate.high)}
          </motion.div>
          <p className="text-xs text-muted-foreground mt-1">
            {estimate.days} business days
          </p>
        </div>
        <dl className="space-y-2 text-sm border-t border-border pt-3">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Speed</dt>
            <dd className="font-medium text-foreground capitalize">{state.speed_preference}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Distance</dt>
            <dd className="font-medium text-foreground capitalize">
              {state.distance_hint === "cross" ? "Cross-country" : state.distance_hint}
            </dd>
          </div>
          {state.size_hint && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Size hint</dt>
              <dd className="font-medium text-foreground capitalize">
                {state.size_hint === "smallbox" ? "Small box" : state.size_hint === "largebox" ? "Large box" : "Envelope"}
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Price cap</dt>
            <dd className="font-medium text-foreground">${state.price_cap}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-2">
            <dt className="font-semibold text-foreground">Hold amount</dt>
            <dd className="font-bold text-primary text-lg">{formatCents(holdAmount)}</dd>
          </div>
        </dl>
      </div>

      {/* Mock Payment Form */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Payment</h3>
          </div>
          <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 bg-amber-50">
            Test Mode
          </Badge>
        </div>

        {/* Decorative card fields */}
        <div className="space-y-3 mb-4">
          <div>
            <label className="text-xs text-muted-foreground">Card number</label>
            <div className="mt-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              4242 4242 4242 4242
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Expiry</label>
              <div className="mt-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                12/29
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">CVC</label>
              <div className="mt-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                123
              </div>
            </div>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground mb-4">
          Payment is simulated in test mode. No real charge will be made.
        </p>

        <Button
          onClick={handleAuthorize}
          disabled={loading}
          className="w-full rounded-xl shadow-sm text-base py-5"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Authorizing…
            </>
          ) : (
            `Authorize Hold — ${formatCents(holdAmount)}`
          )}
        </Button>
      </div>

      {/* Explainer */}
      <div className="bg-muted rounded-xl px-4 py-3 text-xs text-muted-foreground">
        We'll hold up to {formatCents(holdAmount)} on your card. You'll only be charged the actual
        shipping cost when your sender prints a label. Any excess hold is automatically released.
      </div>

      {/* Back */}
      {!loading && (
        <Button variant="outline" onClick={onBack} className="rounded-xl">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
      )}
    </div>
  );
}
