// F1-only — the 3-step "how to ship" strip. Decided 2026-05-13. Carrier-
// agnostic copy with a carrier-specific drop-off hint + "Find a location"
// deep-link pulled from the existing dropOffCopy helper. Subsumes the
// older standalone "Drop off your package" card from ShipmentLabelSection
// (removed 2026-05-13 evening — visual duplication on /t/<code>).
// 2026-05-19: printDone prop + map-pin step 3 + cutoff hint, per unify-confirmation-into-tracking proposal.
import { Check, ExternalLink, MapPin } from "lucide-react";
import { dropOffCopy } from "@/components/sender/senderState";

interface Props {
  carrier: string | null;
  printDone?: boolean;
}

export default function HowToShipStrip({ carrier, printDone = false }: Props) {
  const dropOff = dropOffCopy(carrier ?? "");
  const carrierName = carrier || "carrier";
  const dropOffBody = `${dropOff.body} Most ${carrierName} locations accept drop-offs until late afternoon.`;

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <h3 className="text-sm font-semibold text-foreground mb-3">How to ship</h3>
      <ol className="space-y-3">
        {/* Step 1 — Print */}
        <li className="flex gap-3">
          {printDone ? (
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-success flex items-center justify-center">
              <Check className="w-[11px] h-[11px] text-white" strokeWidth={3.5} />
            </span>
          ) : (
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
              1
            </span>
          )}
          <div className="text-sm">
            {printDone ? (
              <>
                <span className="font-medium text-foreground">Print</span>
                <span className="text-muted-foreground"> — done!</span>
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">Print</span>
                <span className="text-muted-foreground"> — At home, your library, or any print shop.</span>
              </>
            )}
          </div>
        </li>

        {/* Step 2 — Tape securely */}
        <li className="flex gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
            2
          </span>
          <div className="text-sm">
            <span className="font-medium text-foreground">Tape securely</span>
            <span className="text-muted-foreground"> — To the largest flat side. Cover any old barcodes.</span>
          </div>
        </li>

        {/* Step 3 — Drop off */}
        <li className="flex gap-3">
          <MapPin className="w-6 h-6 text-primary flex-shrink-0" strokeWidth={2.2} />
          <div className="text-sm">
            <span className="font-medium text-foreground">Drop off</span>
            <span className="text-muted-foreground"> — {dropOffBody}</span>
          </div>
        </li>
      </ol>
      {dropOff.locationUrl && (
        <a
          href={dropOff.locationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-3 ml-9"
        >
          Find a location <ExternalLink className="w-3 h-3" />
        </a>
      )}
      <p className="text-xs text-muted-foreground mt-4 italic">
        Tracking activates once {carrier || "the carrier"} scans the package.
      </p>
    </div>
  );
}
