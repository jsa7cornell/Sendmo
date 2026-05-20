import { createContext, useContext, useCallback, useEffect, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import type {
  AddressInput,
  DistanceTier,
  PackagingType,
  RecipientPath,
  ShippingRate,
  SpeedTier,
  LabelResult,
} from "@/lib/types";
import { emptyAddress } from "@/lib/utils";
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

// ─── State Shape ────────────────────────────────────────────

export interface RecipientFlowData {
  path: RecipientPath | null;
  completedSteps: number[];

  // Step 1
  destinationAddress: AddressInput;
  email: string;

  // Step 10
  originAddress: AddressInput;
  senderEmail: string;
  itemDescription: string;
  packagingType: PackagingType;
  dimensions: { length: string; width: string; height: string };
  weight: { lbs: string; oz: string };
  selectedRate: ShippingRate | null;
  availableRates: ShippingRate[];
  easypostShipmentId: string;
  insurance: boolean;
  recommendedSpeedHint: SpeedTier | null;

  // Step 11-12
  paymentStatus: "idle" | "processing" | "authorized" | "succeeded" | "failed";
  labelResult: LabelResult | null;

  // Step 20-23 (Flexible Link path)
  distance_hint: DistanceTier;
  size_hint: "envelope" | "smallbox" | "largebox" | null;
  speed_preference: SpeedTier;
  preferred_carrier: string;
  price_cap: number;
  verification_email: string;
  email_verified: boolean;
  short_code: string;
  // Phase E: populated together with short_code when the flex link is created at step 22
  linkId: string;

  // Validation
  tried: Record<number, boolean>;
}

const INITIAL_DATA: RecipientFlowData = {
  path: null,
  completedSteps: [],

  destinationAddress: emptyAddress(),
  email: "",

  originAddress: emptyAddress(),
  senderEmail: "",
  itemDescription: "",
  packagingType: "box",
  dimensions: { length: "", width: "", height: "" },
  weight: { lbs: "", oz: "" },
  selectedRate: null,
  availableRates: [],
  easypostShipmentId: "",
  insurance: false,
  recommendedSpeedHint: null,

  paymentStatus: "idle",
  labelResult: null,

  distance_hint: "regional",
  size_hint: null,
  speed_preference: "standard",
  preferred_carrier: "any",
  price_cap: 100,
  verification_email: "",
  email_verified: false,
  short_code: "",
  linkId: "",

  tried: {},
};

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
  markStepComplete: (step: number) => void;
  getErrors: (step: number) => string[];
  state: RecipientFlowState;
}

const RecipientFlowContext = createContext<RecipientFlowContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────

// SessionStorage-backed flow data so the Google OAuth roundtrip in
// RecipientStepEmailVerifySupabase preserves user-entered destination, email,
// shipping selection, etc. across the redirect to accounts.google.com and back.
// Cleared when the user finishes (label step) or starts a new path.
const STORAGE_KEY = "sendmo:recipient_flow:v1";

function loadPersisted(): RecipientFlowData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RecipientFlowData>;
    return { ...INITIAL_DATA, ...parsed };
  } catch {
    return null;
  }
}

function persist(data: RecipientFlowData): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* sessionStorage full / disabled — best-effort, tolerate */
  }
}

export function RecipientFlowProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<RecipientFlowData>(() => loadPersisted() ?? INITIAL_DATA);
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

  // Auth-aware prefill: when an authenticated user lands here without a
  // destination address yet, fetch their most recent saved address + profile
  // and prefill destination + email. Skip if they've already typed something.
  const prefillRan = useRef(false);
  useEffect(() => {
    if (prefillRan.current) return;
    if (!user) return;
    if (data.destinationAddress.street || data.email) return;
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
        if (prev.destinationAddress.street || prev.email) return prev;
        return {
          ...prev,
          destinationAddress: recentComplete
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
            ? { ...prev.destinationAddress, name: profile.full_name }
            : prev.destinationAddress,
          email: profile?.email ?? user.email ?? prev.email,
        };
      });
    })();
    return () => { cancelled = true; };
  }, [user, data.destinationAddress.street, data.email]);

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
