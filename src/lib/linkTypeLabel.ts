// One label map for link_type across every surface (PR6, seller-link
// launch). Before this, LinksTab's two-branch ternary rendered seller links
// as "Flexible" and Admin's rendered them as "Full label" — opposite wrong
// answers from the same defect. A lookup with a fallback can't silently
// mislabel the next link type; surfaces style their badges locally.
export const LINK_TYPE_LABELS: Record<string, string> = {
  full_label: "Full label",
  flexible: "Flexible",
  seller_link: "Seller",
};

export function linkTypeLabel(linkType: string): string {
  return LINK_TYPE_LABELS[linkType] ?? linkType;
}

// User-facing lane names (Direction A dashboard scrub, 2026-08-31): users see
// the two product names — "Label link" (you pay) and "Checkout link" (buyer
// pays) — while the schema taxonomy above (full_label/flexible) stays on
// admin surfaces, where the distinction matters operationally.
export const USER_LINK_TYPE_LABELS: Record<string, string> = {
  full_label: "Label link",
  flexible: "Label link",
  seller_link: "Checkout link",
};

export function userLinkTypeLabel(linkType: string): string {
  return USER_LINK_TYPE_LABELS[linkType] ?? linkTypeLabel(linkType);
}
