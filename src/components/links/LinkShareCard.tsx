import { useState } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  Copy,
  ArrowRight,
  ArrowLeft,
  QrCode,
  MapPin,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AddressInput, SpeedTier } from "@/lib/types";

interface ShareValueSummary {
  speed_preference: SpeedTier;
  preferred_carrier: string;
  /** Absent on seller links (PR4 — buyer-pays, no cap). */
  price_cap?: number;
  address?: AddressInput;
}

interface Props {
  shortCode: string;
  value: ShareValueSummary;
  onDone: () => void;
  doneLabel?: string;
  onBack?: () => void;
  backLabel?: string;
  /**
   * Which flow created the link. The share snippet describes what the OPENER
   * of the link will do, and that differs by flow: a prepay link's opener
   * prints the already-paid label; a shipping link's opener (the buyer) pays
   * for shipping and never sees a label. Defaults to prepay so existing
   * callers keep today's copy.
   */
  variant?: "prepay" | "seller";
  /** Seller links: the item text, echoed so the link is identifiable later. */
  itemLabel?: string;
  /** Seller links: single-use vs reusable, echoed beside the item. */
  singleUse?: boolean;
}

export default function LinkShareCard({
  shortCode,
  value,
  onDone,
  doneLabel,
  onBack,
  backLabel,
  variant = "prepay",
  itemLabel,
  singleUse,
}: Props) {
  const seller = variant === "seller";
  const [copied, setCopied] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const shortLink = `sendmo.co/s/${shortCode}`;
  const fullUrl = `https://${shortLink}`;

  function handleCopyLink() {
    navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const marketplaceSnippet = seller
    ? `📦 Shipping is easy — open my SendMo link, enter your address, pick your speed, and pay for shipping. I'll get it in the mail.

${shortLink}`
    : `📦 I ship with SendMo — open my link, enter your address, and print the prepaid label.

${shortLink}`;

  function handleCopySnippet() {
    navigator.clipboard.writeText(marketplaceSnippet);
    setSnippetCopied(true);
    setTimeout(() => setSnippetCopied(false), 2000);
  }

  const addressLine = value.address
    ? [
        value.address.street,
        [
          [value.address.city, value.address.state].filter(Boolean).join(", "),
          value.address.zip,
        ]
          .filter(Boolean)
          .join(" "),
      ]
        .filter(Boolean)
        .join(", ")
    : null;

  const carrierLabel =
    value.preferred_carrier && value.preferred_carrier !== "any"
      ? value.preferred_carrier.toUpperCase()
      : null;

  return (
    <div className="space-y-4">
      {/* Combined "ready" + link + meta card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-card rounded-2xl border border-border shadow-sm p-4 sm:p-5"
      >
        <div className="flex items-center gap-2.5 mb-3">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 200, delay: 0.1 }}
          >
            <CheckCircle2 className="w-6 h-6 text-success" />
          </motion.div>
          <h2 className="text-base sm:text-lg font-bold text-foreground">
            {seller ? "Your shipping link is ready — send it to your buyer" : "Your link is ready"}
          </h2>
        </div>

        {seller && (
          <p className="text-xs text-muted-foreground mb-2">
            {itemLabel ? (
              <>
                Shipping for <span className="font-medium text-foreground">{itemLabel}</span>
              </>
            ) : (
              "Your shipping link"
            )}
            {" · "}
            {singleUse ? "single use" : "reusable"} · active until you turn it off
          </p>
        )}

        <div className="flex items-center gap-2 bg-muted/50 rounded-xl px-3 py-2.5 mb-2">
          <span className="text-sm text-foreground font-mono flex-1 truncate">{shortLink}</span>
        </div>

        <Button
          onClick={handleCopyLink}
          className={`w-full rounded-xl gap-2 ${seller ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}`}
        >
          <Copy className="w-4 h-4" />
          {copied ? "Copied!" : "Copy link"}
        </Button>

        <Button
          variant="outline"
          className="w-full rounded-xl gap-2 mt-2"
          onClick={() => setQrOpen(true)}
        >
          <QrCode className="w-4 h-4" />
          {seller ? "Show QR code — in-person sales or a printed listing" : "Show QR code"}
        </Button>

        {(addressLine || carrierLabel) && (
          <div className="mt-3 pt-3 border-t border-border flex items-start gap-2 text-xs text-muted-foreground">
            <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              {addressLine && (
                <div className="text-foreground font-medium truncate">{addressLine}</div>
              )}
              <div>
                <span className="capitalize">{value.speed_preference}</span>
                {carrierLabel && <> · {carrierLabel}</>}
                {typeof value.price_cap === "number" && <> · ${value.price_cap} cap</>}
              </div>
            </div>
          </div>
        )}
      </motion.div>

      {/* Listing snippet card */}
      <div className="bg-muted/40 rounded-2xl border border-border p-4 sm:p-5">
        <div className="mb-3 min-w-0">
          <div className="text-sm font-semibold text-foreground">
            Paste this into your listing
          </div>
          <div className="text-xs text-muted-foreground">
            Works on Marketplace, Craigslist, OfferUp — or just text it.
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border px-3 py-2.5 mb-2 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
          {seller
            ? `📦 Shipping is easy — open my SendMo link, enter your address, pick your speed, and pay for shipping. I'll get it in the mail.\n\n`
            : `📦 I ship with SendMo — open my link, enter your address, and print the prepaid label.\n\n`}
          <span className="font-mono text-primary text-xs break-all">{shortLink}</span>
        </div>
        <Button
          variant="outline"
          onClick={handleCopySnippet}
          className="w-full rounded-xl gap-2"
        >
          <Copy className="w-4 h-4" />
          {snippetCopied ? "Copied!" : "Copy snippet"}
        </Button>
      </div>

      {/* Quiet exits — the primary action on this screen is copying the link */}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3">
        {onBack && (
          <Button
            variant="ghost"
            onClick={onBack}
            className="sm:flex-1 rounded-xl gap-2 text-muted-foreground"
          >
            <ArrowLeft className="w-4 h-4" />
            {backLabel ?? "Go back"}
          </Button>
        )}
        <Button
          variant="ghost"
          className="sm:flex-1 rounded-xl gap-2 text-muted-foreground"
          onClick={onDone}
        >
          {doneLabel ?? "Go to your account page"}
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>

      {/* QR modal */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Scan to open your link</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 pt-2">
            <div className="bg-white p-4 rounded-xl border border-border">
              <QRCodeSVG
                value={fullUrl}
                size={220}
                level="M"
                marginSize={0}
              />
            </div>
            <p className="text-xs text-muted-foreground font-mono break-all text-center">
              {shortLink}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
