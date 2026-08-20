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
   * Who's sending — 'self' (account holder mails out) or 'other' (someone
   * ships to them). Starts null and is resolved IN-FLOW (2026-08-18): by the
   * "deliver to me" chip, the "I'm the sender" claim, or by deferring. While
   * null, NOTHING prefills (prefillSlotFor(null) → null) — null is never
   * treated as 'other'.
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

  // Whether the parcel fields were filled by the Magic Guestimator — drives
  // the beta disclaimer beside the estimated cost. Lived as component-local
  // state while price and parcel shared one screen; persisted once the rate
  // step (20) moved downstream of the package step (14).
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

export const INITIAL_DATA: RecipientFlowData = {
  path: null,
  sender: null,
  completedSteps: [],

  destinationAddress: emptyAddress(),
  email: "",

  deferredDestination: false,
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

  usedGuestimator: false,
  seenSkipExplainer: false,

  tried: {},
};

// ─── Storage seam ───────────────────────────────────────────
//
// Holds flow data so the Google OAuth roundtrip in
// RecipientStepEmailVerifySupabase preserves user-entered destination, email,
// shipping selection, etc. across the redirect to accounts.google.com and back.
// `/onboarding` (OnboardingEntry) renders OUTSIDE RecipientFlowProvider (the
// provider sits at `/onboarding/:pathSlug` so its useParams can read the
// slugs); its Start-fresh / stale-draft clears write here and the provider
// hydrates from it on the next route.
//
// **localStorage, not sessionStorage** (2026-08-18). sessionStorage dies with
// the tab, so closing it — or a phone evicting it — lost every field the user
// had typed, with nothing written server-side until the card step. Measured:
// a fresh tab on /full-label/package bounced to /destination, blank.
//
// The risk that buys is a stale flow silently resurrecting, which is precisely
// how the wrong party's address ends up on a label. Three guards, all required:
//   1. `startFreshFlow` still RESETS on an explicit fresh start — it is
//      never contaminated by an old draft.
//   2. Resuming is OFFERED, never automatic (see `loadResumable`):
//      OnboardingEntry shows a banner the user must accept, and clears any
//      draft that is NOT offerable (finished / expired) so the provider can't
//      silently rehydrate it.
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

// Old flex step numbers → their unified-map equivalents (2026-08-19, one step
// map). Full-label numbers survive unchanged; only the flex tail renumbered:
// verify 21→11, save-card 22→12, share 23→13. Preferences kept 20. Applied on
// READ so a draft persisted before the deploy resumes on the right step —
// PR #68's mid-deploy draft-recovery precedent (LOG 2026-08-18).
const LEGACY_STEP_MAP: Record<number, number> = { 21: 11, 22: 12, 23: 13 };

function migrateSteps(steps: number[] | undefined): number[] | undefined {
  if (!steps) return steps;
  const mapped = steps.map((s) => LEGACY_STEP_MAP[s] ?? s);
  return [...new Set(mapped)];
}

/**
 * Brings a draft written against an older step map onto the current one.
 *
 * Renumbering alone is not enough for a **pre-2026-08-18 flexible draft**.
 * That map's flex sequence was [1, 20, 21, 22, 23] — steps 10 and 14 did not
 * exist on it, so such a draft has neither them nor the defer flags. Under the
 * unified map that reads as "origin and package unanswered", which walks the
 * user back to the origin step AND — because `pathForFlags` derives the product
 * from the flags — silently converts their shipping link into a prepaid label.
 *
 * Being on the flexible path in that era meant exactly one thing: the sender
 * supplies the origin and the parcel. So restore that intent explicitly.
 * Post-2026-08-18 drafts already carry both flags and both completions, so the
 * guard below skips them.
 */
function migrateLegacyFlexDraft(data: RecipientFlowData): RecipientFlowData {
  if (data.path !== "flexible") return data;
  const answeredOrigin = data.completedSteps.includes(10);
  const answeredPackage = data.completedSteps.includes(14);
  if (answeredOrigin && answeredPackage) return data;
  return {
    ...data,
    deferredOrigin: data.deferredOrigin || !answeredOrigin,
    deferredPackage: data.deferredPackage || !answeredPackage,
    completedSteps: [...new Set([...data.completedSteps, 10, 14])],
  };
}

export function loadPersisted(): RecipientFlowData | null {
  const stored = readStored(Date.now());
  if (!stored) return null;
  const data = { ...INITIAL_DATA, ...stored.data };
  data.completedSteps = migrateSteps(data.completedSteps) ?? [];
  return migrateLegacyFlexDraft(data);
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

  let data: RecipientFlowData = { ...INITIAL_DATA, ...stored.data };
  data.completedSteps = migrateSteps(data.completedSteps) ?? [];
  data = migrateLegacyFlexDraft(data);
  // Finished flows are not drafts.
  if (data.labelResult || data.short_code) return null;
  // "Progress" is any typed field, not just a completed step. Someone who
  // entered a name, phone and email but hadn't verified an address yet has done
  // real work — and losing exactly that is the complaint this fixes.
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
 *   null    → unresolved → NO slot; nothing prefills until a chip resolves it
 *
 * Named and shared rather than inlined because there are two prefill sites
 * (RecipientFlowContext and RecipientStepAddress) and a drift between them puts
 * the wrong party's address on a label. See the 2026-08-16 stale-autofill class.
 */
export function prefillSlotFor(sender: SenderKind | null): "origin" | "destination" | null {
  if (sender === "self") return "origin";
  if (sender === "other") return "destination";
  // Unknown (step 0 is gone, 2026-08-18): nothing prefills silently. The
  // address steps offer a "use my address" chip instead, and tapping it is
  // what resolves `sender`. Prefilling a guessed slot is how the wrong
  // party's address ends up on a label.
  return null;
}

/**
 * Starts a clean flow. (Replaces startFlowAs, 2026-08-18: the who's-sending
 * door is gone, so there is no answer to record — `sender` starts null and is
 * derived later from the "use my address" chips or from deferring.)
 *
 * Deliberately resets to INITIAL_DATA rather than merging: starting fresh is
 * a new shipment, and carrying a previous run's addresses across is exactly
 * how the wrong party's address ends up on a label.
 */
export function startFreshFlow(): void {
  // Clear BOTH stores first: persist writes localStorage only and swallows
  // failures, so on a failed write the legacy sessionStorage copy would be
  // the first readable draft — resurrecting exactly what the user declined.
  clearFlow();
  persist({ ...INITIAL_DATA });
}
