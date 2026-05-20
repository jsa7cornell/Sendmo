// ─── Phone formatting + validation ──────────────────────────
//
// Wraps libphonenumber-js (Google's libphonenumber, JS port) so the phone
// field can format as the user types and accept international numbers.
//
// Why a library: hand-rolled international phone formatting is a known
// rabbit hole (every country has a different grouping/length). libphonenumber-js
// is the canonical, extensible answer — adding it satisfies Rule 6 (it's the
// standard, not a one-off).
//
// Country model: default 'US'. A leading '+' makes AsYouType / parsing drop
// the US assumption and format per the detected country code — so US users
// type bare digits and the rare international user types +44…, no country
// dropdown needed.

import { AsYouType, isPossiblePhoneNumber } from "libphonenumber-js";

const DEFAULT_COUNTRY = "US" as const;

/**
 * Progressive "format as you type" formatting.
 *
 *   "4086790449"      → "(408) 679-0449"
 *   "+442079460958"   → "+44 20 7946 0958"
 *
 * `isDeletion` should be true when the change came from a Backspace/Delete
 * (the caller reads it off `InputEvent.inputType`). On deletion we pass the
 * input through raw — reformatting on delete re-inserts separators and traps
 * the cursor ("can't backspace past the space"). Typing AND pasting both
 * format (a pasted intl number replacing a US one still formats correctly —
 * the earlier length-based heuristic mis-classified a shorter paste as a
 * deletion).
 */
export function formatPhoneAsYouType(input: string, isDeletion: boolean = false): string {
  if (isDeletion) return input;
  return new AsYouType(DEFAULT_COUNTRY).input(input);
}

/**
 * True when the input is a plausible phone number. Uses isPossiblePhoneNumber
 * (length-plausible) rather than isValidPhoneNumber (full real-number check) —
 * "possible" is the right bar for a form field. US-default; '+' prefix routes
 * to the international check.
 */
export function isUsablePhone(input: string | undefined | null): boolean {
  const s = String(input ?? "").trim();
  if (!s) return false;
  try {
    return isPossiblePhoneNumber(s, DEFAULT_COUNTRY);
  } catch {
    return false;
  }
}
