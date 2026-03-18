import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle2, Download, Printer, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buyLabel } from "@/lib/api";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import type { SenderFlowState } from "@/hooks/useSenderFlow";

interface Props {
  state: SenderFlowState;
  onUpdate: (partial: Partial<SenderFlowState>) => void;
}

export default function SenderStepLabel({ state, onUpdate }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const calledRef = useRef(false);

  const rate = state.selectedRate!;
  const recipientName = state.link?.recipient_name || "the recipient";
  const carrierName = carrierDisplayName(rate.carrier);

  useEffect(() => {
    if (calledRef.current || !state.recipientAddress) return;
    calledRef.current = true;

    async function generate() {
      setLoading(true);
      setError(null);
      try {
        const result = await buyLabel(
          state.easypostShipmentId,
          rate.id,
          state.fromAddress,
          state.recipientAddress!,
        );
        onUpdate({ labelResult: result });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to generate label");
      } finally {
        setLoading(false);
      }
    }

    generate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const label = state.labelResult;

  // Loading
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <div className="text-center">
          <p className="text-lg font-semibold text-foreground">Generating your shipping label...</p>
          <p className="text-sm text-muted-foreground mt-1">This usually takes a few seconds</p>
        </div>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="space-y-6">
        <div className="bg-card rounded-2xl border border-destructive/50 p-6 text-center space-y-3">
          <p className="text-base font-semibold text-destructive">Label Generation Failed</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              calledRef.current = false;
              setLoading(true);
              setError(null);
            }}
            className="rounded-xl"
          >
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  // Success
  return (
    <div className="space-y-6">
      {/* Success banner */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="bg-success/10 border border-success/30 rounded-2xl p-5 flex items-center gap-3"
      >
        <CheckCircle2 className="w-8 h-8 text-success shrink-0" />
        <div>
          <p className="text-lg font-bold text-foreground">Label ready!</p>
          <p className="text-sm text-muted-foreground">
            Your shipping label has been generated successfully.
          </p>
        </div>
      </motion.div>

      {/* Tracking info */}
      {label && (
        <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <span className="text-muted-foreground">Tracking Number</span>
            <span className="text-foreground font-mono text-xs break-all">{label.tracking_number}</span>

            <span className="text-muted-foreground">Carrier</span>
            <span className="text-foreground font-medium">{carrierDisplayName(label.carrier)}</span>

            <span className="text-muted-foreground">Service</span>
            <span className="text-foreground">{serviceDisplayName(label.service)}</span>

            {rate.estimated_days && (
              <>
                <span className="text-muted-foreground">Estimated Delivery</span>
                <span className="text-foreground">
                  {rate.estimated_days === 1 ? "1 business day" : `${rate.estimated_days} business days`}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Action buttons */}
      {label && (
        <div className="space-y-3">
          <motion.div whileTap={{ scale: 0.98 }}>
            <Button
              onClick={() => window.open(label.label_url, "_blank")}
              className="w-full rounded-xl shadow-sm text-base py-5"
              size="lg"
            >
              <Printer className="w-5 h-5 mr-2" />
              Print Label (PDF)
            </Button>
          </motion.div>

          <Button
            variant="outline"
            onClick={() => {
              const a = document.createElement("a");
              a.href = label.label_url;
              a.download = `sendmo-label-${label.tracking_number}.pdf`;
              a.click();
            }}
            className="w-full rounded-xl"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Label
          </Button>
        </div>
      )}

      {/* Drop-off instructions */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-3">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Next Steps</h3>
        </div>
        <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
          <li>Print the label above</li>
          <li>Attach it securely to your package</li>
          <li>Drop it off at any <span className="font-medium text-foreground">{carrierName}</span> location</li>
        </ol>
        <p className="text-xs text-muted-foreground pt-1">
          {recipientName} will be notified once the package is in transit.
        </p>
      </div>
    </div>
  );
}
