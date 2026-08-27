import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { ArrowLeft, Loader2, AlertCircle } from "lucide-react";
import ShipmentDetailsCard, { type DetailCell } from "@/components/shipment/ShipmentDetailsCard";
import { formatParcelDims, formatParcelWeightLb } from "@/components/shipment/parcelDraft";
import type { LinkData } from "@/lib/api";
import type { AddressInput, ShippingRate } from "@/lib/types";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import { displayName } from "@/lib/name";
import { isValidEmail, type SenderParcel } from "./senderState";

interface Props {
  linkData: LinkData;
  senderAddress: AddressInput;
  /** Phase 3: the sender-entered destination on a needs_destination link. */
  destinationOverride?: AddressInput;
  parcel: SenderParcel;
  selectedRate: ShippingRate;
  senderEmail: string;
  onSenderEmailChange: (e: string) => void;
  shareContact: boolean;
  onShareContactChange: (v: boolean) => void;
  onEditOrigin: () => void;
  onEditDestination?: () => void;
  onEditPackage: () => void;
  onEditRate: () => void;
  onConfirm: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;
}

// SPEC §8 Step 3: Review & Confirm — the last screen before a label exists.
//
// The summary is the SAME block the link's creator saw before they paid
// (components/shipment/ShipmentDetailsCard). Two bespoke cards used to state
// the same four facts in a different shape on this side, which meant the two
// halves of one shipment described it differently. What the sender's copy
// omits is price: they never see what the shipment costs, so there is no
// estimate cell and no total row.
export default function SenderStepReview({
  linkData, senderAddress, destinationOverride, parcel, selectedRate,
  senderEmail, onSenderEmailChange, shareContact, onShareContactChange,
  onEditOrigin, onEditDestination, onEditPackage, onEditRate,
  onConfirm, submitting, submitError,
}: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Email is required (decided 2026-05-12 — cancel-flow proposal). The cancel
  // mechanism uses the email as the durable auth surface; without an address
  // the just-shipped sender can't recover the cancel link if they close the tab.
  const emailMissing = senderEmail.trim().length === 0;
  const emailFormatBad = senderEmail.length > 0 && !isValidEmail(senderEmail);
  const emailInvalid = emailMissing || emailFormatBad;

  // Phase 3: on a destination-deferred link the "to" cell is the address the
  // SENDER just entered — linkData carries none. `recipient` (the payer who
  // prepaid) keeps its linkData meaning in the other copy.
  const recipient = displayName(linkData.recipient_name) || "the recipient";
  const toDeferred = !!destinationOverride;
  const toPrimary = toDeferred
    ? (displayName(destinationOverride.name) || destinationOverride.name || "—")
    : recipient;
  // Rule 7: on an ordinary flex link the sender never sees the delivery
  // street — city/state only. A destination they typed themselves is theirs.
  const toSecondary = toDeferred
    ? destinationOverride.street || ""
    : linkData.recipient_city && linkData.recipient_state
      ? `${linkData.recipient_city}, ${linkData.recipient_state}`
      : "";

  const cells: DetailCell[] = [
    {
      key: "from",
      primary: senderAddress.name || "—",
      secondary: senderAddress.street || "",
      onEdit: onEditOrigin,
    },
    {
      key: "to",
      primary: toPrimary,
      secondary: toSecondary,
      // Only editable when the sender is the one who supplied it.
      onEdit: toDeferred ? onEditDestination : undefined,
    },
    {
      key: "parcel",
      primary: formatParcelDims(parcel),
      secondary: formatParcelWeightLb(parcel.weightOz),
      onEdit: onEditPackage,
    },
    {
      key: "via",
      primary: `${carrierDisplayName(selectedRate.carrier)} ${serviceDisplayName(selectedRate.service)}`,
      secondary: selectedRate.estimated_days
        ? `${selectedRate.estimated_days} business day${selectedRate.estimated_days > 1 ? "s" : ""}`
        : "",
      onEdit: onEditRate,
    },
  ];

  async function handleConfirm() {
    setConfirmOpen(false);
    await onConfirm();
  }

  return (
    <div className="space-y-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Review and confirm</h1>
      </div>

      <div className="space-y-2">
        <ShipmentDetailsCard title="Shipment Details" cells={cells} />
        <p className="max-w-md text-xs text-muted-foreground">
          Shipping is prepaid by {recipient} — you're not charged.
        </p>
      </div>

      {/* Sender email + checkboxes */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <div>
          <label htmlFor="sender-email" className="text-sm font-medium text-foreground mb-1.5 block">
            Your email <span className="text-destructive">*</span>
          </label>
          <input
            id="sender-email"
            type="email"
            required
            placeholder="you@example.com"
            value={senderEmail}
            onChange={(e) => onSenderEmailChange(e.target.value)}
            className={`w-full rounded-xl border ${emailFormatBad ? "border-destructive" : "border-border"} bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`}
          />
          <p className="text-xs text-muted-foreground mt-1">
            It's important to have a reachable email in case you want to change your shipment.
          </p>
          {emailFormatBad && <p className="text-xs text-destructive mt-1">Please enter a valid email.</p>}
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={shareContact}
            onChange={(e) => onShareContactChange(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded accent-primary"
          />
          <span className="text-sm text-foreground">
            Share my contact info with {recipient}
            <span className="block text-xs text-muted-foreground">Let them know who sent the package.</span>
          </span>
        </label>
      </div>

      {submitError && (
        <div className="rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-destructive">Couldn't generate the label</p>
              <p className="text-xs text-muted-foreground mt-0.5">{submitError}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" onClick={onEditRate} className="rounded-xl" disabled={submitting}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </Button>
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={submitting || emailInvalid}
          className="flex-1 rounded-xl shadow-sm"
        >
          {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Confirm and generate label
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              Generating a real label will charge {recipient}'s account. You can print the label on the next screen.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={handleConfirm}>Generate label</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
