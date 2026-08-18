// Client-side launch gates.
//
// SELLER_LINK_ENABLED previously lived inside RecipientStepPathChoice — the
// component that carried the seller link's only door. That component is gone,
// and the seller entry point is now spread across three surfaces (homepage
// door, who-sending step link-out, Dashboard CTA), so the flag needs one home
// they can all read. Default OFF; flip VITE_ENABLE_SELLER_LINK="true" in the
// Vercel env (with SENDMO_LIVE_DEFAULT) to launch. Follows the existing
// VITE_SENDMO_LIVE_DEFAULT flag convention.
export const SELLER_LINK_ENABLED = import.meta.env.VITE_ENABLE_SELLER_LINK === "true";
