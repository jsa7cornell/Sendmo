import { Button } from "@/components/ui/button";
import { Printer, Download, ExternalLink, Package, XCircle, RotateCcw } from "lucide-react";
import { dropOffCopy } from "@/components/sender/senderState";

interface Props {
  labelUrl: string;
  trackingNumber: string;
  carrier: string;
  /** When true, render the Cancel + Change row beneath the single-use warning.
   *  Auth-derive lives in TrackingPage (admin || link-owner || cancel-token). */
  canCancel?: boolean;
  onCancelClick?: () => void;
  onChangeClick?: () => void;
}

// Rendered on /t/<public_code> while status === 'label_created'. Combines
// label preview, primary Print CTA, secondary Download, drop-off
// instructions, and the privacy-aware single-use note. Per proposal §11
// + author response B2 (option a) — anyone with the URL can see this.
export default function ShipmentLabelSection({
  labelUrl, trackingNumber, carrier, canCancel, onCancelClick, onChangeClick,
}: Props) {
  const dropOff = dropOffCopy(carrier);

  return (
    <div className="space-y-4">
      {/* Label preview */}
      <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="bg-foreground text-background px-4 py-2 flex items-center justify-between text-xs">
          <span className="font-semibold">SendMo Label</span>
          <span className="font-mono">{trackingNumber}</span>
        </div>
        <div className="p-5 flex items-center justify-center bg-muted/40 min-h-[160px]">
          <a
            href={labelUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-center hover:opacity-80 transition-opacity"
          >
            <Package className="w-12 h-12 text-muted-foreground mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">Tap to preview label PDF</p>
          </a>
        </div>
      </div>

      {/* Print — primary, largest CTA */}
      <a
        href={labelUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
      >
        <Button className="w-full rounded-xl shadow-md text-lg py-7" size="lg">
          <Printer className="w-5 h-5 mr-2" />
          Print Label (PDF)
        </Button>
      </a>

      {/* Download — secondary */}
      <a href={labelUrl} download className="block">
        <Button variant="outline" className="w-full rounded-xl">
          <Download className="w-4 h-4 mr-2" />
          Download PDF
        </Button>
      </a>

      {/* Single-use + share warning (per author-response B2 (a)) */}
      <div className="rounded-xl bg-muted/40 border border-border px-4 py-3 text-xs text-muted-foreground">
        This label is for a single shipment. Please don't reprint or share — duplicates can be rejected by the carrier or charged twice. Anyone with this link can see the recipient's address, so don't share it publicly.
      </div>

      {/* Cancel + Change row — visible only when the viewer's auth signal
          qualifies. Deliberately de-emphasized so a user who just got the
          label doesn't fat-finger them. */}
      {canCancel && (
        <div className="border-t border-border pt-4">
          <p className="text-xs text-muted-foreground mb-2">Made a mistake?</p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancelClick}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              <XCircle className="w-3.5 h-3.5 mr-1" />
              Cancel label
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onChangeClick}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              Cancel &amp; start over
            </Button>
          </div>
        </div>
      )}

      {/* Drop-off — co-located with label since both apply only while not-yet-shipped */}
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
    </div>
  );
}
