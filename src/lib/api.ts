import type { AddressInput, ShippingRate, LabelResult } from "./types";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// ─── Helpers ────────────────────────────────────────────────

function headers(accessToken?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken || ANON_KEY}`,
  };
}

async function post<T>(fn: string, body: unknown, accessToken?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: headers(accessToken),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || data.message || `API error ${res.status}`);
  }
  return data as T;
}

// ─── Address Verification ───────────────────────────────────

export interface VerifyAddressResult {
  verified: boolean;
  warning?: string;
  address_type?: string;
  is_po_box?: boolean;
  is_military?: boolean;
  usps_only?: boolean;
  easypost_id?: string;
}

export async function verifyAddress(address: AddressInput): Promise<VerifyAddressResult> {
  return post<VerifyAddressResult>("addresses", {
    street1: address.street,
    city: address.city,
    state: address.state,
    zip: address.zip,
    name: address.name,
  });
}

// ─── Shipping Rates ─────────────────────────────────────────

interface RatesResponse {
  rates: Array<{
    carrier: string;
    service: string;
    display_price: number; // dollars (already has 15% margin + $1.00 flat fee applied server-side)
    delivery_days: number | null;
    easypost_shipment_id: string;
    easypost_rate_id: string;
  }>;
}

export function addressToApi(addr: AddressInput) {
  // Fail loudly at the boundary if a required field is missing — JSON.stringify
  // silently drops undefined keys, which previously masked an upstream
  // address-shape bug as a PostgREST "function not found" error (LOG
  // 2026-05-12, launch blocker fix). Phone became required 2026-05-19 to
  // satisfy FedEx/UPS PHONENUMBEREMPTY rejections.
  if (!addr.street || !addr.city || !addr.state || !addr.zip || !addr.phone) {
    throw new Error(
      `addressToApi: incomplete address (street=${!!addr.street}, city=${!!addr.city}, state=${!!addr.state}, zip=${!!addr.zip}, phone=${!!addr.phone})`
    );
  }
  return {
    street1: addr.street,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    name: addr.name || undefined,
    phone: addr.phone,
  };
}

export async function fetchRates(
  from: AddressInput,
  to: AddressInput,
  parcel: { length: number; width: number; height: number; weight: number },
  liveMode: boolean = false,
): Promise<{ rates: ShippingRate[]; easypost_shipment_id: string }> {
  const body = {
    from_address: addressToApi(from),
    to_address: addressToApi(to),
    parcel: {
      length: parcel.length,
      width: parcel.width,
      height: parcel.height,
      weight_oz: parcel.weight, // Edge Function expects weight_oz
    },
    live_mode: liveMode,
  };
  const data = await post<RatesResponse>("rates", body);

  // Server applies 15% margin + $1.00 flat fee and returns display_price in dollars
  const rates: ShippingRate[] = (data.rates || []).map((r) => ({
    id: r.easypost_rate_id,
    carrier: r.carrier,
    service: r.service,
    rate_cents: Math.round((r.display_price * 100 - 100) / 1.15), // back-calculate base
    display_price_cents: Math.round(r.display_price * 100),
    estimated_days: r.delivery_days,
    currency: "USD",
  }));

  const shipmentId = data.rates?.[0]?.easypost_shipment_id || "";
  return { rates, easypost_shipment_id: shipmentId };
}

// ─── Stripe Payments ────────────────────────────────────────

export interface CreatePaymentIntentResult {
  client_secret: string;
  payment_intent_id: string;
  status: string;
  // Customer Session enables saved-PM display in PaymentElement (dahlia
  // requirement). Null when the caller has no Stripe Customer in the
  // resolved mode, OR when the customer_sessions API call failed —
  // either way, frontend falls back to bare PaymentElement.
  customer_session_client_secret?: string | null;
}

export async function createPaymentIntent(params: {
  easypost_shipment_id: string;
  amount_cents: number;
  live_mode?: boolean;
  receipt_email?: string;
  description?: string;
  access_token?: string;
}): Promise<CreatePaymentIntentResult> {
  return post<CreatePaymentIntentResult>(
    "payments",
    {
      easypost_shipment_id: params.easypost_shipment_id,
      amount_cents: params.amount_cents,
      live_mode: params.live_mode ?? false,
      receipt_email: params.receipt_email,
      description: params.description,
    },
    params.access_token,
  );
}

// ─── Stripe Saved Cards (Phase B) ───────────────────────────

export interface CreateSetupIntentResult {
  client_secret: string;
  setup_intent_id: string;
}

export async function createSetupIntent(
  access_token: string,
  retry_n = 0,
): Promise<CreateSetupIntentResult> {
  return post<CreateSetupIntentResult>(
    "payment-methods",
    { retry_n },
    access_token,
  );
}

export async function removePaymentMethod(
  access_token: string,
  pm_id: string,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/functions/v1/payment-methods/${pm_id}`, {
    method: "DELETE",
    headers: headers(access_token),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `Remove card failed (${res.status})`);
  }
}

