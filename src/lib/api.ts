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
  // Fail loudly at the boundary if street is missing — JSON.stringify
  // silently drops undefined keys, which previously masked an upstream
  // address-shape bug as a PostgREST "function not found" error (LOG
  // 2026-05-12, launch blocker fix).
  if (!addr.street || !addr.city || !addr.state || !addr.zip) {
    throw new Error(
      `addressToApi: incomplete address (street=${!!addr.street}, city=${!!addr.city}, state=${!!addr.state}, zip=${!!addr.zip})`
    );
  }
  return {
    street1: addr.street,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    name: addr.name || undefined,
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
    stripe_customer_id: string | null;
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
    stripe_payment_intent_id: string | null;
    stripe_charge_id: string | null;
    stripe_refund_id: string | null;
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
    live_mode: liveMode,
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
  return post<LabelResult>("labels", body, accessToken);
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
    verified?: boolean;
  };
  speed_preference: string;
  preferred_carrier: string;
  price_cap_dollars: number;
  size_hint?: string | null;
  distance_hint?: string;
  notes?: string;
  // 'draft' for flows that authorize a hold before activation (Phase E flex
  // onboarding). Defaults to 'active' on the server when omitted.
  initial_status?: "draft" | "active";
}

export interface CreateLinkResult {
  id: string;
  short_code: string;
  url: string;
}

// Request a flex_hold PaymentIntent against an existing draft link.
// Returns the client_secret + customer session for Stripe Elements.
export interface CreateFlexHoldParams {
  link_id: string;
  amount_cents: number;
  live_mode?: boolean;
  access_token: string;
}
export interface CreateFlexHoldResult {
  client_secret: string;
  payment_intent_id: string;
  status: string;
  customer_session_client_secret: string | null;
}
export async function createFlexHold(
  params: CreateFlexHoldParams,
): Promise<CreateFlexHoldResult> {
  const res = await fetch(`${BASE_URL}/functions/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.access_token}`,
    },
    body: JSON.stringify({
      intent_role: "flex_hold",
      link_id: params.link_id,
      amount_cents: params.amount_cents,
      live_mode: params.live_mode ?? false,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Failed to create flex hold (${res.status})`);
  }
  return data as CreateFlexHoldResult;
}

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
  // Populated for full_label viewer links so the client can redirect to
  // /t/<public_code>. Null for flex-links.
  public_code?: string | null;
}

export interface UpdateLinkParams {
  recipient_address?: {
    name: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
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
    live_mode: liveMode,
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
