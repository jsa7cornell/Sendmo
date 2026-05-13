import { loadStripe, type Stripe } from "@stripe/stripe-js";

// Mode-aware Stripe.js loader. One Promise<Stripe | null> cached per mode so
// `loadStripe` doesn't re-fetch the SDK on every remount. Phase B introduces
// the live-mode key for saved cards on the Dashboard, and Phase C/D will
// reuse this helper for live shipment charges (replacing the hardcoded
// `VITE_STRIPE_PUBLISHABLE_KEY_TEST` import that lived in StripePaymentForm).

const promises: { test: Promise<Stripe | null> | null; live: Promise<Stripe | null> | null } = {
  test: null,
  live: null,
};

export function getStripeForMode(liveMode: boolean): Promise<Stripe | null> {
  const key = liveMode ? "live" : "test";
  if (promises[key]) return promises[key]!;

  const envKey = liveMode
    ? (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY_LIVE as string | undefined)
    : (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY_TEST as string | undefined);

  if (!envKey) {
    console.error(
      `VITE_STRIPE_PUBLISHABLE_KEY_${liveMode ? "LIVE" : "TEST"} is not set`,
    );
    promises[key] = Promise.resolve(null);
    return promises[key]!;
  }

  promises[key] = loadStripe(envKey);
  return promises[key]!;
}
