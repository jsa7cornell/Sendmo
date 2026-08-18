import { createContext, useContext, useCallback, useEffect, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { RecipientPath, SenderKind } from "@/lib/types";
import {
  INITIAL_DATA,
  loadPersisted,
  persist,
  prefillSlotFor,
  type RecipientFlowData,
} from "@/lib/recipientFlowStorage";
import {
  pathSlugToPath,
  slugToStep,
  stepUrl,
  nextStep,
  prevStep,
  canAccessStep,
  stepIndex,
} from "@/lib/stepRouting";
import { getValidationErrors, type RecipientFlowState } from "@/hooks/useRecipientFlow";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";

// ─── Navigation direction for animation ─────────────────────

export type NavDirection = "forward" | "backward";

// ─── Context Value ──────────────────────────────────────────

interface RecipientFlowContextValue {
  data: RecipientFlowData;
  currentStep: number; // derived from URL
  direction: NavDirection;
  updateData: (partial: Partial<RecipientFlowData>) => void;
  tryAdvance: (step: number) => boolean;
  goBack: () => void;
  goToStep: (step: number) => void;
  selectPath: (path: RecipientPath) => void;
  switchToShippingLink: () => void;
  undoShippingLinkSwitch: () => void;
  markStepComplete: (step: number) => void;
  getErrors: (step: number) => string[];
  state: RecipientFlowState;
}

const RecipientFlowContext = createContext<RecipientFlowContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────

export function RecipientFlowProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  // Step 0's answer travels two ways: sessionStorage (survives the OAuth
  // roundtrip and refreshes) and React Router state (survives a sessionStorage
  // write that silently failed — private-mode, disabled storage, quota).
  // `persist` swallows write errors by design, so without this backstop a user
  // who answered "I am" could arrive with sender=null, be treated as 'other',
  // and get their OWN address prefilled into the destination slot — the exact
  // wrong-party bug the sender split exists to prevent.
  const navSender = (location.state as { sender?: SenderKind } | null)?.sender ?? null;
  const [data, setData] = useState<RecipientFlowData>(() => {
    const base = loadPersisted() ?? INITIAL_DATA;
    return base.sender ? base : { ...base, sender: navSender };
  });
  const navigate = useNavigate();
  const params = useParams<{ pathSlug?: string; stepSlug?: string }>();
  const directionRef = useRef<NavDirection>("forward");
  const { user } = useAuth();

  // URL is the source of truth for path + step
  const urlPath = pathSlugToPath(params.pathSlug ?? "");
  const currentStep = slugToStep(urlPath, params.stepSlug);

  // Mirror data → sessionStorage so the OAuth roundtrip in the verify step
  // doesn't blow away the user's destination, rate selection, etc.
  useEffect(() => {
    persist(data);
  }, [data]);

  // If the user is already authenticated with a session whose email matches
  // the typed destination email, the verify step is redundant — the session
  // IS the verification. Mark email_verified=true so the step-11 validation
  // passes and the user goes straight from shipping → payment. Handles
  // (a) Google CTA at step 1 and (b) returning users with a live session.
  useEffect(() => {
    if (!user?.email) return;
    if (data.email_verified) return;
    if (!data.email) return;
    if (user.email.toLowerCase() !== data.email.toLowerCase()) return;
    setData((prev) => ({
      ...prev,
      email_verified: true,
      verification_email: prev.verification_email || prev.email,
    }));
  }, [user?.email, data.email, data.email_verified]);

  // Sync data.path from URL — also marks step 0 complete since the path
  // picker is implicit in the URL.
  useEffect(() => {
    if (!urlPath) return;
    if (data.path === urlPath) return;
    setData((prev) => ({
      ...prev,
      path: urlPath,
      completedSteps: prev.completedSteps.includes(0) ? prev.completedSteps : [...prev.completedSteps, 0],
    }));
  }, [urlPath, data.path]);

  // Auth-aware prefill: when an authenticated user lands here without an
  // address yet, fetch their most recent saved address + profile and prefill.
  //
  // WHICH SLOT the saved address fills depends on step 0's answer, because the
  // account holder is a different party in each branch:
  //   sender='other' (or unknown) → they RECEIVE  → prefill destinationAddress
  //   sender='self'               → they SHIP OUT → prefill originAddress
  // Filling destination unconditionally would pre-populate the user's own
  // address as "where the package is going" on the 'self' branch — pre-verified
  // and green, so a user who doesn't overwrite it ships to themselves. Same
  // class as the 2026-08-16 stale-autofill incident: data that was correct in
  // its original role, silently landing in the inverted role.
  const prefillRan = useRef(false);
  useEffect(() => {
    if (prefillRan.current) return;
    if (!user) return;
    // No "wait for step 0" guard here on purpose: `sender` is seeded
    // synchronously at mount from sessionStorage or router state, so by the time
    // this runs it is either known or genuinely absent. Absent means a deep link
    // that never passed step 0, and prefillSlotFor's documented fallback for
    // that case ('destination') is the correct, pre-existing shape.
    const fillsOrigin = prefillSlotFor(data.sender) === "origin";
    const targetTouched = fillsOrigin
      ? data.originAddress.street
      : data.destinationAddress.street;
    if (targetTouched || data.email) return;
    prefillRan.current = true;

    let cancelled = false;
    (async () => {
      const [{ data: profile }, { data: recentAddr }] = await Promise.all([
        supabase.from("profiles").select("email, full_name, phone").eq("id", user.id).single(),
        supabase
          .from("addresses")
          .select("name, street1, street2, city, state, zip, phone, is_verified")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      const recentComplete =
        recentAddr && !!recentAddr.street1 && !!recentAddr.city && !!recentAddr.state && !!recentAddr.zip;

      setData((prev) => {
        // Bail out if the user has typed anything in the meantime
        const prevTarget = fillsOrigin ? prev.originAddress : prev.destinationAddress;
        if (prevTarget.street || prev.email) return prev;

        const filled = recentComplete
          ? {
              name: recentAddr.name || profile?.full_name || "",
              street: recentAddr.street1!,
              city: recentAddr.city!,
              state: recentAddr.state!,
              zip: recentAddr.zip!,
              phone: recentAddr.phone || profile?.phone || "",
              verified: !!recentAddr.is_verified,
            }
          : profile?.full_name
          ? { ...prevTarget, name: profile.full_name }
          : prevTarget;

        return {
          ...prev,
          // Only the slot the account holder actually owns in this branch.
          ...(fillsOrigin ? { originAddress: filled } : { destinationAddress: filled }),
          email: profile?.email ?? user.email ?? prev.email,
        };
      });
    })();
    return () => { cancelled = true; };
  }, [user, data.sender, data.destinationAddress.street, data.originAddress.street, data.email]);

  // Backward-compat state object (step components still expect currentStep on it)
  const state: RecipientFlowState = { ...data, currentStep };

  const updateData = useCallback((partial: Partial<RecipientFlowData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  const tryAdvance = useCallback((step: number): boolean => {
    const errors = getValidationErrors({ ...data, currentStep: step }, step);
    if (errors.length > 0) {
      setData((prev) => ({
        ...prev,
        tried: { ...prev.tried, [step]: true },
      }));
      return false;
    }

    let next = nextStep(step, data.path);
    // Skip verify steps when email is already confirmed (Google OAuth session).
    // Without these jumps the verify screen flashes for ~1s before its own
    // auto-advance fires; skipping is the same outcome with no flicker.
    if (next === 11 && data.email_verified && data.path === "full_label") {
      next = nextStep(11, data.path);
    }
    if (next === 21 && data.email_verified && data.path === "flexible") {
      next = nextStep(21, data.path);
    }
    if (next !== null) {
      // flushSync forces React to commit the completedSteps update BEFORE we
      // navigate. Without this, navigate() updates the URL synchronously while
      // setData is still queued — the page-level guard at RecipientOnboarding
      // reads the OLD completedSteps against the NEW URL's step and bounces
      // the user back to firstIncompleteUrl. Notably visible on the flex
      // /authorize → /share advance when the server auto-detected an existing
      // PM and the auto-skip path fires (FlexPaymentStep first-effect).
      flushSync(() => {
        setData((prev) => ({
          ...prev,
          completedSteps: prev.completedSteps.includes(step)
            ? (next === 12 && !prev.completedSteps.includes(11)
                ? [...prev.completedSteps, 11]
                : next === 22 && !prev.completedSteps.includes(21)
                  ? [...prev.completedSteps, 21]
                  : prev.completedSteps)
            : (next === 12
                ? [...prev.completedSteps, step, 11]
                : next === 22
                  ? [...prev.completedSteps, step, 21]
                  : [...prev.completedSteps, step]),
        }));
      });
      directionRef.current = "forward";
      navigate(stepUrl(data.path, next));
    }
    return true;
  }, [data, navigate]);

  const goBack = useCallback(() => {
    directionRef.current = "backward";
    let prev = prevStep(currentStep, data.path);
    // Skip the verify step on the way back when the email is already
    // confirmed — symmetric with the forward skip in tryAdvance. Landing on
    // the verify screen would just show its "Email verified" state and
    // auto-advance the user straight back here, making Back a dead-end.
    if (prev === 21 && data.email_verified && data.path === "flexible") {
      prev = prevStep(21, data.path);
    }
    if (prev === 11 && data.email_verified && data.path === "full_label") {
      prev = prevStep(11, data.path);
    }
    if (prev !== null) {
      navigate(stepUrl(data.path, prev));
    } else {
      navigate("/onboarding");
    }
  }, [navigate, currentStep, data.path, data.email_verified]);

  const goToStep = useCallback((step: number) => {
    if (!canAccessStep(step, data.completedSteps, data.path) && step !== currentStep) return;
    const targetIdx = stepIndex(step, data.path);
    const currentIdx = stepIndex(currentStep, data.path);
    directionRef.current = targetIdx < currentIdx ? "backward" : "forward";
    navigate(stepUrl(data.path, step));
  }, [data.completedSteps, data.path, currentStep, navigate]);

  const selectPath = useCallback((path: RecipientPath) => {
    setData((prev) => ({
      ...prev,
      path,
      completedSteps: prev.completedSteps.includes(0) ? prev.completedSteps : [...prev.completedSteps, 0],
    }));
    directionRef.current = "forward";
    navigate(stepUrl(path, 1));
  }, [navigate]);

  // ── The address escape ────────────────────────────────────
  //
  // "I don't have their address" is the ONLY place a flow changes product
  // mid-session. Both branches start on full_label; this moves the user to the
  // shipping-link (flexible) path, where the other party fills in the origin.
  //
  // Steps 0 and 1 are shared by both paths and are already complete here, so
  // canAccessStep(20, …, 'flexible') passes without touching completedSteps.
  // originAddress is deliberately NOT cleared — undo restores what was typed.
  //
  // Navigate ONLY — do not pre-set data.path here.
  //
  // The 2026-05-19 flushSync pattern exists for updates the page guard reads
  // (completedSteps). This transition changes neither: steps 0 and 1 are
  // already complete and are shared by both paths, so canAccessStep(20, [0,1],
  // 'flexible') passes on the very first render after the URL flips.
  //
  // `data.path` is DERIVED from the URL by the sync effect above, so setting it
  // here as well would only add a redundant write plus one render where
  // data.path and the URL disagree. Let the URL stay the single source of truth
  // for path, exactly as it is for every other entry into a path.
  const switchToShippingLink = useCallback(() => {
    directionRef.current = "forward";
    navigate(stepUrl("flexible", 20));
  }, [navigate]);

  const undoShippingLinkSwitch = useCallback(() => {
    directionRef.current = "backward";
    navigate(stepUrl("full_label", 10));
  }, [navigate]);

  const markStepComplete = useCallback((step: number) => {
    setData((prev) => ({
      ...prev,
      completedSteps: prev.completedSteps.includes(step) ? prev.completedSteps : [...prev.completedSteps, step],
    }));
  }, []);

  const getErrors = useCallback((step: number) => {
    return getValidationErrors({ ...data, currentStep: step }, step);
  }, [data]);

  return (
    <RecipientFlowContext.Provider
      value={{
        data,
        currentStep,
        direction: directionRef.current,
        updateData,
        tryAdvance,
        goBack,
        goToStep,
        selectPath,
        switchToShippingLink,
        undoShippingLinkSwitch,
        markStepComplete,
        getErrors,
        state,
      }}
    >
      {children}
    </RecipientFlowContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────

export function useRecipientFlowContext() {
  const ctx = useContext(RecipientFlowContext);
  if (!ctx) throw new Error("useRecipientFlowContext must be used within RecipientFlowProvider");
  return ctx;
}
