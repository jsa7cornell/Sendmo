import { describe, it, expect } from "vitest";
import { deriveClientLiveMode } from "@/lib/mode";

// ─── Mirrored truth table — CLIENT half (review N4) ─────────────────
// This table deliberately mirrors the SERVER test in tests/unit/mode.test.ts
// (supabase/functions/_shared/mode.ts:resolveLiveMode). The two policies are
// hand-synced copies (Deno vs Vite can't share code); case names correspond
// 1:1 so a drift between the tables is visible at a glance.
//
// Semantics being mirrored:
//   admin  + test        → false   (server: isLive=false)
//   admin  + live_charge → true    (server: isLive=true)
//   admin  + live_comp   → true    ← INTENTIONAL client/server asymmetry:
//       client liveMode means "mount the live Stripe publishable key", and
//       comp mode buys a real live-mode label, so the client resolves true
//       (EXISTING behavior, preserved). The server's isLive is false for
//       comp (no charge) with isComp=true.
//   customer             → envLiveDefault (VITE_SENDMO_LIVE_DEFAULT)
//
// NOT mirrored here because it has no client-side equivalent: server-side,
// an ANONYMOUS caller always resolves test regardless of any env signal
// (decision on OQ3/N6). The client can't distinguish signed-out from
// customer (isAdmin=false either way) and doesn't need to — client liveMode
// only selects the publishable key; the server is the enforcement.

describe("deriveClientLiveMode — mirrored truth table (gate A)", () => {
  // ── Admin: toolbar decides, environment irrelevant ──
  describe("admin: adminActiveMode decides; envLiveDefault must not matter", () => {
    for (const envLiveDefault of [false, true]) {
      it(`admin + test → false (envLiveDefault=${envLiveDefault})`, () => {
        expect(
          deriveClientLiveMode({ isAdmin: true, adminActiveMode: "test", envLiveDefault }),
        ).toBe(false);
      });

      it(`admin + live_comp → true (envLiveDefault=${envLiveDefault})`, () => {
        // Existing behavior: comp mounts the LIVE publishable key (real
        // label, no charge). Server-side isLive is false for comp — see
        // header comment for why this asymmetry is intentional.
        expect(
          deriveClientLiveMode({ isAdmin: true, adminActiveMode: "live_comp", envLiveDefault }),
        ).toBe(true);
      });

      it(`admin + live_charge → true (envLiveDefault=${envLiveDefault})`, () => {
        expect(
          deriveClientLiveMode({ isAdmin: true, adminActiveMode: "live_charge", envLiveDefault }),
        ).toBe(true);
      });
    }
  });

  // ── Customer / signed-out: environment decides ──
  describe("customer: envLiveDefault decides; adminActiveMode must not matter", () => {
    it("customer + envLiveDefault=false → false (ship-inert default: env var unset ⇒ today's behavior)", () => {
      expect(
        deriveClientLiveMode({ isAdmin: false, adminActiveMode: "test", envLiveDefault: false }),
      ).toBe(false);
    });

    it("customer + envLiveDefault=true → true (prod: live publishable key)", () => {
      expect(
        deriveClientLiveMode({ isAdmin: false, adminActiveMode: "test", envLiveDefault: true }),
      ).toBe(true);
    });

    it("customer with stale live_charge adminActiveMode still follows envLiveDefault (isAdmin dominates)", () => {
      // Defensive: a de-roled admin (2026-06-27 incident class) whose local
      // state still says live_charge must be treated as a customer.
      expect(
        deriveClientLiveMode({ isAdmin: false, adminActiveMode: "live_charge", envLiveDefault: false }),
      ).toBe(false);
      expect(
        deriveClientLiveMode({ isAdmin: false, adminActiveMode: "live_charge", envLiveDefault: true }),
      ).toBe(true);
    });
  });
});
