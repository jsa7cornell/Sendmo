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

  /**
   * Which questions the payer handed to the sender. Set by the "The sender
   * will fill this in" answer on steps 10 and 14. Skipping is *answering* —
   * the step is marked complete either way — and the pair decides the product:
   * neither deferred = an ordinary prepaid label; either deferred = a shipping
   * link the sender completes.
   */
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

  deferredOrigin: false,
  deferredPackage: false,

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

// ─── Storage seam ───────────────────────────────────────────
//
// Holds flow data so the Google OAuth roundtrip in
// RecipientStepEmailVerifySupabase preserves user-entered destination, email,
// shipping selection, etc. across the redirect to accounts.google.com and back.
// It is also how step 0's answer reaches the provider: `/onboarding` renders
// OUTSIDE RecipientFlowProvider (the provider sits at `/onboarding/:pathSlug`
// so its useParams can read the slugs), so the who-sending step writes here and
// the provider hydrates from it on the next route.
//
// **localStorage, not sessionStorage** (2026-08-18). sessionStorage dies with
// the tab, so closing it — or a phone evicting it — lost every field the user
// had typed, with nothing written server-side until the card step. Measured:
// a fresh tab on /full-label/package bounced to /destination, blank.
//
// The risk that buys is a stale flow silently resurrecting, which is precisely
// how the wrong party's address ends up on a label. Three guards, all required:
//   1. `startFlowAs` still RESETS on every new door pick — a fresh start is
//      never contaminated by an old draft.
//   2. Resuming is OFFERED, never automatic (see `loadResumable`): step 0 shows
//      a banner the user must accept.
//   3. Drafts expire. An address typed weeks ago is more likely wrong than
//      useful, and this is shared-computer data.

const STORAGE_KEY = "sendmo:recipient_flow:v1";

/** How long an unfinished flow stays offerable. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredFlow {
  data: Partial<RecipientFlowData>;
  savedAt: number;
}

/**
 * Raw read shared by loadPersisted and loadResumable, so the two can't
 * disagree about what exists (they did: the envelope-only savedAt check in
 * loadResumable silently excluded every draft the compat path below accepts).
 *
 * Two compat cases for flows mid-air across the 2026-08-18 deploy, both
 * treated as saved *now* — their true age is unknowable (the old shape carried
 * no timestamp) and both predate the deploy by at most one session:
 *   1. The pre-deploy code wrote to sessionStorage, so in the same tab the
 *      draft is THERE, not in localStorage. Fall back to it.
 *   2. A bare payload (no envelope) under either key.
 */
function readStored(now: number): StoredFlow | null {
  if (typeof window === "undefined") return null;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as StoredFlow | Partial<RecipientFlowData> | null;
      if (!parsed || typeof parsed !== "object") continue;
      if ("savedAt" in parsed && typeof parsed.savedAt === "number") {
        return parsed as StoredFlow;
      }
      return { data: parsed as Partial<RecipientFlowData>, savedAt: now };
    } catch {
      continue;
    }
  }
  return null;
}

export function loadPersisted(): RecipientFlowData | null {
  const stored = readStored(Date.now());
  if (!stored) return null;
  return { ...INITIAL_DATA, ...stored.data };
}

export function persist(data: RecipientFlowData): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: StoredFlow = { data, savedAt: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    /* storage full / disabled — best-effort, tolerate */
  }
}

export function clearFlow(): void {
  if (typeof window === "undefined") return;
  // Both stores: a legacy sessionStorage draft (readStored's fallback) would
  // otherwise resurrect the moment the localStorage copy is cleared.
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * An unfinished flow worth offering to resume, or null.
 *
 * Deliberately narrow. It must have got past the door (so there is something to
 * come back to), must not already be finished, and must be recent. Anything
 * else is noise that would make the offer untrustworthy — and an offer the user
 * learns to dismiss is worse than none.
 */
export function loadResumable(now: number = Date.now()): RecipientFlowData | null {
  const stored = readStored(now);
  if (!stored) return null;
  if (now - stored.savedAt > DRAFT_TTL_MS) return null;

  const data: RecipientFlowData = { ...INITIAL_DATA, ...stored.data };
  // Finished flows are not drafts.
  if (data.labelResult || data.short_code) return null;
  // "Progress" is any typed field, not just a completed step. Someone who
  // entered a name, phone and email but hadn't verified an address yet has done
  // real work — and losing exactly that is the complaint this fixes. Picking a
  // door alone never qualifies: startFlowAs resets everything but `sender`.
  const progressed =
    data.completedSteps.some((n) => n >= 1) ||
    !!data.destinationAddress.street ||
    !!data.destinationAddress.name ||
    !!data.destinationAddress.phone ||
    !!data.email ||
    !!data.originAddress.street ||
    !!data.originAddress.name;
  return progressed ? data : null;
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
