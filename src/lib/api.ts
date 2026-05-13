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
): Promise<LabelResult> {
  const body = {
    easypost_shipment_id: easypostShipmentId,
    easypost_rate_id: easypostRateId,
    from_address: addressToApi(from),
    to_address: addressToApi(to),
    live_mode: liveMode,
    recipient_email: contacts?.recipient_email,
    sender_email: contacts?.sender_email,
    link_short_code: link?.short_code,
    payment_intent_id: payment?.payment_intent_id,
    comp: payment?.comp,
    display_price_cents: payment?.display_price_cents,
  };
  return post<LabelResult>("labels", body, accessToken);
}

// ─── Email Verification ────────────────────────────────────

export async function sendOTP(email: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>("email", { action: "send", email });
}

export async function confirmOTP(email: string, code: string): Promise<{ ok: boolean; verified: boolean }> {
  return post<{ ok: boolean; verified: boolean }>("email", { action: "confirm", email, code });
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
}

export interface CreateLinkResult {
  id: string;
  short_code: string;
  url: string;
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
