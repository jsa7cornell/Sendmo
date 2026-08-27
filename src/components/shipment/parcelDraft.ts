import type { PackagingType } from "@/lib/types";

/**
 * Every parcel field, as strings — these are form inputs. The shape both
 * flows adapt their own state to before handing it to <ParcelQuestion>.
 *
 * Lives beside the component rather than inside it so the file that exports
 * the component exports only the component (react-refresh/only-export-components).
 */
export interface ParcelDraft {
  description: string;
  packaging: PackagingType;
  length: string;
  width: string;
  height: string;
  weightLbs: string;
  weightOz: string;
}

export const EMPTY_PARCEL_DRAFT: ParcelDraft = {
  description: "", packaging: "box",
  length: "", width: "", height: "", weightLbs: "", weightOz: "",
};

// ── Display formatting ───────────────────────────────────────
//
// One rule for how a parcel reads, because three surfaces print the same
// shipment: the creator's card (recipient/ShipmentDetails), and the sender's
// intro and review cards. Each had grown its own height rule, so a link whose
// prefill carried no height rendered "12×9 in" on the intro and "12×9×1 in"
// two screens later on review — the same parcel, described two ways, on the
// two screens that are supposed to be one object.
//
// Height is shown unless the packaging is flat, and unless we don't have one.
// An envelope has no meaningful third dimension; everything else does.

/** `12×9×4 in`, or `12×9 in` for an envelope or a height we don't have. */
export function formatParcelDims(p: {
  length: number;
  width: number;
  height?: number | null;
  packaging?: PackagingType | null;
}): string {
  const showHeight = p.packaging !== "envelope" && p.height != null && p.height > 0;
  return `${p.length}×${p.width}${showHeight ? `×${p.height}` : ""} in`;
}

/**
 * `2 lb` — pounds to two decimals, trailing zeros dropped.
 *
 * The creator's card deliberately does NOT use this: it prints "1 lb 8 oz",
 * echoing the two boxes they typed into. The sender never typed either, so a
 * single decimal number is the clearer read on both sender cards.
 */
export function formatParcelWeightLb(weightOz: number): string {
  return `${Number((weightOz / 16).toFixed(2))} lb`;
}
