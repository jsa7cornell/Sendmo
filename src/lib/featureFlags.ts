// Client-side launch gates.

/**
 * How the seller ("SendMo for Sellers") entry points render.
 *
 * Three states rather than a boolean, because the seller flow reaches "worth
 * showing" before it reaches "able to take money": the buyer checkout runs in
 * test mode until the live-payment work lands, so a real buyer's card is
 * rejected. Shipping a visible-but-inert entry point is how the product gets
 * announced without anyone starting a sale that cannot complete.
 *
 *   'off'         — nothing renders. Vite inlines the flag at build time, so the
 *                   gated markup is eliminated from the bundle entirely.
 *   'coming-soon' — the entry point renders, badged, and is NOT interactive.
 *   'live'        — the entry point renders and navigates to /sell.
 *
 * Driven by the existing VITE_ENABLE_SELLER_LINK var so nothing already
 * documented breaks: "true" still means live. `/sell` itself is never gated —
 * it stays reachable by direct URL for testing in every mode.
 */
export type SellerLinkMode = "off" | "coming-soon" | "live";

function resolveSellerLinkMode(): SellerLinkMode {
  const raw = import.meta.env.VITE_ENABLE_SELLER_LINK;
  if (raw === "true") return "live";
  if (raw === "coming-soon") return "coming-soon";
  return "off";
}

export const SELLER_LINK_MODE: SellerLinkMode = resolveSellerLinkMode();

/** Whether a seller entry point should render at all (badged or clickable). */
export const SELLER_LINK_VISIBLE = SELLER_LINK_MODE !== "off";

/** Whether a seller entry point should actually navigate into the flow. */
export const SELLER_LINK_LIVE = SELLER_LINK_MODE === "live";