// ─── Magic Guestimator (AI) ─────────────────────────────────

export interface GuestimateApiResult {
  itemName: string;
  packaging: "box" | "envelope" | "tube";
  length_in: number;
  width_in: number;
  height_in: number;
  weight_lbs: number;
  speedHint: "economy" | "standard" | "express" | null;
  confidence: "high" | "medium" | "low";
  notes: string;
}

export async function fetchGuestimate(description: string): Promise<GuestimateApiResult> {
  return post<GuestimateApiResult>("guestimate", { description });
}

// ─── Print logging (decided 2026-05-13) ────────────────────
// POST /label-print writes a `label.printed` event_logs row + returns the
// updated count. Same 3-path auth shape as cancel-label (JWT / X-Cancel-Token
// / anonymous). Fire-and-forget from the Print button's onClick — the actual
// PDF window.open happens in parallel via target="_blank".

export interface LogPrintResult {
  actor: string;
  print_count: number;
  skipped?: string;
}

export async function logLabelPrint(
  publicCode: string,
  opts: { accessToken?: string; cancelToken?: string } = {},
): Promise<LogPrintResult> {
  const hdrs: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
  };
  if (opts.accessToken) hdrs.Authorization = `Bearer ${opts.accessToken}`;
  else hdrs.Authorization = `Bearer ${ANON_KEY}`;
  if (opts.cancelToken) hdrs["X-Cancel-Token"] = opts.cancelToken;
  const res = await fetch(`${BASE_URL}/functions/v1/label-print`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ public_code: publicCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Print log failed (${res.status})`);
  }
  return res.json();
}

// ─── Admin debug surface for /t/<code> (decided 2026-05-13, Ask 4) ──
// Returns the rich shipment debug payload for /t/<code>'s collapsible
// Admin Debug card. Server-side gated by profiles.role='admin' via
// requireAdmin in tracking-admin/index.ts.

export interface AdminTrackingPayload {
  identifiers: {
    shipment_id: string;
    public_code: string;
    tracking_number: string | null;
    easypost_shipment_id: string | null;
    easypost_tracker_id: string | null;
    stripe_payment_intent_id: string | null;
    cancel_token: string | null;  // defanged ("••••• abcd") or null
    carrier_refund_id: string | null;
  };
  mode: {
    is_test: boolean;
    is_live: boolean;
    payment_method: string | null;
    carrier: string | null;
    service: string | null;
  };
  state: {
    status: string;
    refund_status: string;
  };
  timeline: {
    created_at: string;
    updated_at: string;
    cancelled_at: string | null;
    refund_submitted_at: string | null;
    delivered_at: string | null;
    promised_delivery_date: string | null;
  };
  parcel: {
    weight_oz: number | null;
    length_in: number | null;
    width_in: number | null;
    height_in: number | null;
    item_description: string | null;
  };
  money: {
    rate_cents: number | null;
    display_price_cents: number | null;
  };
  addresses: {
    sender: { name: string | null; street1: string | null; city: string | null; state: string | null; zip: string | null } | null;
    recipient: { name: string | null; street1: string | null; city: string | null; state: string | null; zip: string | null } | null;
  };
  link: {
    id: string;
    short_code: string;
    link_type: string;
    status: string;
    user_id: string;
    created_at: string;
    updated_at: string;
  } | null;
  label_url: string | null;
  transactions: Array<{
    id: string;
    type: string;
    amount_cents: number;
    mode: string;
    idempotency_key: string | null;
    stripe_intent_id: string | null;
    stripe_charge_id: string | null;
    created_at: string;
  }>;
  event_logs: Array<{
    id: string;
    event_type: string;
    severity: string;
    source: string;
    duration_ms: number | null;
    properties: Record<string, unknown>;
    created_at: string;
  }>;
  easypost: { shipment: unknown } | null;
  _meta: { queried_by: string; queried_at: string; refetch: string | null };
}

export async function fetchTrackingAdmin(
  publicCode: string,
  opts: { accessToken: string; refetch?: "easypost" }
): Promise<AdminTrackingPayload> {
  const params = new URLSearchParams({ code: publicCode });
  if (opts.refetch) params.set("refetch", opts.refetch);
  const res = await fetch(`${BASE_URL}/functions/v1/tracking-admin?${params}`, {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${opts.accessToken}`,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Admin fetch failed (${res.status})`);
  }
  return res.json();
}

// ─── Label Purchase ─────────────────────────────────────────

// Thrown when the labels function returned HTTP 409 + error:"rate_changed".
// Callers should catch this and render a "rate changed" dialog with the
// before/after prices, then either re-shop or cancel based on user choice.
// See proposals/2026-05-23_buy-time-rate-gate.md.
export class BuyLabelRateChangedError extends Error {
  readonly code = "BUY_TIME_RATE_EXCEEDS_DISPLAY_PRICE";
  readonly quotedDisplayPriceCents: number;
  readonly buyTimeRateCents: number;
  readonly newDisplayPriceCents: number;
  readonly refunded: boolean;
  readonly refundError: string | null;
  readonly paymentIntentId: string | null;
  readonly easypostShipmentId: string;
  readonly easypostRateId: string;
  readonly userMessage: string;

  constructor(body: {
    message: string;
    quoted_display_price_cents: number;
    buy_time_rate_cents: number;
    new_display_price_cents: number;
    refunded: boolean;
    refund_error: string | null;
    payment_intent_id: string | null;
    easypost_shipment_id: string;
    easypost_rate_id: string;
  }) {
    super(body.message);
    this.name = "BuyLabelRateChangedError";
    this.quotedDisplayPriceCents = body.quoted_display_price_cents;
    this.buyTimeRateCents = body.buy_time_rate_cents;
    this.newDisplayPriceCents = body.new_display_price_cents;
    this.refunded = body.refunded;
    this.refundError = body.refund_error;
    this.paymentIntentId = body.payment_intent_id;
    this.easypostShipmentId = body.easypost_shipment_id;
    this.easypostRateId = body.easypost_rate_id;
    this.userMessage = body.message;
  }
}

export async function buyLabel(
  easypostShipmentId: string,
  easypostRateId: string,
  from: AddressInput,
  to: AddressInput,  // pass minimal/empty when link_short_code is set; server resolves
  liveMode: boolean = false,
  contacts?: { recipient_email?: string; sender_email?: string },
  link?: { short_code?: string },  // flex-link auth claim (sender flow)
  payment?: { payment_intent_id?: string; comp?: boolean; display_price_cents?: number },
  accessToken?: string,  // user JWT — labels fn stamps shipments.user_id off this (full-label)
  parcel?: { description?: string },  // tracking-page-ia-polish (decided 2026-05-13): sender-declared package contents → shipments.item_description (migration 021)
): Promise<LabelResult> {
  const body = {
    easypost_shipment_id: easypostShipmentId,
    easypost_rate_id: easypostRateId,
    from_address: addressToApi(from),
    // When link_short_code is set the server resolves to_address from the DB
    // and ignores any client-supplied value. Skip addressToApi validation so
    // a city-only stub doesn't throw before we even reach the network call.
    to_address: link?.short_code ? undefined : addressToApi(to),
    // B2 (customer-live-payments): on the flex path the server derives
    // live-ness from the link itself (is_test), so omit live_mode entirely
    // (undefined keys are dropped by JSON.stringify). Full-label buys keep
    // sending it as a hint/key-selection signal.
    live_mode: link?.short_code ? undefined : liveMode,
    recipient_email: contacts?.recipient_email,
    sender_email: contacts?.sender_email,
    link_short_code: link?.short_code,
    payment_intent_id: payment?.payment_intent_id,
    comp: payment?.comp,
    display_price_cents: payment?.display_price_cents,
    // labels function reads parcel.description and writes it to
    // shipments.item_description via a follow-up UPDATE (migration 021).
    parcel: parcel?.description ? { description: parcel.description } : undefined,
  };
  // Custom fetch path (not post<T>): we need to surface the 409 rate-changed
  // body as a typed error rather than collapsing it to `new Error(message)`.
  const res = await fetch(`${BASE_URL}/functions/v1/labels`, {
    method: "POST",
    headers: headers(accessToken),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 409 && data?.error === "rate_changed") {
    throw new BuyLabelRateChangedError(data);
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || `API error ${res.status}`);
  }
  return data as LabelResult;
}

// ─── Flexible Link CRUD ────────────────────────────────────

export interface CreateLinkParams {
  recipient_address: {
    name: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    // Required since 2026-05-19 — the links Edge Function 400s without it
    // (FedEx/UPS need a phone on the delivery address). Every caller must
    // pass it through from the collected AddressInput.phone.
    phone: string;
    verified?: boolean;
  };
  speed_preference: string;
  preferred_carrier: string;
  price_cap_dollars: number;
  size_hint?: string | null;
  distance_hint?: string;
  notes?: string;
  // 'draft' = link starts inactive, becomes active after webhook attaches a PM
  //   (used by RecipientStepFlexPayment for onboarding).
  // 'active' = link is immediately usable; assumes a PM exists (or will be
  //   added separately). Default when omitted, for backward compat.
  // 'auto'  = server inspects the user's default PM in the link's mode and
  //   picks draft/active. Used by /links/new so returning users skip the
  //   inline SetupIntent step. The resolved status is returned in the response.
  initial_status?: "draft" | "active" | "auto";
}

export interface CreateLinkResult {
  id: string;
  short_code: string;
  url: string;
  // Populated when initial_status='auto' (and benign for the other forms,
  // where it echoes what the client requested). Lets the client branch on
  // whether the SetupIntent step still needs to run.
  status?: "draft" | "active";
}

// REMOVED 2026-05-18 (Pattern D, Phase F): createFlexHold no longer exists.
// Flex links collect cards via SetupIntent at /payment-methods (existing
// Add Card flow), then per-shipment off_session charges happen inside the
// labels Edge Function. See proposals/2026-05-16_flex-payment-pattern-d-
// execution_reviewed-2026-05-16_decided-2026-05-18.md.

export async function createFlexLink(
  params: CreateLinkParams,
  accessToken: string,
): Promise<CreateLinkResult> {
  const res = await fetch(`${BASE_URL}/functions/v1/links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Failed to create link (${res.status})`);
  }
  return data as CreateLinkResult;
}

// ─── Seller Link (buyer-pays) ──────────────────────────────
// The seller specs the ORIGIN + package up front; the buyer supplies their
// destination and pays at checkout. Hits the same /links POST with
// link_type='seller_link' (server branches to the seller create flow).

export interface CreateSellerLinkParams {
  origin_address: {
    name: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    phone: string;
    verified?: boolean;
  };
  length_in: number;
  width_in: number;
  height_in: number;
  weight_oz: number;
  speed_preference?: string;
  preferred_carrier?: string;
  price_cap_dollars?: number;
  /** 1 = single-use (closes after the first sale); omit/null = reusable. */
  max_shipments?: number | null;
  notes?: string;
}

export async function createSellerLink(
  params: CreateSellerLinkParams,
  accessToken: string,
): Promise<CreateLinkResult> {
  const res = await fetch(`${BASE_URL}/functions/v1/links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ ...params, link_type: "seller_link" }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Failed to create seller link (${res.status})`);
  }
  return data as CreateLinkResult;
}

export interface LinkData {
  id: string;
  short_code: string;
  link_type: string;
  status: string;
  max_price_cents: number;
  preferred_speed: string | null;
  preferred_carrier: string | null;
  size_hint: string | null;
  notes: string | null;
  recipient_city: string | null;
  recipient_state: string | null;
  recipient_zip: string | null;
  recipient_name: string | null;
  // False when the stored destination address has no street1 — sender flow
  // should surface an error immediately rather than failing at label creation.
  recipient_address_complete: boolean;
  // Pattern D (Phase F): false → flex link has no usable saved PM (either
  // none exists, or the default's stored expiry passed). Sender flow shows
  // "this link isn't accepting payments" up-front instead of letting the
  // user reach Review & Confirm. Always true for full_label links.
  is_funded?: boolean;
  // Populated for full_label viewer links so the client can redirect to
  // /t/<public_code>. Null for flex-links.
  public_code?: string | null;
  // Seller links: the buyer's "ships from" hint (city/state only — the origin
  // street is resolved server-side, never exposed to the buyer's client).
  // Null for flex/full-label links.
  origin_city?: string | null;
  origin_state?: string | null;
  // Mode of the link (seller-link): the anonymous buyer confirms the on-session
  // PI client-side, so BuyerFlow must load the Stripe publishable key that
  // matches the mode seller-checkout creates the PI in (both derived from this).
  is_test?: boolean;
}

export interface UpdateLinkParams {
  recipient_address?: {
    name: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    // Required when recipient_address is present — the PATCH handler 400s
    // without it (FedEx/UPS phone requirement, 2026-05-19).
    phone: string;
    verified?: boolean;
  };
  speed_preference?: string;
  preferred_carrier?: string;
  price_cap_dollars?: number;
  size_hint?: string | null;
  notes?: string | null;
}

export interface UpdateLinkResult {
  id: string;
  short_code: string;
  updated_at: string;
  recipient_address: { name: string; city: string; state: string; zip: string } | null;
  speed_preference: string | null;
  preferred_carrier: string | null;
  max_price_cents: number;
  size_hint: string | null;
}

export async function updateFlexLink(
  linkId: string,
  params: UpdateLinkParams,
  accessToken: string,
): Promise<UpdateLinkResult> {
  const res = await fetch(`${BASE_URL}/functions/v1/links/${encodeURIComponent(linkId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Failed to update link (${res.status})`);
  }
  return data as UpdateLinkResult;
}

export async function fetchLink(shortCode: string): Promise<LinkData> {
  const res = await fetch(`${BASE_URL}/functions/v1/links?code=${encodeURIComponent(shortCode)}`, {
    method: "GET",
    headers: headers(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Link not found (${res.status})`);
  }
  return data as LinkData;
}

