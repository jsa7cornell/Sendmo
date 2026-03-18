import { useCallback, useState } from "react";
import type {
  AddressInput,
  PackagingType,
  ShippingRate,
  LabelResult,
} from "@/lib/types";
import type { LinkData } from "@/lib/api";
import { emptyAddress } from "@/lib/utils";

// ─── State Shape ────────────────────────────────────────────

export interface SenderFlowState {
  currentStep: number; // 0-4
  completedSteps: number[];

  // Link data (loaded on mount)
  link: LinkData | null;
  recipientAddress: AddressInput | null; // full address — NEVER displayed, only for API calls

  // Step 1: Origin + Package
  fromAddress: AddressInput;
  packagingType: PackagingType;
  dimensions: { length: string; width: string; height: string };
  weight: { lbs: string; oz: string };
  itemDescription: string;

  // Step 2: Shipping
  availableRates: ShippingRate[];
  selectedRate: ShippingRate | null;
  easypostShipmentId: string;

  // Step 4: Label
  labelResult: LabelResult | null;

  // Validation
  tried: Record<number, boolean>;
}

export const INITIAL_SENDER_STATE: SenderFlowState = {
  currentStep: 0,
  completedSteps: [],

  link: null,
  recipientAddress: null,

  fromAddress: emptyAddress(),
  packagingType: "box",
  dimensions: { length: "", width: "", height: "" },
  weight: { lbs: "", oz: "" },
  itemDescription: "",

  availableRates: [],
  selectedRate: null,
  easypostShipmentId: "",

  labelResult: null,

  tried: {},
};

// ─── Steps ──────────────────────────────────────────────────

const SENDER_STEPS = [0, 1, 2, 3, 4];

function nextStep(current: number): number | null {
  const idx = SENDER_STEPS.indexOf(current);
  return idx >= 0 && idx < SENDER_STEPS.length - 1 ? SENDER_STEPS[idx + 1] : null;
}

function prevStep(current: number): number | null {
  const idx = SENDER_STEPS.indexOf(current);
  return idx > 0 ? SENDER_STEPS[idx - 1] : null;
}

// ─── Validation ─────────────────────────────────────────────

export function getSenderValidationErrors(state: SenderFlowState, step: number): string[] {
  const errors: string[] = [];

  if (step === 1) {
    if (!state.fromAddress.name?.trim()) errors.push("Enter your name");
    if (!state.fromAddress.verified) errors.push("Verify your address");

    const l = parseFloat(state.dimensions.length);
    const w = parseFloat(state.dimensions.width);
    const h = parseFloat(state.dimensions.height);
    if (!l || l <= 0) errors.push("Enter package length");
    if (!w || w <= 0) errors.push("Enter package width");
    if (state.packagingType !== "envelope" && (!h || h <= 0)) errors.push("Enter package height");

    const lbs = parseFloat(state.weight.lbs) || 0;
    const oz = parseFloat(state.weight.oz) || 0;
    if (lbs + oz <= 0) errors.push("Enter package weight");
  }

  if (step === 2) {
    if (!state.selectedRate) errors.push("Select a shipping method");
  }

  return errors;
}

// ─── Computed Values ────────────────────────────────────────

export function getSenderWeightOz(state: SenderFlowState): number {
  const lbs = parseFloat(state.weight.lbs) || 0;
  const oz = parseFloat(state.weight.oz) || 0;
  return lbs * 16 + oz;
}

export function canSenderFetchRates(state: SenderFlowState): boolean {
  if (!state.fromAddress.verified || !state.recipientAddress) return false;
  const l = parseFloat(state.dimensions.length);
  const w = parseFloat(state.dimensions.width);
  const h = parseFloat(state.dimensions.height);
  const wt = getSenderWeightOz(state);
  if (!l || l <= 0 || !w || w <= 0 || wt <= 0) return false;
  if (state.packagingType !== "envelope" && (!h || h <= 0)) return false;
  return true;
}

// ─── Fields that invalidate rate selection when changed ─────

const RATE_INVALIDATING_KEYS: (keyof SenderFlowState)[] = [
  "fromAddress",
  "dimensions",
  "weight",
  "packagingType",
];

// ─── Hook ───────────────────────────────────────────────────

export function useSenderFlow() {
  const [state, setState] = useState<SenderFlowState>(INITIAL_SENDER_STATE);

  const updateState = useCallback((partial: Partial<SenderFlowState>) => {
    setState((prev) => {
      const next = { ...prev, ...partial };

      // Auto-clear rate selection when package details change
      const rateInvalidated = RATE_INVALIDATING_KEYS.some(
        (key) => key in partial && partial[key] !== prev[key],
      );
      if (rateInvalidated && prev.selectedRate) {
        next.selectedRate = null;
        next.availableRates = [];
        next.easypostShipmentId = "";
      }

      return next;
    });
  }, []);

  const goToStep = useCallback((step: number) => {
    setState((prev) => {
      if (prev.completedSteps.includes(step) || step === prev.currentStep) {
        return { ...prev, currentStep: step };
      }
      return prev;
    });
  }, []);

  const goBack = useCallback(() => {
    setState((prev) => {
      const prev_step = prevStep(prev.currentStep);
      return prev_step !== null ? { ...prev, currentStep: prev_step } : prev;
    });
  }, []);

  const tryAdvance = useCallback((step: number): boolean => {
    let errors: string[];
    setState((prev) => {
      errors = getSenderValidationErrors(prev, step);
      if (errors.length > 0) {
        return { ...prev, tried: { ...prev.tried, [step]: true } };
      }
      const next = nextStep(step);
      if (next !== null) {
        return {
          ...prev,
          currentStep: next,
          completedSteps: prev.completedSteps.includes(step)
            ? prev.completedSteps
            : [...prev.completedSteps, step],
        };
      }
      return prev;
    });
    // Re-check outside setState for return value
    errors = getSenderValidationErrors(state, step);
    return errors.length === 0;
  }, [state]);

  const markComplete = useCallback((step: number) => {
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
    markComplete,
    getErrors: (step: number) => getSenderValidationErrors(state, step),
  };
}
