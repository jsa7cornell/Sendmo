import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, AlertCircle, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import AppHeader from "@/components/AppHeader";
import {
  fetchLink, fetchSenderRates, buyLabel,
} from "@/lib/api";
import type { LinkData } from "@/lib/api";
import type { AddressInput, ShippingRate } from "@/lib/types";
import { emptyAddress } from "@/lib/utils";

import SenderProgressBar from "@/components/sender/SenderProgressBar";
import SenderStepIntro from "@/components/sender/SenderStepIntro";
import SenderStepPackage from "@/components/sender/SenderStepPackage";
import SenderStepRates from "@/components/sender/SenderStepRates";
import SenderStepReview from "@/components/sender/SenderStepReview";
import {
  type SenderStep, type SenderParcel,
  loadSavedSender, saveSender, sortRatesForSender, pickBestPerCarrier,
} from "@/components/sender/senderState";

// 5-step sender wizard for flex shipping links. See SPEC §8 and
// proposals/2026-05-11_sender-flow-wizard...md for the canonical spec.
export default function SenderFlow() {
  const { shortCode } = useParams<{ shortCode: string }>();
  const navigate = useNavigate();

  const [linkData, setLinkData] = useState<LinkData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<SenderStep | "loading" | "error">("loading");

  // "Cancel & start over" banner — set by TrackingPage when a Change action
  // redirects back to /s/<short_code>. Read once, then cleared.
  const [showChangeBanner] = useState(() => {
    try {
      if (sessionStorage.getItem("sendmo_just_voided_for_change") === "1") {
        sessionStorage.removeItem("sendmo_just_voided_for_change");
        return true;
      }
    } catch { /* noop */ }
    return false;
  });

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
  const [usedGuestimator, setUsedGuestimator] = useState(false);

  useEffect(() => {
    if (!shortCode) {
      setLoadError("No link code provided");
      setStep("error");
      return;
    }
    fetchLink(shortCode)
      .then((data) => {
        // Full-label links are viewer links — the label was already bought
        // at link-creation time. Redirect to the tracking page instead of
        // rendering the sender wizard (which expects a flex-link).
        if (data.link_type === "full_label" && data.public_code) {
          navigate(`/t/${data.public_code}`, { replace: true });
          return;
        }
        // Fail fast if the destination address is incomplete — better to show
        // a clear error here than to let the sender fill in package details
        // only to fail at rate-fetching with a cryptic EasyPost/FedEx error.
        if (data.recipient_address_complete === false) {
          setLoadError("This link's delivery address is incomplete — it's missing a street address. The person who set up this link needs to update their delivery address before you can ship.");
          setStep("error");
          return;
        }
        // Pattern D (Phase F): flex link without a usable saved PM can't
        // accept new shipments — the labels function would refuse the
        // off_session charge. Show a recipient-named message up-front so
        // the sender doesn't waste time filling the form.
        if (data.link_type === "flexible" && data.is_funded === false) {
          const name = data.recipient_name || "the recipient";
          setLoadError(`This link isn't accepting payments right now. Please check back with ${name} once they've updated their payment method.`);
          setStep("error");
          return;
        }
        setLinkData(data);
        setStep("intro");
      })
      .catch((err) => {
        setLoadError(err.message || "We looked everywhere, but this link doesn't seem to exist. Double-check the URL?");
        setStep("error");
      });
  }, [shortCode, navigate]);

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
          short_code: linkData.short_code,
        },
      );
      setEasypostShipmentId(easypost_shipment_id);
      // One best-value option per carrier, ranked best first.
      // sortRatesForSender then re-orders within that set so the
      // recipient's preferred speed tier floats to the top.
      // Store only the filtered list so the UI shows one option per carrier.
      const perCarrier = pickBestPerCarrier(r);
      const sorted = sortRatesForSender(perCarrier, linkData);
      setRates(sorted);
      if (sorted.length > 0) setSelectedRate(sorted[0]);
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
        // Pattern D (Phase F): labels function creates a fresh off_session
        // PaymentIntent against the recipient's saved PM for the actual
        // rate. display_price_cents is audit-only — server re-derives the
        // canonical value from the EasyPost rate.
        { comp: false, display_price_cents: selectedRate.display_price_cents },
        undefined,  // accessToken — sender flow uses link_short_code auth, not JWT
        { description: parcel.description ?? undefined },
      );
      // Per proposal §11/§13 B3: navigate to the shipment page with a fresh
      // celebration flag; the URL is the bookmark-friendly post-generation surface.
      // Fall back to the in-flow "done" placeholder only if the labels function
      // didn't return a public_code (shouldn't happen post-Round-1 B2 — the RPC
      // is awaited and public_code is in the response — but defends against a
      // partial regression).
      if (labelResult.public_code) {
        // Stash the cancel_token in sessionStorage keyed by public_code so the
        // TrackingPage Cancel/Change row renders. Migration 020 + cancel-flow
        // proposal decided 2026-05-12. Both reads + writes happen via
        // sessionStorage so the inline (just-shipped) and email transport
        // (?cancel=<hex> from "Label ready" email) converge on one source.
        if (labelResult.cancel_token) {
          try {
            sessionStorage.setItem(
              `sendmo:cancel_token:${labelResult.public_code}`,
              labelResult.cancel_token,
            );
          } catch { /* sessionStorage unavailable — graceful no-op */ }
        }
        navigate(`/t/${labelResult.public_code}?fresh=1`, { replace: true });
      } else {
        setSubmitError(
          "Label generated but we couldn't build the tracking link. Check your dashboard or contact support.",
        );
      }
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
          {showChangeBanner && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl px-4 py-3 mb-4 text-sm text-foreground">
              Previous label voided. Let's try again.
            </div>
          )}

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
                  onGuestimatorUsed={() => setUsedGuestimator(true)}
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
                  usedGuestimator={usedGuestimator}
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

            {/* Post-Round-2: "done" step removed — handleConfirm navigates to
                /t/<public_code>?fresh=1 on success. Kept only as a fallback path
                when public_code is missing from the labels response. */}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
