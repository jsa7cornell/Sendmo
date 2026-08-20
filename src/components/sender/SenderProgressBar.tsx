import { Package, Truck, ClipboardCheck } from "lucide-react";
import type { LinkData } from "@/lib/api";
import MorphProgressBar, { type ProgressSegment } from "@/components/recipient/MorphProgressBar";
import { senderScenario, collectionStepLabel } from "@/lib/senderScenario";
import { SENDER_STEP_ORDER, type SenderStep } from "./senderState";

// The sender's progress bar — now the same component the creator sees, per
// §3 PR 3 of the 2026-08-19 flow-redesign proposal. Two bars with two sets of
// state semantics was the thing that made the flow feel like two products;
// one component means "done" looks like "done" on both sides of the link.
//
// The first segment's LABEL is computed from what this particular link left
// unfilled — "Package" when only the parcel is missing, "Your info" when the
// origin is too, "Destination & info" when nothing was prefilled. The sender
// is told what THEY have to do, not what the creator did or didn't do.
//
// No skipped state: a sender fills in everything they are asked for.
//
// Intro renders no bar (the welcome screen is its own moment) — unchanged
// from the previous bar, and still what SPEC §8 specifies.
export default function SenderProgressBar({
  step, linkData,
}: {
  step: SenderStep;
  linkData: LinkData;
}) {
  if (step === "intro") return null;

  const segments: ProgressSegment[] = [
    { icon: Package, label: collectionStepLabel(senderScenario(linkData)) },
    { icon: Truck, label: "Shipping" },
    { icon: ClipboardCheck, label: "Review" },
  ];

  // The bar covers the three form steps; intro is excluded from both the
  // segment list and the index maths so they cannot disagree.
  const formSteps = SENDER_STEP_ORDER.filter((s) => s !== "intro");
  const activeIndex = formSteps.indexOf(step);

  return (
    <MorphProgressBar
      segments={segments}
      activeIndex={activeIndex}
      completedIndexes={formSteps.map((_, i) => i).filter((i) => i < activeIndex)}
    />
  );
}
