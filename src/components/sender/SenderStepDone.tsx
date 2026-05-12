import { Button } from "@/components/ui/button";
import { CheckCircle2, Printer, Download, ExternalLink, Package } from "lucide-react";
import { Link } from "react-router-dom";
import type { LinkData } from "@/lib/api";
import type { AddressInput } from "@/lib/types";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import { dropOffCopy, type SenderResult } from "./senderState";

interface Props {
  linkData: LinkData;
  senderAddress: AddressInput;
  result: SenderResult;
}

// SPEC §8 Step 4. Print Label is the LARGEST CTA. Per B3 + Predicted-Pitfall-4:
// the PDF opens in a new tab (`<a target="_blank">`) — no iframe, no thermal-print
// CSS on the SendMo page. Mobile Safari handles PDFs much more reliably this way.
export default function SenderStepDone({ linkData, senderAddress, result }: Props) {
  const recipient = linkData.recipient_name?.trim() || "the recipient";
  const cityState = linkData.recipient_city && linkData.recipient_state
    ? `${linkData.recipient_city}, ${linkData.recipient_state}`
    : null;
  const dropOff = dropOffCopy(result.carrier);

  return (
    <div className="space-y-5">
      {/* Success banner */}
      <div className="bg-success/10 border border-success/30 rounded-2xl p-6 text-center">
        <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-3" />
        <h1 className="text-2xl font-bold text-foreground">Label ready!</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Print it, tape it to the package, and drop it off.
        </p>
      </div>

      {/* Label preview thumbnail */}
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="bg-foreground text-background px-4 py-2 flex items-center justify-between text-xs">
          <span className="font-semibold">SendMo Label</span>
          <span className="font-mono">{result.trackingNumber}</span>
        </div>
        <div className="p-5 flex items-center justify-center bg-muted/40 min-h-[160px]">
          <a
            href={result.labelUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-center hover:opacity-80 transition-opacity"
          >
            <Package className="w-12 h-12 text-muted-foreground mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">Tap to preview label PDF</p>
          </a>
        </div>
      </div>

      {/* PRINT — largest CTA on the page */}
      <a
        href={result.labelUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <Button className="w-full rounded-xl shadow-md text-lg py-7" size="lg">
          <Printer className="w-5 h-5 mr-2" />
          Print Label (PDF)
        </Button>
      </a>

      {/* Download secondary */}
      <a href={result.labelUrl} download className="block">
        <Button variant="outline" className="w-full rounded-xl">
          <Download className="w-4 h-4 mr-2" />
          Download PDF
        </Button>
      </a>

      {/* Drop-off instructions */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-2">Drop off your package</h3>
        <p className="text-sm text-muted-foreground">{dropOff.body}</p>
        {dropOff.locationUrl && (
          <a
            href={dropOff.locationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-2"
          >
            Find a location <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
          Tape the label securely to the largest flat side of the package. Cover any old shipping labels.
        </p>
      </div>

      {/* Shipment summary */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-semibold text-foreground mb-3">Shipment details</h3>
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-muted-foreground">From</dt>
            <dd className="font-medium text-foreground">{senderAddress.city}, {senderAddress.state}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">To</dt>
            <dd className="font-medium text-foreground">{recipient}{cityState && ` · ${cityState}`}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Service</dt>
            <dd className="font-medium text-foreground">{carrierDisplayName(result.carrier)} {serviceDisplayName(result.service)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Tracking</dt>
            <dd className="font-mono text-xs text-foreground">{result.trackingNumber}</dd></div>
        </dl>
      </div>

      <div className="flex flex-col gap-2">
        {result.publicCode && (
          <Link to={`/t/${result.publicCode}`}>
            <Button variant="outline" className="w-full rounded-xl">
              Track this package
            </Button>
          </Link>
        )}
        <Link to="/">
          <Button variant="ghost" className="w-full rounded-xl text-muted-foreground">
            Back to SendMo
          </Button>
        </Link>
      </div>
    </div>
  );
}
