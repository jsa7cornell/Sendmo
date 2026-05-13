// F1-only — the 3-step "how to ship" strip. Decided 2026-05-13. Carrier-
// agnostic copy with a carrier-specific drop-off hint + "Find a location"
// deep-link pulled from the existing dropOffCopy helper. Subsumes the
// older standalone "Drop off your package" card from ShipmentLabelSection
// (removed 2026-05-13 evening — visual duplication on /t/<code>).
import { ExternalLink } from "lucide-react";
import { dropOffCopy } from "@/components/sender/senderState";

interface Props {
  carrier: string | null;
}

export default function HowToShipStrip({ carrier }: Props) {
  const dropOff = dropOffCopy(carrier ?? "");
  const steps = [
    { n: 1, head: "Print", body: "At home, your library, or any print shop." },
    { n: 2, head: "Tape securely", body: "To the largest flat side. Cover any old barcodes." },
    { n: 3, head: "Drop off", body: dropOff.body },
  ];

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <h3 className="text-sm font-semibold text-foreground mb-3">How to ship</h3>
      <ol className="space-y-3">
        {steps.map(({ n, head, body }) => (
          <li key={n} className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
              {n}
            </span>
            <div className="text-sm">
              <span className="font-medium text-foreground">{head}</span>
              <span className="text-muted-foreground"> — {body}</span>
            </div>
          </li>
        ))}
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
