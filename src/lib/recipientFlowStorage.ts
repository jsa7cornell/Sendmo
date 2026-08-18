import { emptyAddress } from "@/lib/utils";
import type {
  AddressInput,
  DistanceTier,
  LabelResult,
  PackagingType,
  RecipientPath,
  SenderKind,
  ShippingRate,
  SpeedTier,
} from "@/lib/types";

// ─── State Shape ────────────────────────────────────────────

export interface RecipientFlowData {
  path: RecipientPath | null;
  /**
   * Step 0's answer. Decides which party owns which address slot, so it gates
   * every saved-address prefill. Null only for flows entered by deep link
   * before step 0 ran — those are treated as 'other' (today's shape).
   */
  sender: SenderKind | null;
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

  // Step 20-23 (shipping-link path)
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

export const INITIAL_DATA: RecipientFlowData = {
  path: null,
  sender: null,
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

// ─── SessionStorage seam ────────────────────────────────────
//
// SessionStorage-backed flow data so the Google OAuth roundtrip in
// RecipientStepEmailVerifySupabase preserves user-entered destination, email,
// shipping selection, etc. across the redirect to accounts.google.com and back.
// It is also how step 0's answer reaches the provider: `/onboarding` renders
// OUTSIDE RecipientFlowProvider (the provider sits at `/onboarding/:pathSlug`
// so its useParams can read the slugs), so the who-sending step writes here and
// the provider hydrates from it on the next route.

const STORAGE_KEY = "sendmo:recipient_flow:v1";

export function loadPersisted(): RecipientFlowData | null {
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

export function persist(data: RecipientFlowData): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* sessionStorage full / disabled — best-effort, tolerate */
  }
}

/**
 * Which address slot a signed-in user's saved address belongs in.
 *
 * The account holder is a different party in each branch, so this is the single
 * fact every saved-address prefill has to agree on:
 *   'self'  → they ship OUT   → the saved address is the ORIGIN
 *   'other' → they RECEIVE    → the saved address is the DESTINATION
 *   null    → not asked yet (deep link) → treat as today's shape, 'destination'
 *
 * Named and shared rather than inlined because there are two prefill sites
 * (RecipientFlowContext and RecipientStepAddress) and a drift between them puts
 * the wrong party's address on a label. See the 2026-08-16 stale-autofill class.
 */
export function prefillSlotFor(sender: SenderKind | null): "origin" | "destination" {
  return sender === "self" ? "origin" : "destination";
}

/**
 * Records step 0's answer and starts a clean flow.
 *
 * Deliberately resets to INITIAL_DATA rather than merging: picking a door
 * starts a new shipment, and 'self' vs 'other' swap which party owns the
 * destination slot, so carrying a previous run's addresses across a re-pick is
 * exactly how the wrong party's address ends up on a label.
 */
export function startFlowAs(sender: SenderKind): void {
  persist({ ...INITIAL_DATA, sender });
}
