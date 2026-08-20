import type {
  AddressInput,
  DistanceTier,
  PackagingType,
  RecipientPath,
  SenderKind,
  ShippingRate,
  SpeedTier,
  LabelResult,
} from "@/lib/types";
import { isUsablePhone } from "@/lib/phone";

// ─── State Shape ────────────────────────────────────────────

export interface RecipientFlowState {
  currentStep: number;
  path: RecipientPath | null;
  /** Who's sending — derived in-flow (chips / deferring), null until claimed. */
  sender: SenderKind | null;
  completedSteps: number[];

  // Step 1
  destinationAddress: AddressInput;
  email: string;

  /**
   * Which questions the payer handed to the sender (steps 10 and 14). Mirrors
   * RecipientFlowData — the flow state is that object plus currentStep, and
   * these decide both the product type and what gets carried onto the link.
   */
  deferredDestination: boolean;
  deferredOrigin: boolean;
  deferredPackage: boolean;

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
  // Speed hint from the AI guestimator — drives auto-selection of recommended rate
  // when fresh rates arrive. Cleared after the user manually picks a different rate.
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
  // Phase E: link is created at step 22 (with status='draft') so the hold can
  // attach to it. linkId + short_code populate together when the link lands.
  linkId: string;

  // Whether the parcel fields came from the Magic Guestimator (persisted —
  // the Shipping step downstream shows the beta disclaimer beside the price).
  usedGuestimator: boolean;

  /**
   * Whether the one-time "this is a shipping link now" explainer has been
   * shown. Flow state, not component state: the skip that triggers the bubble
   * also navigates, unmounting the step that would have rendered it.
   */
  seenSkipExplainer: boolean;

  // Validation
  tried: Record<number, boolean>;
}

// Step navigation (stepsForPath/nextStep/prevStep), progress-bar mapping, and
// the useRecipientFlow hook that owned local step state all lived here until
// 2026-08-18. They were superseded by src/lib/stepRouting.ts + the
// RecipientFlowProvider context, but the stale copies stayed behind — without
// step 14, exporting the same names as stepRouting. Deleted so the wrong
// import can't compile. This module now holds only the flow-state shape and
// its pure validation/computed helpers.

// ─── Validation ─────────────────────────────────────────────

/**
 * Deliberately permissive: this only has to stop obvious typos before we spend
 * an OTP send on the address. The authoritative check is whether the code that
 * lands in the inbox comes back.
 *
 * Exported so the Contact step's "Send code" button and this step's validator
 * cannot disagree about what counts as an address — they did briefly, when the
 * button had its own inline copy of the regex.
 */
export function isValidEmail(value: string): boolean {
  return /^.+@.+\..+$/.test(value.trim());
}

export function getValidationErrors(state: RecipientFlowState, step: number): string[] {
  const errors: string[] = [];

  if (step === 1) {
    // Destination deferred (Phase 3): the sender enters it in the sender flow,
    // so the address half of this step is answered. Email is NOT deferrable —
    // the creator still needs an account and a card.
    if (!state.deferredDestination) {
      if (!state.destinationAddress.verified) errors.push("Destination address is required");
      else if (!state.destinationAddress.street) errors.push("Destination address is missing a street — please re-select it from the dropdown");
      if (!isUsablePhone(state.destinationAddress.phone)) errors.push("Add a phone number — the shipping carriers require it");
    }
    // Email is NOT collected here since 2026-08-19: identity moved to its own
    // step (design brief point 3), so the Contact step (11) both collects and
    // verifies it. Accepted consequence, John's call: a flow abandoned before
    // step 11 leaves no contact address, where step 1 used to capture one.
    // Restoring capture here means re-adding the field in RecipientStepAddress
    // AND the two rules that used to live on this line.
  }

  // Step 20 is the shared Shipping step (one map, 2026-08-19). Two modes:
  // everything known → the user picks a concrete rate; anything skipped →
  // they set speed/cap preferences instead, because no rate is computable.
  // The mode is the path, which pathForFlags derives from the skip flags.
  if (step === 20) {
    if (state.path === "flexible") {
      if (state.price_cap <= 0) errors.push("Price cap must be greater than $0");
      if (state.price_cap > 500) errors.push("Price cap cannot exceed $500");
    } else {
      if (!state.selectedRate) errors.push("Select a shipping method");
    }
  }

  // The Contact step (slug `verify`) — one step for both paths since the map
  // unified; the old flex step 21 migrated onto 11 (recipientFlowStorage).
  // Since 2026-08-19 it owns email CAPTURE as well as verification, so the
  // format rule that used to gate step 1 lives here.
  if (step === 11) {
    if (!state.email.trim()) errors.push("Email is required");
    else if (!isValidEmail(state.email)) errors.push("Enter a valid email address");
    if (!state.email_verified) errors.push("Verify your email to continue");
  }

  // Step 10 is the ship-from address only (slug `origin` since 2026-08-19).
  // Split from the parcel 2026-08-18 so each can be skipped independently —
  // deferring the address must not also skip the package question.
  if (step === 10) {
    if (!state.originAddress.name) errors.push("Sender name is required");
    if (!state.originAddress.verified) errors.push("Origin address is required");
    else if (!state.originAddress.street) errors.push("Origin address is missing a street — please re-select it from the dropdown");
    if (!isUsablePhone(state.originAddress.phone)) errors.push("Add a phone number — the shipping carriers require it");
  }

  // Step 14 is the parcel only. The carrier/rate choice moved to the shared
  // Shipping step (20) when the maps unified — the design's Package screen
  // shows no prices, so the fetch runs downstream of both halves.
  if (step === 14) {
    const l = parseFloat(state.dimensions.length);
    const w = parseFloat(state.dimensions.width);
    const h = parseFloat(state.dimensions.height);
    if (!l || l <= 0) errors.push("Length is required");
    if (!w || w <= 0) errors.push("Width is required");
    if (state.packagingType !== "envelope" && (!h || h <= 0)) errors.push("Height is required");

    const lbs = parseFloat(state.weight.lbs) || 0;
    const oz = parseFloat(state.weight.oz) || 0;
    if (lbs + oz <= 0) errors.push("Weight is required");
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
  if (!state.originAddress.verified || !state.originAddress.street) return false;
  if (!state.destinationAddress.verified || !state.destinationAddress.street) return false;
  // Phone gates the rate fetch too. fetchRates → addressToApi throws without a
  // phone on either address; gating here keeps that raw "incomplete address"
  // string from reaching the user instead of an inline field error. Mirrors
  // the step-10 / step-1 validation in getValidationErrors.
  if (!isUsablePhone(state.originAddress.phone)) return false;
  if (!isUsablePhone(state.destinationAddress.phone)) return false;
  const l = parseFloat(state.dimensions.length);
  const w = parseFloat(state.dimensions.width);
  const h = parseFloat(state.dimensions.height);
  const wt = getTotalWeightOz(state);
  if (!l || l <= 0 || !w || w <= 0 || wt <= 0) return false;
  if (state.packagingType !== "envelope" && (!h || h <= 0)) return false;
  return true;
}
