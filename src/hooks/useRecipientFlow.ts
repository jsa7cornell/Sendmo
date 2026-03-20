import { useCallback, useState } from "react";
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

// ─── State Shape ────────────────────────────────────────────

export interface RecipientFlowState {
  currentStep: number;
  path: RecipientPath | null;
  completedSteps: number[];

  // Step 1
  destinationAddress: AddressInput;
  email: string;

  // Step 10
  originAddress: AddressInput;
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

const INITIAL_STATE: RecipientFlowState = {
  currentStep: 0,
  path: null,
  completedSteps: [],

  destinationAddress: emptyAddress(),
  email: "",

  originAddress: emptyAddress(),
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

// ─── Step Navigation Maps ───────────────────────────────────

const FULL_LABEL_STEPS = [0, 1, 10, 11, 12];
const FLEX_LINK_STEPS = [0, 1, 20, 21, 22, 23];

function stepsForPath(path: RecipientPath | null): number[] {
  return path === "flexible" ? FLEX_LINK_STEPS : FULL_LABEL_STEPS;
}

function nextStep(current: number, path: RecipientPath | null): number | null {
  const steps = stepsForPath(path);
  const idx = steps.indexOf(current);
  return idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : null;
}

function prevStep(current: number, path: RecipientPath | null): number | null {
  const steps = stepsForPath(path);
  const idx = steps.indexOf(current);
  return idx > 0 ? steps[idx - 1] : null;
}

// ─── Progress Bar Mapping ───────────────────────────────────

export function stepToProgressIndex(step: number): number {
  if (step === 0 || step === 1) return 0;
  if (step === 10) return 1;
  if (step === 11) return 2;
  if (step === 12) return 3;
  // Flexible link mapping (future)
  if (step === 20) return 1;
  if (step === 21 || step === 22) return 2;
  if (step === 23) return 3;
  return 0;
}

// ─── Validation ─────────────────────────────────────────────

export function getValidationErrors(state: RecipientFlowState, step: number): string[] {
  const errors: string[] = [];

  if (step === 1) {
    if (!state.destinationAddress.verified) errors.push("Destination address is required");
    if (!state.email.trim()) errors.push("Email is required");
    else if (!/^.+@.+\..+$/.test(state.email.trim())) errors.push("Enter a valid email address");
  }

  if (step === 20) {
    if (state.price_cap <= 0) errors.push("Price cap must be greater than $0");
    if (state.price_cap > 500) errors.push("Price cap cannot exceed $500");
  }

  if (step === 21) {
    if (!state.email_verified) errors.push("Email must be verified to continue");
  }

  if (step === 10) {
    if (!state.originAddress.verified) errors.push("Ship from address is required");

    const l = parseFloat(state.dimensions.length);
    const w = parseFloat(state.dimensions.width);
    const h = parseFloat(state.dimensions.height);
    if (!l || l <= 0) errors.push("Length is required");
    if (!w || w <= 0) errors.push("Width is required");
    if (state.packagingType !== "envelope" && (!h || h <= 0)) errors.push("Height is required");

    const lbs = parseFloat(state.weight.lbs) || 0;
    const oz = parseFloat(state.weight.oz) || 0;
    if (lbs + oz <= 0) errors.push("Weight is required");

    if (!state.selectedRate) errors.push("Select a shipping method");
  }

  return errors;
}

// ─── Computed Values ────────────────────────────────────────

export function getTotalWeightOz(state: RecipientFlowState): number {
  const lbs = parseFloat(state.weight.lbs) || 0;
  const oz = parseFloat(state.weight.oz) || 0;
  return lbs * 16 + oz;
}

export function getTotalPriceCents(state: RecipientFlowState): number {
  if (!state.selectedRate) return 0;
  let total = state.selectedRate.display_price_cents;
  if (state.insurance) total += 250;
  return total;
}

export function canFetchRates(state: RecipientFlowState): boolean {
  if (!state.originAddress.verified || !state.destinationAddress.verified) return false;
  const l = parseFloat(state.dimensions.length);
  const w = parseFloat(state.dimensions.width);
  const h = parseFloat(state.dimensions.height);
  const wt = getTotalWeightOz(state);
  if (!l || l <= 0 || !w || w <= 0 || wt <= 0) return false;
  if (state.packagingType !== "envelope" && (!h || h <= 0)) return false;
  return true;
}

// ─── Hook ───────────────────────────────────────────────────

export function useRecipientFlow() {
  const [state, setState] = useState<RecipientFlowState>(INITIAL_STATE);

  const updateState = useCallback((partial: Partial<RecipientFlowState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const goToStep = useCallback((step: number) => {
    setState((prev) => {
      // Only allow going to completed steps or the current next step
      if (prev.completedSteps.includes(step) || step === prev.currentStep) {
        return { ...prev, currentStep: step };
      }
      return prev;
    });
  }, []);

  const goBack = useCallback(() => {
    setState((prev) => {
      const prev_step = prevStep(prev.currentStep, prev.path);
      return prev_step !== null ? { ...prev, currentStep: prev_step } : prev;
    });
  }, []);

  const tryAdvance = useCallback((step: number): boolean => {
    const errors = getValidationErrors(state, step);
    if (errors.length > 0) {
      setState((prev) => ({
        ...prev,
        tried: { ...prev.tried, [step]: true },
      }));
      return false;
    }

    const next = nextStep(step, state.path);
    if (next !== null) {
      setState((prev) => ({
        ...prev,
        currentStep: next,
        completedSteps: prev.completedSteps.includes(step)
          ? prev.completedSteps
          : [...prev.completedSteps, step],
      }));
    }
    return true;
  }, [state]);

  const selectPath = useCallback((path: RecipientPath) => {
    setState((prev) => ({
      ...prev,
      path,
      currentStep: 1,
      completedSteps: prev.completedSteps.includes(0) ? prev.completedSteps : [...prev.completedSteps, 0],
    }));
  }, []);

  const markStepComplete = useCallback((step: number) => {
    setState((prev) => ({
      ...prev,
      completedSteps: prev.completedSteps.includes(step)
        ? prev.completedSteps
        : [...prev.completedSteps, step],
    }));
  }, []);

  return {
    state,
    updateState,
    goToStep,
    goBack,
    tryAdvance,
    selectPath,
    markStepComplete,
    getErrors: (step: number) => getValidationErrors(state, step),
  };
}
