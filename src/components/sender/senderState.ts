// Shared state + helpers for the 5-step sender flow at /s/:shortCode.
// See proposal 2026-05-11_sender-flow-wizard for the spec; SPEC.md §8 for
// the canonical step contract.

import type { AddressInput, ShippingRate } from "@/lib/types";
import type { LinkData } from "@/lib/api";
import { classifySpeedTier } from "@/lib/utils";

export type SenderStep = "intro" | "package" | "rates" | "review" | "done";

export const SENDER_STEP_ORDER: SenderStep[] = [
  "intro", "package", "rates", "review", "done",
];

export type PackagingType = "box" | "envelope" | "tube";

export interface SenderParcel {
  length: number;
  width: number;
  height: number;
  weightOz: number;
  description: string;
  packaging: PackagingType;
}

export interface SenderResult {
  labelUrl: string;
  trackingNumber: string;
  publicCode: string | null;
  carrier: string;
  service: string;
}

// localStorage versioning per author-response non-blocking nit. Bump VERSION
// when the shape changes; reads tolerate version mismatch by returning null.
const STORAGE_KEY = "sendmo:sender:v1";
const STORAGE_VERSION = 1;

interface StoredSender {
  version: number;
  senderAddress: AddressInput;
  senderEmail: string;
}

export function loadSavedSender(): { senderAddress: AddressInput; senderEmail: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSender;
    if (parsed.version !== STORAGE_VERSION) return null;
    return { senderAddress: parsed.senderAddress, senderEmail: parsed.senderEmail };
  } catch {
    return null;
  }
}

export function saveSender(senderAddress: AddressInput, senderEmail: string): void {
  if (typeof window === "undefined") return;
  try {
    const payload: StoredSender = { version: STORAGE_VERSION, senderAddress, senderEmail };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be unavailable (Safari private mode, quota exceeded).
    // Silent — the save is a nice-to-have, not load-bearing.
  }
}

// "Preferred by {recipient}" badge: a rate is preferred if its EasyPost
// service matches the link's preferred_speed tier. Re-uses the canonical
// classifySpeedTier from @/lib/utils to keep the mapping in lockstep with
// the rest of the app (PLAYBOOK Rule 6: extend, don't invent).
export function speedTierForService(_carrier: string, service: string): "economy" | "standard" | "express" {
  return classifySpeedTier(service);
}

export function isPreferredRate(rate: ShippingRate, linkData: LinkData): boolean {
  if (!linkData.preferred_speed) return false;
  return speedTierForService(rate.carrier, rate.service) === linkData.preferred_speed;
}

// Drop-off copy keyed to the SELECTED rate's carrier, not the link's
// preferred carrier (reviewer non-blocking #3).
export function dropOffCopy(carrier: string): { body: string; locationUrl: string | null } {
  const c = (carrier || "").toLowerCase();
  if (c.includes("usps")) {
    return {
      body: "Drop off at any USPS Blue Box, Post Office, or hand to your mail carrier.",
      locationUrl: "https://tools.usps.com/find-location.htm",
    };
  }
  if (c.includes("ups")) {
    return {
      body: "Drop off at any UPS Store, UPS Drop Box, or UPS Access Point.",
      locationUrl: "https://www.ups.com/dropoff",
    };
  }
  if (c.includes("fedex")) {
    return {
      body: "Drop off at any FedEx location, FedEx Drop Box, or participating retailer.",
      locationUrl: "https://www.fedex.com/locate",
    };
  }
  if (c.includes("dhl")) {
    return {
      body: "Drop off at any DHL Service Point or scheduled pickup location.",
      locationUrl: "https://locator.dhl.com",
    };
  }
  return {
    body: `Drop off at any authorized ${carrier || "carrier"} location.`,
    locationUrl: null,
  };
}

export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
