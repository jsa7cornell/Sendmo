import { isPossiblePhoneNumber } from "https://esm.sh/libphonenumber-js@1.13.2";

// Phone is required on every shipping address — FedEx/UPS reject EasyPost
// label purchases without one (PHONENUMBER.EMPTY). `isPossiblePhoneNumber` is
// a length-plausibility check (US default; a leading '+' routes to the
// international check) — the server mirror of the client `isUsablePhone` in
// src/lib/phone.ts.
//
// Single source for every Edge Function that enforces the phone requirement
// (links POST/PATCH, rates) so the implementations cannot drift — audit
// finding 6, 2026-05-20_phone-required-flow-audit.md.
export function isUsablePhone(input: unknown): boolean {
    const s = String(input ?? "").trim();
    if (!s) return false;
    try {
        return isPossiblePhoneNumber(s, "US");
    } catch {
        return false;
    }
}
