import type { AddressInput, ShippingRate, LabelResult } from "./types";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// ─── Helpers ────────────────────────────────────────────────

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ANON_KEY}`,
  };
}

async function post<T>(fn: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: headers(),
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

// ─── Label Purchase ─────────────────────────────────────────

export async function buyLabel(
  easypostShipmentId: string,
  easypostRateId: string,
  from: AddressInput,
  to: AddressInput,
  liveMode: boolean = false,
): Promise<LabelResult> {
  const body = {
    easypost_shipment_id: easypostShipmentId,
    easypost_rate_id: easypostRateId,
    from_address: addressToApi(from),
    to_address: addressToApi(to),
    live_mode: liveMode,
  };
  return post<LabelResult>("labels", body);
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
    // Link preference filters — rates function will use these
    preferred_carrier: linkPrefs?.preferred_carrier || undefined,
    preferred_speed: linkPrefs?.preferred_speed || undefined,
    max_price_cents: linkPrefs?.max_price_cents || undefined,
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
