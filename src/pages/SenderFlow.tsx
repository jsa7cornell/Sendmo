import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchLink, fetchAddress } from "@/lib/api";
import { useSenderFlow } from "@/hooks/useSenderFlow";
import SenderProgressBar from "@/components/sender/SenderProgressBar";
import SenderStepIntro from "@/components/sender/SenderStepIntro";
import SenderStepOrigin from "@/components/sender/SenderStepOrigin";
import SenderStepShipping from "@/components/sender/SenderStepShipping";
import SenderStepReview from "@/components/sender/SenderStepReview";
import SenderStepLabel from "@/components/sender/SenderStepLabel";

// ─── Animation variants (matches recipient flow) ────────────

const stepVariants = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
};

// ─── Page Component ─────────────────────────────────────────

export default function SenderFlow() {
  const { shortCode } = useParams<{ shortCode: string }>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  const { state, updateState, goToStep, goBack, tryAdvance, markComplete, getErrors } = useSenderFlow();

  // ── Fetch link + recipient address on mount ───────────────
  useEffect(() => {
    if (!shortCode || fetchedRef.current) return;
    fetchedRef.current = true;

    async function load() {
      try {
        const linkData = await fetchLink(shortCode!);

        if (linkData.status === "expired") {
          setLoadError("This shipping link has expired.");
          return;
        }
        if (linkData.status === "used") {
          setLoadError("This shipping link has already been used.");
          return;
        }
        if (linkData.status !== "active" && linkData.status !== "draft") {
          setLoadError("This shipping link is not available.");
          return;
        }

        // Fetch full recipient address for rate/label API calls (NEVER displayed)
        const recipientAddr = await fetchAddress(linkData.recipient_address_id);
        updateState({ link: linkData, recipientAddress: recipientAddr });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load shipping link");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [shortCode, updateState]);

  // ── Navigation helpers ────────────────────────────────────

  function handleIntroAdvance() {
    markComplete(0);
    goToStep(1);
  }

  function handleStepAdvance(step: number) {
    tryAdvance(step);
  }

  // ── Loading ───────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading shipping link...</p>
        </div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────

  if (loadError || !state.link) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex items-center justify-center px-4">
        <div className="bg-card rounded-2xl border border-border shadow-sm p-8 max-w-md w-full text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
          <h1 className="text-xl font-bold text-foreground">Link Not Available</h1>
          <p className="text-sm text-muted-foreground">
            {loadError || "This shipping link could not be loaded."}
          </p>
          <Link to="/">
            <Button variant="outline" className="rounded-xl mt-2">
              Go to SendMo
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // ── Derived values ────────────────────────────────────────

  const recipientName = state.link.recipient_name;
  const recipientLocation = [state.link.recipient_city, state.link.recipient_state]
    .filter(Boolean)
    .join(", ");

  // ── Render wizard ─────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <div className="container max-w-2xl mx-auto px-4 py-8">
        {/* Progress bar — shown on steps 1-4, NOT clickable per PRD */}
        {state.currentStep > 0 && (
          <SenderProgressBar
            activeIndex={state.currentStep}
            completedIndexes={state.completedSteps}
          />
        )}

        {/* Step content with Framer Motion transitions */}
        <AnimatePresence mode="wait">
          <motion.div
            key={state.currentStep}
            variants={stepVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.25 }}
          >
            {/* Step 0: Intro */}
            {state.currentStep === 0 && (
              <SenderStepIntro
                recipientName={recipientName}
                recipientLocation={recipientLocation}
                onContinue={handleIntroAdvance}
              />
            )}

            {/* Step 1: Origin + Package Details */}
            {state.currentStep === 1 && (
              <SenderStepOrigin
                state={state}
                recipientName={recipientName}
                tried={!!state.tried[1]}
                errors={getErrors(1)}
                onUpdate={updateState}
                onContinue={() => handleStepAdvance(1)}
                onBack={goBack}
              />
            )}

            {/* Step 2: Choose Shipping */}
            {state.currentStep === 2 && (
              <SenderStepShipping
                state={state}
                onUpdate={updateState}
                onContinue={() => handleStepAdvance(2)}
                onBack={goBack}
              />
            )}

            {/* Step 3: Review & Confirm */}
            {state.currentStep === 3 && state.selectedRate && (
              <SenderStepReview
                state={state}
                onConfirm={() => handleStepAdvance(3)}
                onBack={goBack}
                onEditPackage={() => goToStep(1)}
                onEditShipping={() => goToStep(2)}
              />
            )}

            {/* Step 4: Label Ready */}
            {state.currentStep === 4 && state.selectedRate && (
              <SenderStepLabel
                state={state}
                onUpdate={updateState}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
