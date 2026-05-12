import { useState, useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, AlertCircle, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";
import {
  fetchLink, fetchSenderRates, buyLabel, pickRecommendedRate,
} from "@/lib/api";
import type { LinkData } from "@/lib/api";
import type { AddressInput, ShippingRate } from "@/lib/types";
import { emptyAddress } from "@/lib/utils";

import SenderProgressBar from "@/components/sender/SenderProgressBar";
import SenderStepIntro from "@/components/sender/SenderStepIntro";
import SenderStepPackage from "@/components/sender/SenderStepPackage";
import SenderStepRates from "@/components/sender/SenderStepRates";
import SenderStepReview from "@/components/sender/SenderStepReview";
import SenderStepDone from "@/components/sender/SenderStepDone";
import {
  type SenderStep, type SenderParcel, type SenderResult,
  loadSavedSender, saveSender,
} from "@/components/sender/senderState";

// 5-step sender wizard for flex shipping links. See SPEC §8 and
// proposals/2026-05-11_sender-flow-wizard...md for the canonical spec.
export default function SenderFlow() {
  const { shortCode } = useParams<{ shortCode: string }>();

  const [linkData, setLinkData] = useState<LinkData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<SenderStep | "loading" | "error">("loading");

  // Pre-fill from localStorage when available (non-blocking nit).
  const saved = useMemo(() => loadSavedSender(), []);
  const [senderAddress, setSenderAddress] = useState<AddressInput>(saved?.senderAddress ?? emptyAddress());
  const [senderEmail, setSenderEmail] = useState(saved?.senderEmail ?? "");
  const [saveInfo, setSaveInfo] = useState(true);
  const [shareContact, setShareContact] = useState(false);

  const [parcel, setParcel] = useState<SenderParcel | null>(null);
  const [rates, setRates] = useState<ShippingRate[]>([]);
  const [easypostShipmentId, setEasypostShipmentId] = useState<string>("");
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<SenderResult | null>(null);

  useEffect(() => {
    if (!shortCode) {
      setLoadError("No link code provided");
      setStep("error");
      return;
    }
    fetchLink(shortCode)
      .then((data) => {
        setLinkData(data);
        setStep("intro");
      })
      .catch((err) => {
        setLoadError(err.message || "We looked everywhere, but this link doesn't seem to exist. Double-check the URL?");
        setStep("error");
      });
  }, [shortCode]);

  async function handleFetchRates(p: SenderParcel) {
    if (!linkData) return;
    setRatesLoading(true);
    setRatesError(null);
    setSelectedRate(null);
    setStep("rates");
    try {
      const { rates: r, easypost_shipment_id } = await fetchSenderRates(
        senderAddress,
        {
          name: linkData.recipient_name || "Recipient",
          city: linkData.recipient_city || "",
          state: linkData.recipient_state || "",
          zip: linkData.recipient_zip || "",
        },
        { length: p.length, width: p.width, height: p.height, weight: p.weightOz },
        {
          preferred_carrier: linkData.preferred_carrier,
          preferred_speed: linkData.preferred_speed,
          max_price_cents: linkData.max_price_cents,
        },
      );
      setRates(r);
      setEasypostShipmentId(easypost_shipment_id);
      // Default-select the recommended rate matching the link's speed preference.
      const speed = (linkData.preferred_speed as "economy" | "standard" | "express" | null) || "standard";
      const recommended = pickRecommendedRate(r, speed);
      if (recommended) setSelectedRate(recommended);
    } catch (err) {
      setRatesError(err instanceof Error ? err.message : "Failed to fetch rates");
    } finally {
      setRatesLoading(false);
    }
  }

  async function handleConfirm() {
    if (!linkData || !selectedRate || !parcel || !easypostShipmentId) return;
    if (saveInfo) saveSender(senderAddress, senderEmail);

    setSubmitting(true);
    setSubmitError(null);
    try {
      const labelResult = await buyLabel(
        easypostShipmentId,
        selectedRate.id,
        senderAddress,
        // to_address is resolved server-side from link_short_code; pass a stub.
        { name: linkData.recipient_name || "Recipient", street: "", city: linkData.recipient_city || "", state: linkData.recipient_state || "", zip: linkData.recipient_zip || "" },
        false,
        {
          sender_email: shareContact && senderEmail ? senderEmail : (senderEmail || undefined),
        },
        { short_code: linkData.short_code },
        { comp: true, display_price_cents: selectedRate.display_price_cents },
      );
      setResult({
        labelUrl: labelResult.label_url,
        trackingNumber: labelResult.tracking_number,
        publicCode: labelResult.public_code ?? null,
        carrier: labelResult.carrier,
        service: labelResult.service,
      });
      setStep("done");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to generate label");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex flex-col">
      <AppHeader actions={
        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5" />
          Prepaid shipping
        </span>
      } />

      <div className="flex-1 py-8 px-4">
        <div className="container max-w-md mx-auto">
          {step !== "loading" && step !== "error" && (
            <SenderProgressBar step={step} />
          )}

          <AnimatePresence mode="wait">
            {step === "loading" && (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-center py-16 space-y-3">
                <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
                <p className="text-foreground font-medium">Loading shipping link…</p>
              </motion.div>
            )}

            {step === "error" && (
              <motion.div key="error" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                <div className="bg-destructive/10 border border-destructive/30 rounded-2xl p-6 text-center">
                  <AlertCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
                  <h2 className="text-lg font-bold text-foreground mb-2">Hmm, that link didn't work</h2>
                  <p className="text-sm text-muted-foreground">{loadError}</p>
                </div>
                <Button variant="outline" className="w-full rounded-xl mt-5" onClick={() => (window.location.href = "/")}>
                  Back to SendMo
                </Button>
              </motion.div>
            )}

            {step === "intro" && linkData && (
              <motion.div key="intro" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                <SenderStepIntro linkData={linkData} onContinue={() => setStep("package")} />
              </motion.div>
            )}

            {step === "package" && linkData && (
              <motion.div key="package" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                <SenderStepPackage
                  linkData={linkData}
                  senderAddress={senderAddress}
                  onAddressChange={setSenderAddress}
                  initialParcel={parcel}
                  onSubmit={(p) => {
                    setParcel(p);
                    handleFetchRates(p);
                  }}
                  onBack={() => setStep("intro")}
                />
              </motion.div>
            )}

            {step === "rates" && linkData && (
              <motion.div key="rates" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                <SenderStepRates
                  linkData={linkData}
                  rates={rates}
                  loading={ratesLoading}
                  error={ratesError}
                  selectedRate={selectedRate}
                  onSelectRate={setSelectedRate}
                  onContinue={() => setStep("review")}
                  onBack={() => setStep("package")}
                  onRetry={() => parcel && handleFetchRates(parcel)}
                />
              </motion.div>
            )}

            {step === "review" && linkData && parcel && selectedRate && (
              <motion.div key="review" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                <SenderStepReview
                  linkData={linkData}
                  senderAddress={senderAddress}
                  parcel={parcel}
                  selectedRate={selectedRate}
                  senderEmail={senderEmail}
                  onSenderEmailChange={setSenderEmail}
                  saveInfo={saveInfo}
                  onSaveInfoChange={setSaveInfo}
                  shareContact={shareContact}
                  onShareContactChange={setShareContact}
                  onEditPackage={() => setStep("package")}
                  onEditRate={() => setStep("rates")}
                  onConfirm={handleConfirm}
                  submitting={submitting}
                  submitError={submitError}
                />
              </motion.div>
            )}

            {step === "done" && linkData && result && (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                <SenderStepDone linkData={linkData} senderAddress={senderAddress} result={result} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
