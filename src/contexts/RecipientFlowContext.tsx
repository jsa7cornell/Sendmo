import { createContext, useContext, useCallback, useState, useRef } from "react";
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
  slugToStep,
  stepToSlug,
  nextStep,
  canAccessStep,
  stepIndex,
} from "@/lib/stepRouting";
import { getValidationErrors, type RecipientFlowState } from "@/hooks/useRecipientFlow";

// ─── State Shape (same as before, minus currentStep) ────────

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
  // For compatibility: expose state in the old RecipientFlowState shape
  state: RecipientFlowState;
}

const RecipientFlowContext = createContext<RecipientFlowContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────

export function RecipientFlowProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<RecipientFlowData>(INITIAL_DATA);
  const navigate = useNavigate();
  const params = useParams<{ step?: string }>();
  const directionRef = useRef<NavDirection>("forward");

  // Derive current step from URL
  const currentStep = params.step ? (slugToStep(params.step) ?? 0) : 0;

  // Build the old-style state object for backward compatibility with step components
  const state: RecipientFlowState = {
    ...data,
    currentStep,
  };

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

    const next = nextStep(step, data.path);
    if (next !== null) {
      setData((prev) => ({
        ...prev,
        completedSteps: prev.completedSteps.includes(step)
          ? prev.completedSteps
          : [...prev.completedSteps, step],
      }));
      const slug = stepToSlug(next);
      directionRef.current = "forward";
      if (slug) navigate(`/onboarding/${slug}`);
    }
    return true;
  }, [data, navigate]);

  const goBack = useCallback(() => {
    directionRef.current = "backward";
    navigate(-1);
  }, [navigate]);

  const goToStep = useCallback((step: number) => {
    if (!canAccessStep(step, data.completedSteps, data.path) && step !== currentStep) {
      return;
    }
    const targetIdx = stepIndex(step, data.path);
    const currentIdx = stepIndex(currentStep, data.path);
    directionRef.current = targetIdx < currentIdx ? "backward" : "forward";

    if (step === 0) {
      navigate("/onboarding");
    } else {
      const slug = stepToSlug(step);
      if (slug) navigate(`/onboarding/${slug}`);
    }
  }, [data.completedSteps, data.path, currentStep, navigate]);

  const selectPath = useCallback((path: RecipientPath) => {
    setData((prev) => ({
      ...prev,
      path,
      completedSteps: prev.completedSteps.includes(0) ? prev.completedSteps : [...prev.completedSteps, 0],
    }));
    directionRef.current = "forward";
    navigate("/onboarding/address");
  }, [navigate]);

  const markStepComplete = useCallback((step: number) => {
    setData((prev) => ({
      ...prev,
      completedSteps: prev.completedSteps.includes(step)
        ? prev.completedSteps
        : [...prev.completedSteps, step],
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
