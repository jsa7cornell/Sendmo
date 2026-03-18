import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── Carrier Display Normalization ──────────────────────────

const CARRIER_NAMES: Record<string, string> = {
  UPSDAP: "UPS", UPS: "UPS", UPSMI: "UPS Mail Innovations",
  FedExDefault: "FedEx", FedEx: "FedEx", FEDEX: "FedEx", FedExSmartPost: "FedEx Smart Post",
  USPS: "USPS",
  DhlEcs: "DHL eCommerce", DHLExpress: "DHL Express", DHL: "DHL",
  CanadaPost: "Canada Post", USAExportPBA: "USPS Export",
  Lasership: "LaserShip", OnTrac: "OnTrac",
};

export function carrierDisplayName(raw: string): string {
  return CARRIER_NAMES[raw] ?? raw;
}

// Known EasyPost service names → human-readable display names
const SERVICE_NAMES: Record<string, string> = {
  // USPS
  GroundAdvantage: "Ground Advantage",
  Groundadvantage: "Ground Advantage",
  First: "First Class",
  Priority: "Priority Mail",
  Express: "Priority Express",
  ParcelSelect: "Parcel Select",
  LibraryMail: "Library Mail",
  MediaMail: "Media Mail",
  // UPS
  Ground: "Ground",
  "3DaySelect": "3 Day Select",
  "2ndDayAir": "2nd Day Air",
  "2ndDayAirAM": "2nd Day Air AM",
  NextDayAir: "Next Day Air",
  NextDayAirSaver: "Next Day Air Saver",
  NextDayAirEarlyAM: "Next Day Air Early AM",
  Nextdayairearlyam: "Next Day Air Early AM",
  UPSGround: "Ground",
  UPSGroundSaverGreaterThan1lb: "Ground Saver",
  Upsgroundsavergreaterthan1lb: "Ground Saver",
  // FedEx
  FEDEX_GROUND: "Ground",
  GROUND_HOME_DELIVERY: "Home Delivery",
  FEDEX_2_DAY: "2 Day",
  FEDEX_2_DAY_AM: "2 Day AM",
  FEDEX_EXPRESS_SAVER: "Express Saver",
  STANDARD_OVERNIGHT: "Standard Overnight",
  PRIORITY_OVERNIGHT: "Priority Overnight",
  FIRST_OVERNIGHT: "First Overnight",
  "Fedex 2 Day Am": "2 Day AM",
  "First Overnight": "First Overnight",
  "Priority Overnight": "Priority Overnight",
};

export function serviceDisplayName(raw: string): string {
  if (SERVICE_NAMES[raw]) return SERVICE_NAMES[raw];
  // Fallback: split camelCase and underscores, then title-case
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")  // split camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")  // split consecutive caps
    .toLowerCase()
    .replace(/\b(\w)/g, (c) => c.toUpperCase());
}

// ─── Speed Tier Classification ──────────────────────────────

import type { SpeedTier } from "./types";

const SPEED_MAP: Record<string, SpeedTier> = {
  // USPS
  "GroundAdvantage": "economy", "Groundadvantage": "economy",
  "First": "standard",
  "Priority": "standard",
  "ParcelSelect": "economy",
  "Express": "express",
  // UPS (multiple casing variants from EasyPost test vs live)
  "Ground": "economy", "UPSGround": "economy",
  "UPSGroundSaverGreaterThan1lb": "economy", "Upsgroundsavergreaterthan1lb": "economy",
  "3DaySelect": "standard",
  "2ndDayAir": "express", "2ndDayAirAM": "express",
  "NextDayAir": "express", "NextDayAirSaver": "express",
  "NextDayAirEarlyAM": "express", "Nextdayairearlyam": "express",
  // FedEx
  "FEDEX_GROUND": "economy",
  "GROUND_HOME_DELIVERY": "economy",
  "FEDEX_2_DAY": "express", "FEDEX_2_DAY_AM": "express",
  "FEDEX_EXPRESS_SAVER": "express",
  "STANDARD_OVERNIGHT": "express",
  "PRIORITY_OVERNIGHT": "express", "FIRST_OVERNIGHT": "express",
};

export function classifySpeedTier(service: string): SpeedTier {
  for (const [key, tier] of Object.entries(SPEED_MAP)) {
    if (service.includes(key)) return tier;
  }
  return "standard";
}

// ─── Speed Tier Colors ──────────────────────────────────────

export const SPEED_TIER_COLORS: Record<SpeedTier, { bg: string; border: string; text: string; label: string }> = {
  economy: { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-700", label: "Economy" },
  standard: { bg: "bg-blue-50", border: "border-blue-300", text: "text-blue-700", label: "Standard" },
  express: { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-700", label: "Express" },
};

// ─── Empty Address Helper ───────────────────────────────────

import type { AddressInput } from "./types";

export const emptyAddress = (): AddressInput => ({
  name: "", street: "", city: "", state: "", zip: "",
});
