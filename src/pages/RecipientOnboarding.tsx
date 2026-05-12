import { useState } from "react";
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

// Per Stripe proposal §6 Phase C (decided 2026-05-11), three modes:
//   - test       → EasyPost test API, Stripe test mode. Free fake label.
//   - live_comp  → EasyPost LIVE API, NO Stripe charge. Real label, comped
//                  to SendMo. For dogfood / friends-and-family / marketing.
//   - live_charge → EasyPost LIVE API, real Stripe charge. Dogfood real
//                  payment flow end-to-end (Phase C self-charge).
// Note: prior to 2026-05-11, "live_comp" mistakenly charged the card —
// the rename + comp button below brings code in line with PLAYBOOK's
// long-standing documented semantics.
type AdminMode = "test" | "live_comp" | "live_charge";

function AdminToolbar({ mode, onModeChange }: { mode: AdminMode; onModeChange: (m: AdminMode) => void }) {
  const labels: Record<AdminMode, string> = {
    test: "Test",
    live_comp: "Live Comp",
    live_charge: "Live Charge",
  };
  const styles: Record<AdminMode, { active: string }> = {
    test: { active: "bg-primary/10 text-primary border border-primary/30" },
    live_comp: { active: "bg-amber-100 text-amber-800 border border-amber-300" },
    live_charge: { active: "bg-destructive/10 text-destructive border border-destructive/30" },
  };
  return (
    <div className="fixed bottom-4 right-4 z-50 bg-card border border-border rounded-xl shadow-lg px-3 py-2 flex items-center gap-2 text-xs">
      <span className="font-medium text-muted-foreground">Mode:</span>
      {(["test", "live_comp", "live_charge"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onModeChange(m)}
          className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
            mode === m ? styles[m].active : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}

// ─── Layout Component ───────────────────────────────────────

export default function RecipientOnboarding() {
  const { isAdmin } = useAuth();
  const [adminMode, setAdminMode] = useState<AdminMode>("test");
  // liveMode = use EasyPost LIVE API (both comp and charge variants).
  // compMode = bypass Stripe entirely, use the labels function's `comp:true`
  //   path with an admin JWT. Only meaningful when liveMode is true.
  const liveMode = isAdmin && (adminMode === "live_comp" || adminMode === "live_charge");
  const compMode = isAdmin && adminMode === "live_comp";
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

            {/* Step 11/12: Payment + Label Ready */}
            {(currentStep === 11 || currentStep === 12) && (
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
