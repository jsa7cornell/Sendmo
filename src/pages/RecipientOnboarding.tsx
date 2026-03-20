import { useState } from "react";
import { useLocation, Navigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { isAdminSession } from "@/pages/Admin";
import { useRecipientFlowContext } from "@/contexts/RecipientFlowContext";
import {
  stepToProgressIndex,
  progressIndexToStep,
  canAccessStep,
  firstIncompleteSlug,
  isSlugValidForPath,
} from "@/lib/stepRouting";
import ProgressBar from "@/components/recipient/ProgressBar";
import RecipientStepPathChoice from "@/components/recipient/RecipientStepPathChoice";
import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import RecipientStepFullShipping from "@/components/recipient/RecipientStepFullShipping";
import RecipientStepPayment from "@/components/recipient/RecipientStepPayment";
import RecipientStepFlexPreferences from "@/components/recipient/RecipientStepFlexPreferences";
import RecipientStepEmailVerify from "@/components/recipient/RecipientStepEmailVerify";
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

// ─── Admin Toolbar ──────────────────────────────────────────

type AdminMode = "test" | "live_comp";

function AdminToolbar({ mode, onModeChange }: { mode: AdminMode; onModeChange: (m: AdminMode) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 bg-card border border-border rounded-xl shadow-lg px-3 py-2 flex items-center gap-2 text-xs">
      <span className="font-medium text-muted-foreground">Mode:</span>
      {(["test", "live_comp"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onModeChange(m)}
          className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
            mode === m
              ? m === "live_comp" ? "bg-destructive/10 text-destructive border border-destructive/30" : "bg-primary/10 text-primary border border-primary/30"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {m === "test" ? "Test" : "Live Comp"}
        </button>
      ))}
    </div>
  );
}

// ─── Layout Component ───────────────────────────────────────

export default function RecipientOnboarding() {
  const isAdmin = isAdminSession();
  const [adminMode, setAdminMode] = useState<AdminMode>("test");
  const liveMode = isAdmin && adminMode === "live_comp";
  const location = useLocation();

  const {
    data,
    currentStep,
    direction,
    state,
    updateData,
    goToStep,
    goBack,
    tryAdvance,
    selectPath,
    getErrors,
  } = useRecipientFlowContext();

  // ── Step guard: redirect if step is not accessible ────────

  // Extract slug from pathname
  const pathParts = location.pathname.split("/").filter(Boolean);
  const slug = pathParts.length > 1 ? pathParts[1] : null; // "address", "shipping", etc.

  if (slug) {
    // Validate slug is valid for the selected path
    if (!isSlugValidForPath(slug, data.path)) {
      const redirect = firstIncompleteSlug(data.completedSteps, data.path);
      return <Navigate to={redirect ? `/onboarding/${redirect}` : "/onboarding"} replace />;
    }

    // Validate step is accessible (all prior steps completed)
    if (!canAccessStep(currentStep, data.completedSteps, data.path)) {
      const redirect = firstIncompleteSlug(data.completedSteps, data.path);
      return <Navigate to={redirect ? `/onboarding/${redirect}` : "/onboarding"} replace />;
    }
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
      <div className="container max-w-2xl mx-auto px-4 py-8">
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
            {/* Step 0: Path Choice */}
            {currentStep === 0 && (
              <RecipientStepPathChoice onSelect={selectPath} />
            )}

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

            {/* Step 11/12: Payment + Label Ready */}
            {(currentStep === 11 || currentStep === 12) && (
              <RecipientStepPayment
                state={state}
                onUpdate={updateData}
                onBack={goBack}
                liveMode={liveMode}
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

            {/* Step 21: Flex — Email Verification */}
            {currentStep === 21 && (
              <RecipientStepEmailVerify
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

      {/* Admin toolbar — only visible after PIN auth via /admin */}
      {isAdmin && <AdminToolbar mode={adminMode} onModeChange={setAdminMode} />}
    </div>
  );
}