// ─── Pattern D (Phase F): link status polling + URL rotation ────

export interface LinkStatusResponse {
  id: string;
  short_code: string;
  link_type: string;
  status: string;
  max_price_cents: number;
  is_test: boolean;
}

// Auth'd. Used by RecipientStepFlexPayment to poll for the draft→active
// flip that happens server-side in the payment_method.attached webhook.
export async function fetchLinkStatusById(linkId: string, accessToken: string): Promise<LinkStatusResponse> {
  const res = await fetch(`${BASE_URL}/functions/v1/links/${encodeURIComponent(linkId)}`, {
    method: "GET",
    headers: { ...headers(), Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Link status fetch failed (${res.status})`);
  }
  return data as LinkStatusResponse;
}

export interface RotateLinkResult {
  id: string;
  short_code: string;
  url: string;
}

// Auth'd. Rotates the link's short_code (old code marked cancelled, no
// grace window). Returns the new short_code + URL.
export async function rotateLinkUrl(linkId: string, accessToken: string): Promise<RotateLinkResult> {
  const res = await fetch(`${BASE_URL}/functions/v1/links/${encodeURIComponent(linkId)}/rotate`, {
    method: "POST",
    headers: { ...headers(), Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Rotate failed (${res.status})`);
  }
  return data as RotateLinkResult;
}

export interface ActivateLinkResult {
  id: string;
  short_code: string;
  status: "active";
}

// Auth'd. Activates a draft flex link using the user's existing default
// payment method (no Stripe call needed; the PM is already attached server-
// side from a prior SetupIntent). Used by FlexPaymentStep when a returning
// user clicks "Activate" on the saved-card row. Idempotent — if the link is
// already active, the server returns 200 with the same shape.
export async function activateLinkWithExistingPm(
  linkId: string,
  accessToken: string,
): Promise<ActivateLinkResult> {
  const res = await fetch(`${BASE_URL}/functions/v1/links/${encodeURIComponent(linkId)}/activate`, {
    method: "POST",
    headers: { ...headers(), Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Activate failed (${res.status})`);
  }
  return data as ActivateLinkResult;
}

// ─── Sender Rates (with link preferences) ──────────────────

export async function fetchSenderRates(
  from: AddressInput,
  to: { name: string; city: string; state: string; zip: string },
  parcel: { length: number; width: number; height: number; weight: number },
  linkPrefs?: {
    preferred_carrier?: string | null;
    preferred_speed?: string | null;
    max_price_cents?: number;
    short_code?: string;
  },
  liveMode: boolean = false,
): Promise<{ rates: ShippingRate[]; easypost_shipment_id: string }> {
  const body = {
    from_address: addressToApi(from),
    to_address: {
      name: to.name,
      city: to.city,
      state: to.state,
      zip: to.zip,
    },
    parcel: {
      length: parcel.length,
      width: parcel.width,
      height: parcel.height,
      weight_oz: parcel.weight,
    },
    // B2 (customer-live-payments): when quoting against a flex link the
    // server derives mode from the link's is_test — omit live_mode
    // (undefined is dropped by JSON.stringify).
    live_mode: linkPrefs?.short_code ? undefined : liveMode,
    preferred_carrier: linkPrefs?.preferred_carrier || undefined,
    preferred_speed: linkPrefs?.preferred_speed || undefined,
    max_price_cents: linkPrefs?.max_price_cents || undefined,
    // Sender flow: server resolves the full to_address server-side so
    // EasyPost's /buy doesn't reject for missing street1.
    link_short_code: linkPrefs?.short_code || undefined,
  };
  const data = await post<RatesResponse>("rates", body);

  const rates: ShippingRate[] = (data.rates || []).map((r) => ({
    id: r.easypost_rate_id,
    carrier: r.carrier,
    service: r.service,
    rate_cents: Math.round((r.display_price * 100 - 100) / 1.15),
    display_price_cents: Math.round(r.display_price * 100),
    estimated_days: r.delivery_days,
    currency: "USD",
  }));

  const shipmentId = data.rates?.[0]?.easypost_shipment_id || "";
  return { rates, easypost_shipment_id: shipmentId };
}

// ─── Buyer Rates (seller-link, PRICE-VISIBLE) ──────────────
//
// The anonymous buyer at /s/<code> supplies ONLY their destination address;
// the seller's origin + package (and carrier/price constraints) are resolved
// server-side from link_short_code. Unlike the sender flow, the buyer pays,
// so the returned display_price_cents is shown to them verbatim.
//
// Same /rates endpoint + anon-key headers as fetchSenderRates. The server
// returns display_price in DOLLARS (already margin-applied); we convert to
// cents here exactly like fetchSenderRates.
//
// Returns the easypost_shipment_id alongside the rates (mirrors fetchRates/
// fetchSenderRates): one EasyPost Shipment backs the whole rate list, and the
// on-session payment + label buy both need that id. ShippingRate itself stays
// shipment-id-free — the id belongs to the shipment, not each rate.
export async function fetchBuyerRates(
  destAddress: { name: string; street1: string; city: string; state: string; zip: string; phone: string },
  linkShortCode: string,
): Promise<{ rates: ShippingRate[]; easypost_shipment_id: string }> {
  const body = {
    to_address: { ...destAddress, country: "US" },
    // No from_address, no parcel — the server resolves the seller's origin +
    // package from the link. link_short_code drives the seller-link branch.
    link_short_code: linkShortCode,
  };
  const data = await post<RatesResponse>("rates", body);

  const rates: ShippingRate[] = (data.rates || []).map((r) => ({
    id: r.easypost_rate_id,
    carrier: r.carrier,
    service: r.service,
    rate_cents: Math.round((r.display_price * 100 - 100) / 1.15), // back-calculate base
    display_price_cents: Math.round(r.display_price * 100),
    estimated_days: r.delivery_days,
    currency: "USD",
  }));

  const shipmentId = data.rates?.[0]?.easypost_shipment_id || "";
  return { rates, easypost_shipment_id: shipmentId };
}

// ─── Seller Checkout (on-session PaymentIntent) ─────────────
//
// The anonymous buyer's on-session PI. Server-derives the amount from the
// link + selected rate — the buyer's client must NOT send an amount (contrast
// with createPaymentIntent, which takes amount_cents from a trusted caller).
// Anon key only (no user JWT — the buyer has no account). The returned
// client_secret + payment_intent_id feed StripePaymentForm via its createIntent
// prop; the id is later handed to buyLabelSeller.
export async function createSellerCheckoutPI(params: {
  link_short_code: string;
  easypost_shipment_id: string;
  easypost_rate_id: string;
  buyer_email: string;
}): Promise<{ client_secret: string; payment_intent_id: string; status: string }> {
  return post<{ client_secret: string; payment_intent_id: string; status: string }>(
    "seller-checkout",
    {
      link_short_code: params.link_short_code,
      easypost_shipment_id: params.easypost_shipment_id,
      easypost_rate_id: params.easypost_rate_id,
      buyer_email: params.buyer_email,
    },
  );
}

// Buys the EasyPost label for a seller-link buyer AFTER their card is charged.
// Sends ONLY the 5 fields the server needs — it resolves from/to addresses +
// parcel from the link itself (never trust the buyer's client for those), and
// derives live-ness from the link's is_test (so no live_mode either). Mirrors
// buyLabel's typed 409/rate_changed handling.
export async function buyLabelSeller(params: {
  easypost_shipment_id: string;
  easypost_rate_id: string;
  link_short_code: string;
  payment_intent_id: string;
  buyer_email: string;
}): Promise<LabelResult> {
  const res = await fetch(`${BASE_URL}/functions/v1/labels`, {
    method: "POST",
    headers: headers(), // anon — the buyer has no account
    body: JSON.stringify({
      easypost_shipment_id: params.easypost_shipment_id,
      easypost_rate_id: params.easypost_rate_id,
      link_short_code: params.link_short_code,
      payment_intent_id: params.payment_intent_id,
      buyer_email: params.buyer_email,
    }),
  });
  const data = await res.json();
  if (res.status === 409 && data?.error === "rate_changed") {
    throw new BuyLabelRateChangedError(data);
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || `API error ${res.status}`);
  }
  return data as LabelResult;
}

// ─── Pricing Helpers ────────────────────────────────────────

const MARGIN_MULTIPLIER = 1.15;
const MARGIN_FLAT_CENTS = 100; // $1.00 flat fee
const INSURANCE_FLAT_CENTS = 250; // $2.50

export function applyMargin(rateCents: number): number {
  return Math.round(rateCents * MARGIN_MULTIPLIER) + MARGIN_FLAT_CENTS;
}

export function addInsurance(priceCents: number): number {
  return priceCents + INSURANCE_FLAT_CENTS;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function isOverCap(displayPriceCents: number, capDollars: number = 100): boolean {
  return displayPriceCents > capDollars * 100;
}

// ─── Recommended Rate Selection ────────────────────────────
//
// Picks the "best" rate from the EasyPost rate list given an optional speed hint.
//   - 'express' → fastest delivery (lowest estimated_days, tiebreak by price)
//   - 'economy' → cheapest absolute price
//   - 'standard' or null → best value: cheapest rate arriving in ≤5 business days,
//     falling back to absolute cheapest if nothing qualifies.
//
// Returns null if no rates are available.
export function pickRecommendedRate<T extends { display_price_cents: number; estimated_days: number | null }>(
  rates: T[],
  hint: "economy" | "standard" | "express" | null,
): T | null {
  if (!rates.length) return null;

  if (hint === "express") {
    const sorted = [...rates].sort((a, b) => {
      const da = a.estimated_days ?? 99;
      const db = b.estimated_days ?? 99;
      if (da !== db) return da - db;
      return a.display_price_cents - b.display_price_cents;
    });
    return sorted[0];
  }

  if (hint === "economy") {
    return [...rates].sort((a, b) => a.display_price_cents - b.display_price_cents)[0];
  }

  // standard / null → best value: cheapest among rates arriving in ≤5 days
  const fast = rates.filter((r) => r.estimated_days !== null && r.estimated_days <= 5);
  const pool = fast.length > 0 ? fast : rates;
  return [...pool].sort((a, b) => a.display_price_cents - b.display_price_cents)[0];
}

// ─── Cancel / Change ────────────────────────────────────────
// Decided proposal: 2026-05-11_label-cancel-and-change_decided-2026-05-12.
// Three auth paths server-side; the client surfaces whichever signal it has:
//   - Bearer access_token (admin or link owner)
//   - X-Cancel-Token header (just-shipped session OR email-token captured to sessionStorage)

export interface CancelShipmentResult {
  success: boolean;
  refund_status: "submitted" | "refunded" | "rejected" | "not_applicable" | "none";
  link_revived: boolean;
  link_short_code: string | null;
  message: string;
  shipment_id: string;
  public_code: string;
}

export async function cancelShipment(
  publicCode: string,
  reason: "user_cancel" | "user_change",
  opts?: { cancelToken?: string; accessToken?: string },
): Promise<CancelShipmentResult> {
  const hdrs: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts?.accessToken || ANON_KEY}`,
  };
  if (opts?.cancelToken) hdrs["X-Cancel-Token"] = opts.cancelToken;
  const res = await fetch(`${BASE_URL}/functions/v1/cancel-label`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ public_code: publicCode, reason }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || data.message || `Cancel failed (${res.status})`);
  }
  return data as CancelShipmentResult;
}
