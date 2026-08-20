import { useLocation, useParams, Navigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Package, Link2, Undo2 } from "lucide-react";
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
  RETIRED_SLUG_REDIRECTS,
} from "@/lib/stepRouting";
import MorphProgressBar from "@/components/recipient/MorphProgressBar";
import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import RecipientStepOrigin from "@/components/recipient/RecipientStepOrigin";
import RecipientStepPackage from "@/components/recipient/RecipientStepPackage";
import RecipientStepShipping from "@/components/recipient/RecipientStepShipping";
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
    deferToSender,
    undoShippingLinkSwitch,
  } = useRecipientFlowContext();

  // ── Step guard ─────────────────────────────────────────────

  const urlPath = pathSlugToPath(params.pathSlug ?? "");
  const stepSlug = params.stepSlug ?? "";

  // Bad path slug → bounce to picker
  if (!urlPath) {
    return <Navigate to="/onboarding" replace />;
  }

  // Retired slugs (preferences / authorize / share) canonicalize to the live
  // slug that asks the same question — every URL that ever circulated keeps
  // resolving (decided 2026-08-17 OQ2). `replace` so Back doesn't replay it.
  if (stepSlug && RETIRED_SLUG_REDIRECTS[stepSlug]) {
    return <Navigate to={`/onboarding/${params.pathSlug}/${RETIRED_SLUG_REDIRECTS[stepSlug]}`} replace />;
  }

  // Unknown slug → bounce to picker
  if (stepSlug && !isSlugValidForPath(stepSlug, urlPath)) {
    return <Navigate to="/onboarding" replace />;
  }

  // Trying to skip ahead → bounce to first incomplete step. (Step 0 is gone
  // from the step arrays as of 2026-08-18, so completedSteps is passed as-is —
  // the old `[0, ...]` splice guarded a picker that no longer exists.)
  //
  // If this bounce fires unexpectedly (user reports being "stuck" on a step
  // despite the server confirming the step's action succeeded), audit any
  // place `navigate(...)` is paired with `setData(...)` for completedSteps —
  // navigate is synchronous (history.pushState) but setData is queued, so the
  // URL flips before completedSteps commits and this guard sees inconsistent
  // state. Fix: wrap the setData in `flushSync` before `navigate`. See LOG.md
  // → 2026-05-19 "navigate vs setData race" + PLAYBOOK Rule 20.
  if (stepSlug && !canAccessStep(currentStep, data.completedSteps, urlPath)) {
    return <Navigate to={firstIncompleteUrl(data.completedSteps, urlPath)} replace />;
  }

  // ── Progress bar ──────────────────────────────────────────

  const currentProgressIndex = stepToProgressIndex(currentStep);
  // One step map (2026-08-19): every completed step lights its own fixed
  // segment — the per-path filtering that guarded against cross-path index
  // collisions is gone because there are no longer two step sets to collide.
  const completedProgressIndexes = data.completedSteps
    .map((s) => stepToProgressIndex(s))
    .filter((i): i is number => i !== undefined && i >= 0);
  // A skip turns its segment's state in place — the morph (brief point 2).
  const skippedProgressIndexes = [
    ...(data.deferredDestination ? [0] : []),
    ...(data.deferredOrigin ? [1] : []),
    ...(data.deferredPackage ? [2] : []),
  ];

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
              {/* Names describe what was made, not a product the user had to
                  pick: a finished artifact vs a promise filled in later. */}
              {data.path === "full_label" ? (
                <><Package className="w-3 h-3" /> Prepaid label</>
              ) : (
                <><Link2 className="w-3 h-3" /> Shipping link</>
              )}
            </span>
          </div>
        )}

        {/* Progress bar (hidden on Step 0) */}
        {currentStep !== 0 && (
          <MorphProgressBar
            activeIndex={currentProgressIndex}
            completedIndexes={completedProgressIndexes}
            skippedIndexes={skippedProgressIndexes}
            onClickIndex={handleProgressClick}
          />
        )}

        {/* Undo for the address escape. Flow-level affordance: it reverses the
            branch decision itself, and the typed origin address is still in
            flow state, so coming back restores it. */}
        {/* Mirrors the escape's own condition (`!isSelfSender` in
            RecipientStepOrigin / RecipientStepPackage). Gating this on === "other" while the
            escape is offered to null-sender users too — existing deep links,
            and sessions persisted before this shipped — let those users convert
            to a shipping link with no rendered way back. */}
        {/* The moment anything is deferred the product changed — say so NOW,
            not at the end (unified-onboarding proposal, John's point 3). Same
            banner on step 14 (after deferring the origin) and step 20. Undo
            reverses the deferral itself (flags + location). */}
        {[10, 14, 20].includes(currentStep) &&
          (data.deferredDestination || data.deferredOrigin || data.deferredPackage) && (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-muted px-4 py-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">This will be a shipping link, not a label.</span>{" "}
              The sender fills in what you skipped and prints the label — you pay when they use it.
            </p>
            <button
              type="button"
              onClick={undoShippingLinkSwitch}
              className="shrink-0 inline-flex items-center gap-1.5 text-sm font-medium text-primary rounded-lg px-2 py-1 transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
              Undo skip
            </button>
          </div>
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
                sender={data.sender}
                errors={getErrors(1)}
                tried={!!state.tried[1]}
                onAddressChange={(addr) => updateData({ destinationAddress: addr })}
                onEmailChange={(email) => updateData({ email })}
                onSenderResolved={(sender) => updateData({ sender })}
                deferredDestination={data.deferredDestination}
                // Deferring the destination is an identity claim like every
                // other defer: someone else is the sender. It does NOT
                // auto-advance — email verification below is not deferrable.
                onDeferDestination={() => updateData({ deferredDestination: true, sender: data.sender ?? "other" })}
                onUndoDeferDestination={() => updateData({ deferredDestination: false })}
                onContinue={() => tryAdvance(1)}
              />
            )}

            {/* Step 10 (origin): the ship-from address. */}
            {currentStep === 10 && (
              <RecipientStepOrigin
                state={state}
                sender={data.sender}
                errors={getErrors(10)}
                tried={!!state.tried[10]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(10)}
                onBack={goBack}
                onNoAddress={() => deferToSender("origin")}
              />
            )}

            {/* Step 14 (package): the parcel. Carrier choice moved to step 20
                when the maps unified (2026-08-19). */}
            {currentStep === 14 && (
              <RecipientStepPackage
                state={state}
                sender={data.sender}
                errors={getErrors(14)}
                tried={!!state.tried[14]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(14)}
                onBack={goBack}
                onNoAddress={() => deferToSender("package")}
              />
            )}

            {/* Step 20 (shipping) — one step, two modes (§2.2): rate cards
                when everything is known; speed + carrier preference + cap
                when anything was skipped. data.path carries the mode — the
                URL segment rewrites on the first skip / last undo. */}
            {currentStep === 20 && (data.path === "flexible" ? (
              <RecipientStepFlexPreferences
                state={state}
                errors={getErrors(20)}
                tried={!!state.tried[20]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(20)}
                onBack={goBack}
              />
            ) : (
              <RecipientStepShipping
                state={state}
                errors={getErrors(20)}
                tried={!!state.tried[20]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(20)}
                onBack={goBack}
                liveMode={liveMode}
              />
            ))}

            {/* Step 11 (verify — the Contact step): Supabase OTP, one step for
                both paths since the maps unified; the components differ only
                in copy and stay per-path until PR 2 consolidates them. */}
            {currentStep === 11 && (data.path === "flexible" ? (
              <RecipientStepEmailVerifyFlex
                state={state}
                onUpdate={updateData}
                onContinue={() => tryAdvance(11)}
                onBack={goBack}
              />
            ) : (
              <RecipientStepEmailVerifySupabase
                state={state}
                onUpdate={updateData}
                onContinue={() => tryAdvance(11)}
                onBack={goBack}
              />
            ))}

            {/* Steps 12/13 (payment / done), label path: RecipientStepPayment
                internally owns both — charge, then label-ready. */}
            {(currentStep === 12 || currentStep === 13) && data.path !== "flexible" && (
              <RecipientStepPayment
                state={state}
                onUpdate={updateData}
                onBack={goBack}
                liveMode={liveMode}
                compMode={compMode}
              />
            )}

            {/* Step 12 (payment), link path: save the card (Pattern D). */}
            {currentStep === 12 && data.path === "flexible" && (
              <RecipientStepFlexPayment
                state={state}
                onUpdate={updateData}
                onContinue={() => tryAdvance(12)}
                onBack={goBack}
                onEditDestination={() => goToStep(1)}
                onEditShipping={() => goToStep(20)}
              />
            )}

            {/* Step 13 (done), link path: the link, ready to share. */}
            {currentStep === 13 && data.path === "flexible" && (
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
