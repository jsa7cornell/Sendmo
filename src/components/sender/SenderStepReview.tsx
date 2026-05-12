import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Package, Truck, ArrowLeft, Loader2, AlertCircle, Pencil } from "lucide-react";
import type { LinkData } from "@/lib/api";
import type { AddressInput, ShippingRate } from "@/lib/types";
import { carrierDisplayName, serviceDisplayName } from "@/lib/utils";
import { isValidEmail, type SenderParcel } from "./senderState";

interface Props {
  linkData: LinkData;
  senderAddress: AddressInput;
  parcel: SenderParcel;
  selectedRate: ShippingRate;
  senderEmail: string;
  onSenderEmailChange: (e: string) => void;
  saveInfo: boolean;
  onSaveInfoChange: (v: boolean) => void;
  shareContact: boolean;
  onShareContactChange: (v: boolean) => void;
  onEditPackage: () => void;
  onEditRate: () => void;
  onConfirm: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;
}

// SPEC §8 Step 3: Review & Confirm. Edit buttons on summary cards;
// email-for-tracking field; two checkboxes; AlertDialog-equivalent confirm.
export default function SenderStepReview({
  linkData, senderAddress, parcel, selectedRate,
  senderEmail, onSenderEmailChange,
  saveInfo, onSaveInfoChange, shareContact, onShareContactChange,
  onEditPackage, onEditRate, onConfirm, submitting, submitError,
}: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const emailInvalid = senderEmail.length > 0 && !isValidEmail(senderEmail);

  const recipient = linkData.recipient_name?.trim() || "the recipient";
  const cityState = linkData.recipient_city && linkData.recipient_state
    ? `${linkData.recipient_city}, ${linkData.recipient_state}`
    : "this prepaid link";

  async function handleConfirm() {
    setConfirmOpen(false);
    await onConfirm();
  }

  return (
    <div className="space-y-5">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Review and confirm</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          One last look before we generate the label.
        </p>
      </div>

      {/* Package summary */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Package className="w-4 h-4" /> Your package
          </h3>
          <button
            type="button"
            onClick={onEditPackage}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
        </div>
        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-muted-foreground">From</dt>
            <dd className="font-medium text-foreground text-right">{senderAddress.city}, {senderAddress.state}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">To</dt>
            <dd className="font-medium text-foreground text-right">{recipient} · {cityState}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Packaging</dt>
            <dd className="font-medium text-foreground capitalize">{parcel.packaging}</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Dimensions</dt>
            <dd className="font-medium text-foreground">{parcel.length} × {parcel.width} × {parcel.height} in</dd></div>
          <div className="flex justify-between"><dt className="text-muted-foreground">Weight</dt>
            <dd className="font-medium text-foreground">{(parcel.weightOz / 16).toFixed(2)} lb</dd></div>
          {parcel.description && (
            <div className="flex justify-between"><dt className="text-muted-foreground">Item</dt>
              <dd className="font-medium text-foreground truncate ml-2 max-w-[60%]">{parcel.description}</dd></div>
          )}
        </dl>
      </div>

      {/* Shipping method summary */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Truck className="w-4 h-4" /> Shipping method
          </h3>
          <button
            type="button"
            onClick={onEditRate}
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
        </div>
        <p className="text-sm font-medium text-foreground">
          {carrierDisplayName(selectedRate.carrier)} {serviceDisplayName(selectedRate.service)}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {selectedRate.estimated_days
            ? `${selectedRate.estimated_days} business day${selectedRate.estimated_days > 1 ? "s" : ""}`
            : "Estimated delivery TBD"} · Prepaid by {recipient}
        </p>
      </div>

      {/* Sender email + checkboxes */}
      <div className="bg-card rounded-2xl border border-border shadow-sm p-5 space-y-4">
        <div>
          <label htmlFor="sender-email" className="text-sm font-medium text-foreground mb-1.5 block">
            Your email <span className="font-normal text-muted-foreground">(for tracking updates)</span>
          </label>
          <input
            id="sender-email"
            type="email"
            placeholder="you@example.com"
            value={senderEmail}
            onChange={(e) => onSenderEmailChange(e.target.value)}
            className={`w-full rounded-xl border ${emailInvalid ? "border-destructive" : "border-border"} bg-background px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary`}
          />
          {emailInvalid && <p className="text-xs text-destructive mt-1">Please enter a valid email.</p>}
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={saveInfo}
            onChange={(e) => onSaveInfoChange(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded accent-primary"
          />
          <span className="text-sm text-foreground">
            Save my information on this device
            <span className="block text-xs text-muted-foreground">Pre-fill your address and email next time you ship.</span>
          </span>
        </label>

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
            <DialogTitle>Generate label for {recipient}?</DialogTitle>
            <DialogDescription>
              This will create a real shipping label. You can print it on the next screen.
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
