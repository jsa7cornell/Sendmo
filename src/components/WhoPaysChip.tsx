import { cn } from "@/lib/utils";

// The who-pays split as one chip with two variants: green "Buyer pays" on
// checkout-link surfaces, blue "You pay" on label-link surfaces. Extracted
// from SellerBuilder's inline chip (Direction A dashboard scrub) so the
// dashboard rows and the /sell header can't drift apart. Blue and green are
// the same semantic pair the homepage cards carry.
export default function WhoPaysChip({
  variant,
  className,
}: {
  variant: "buyer" | "you";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block text-xs font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full border",
        variant === "buyer"
          ? "text-emerald-700 bg-emerald-100 border-emerald-200"
          : "text-primary bg-primary/10 border-primary/20",
        className,
      )}
    >
      {variant === "buyer" ? "Buyer pays" : "You pay"}
    </span>
  );
}
