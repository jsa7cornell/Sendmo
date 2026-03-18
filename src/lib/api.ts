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
    display_price: number; // dollars (already has 15% margin applied server-side)
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

  // Server already applies 15% margin and returns display_price in dollars
  const rates: ShippingRate[] = (data.rates || []).map((r) => ({
    id: r.easypost_rate_id,
    carrier: r.carrier,
    service: r.service,
    rate_cents: Math.round(r.display_price * 100 / 1.15), // back-calculate base
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

// ─── Fetch Link by Short Code ───────────────────────────────

export interface LinkData {
  id: string;
  short_code: string;
  link_type: string;
  status: string;
  recipient_name: string;
  recipient_city: string;
  recipient_state: string;
  max_price_cents: number;
  preferred_speed: string | null;
  preferred_carrier: string | null;
  size_hint: string | null;
  notes: string | null;
  expires_at: string | null;
  recipient_address_id: string;
}

export async function fetchLink(shortCode: string): Promise<LinkData> {
  const res = await fetch(
    `${BASE_URL}/rest/v1/sendmo_links?short_code=eq.${encodeURIComponent(shortCode)}&select=id,short_code,link_type,status,max_price_cents,preferred_speed,preferred_carrier,size_hint,notes,expires_at,recipient_address_id,profiles(full_name),addresses!sendmo_links_recipient_address_id_fkey(city,state)`,
    {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error("Failed to load shipping link");
  const rows = await res.json();
  if (!rows || rows.length === 0) throw new Error("Link not found");
  const row = rows[0];
  return {
    id: row.id,
    short_code: row.short_code,
    link_type: row.link_type,
    status: row.status,
    max_price_cents: row.max_price_cents,
    preferred_speed: row.preferred_speed,
    preferred_carrier: row.preferred_carrier,
    size_hint: row.size_hint,
    notes: row.notes,
    expires_at: row.expires_at,
    recipient_address_id: row.recipient_address_id,
    recipient_name: row.profiles?.full_name || "the recipient",
    recipient_city: row.addresses?.city || "",
    recipient_state: row.addresses?.state || "",
  };
}

// ─── Fetch Address (for internal rate/label API calls only) ──

export async function fetchAddress(addressId: string): Promise<AddressInput> {
  const res = await fetch(
    `${BASE_URL}/rest/v1/addresses?id=eq.${encodeURIComponent(addressId)}&select=name,street1,city,state,zip`,
    {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error("Failed to load address");
  const rows = await res.json();
  if (!rows || rows.length === 0) throw new Error("Address not found");
  const a = rows[0];
  return { name: a.name, street: a.street1, city: a.city, state: a.state, zip: a.zip, verified: true };
}

// ─── Pricing Helpers ────────────────────────────────────────

const MARGIN_MULTIPLIER = 1.15;
const INSURANCE_FLAT_CENTS = 250; // $2.50

export function applyMargin(rateCents: number): number {
  return Math.round(rateCents * MARGIN_MULTIPLIER);
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
