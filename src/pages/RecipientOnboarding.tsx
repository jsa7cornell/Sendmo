import { useLocation, useParams, Navigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import { useRecipientFlowContext } from "@/contexts/RecipientFlowContext";
import AppHeader from "@/components/AppHeader";
import {
  canAccessStep,
  firstIncompleteUrl,
  isSlugValidForPath,
  pathSlugToPath,
  RETIRED_SLUG_REDIRECTS,
} from "@/lib/stepRouting";
import RecipientStepAddress from "@/components/recipient/RecipientStepAddress";
import RecipientStepOrigin from "@/components/recipient/RecipientStepOrigin";
import RecipientStepPackage from "@/components/recipient/RecipientStepPackage";
import RecipientStepShipping from "@/components/recipient/RecipientStepShipping";
import RecipientStepPayment from "@/components/recipient/RecipientStepPayment";
import RecipientStepFlexPreferences from "@/components/recipient/RecipientStepFlexPreferences";
import RecipientStepContact from "@/components/recipient/RecipientStepContact";
import RecipientStepFlexPayment from "@/components/recipient/RecipientStepFlexPayment";
import RecipientStepLinkReady from "@/components/recipient/RecipientStepLinkReady";

// ─── Animation variants ─────────────────────────────────────

function getVariants(direction: "forward" | "backward") {
  return {
    initial: { opacity: 0, x: direction === "forward" ? 20 : -20 },
    animate: { opacity: 1, x: 0, pointerEvents: "auto" as const },
    // `pointerEvents: none` while leaving is load-bearing, not polish.
    // AnimatePresence runs mode="wait", so for the ~250ms after the URL flips
    // the OUTGOING step is the only thing mounted — and it stays clickable.
    // Since 2026-08-22 all three question steps carry a control with the same
    // accessible name ("Sender will fill this in"), so a fast click during
    // that window fires the PREVIOUS step's skip: on the origin step it read
    // as "skipping the origin did nothing", when it had actually re-skipped
    // the destination and bounced the flow back to origin.
    //
    // Pinned by skip-to-sender.spec, "skipping the origin right after arriving
    // does not re-skip the destination", which fails without this line. It
    // reaches the origin step the SLOW way (filling the destination), which is
    // what reproduces the race — a two-skip minimal repro passes either way,
    // because Playwright's click actionability check waits the transition out.
    // progress-bar.spec was the accidental guard until the bar was deleted
    // with the rest of the progress UI (2026-08-23).
    exit: { opacity: 0, x: direction === "forward" ? -20 : 20, pointerEvents: "none" as const },
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
    keepIt,
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

  // ── Render ────────────────────────────────────────────────

  const variants = getVariants(direction);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />

      <div className="container max-w-2xl mx-auto px-4 py-8">
        {/* No progress bar, no path chip, no skip banner (2026-08-23).
            Three devices all narrating position; none of them said what the
            user had actually decided. The Shipment Details card on the payment
            step says that instead — once, where it is the thing being
            confirmed. See ShipmentDetails.tsx. */}

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
            {/* Step 1: destination address */}
            {currentStep === 1 && (
              <RecipientStepAddress
                address={state.destinationAddress}
                sender={data.sender}
                errors={getErrors(1)}
                tried={!!state.tried[1]}
                onAddressChange={(addr) => updateData({ destinationAddress: addr })}
                deferredDestination={data.deferredDestination}
                onDeferDestination={() => deferToSender("destination")}
                onUndoDeferDestination={() => keepIt("destination")}
                onContinue={() => tryAdvance(1)}
              />
            )}

            {/* Step 10 (origin): the ship-from address. */}
            {currentStep === 10 && (
              <RecipientStepOrigin
                state={state}
                errors={getErrors(10)}
                tried={!!state.tried[10]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(10)}
                onBack={goBack}
                onNoAddress={() => deferToSender("origin")}
                onKeepIt={() => keepIt("origin")}
              />
            )}

            {/* Step 14 (package): the parcel. Carrier choice moved to step 20
                when the maps unified (2026-08-19). */}
            {currentStep === 14 && (
              <RecipientStepPackage
                state={state}
                errors={getErrors(14)}
                tried={!!state.tried[14]}
                onUpdate={updateData}
                onContinue={() => tryAdvance(14)}
                onBack={goBack}
                onNoAddress={() => deferToSender("package")}
                onKeepIt={() => keepIt("package")}
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

            {/* Step 11 (the Contact step): collect the creator's email and
                confirm it. One component for both paths — only the magic-link
                redirect target differs, which it derives from state.path. */}
            {currentStep === 11 && (
              <RecipientStepContact
                state={state}
                onUpdate={updateData}
                onContinue={() => tryAdvance(11)}
                onBack={goBack}
              />
            )}

            {/* Steps 12/13 (payment / done), label path: RecipientStepPayment
                internally owns both — charge, then label-ready. */}
            {(currentStep === 12 || currentStep === 13) && data.path !== "flexible" && (
              <RecipientStepPayment
                state={state}
                onUpdate={updateData}
                onBack={goBack}
                onEditStep={goToStep}
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
                onEditShipping={() => goToStep(20)}
                onEditStep={goToStep}
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
