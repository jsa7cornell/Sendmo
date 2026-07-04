// ─── Client live-mode derivation — gate A ───────────────────────────
// Proposal: 2026-07-04_customer-live-payments (§3.3 + review N4).
//
// This is the CLIENT half of a deliberately duplicated policy. The server
// half lives in supabase/functions/_shared/mode.ts (resolveLiveMode) and
// cannot be shared with this file (Deno vs Vite/import.meta.env), so each
// side carries a mirrored truth-table unit test asserting the same
// semantics:
//   client → tests/unit/clientMode.test.ts
//   server → tests/unit/mode.test.ts
// If you change the policy here, change it there (and both tests).
//
// What client liveMode MEANS: "mount the LIVE Stripe publishable key"
// (getStripeForMode) + render admin mode badges. It is NOT the money
// decision — the server independently re-derives mode for every charge
// (PLAYBOOK Rule 14; the client value is at most a hint).
//
// One intentional client/server asymmetry: admin live_comp resolves
// liveMode=true here (comp buys a real live-mode label, so Elements must
// mount the live publishable key) while the server's isLive is false for
// comp (no charge). Existing behavior, preserved.

export type AdminMode = "test" | "live_comp" | "live_charge";

export function deriveClientLiveMode({
  isAdmin,
  adminActiveMode,
  envLiveDefault,
}: {
  isAdmin: boolean;
  adminActiveMode: AdminMode;
  envLiveDefault: boolean;
}): boolean {
  if (isAdmin) {
    // Admin: the toolbar decides, environment is irrelevant — admins keep
    // explicit test/comp/charge control for dogfooding.
    return adminActiveMode === "live_comp" || adminActiveMode === "live_charge";
  }
  // Customer (or signed-out visitor): the environment decides.
  // VITE_SENDMO_LIVE_DEFAULT="true" is set only on the production Vercel
  // deploy; unset (local/preview) everyone stays on the test key.
  // Signed-out visitors getting envLiveDefault is correct — the SERVER is
  // the enforcement and refuses anonymous live charges unconditionally.
  return envLiveDefault;
}
