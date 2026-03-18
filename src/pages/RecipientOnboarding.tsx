import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useRecipientFlow } from "@/hooks/useRecipientFlow";
import { isAdminSession } from "@/pages/Admin";
import ProgressBar from "@/components/recipient/ProgressBar";
import RecipientStepPathChoice from "@/components/recipient/RecipientStepPathChoice";
import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import RecipientStepFullShipping from "@/components/recipient/RecipientStepFullShipping";
import RecipientStepPayment from "@/components/recipient/RecipientStepPayment";

// ─── Animation variants ─────────────────────────────────────

const stepVariants = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
};

// ─── Progress index mapping ─────────────────────────────────

const STEP_TO_PROGRESS: Record<number, number> = {
  0: -1, // no progress bar on step 0
  1: 0,
  10: 1,
  11: 2,
  12: 3,
};

function progressIndexToStep(index: number, path: string | null): number {
  if (path === "full_label") {
    return [1, 10, 11, 12][index] ?? 1;
  }
  return [1, 10, 11, 12][index] ?? 1;
}

// ─── Page Component ─────────────────────────────────────────

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

export default function RecipientOnboarding() {
  const isAdmin = isAdminSession();
  const [adminMode, setAdminMode] = useState<AdminMode>("test");
  const liveMode = isAdmin && adminMode === "live_comp";

  const {
    state,
    updateState,
    goToStep,
    goBack,
    tryAdvance,
    selectPath,
    getErrors,
  } = useRecipientFlow();

  const currentProgressIndex = STEP_TO_PROGRESS[state.currentStep] ?? -1;
  const completedProgressIndexes = state.completedSteps
    .map((s) => STEP_TO_PROGRESS[s])
    .filter((i): i is number => i !== undefined && i >= 0);

  function handleProgressClick(index: number) {
    const targetStep = progressIndexToStep(index, state.path);
    goToStep(targetStep);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <div className="container max-w-2xl mx-auto px-4 py-8">
        {/* Progress bar (hidden on Step 0) */}
        {state.currentStep !== 0 && (
          <ProgressBar
            activeIndex={currentProgressIndex}
            completedIndexes={completedProgressIndexes}
            onClickIndex={handleProgressClick}
          />
        )}

        {/* Step content with animation */}
        <AnimatePresence mode="wait">
          <motion.div
            key={state.currentStep}
            variants={stepVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: 0.25 }}
          >
            {/* Step 0: Path Choice */}
            {state.currentStep === 0 && (
              <RecipientStepPathChoice onSelect={selectPath} />
            )}

            {/* Step 1: Address + Email */}
            {state.currentStep === 1 && (
              <RecipientStepAddress
                address={state.destinationAddress}
                email={state.email}
                path={state.path}
                errors={getErrors(1)}
                tried={!!state.tried[1]}
                onAddressChange={(addr) => updateState({ destinationAddress: addr })}
                onEmailChange={(email) => updateState({ email })}
                onContinue={() => tryAdvance(1)}
                onBack={goBack}
              />
            )}

            {/* Step 10: Full Label — Shipment Details */}
            {state.currentStep === 10 && (
              <RecipientStepFullShipping
                state={state}
                errors={getErrors(10)}
                tried={!!state.tried[10]}
                onUpdate={updateState}
                onContinue={() => tryAdvance(10)}
                onBack={goBack}
                liveMode={liveMode}
              />
            )}

            {/* Step 11/12: Payment + Label Ready */}
            {(state.currentStep === 11 || state.currentStep === 12) && (
              <RecipientStepPayment
                state={state}
                onUpdate={updateState}
                onBack={goBack}
                liveMode={liveMode}
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
