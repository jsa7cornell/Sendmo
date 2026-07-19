// =============================================================
// SendMo — Shared TypeScript Types
// Maps to the 7 DB tables: profiles, addresses, sendmo_links,
// shipments, payments, balances, webhook_events
// =============================================================

// ─── Profiles ────────────────────────────────────────────────
export interface Profile {
    id: string;
    email: string;
    full_name: string | null;
    phone: string | null;
    avatar_url: string | null;
    created_at: string;
    updated_at: string;
}

// ─── Addresses ───────────────────────────────────────────────
export interface Address {
    id: string;
    user_id: string;
    label: string | null;
    name: string;
    street1: string;
    street2: string | null;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone: string | null;
    is_verified: boolean;
    easypost_id: string | null;
    created_at: string;
}

// ─── SendMo Links ────────────────────────────────────────────
export type LinkType = "full_label" | "flexible" | "seller_link";
// NOTE: 'in_use'/'completed' per migration 020 (renamed 'used' → 'in_use', added 'completed').
export type LinkStatus = "draft" | "active" | "in_use" | "completed" | "expired" | "cancelled";
export type LinkFunder = "buyer" | "seller";

export interface SendmoLink {
    id: string;
    user_id: string;
    short_code: string;
    link_type: LinkType;
    status: LinkStatus;
    funder: LinkFunder;
    /** Recipient/full-label: the destination. NULL for seller links (destination unknown until the buyer completes). */
    recipient_address_id: string | null;
    /** Seller links only: the seller's ship-FROM address. NULL for recipient/full-label links. */
    origin_address_id: string | null;
    sender_name: string | null;
    max_price_cents: number;
    preferred_speed: string | null;
    preferred_carrier: string | null;
    size_hint: string | null;
    weight_hint_oz: number | null;
    /** Seller links: the seller's specced package dims (weight reuses weight_hint_oz). */
    length_in: number | null;
    width_in: number | null;
    height_in: number | null;
    /** NULL = reusable (each buyer spawns a child shipment); 1 = single-use. */
    max_shipments: number | null;
    notes: string | null;
    expires_at: string | null;
    created_at: string;
    updated_at: string;
}

// ─── Shipments ───────────────────────────────────────────────
export type ShipmentStatus =
    | "label_created"
    | "in_transit"
    | "out_for_delivery"
    | "delivered"
    | "return_to_sender"
    | "cancelled";

export interface Shipment {
    id: string;
    link_id: string;
    sender_address_id: string | null;
    recipient_address_id: string;
    easypost_shipment_id: string | null;
    easypost_tracker_id: string | null;
    carrier: string;
    service: string;
    tracking_number: string | null;
    label_url: string | null;
    rate_cents: number;
    display_price_cents: number;
    status: ShipmentStatus;
    weight_oz: number;
    length_in: number;
    width_in: number;
    height_in: number;
    /** Seller-link shipments: the paying buyer's email + optional claimed account (else NULL). */
    buyer_email: string | null;
    recipient_user_id: string | null;
    created_at: string;
    updated_at: string;
}

// ─── Transactions (Stripe Phase A — migration 017) ──────────
// Append-only ledger. The legacy `payments` table was dropped.
// Signed amount_cents: + = SendMo gains, − = SendMo loses.

export type TransactionType =
    | "charge"
    | "fee_stripe"
    | "refund"
    | "refund_fee_recovered"
    | "comp_grant"
    | "balance_topup"
    | "balance_topup_bonus"
    | "balance_redeem"
    | "carrier_adjustment"
    | "chargeback"
    | "adjustment";

export type FundingSource = "card" | "balance" | "split" | "us_bank_account" | "comp";
export type LedgerMode = "test" | "live";

export interface Transaction {
    id: string;
    user_id: string;
    shipment_id: string | null;
    link_id: string | null;
    stripe_intent_id: string | null;
    stripe_charge_id: string | null;
    type: TransactionType;
    funding_source: FundingSource | null;
    amount_cents: number;
    description: string | null;
    mode: LedgerMode;
    idempotency_key: string;
    created_at: string;
}

// ─── Balances ────────────────────────────────────────────────
export interface Balance {
    id: string;
    user_id: string;
    amount_cents: number;
    created_at: string;
    updated_at: string;
}

// ─── Webhook Events ─────────────────────────────────────────
export type WebhookSource = "stripe" | "easypost";

export interface WebhookEvent {
    id: string;
    source: WebhookSource;
    event_type: string;
    event_id: string;
    payload: Record<string, unknown>;
    processed: boolean;
    created_at: string;
}

// ─── Helper / Derived Types ──────────────────────────────────
export interface ShippingRate {
    id: string;
    carrier: string;
    service: string;
    rate_cents: number;
    display_price_cents: number;
    estimated_days: number | null;
    currency: string;
}

export interface PackageDimensions {
    length_in: number;
    width_in: number;
    height_in: number;
    weight_oz: number;
}

export interface AddressInput {
    name: string;
    street: string;
    city: string;
    state: string;
    zip: string;
    // Phone is required across all forms (added 2026-05-19 after FedEx
    // rejected labels with PHONENUMBEREMPTY). USPS doesn't require it,
    // but FedEx/UPS do — collecting it universally avoids the awkward
    // "you can't pick FedEx because you didn't enter a phone" UX.
    phone: string;
    verified?: boolean;   // true when user selected from Google Places dropdown
    place_id?: string;    // Google Places place_id for the selected location
}

// ─── Recipient Flow Types ───────────────────────────────────

export type PackagingType = 'box' | 'envelope' | 'tube';
export type SpeedTier = 'economy' | 'standard' | 'express';
export type DistanceTier = 'nearby' | 'regional' | 'cross';
export type RecipientPath = 'full_label' | 'flexible';
/** The /onboarding picker choice. 'seller_link' routes to a SEPARATE seller-builder (not the recipient state machine). */
export type OnboardingChoice = RecipientPath | 'seller_link';

export interface ShippingMethodOption extends ShippingRate {
    speed_tier: SpeedTier;
    disabled?: boolean;
    disabledReason?: string;
}

export interface GuestimatorResult {
    packaging: PackagingType;
    length: number;
    width: number;
    height: number;
    weightLbs: number;
    speedHint?: SpeedTier;
    itemName: string;
}

export interface LabelResult {
    tracking_number: string;
    carrier: string;
    service: string;
    label_url: string;
    sendmo_id?: string;
    public_code?: string | null;
    short_code?: string | null;
    shipment_id?: string | null;
    /** Per-shipment hex token (migration 020) for anonymous user-facing cancel. */
    cancel_token?: string | null;
}

// API request/response types are defined inline in api.ts to match
// the Edge Function field names (from_address, to_address, parcel)
