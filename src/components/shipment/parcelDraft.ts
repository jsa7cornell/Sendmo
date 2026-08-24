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
