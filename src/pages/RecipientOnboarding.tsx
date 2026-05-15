import { useLocation, useParams, Navigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Package, Link2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useRecipientFlowContext } from "@/contexts/RecipientFlowContext";
import AppHeader from "@/components/AppHeader";
import {
  stepToProgressIndex,
  progressIndexToStep,
  canAccessStep,
  firstIncompleteUrl,
  isSlugValidForPath,
  pathSlugToPath,
} from "@/lib/stepRouting";
import ProgressBar from "@/components/recipient/ProgressBar";
import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import RecipientStepFullShipping from "@/components/recipient/RecipientStepFullShipping";
import RecipientStepPayment from "@/components/recipient/RecipientStepPayment";
import RecipientStepFlexPreferences from "@/components/recipient/RecipientStepFlexPreferences";
import RecipientStepEmailVerifyFlex from "@/components/recipient/RecipientStepEmailVerifyFlex";
import RecipientStepEmailVerifySupabase from "@/components/recipient/RecipientStepEmailVerifySupabase";
import RecipientStepFlexPayment from "@/components/recipient/RecipientStepFlexPayment";
import RecipientStepLinkReady from "@/components/recipient/RecipientStepLinkReady";

// ─── Animation variants ─────────────────────────────────────

function getVariants(direction: "forward" | "backward") {
  return {
    initial: { opacity: 0, x: direction === "forward" ? 20 : -20 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: direction === "forward" ? -20 : 20 },
  };
}

// ─── Layout Component ───────────────────────────────────────
//
// Admin mode toolbar lives in AppHeader (Phase B B2 fix, 2026-05-13). Mode
// resolves from profiles.admin_active_mode via useAuth(); liveMode/compMode
// are derived in the auth context.

export default function RecipientOnboarding() {
  const { liveMode, compMode } = useAuth();
  const location = useLocation();
  const params = useParams<{ pathSlug?: string; stepSlug?: string }>();

  const {
    data,
    currentStep,
    direction,
    state,
    updateData,
    goToStep,
    goBack,
    tryAdvance,
    getErrors,
  } = useRecipientFlowContext();

  // ── Step guard ─────────────────────────────────────────────

  const urlPath = pathSlugToPath(params.pathSlug ?? "");
  const stepSlug = params.stepSlug ?? "";

  // Bad path slug → bounce to picker
  if (!urlPath) {
    return <Navigate to="/onboarding" replace />;
  }

  // Slug doesn't belong to this path (e.g. /onboarding/full-label/preferences) → bounce to picker
  if (stepSlug && !isSlugValidForPath(stepSlug, urlPath)) {
    return <Navigate to="/onboarding" replace />;
  }

  // Trying to skip ahead → bounce to first incomplete step. Step 0 (path
  // picker) is implicitly complete whenever the URL carries a valid pathSlug,
  // so we always pass `[0, ...]` to the guard rather than racing the URL-sync
  // effect that adds 0 to data.completedSteps.
  const effectiveCompleted = data.completedSteps.includes(0)
    ? data.completedSteps
    : [0, ...data.completedSteps];
  if (stepSlug && !canAccessStep(currentStep, effectiveCompleted, urlPath)) {
    return <Navigate to={firstIncompleteUrl(effectiveCompleted, urlPath)} replace />;
  }

  // ── Progress bar ──────────────────────────────────────────

  const currentProgressIndex = stepToProgressIndex(currentStep);
  const completedProgressIndexes = data.completedSteps
    .map((s) => stepToProgressIndex(s))
    .filter((i): i is number => i !== undefined && i >= 0);

  function handleProgressClick(index: number) {
    const targetStep = progressIndexToStep(index, data.path);
    goToStep(targetStep);
  }

  // ── Render ────────────────────────────────────────────────

  const variants = getVariants(direction);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />

      <div className="container max-w-2xl mx-auto px-4 py-8">
        {/* Flow badge — visible once a path is chosen */}
        {data.path && currentStep !== 0 && (
          <div className="flex justify-center mb-5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary border border-primary/20 px-3 py-1 text-xs font-medium">
              {data.path === "full_label" ? (
                <><Package className="w-3 h-3" /> Full Prepaid Label</>
              ) : (
                <><Link2 className="w-3 h-3" /> Flexible Shipping Link</>
              )}
            </span>
          </div>
        )}

        {/* Progress bar (hidden on Step 0) */}
        {currentStep !== 0 && (
          <ProgressBar
            activeIndex={currentProgressIndex}
            completedIndexes={completedProgressIndexes}
            onClickIndex={handleProgressClick}
          />
        )}

        {/* Step content with animation */}
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.25 }}
          >
            {/* Step 1: Address + Email */}
            {currentStep === 1 && (
              <RecipientStepAddress
                address={state.destinationAddress}
                email={state.email}
                path={state.path}
                errors={getErrors(1)}
                tried={!!state.tried[1]}
                onAddressChange={(addr) => updateData({ destinationAddress: addr })}
                onEmailChange={(email) => updateData({ email })}
                onContinue={() => tryAdvance(1)}
                onBack={goBack}
              />
            )}

            {/* Step 10: Full Label — Shipment Details */}
            {currentStep === 10 && (
              <RecipientStepFullShipping
                state={state}
                errors={getErrors(10)}
                tried={!!state.tried[10]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(10)}
                onBack={goBack}
                liveMode={liveMode}
              />
            )}

            {/* Step 11: Full Label — Supabase OTP verify (proposal 2026-05-11_account-creation-timing) */}
            {currentStep === 11 && data.path === "full_label" && (
              <RecipientStepEmailVerifySupabase
                state={state}
                onUpdate={updateData}
                onContinue={() => tryAdvance(11)}
                onBack={goBack}
              />
            )}

            {/* Step 12/13: Payment + Label Ready */}
            {(currentStep === 12 || currentStep === 13) && data.path === "full_label" && (
              <RecipientStepPayment
                state={state}
                onUpdate={updateData}
                onBack={goBack}
                liveMode={liveMode}
                compMode={compMode}
              />
            )}

            {/* Step 20: Flex — Shipping Preferences */}
            {currentStep === 20 && (
              <RecipientStepFlexPreferences
                state={state}
                errors={getErrors(20)}
                tried={!!state.tried[20]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(20)}
                onBack={goBack}
              />
            )}

            {/* Step 21: Flex — Email Verification (Supabase Auth — proposal 2026-05-11_account-creation-timing) */}
            {currentStep === 21 && (
              <RecipientStepEmailVerifyFlex
                state={state}
                onUpdate={updateData}
                onContinue={() => tryAdvance(21)}
                onBack={goBack}
              />
            )}

            {/* Step 22: Flex — Payment Authorization */}
            {currentStep === 22 && (
              <RecipientStepFlexPayment
                state={state}
                onUpdate={updateData}
                onContinue={() => tryAdvance(22)}
                onBack={goBack}
              />
            )}

            {/* Step 23: Flex — Link Ready */}
            {currentStep === 23 && (
              <RecipientStepLinkReady
                state={state}
                onUpdate={updateData}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

    </div>
  );
}
