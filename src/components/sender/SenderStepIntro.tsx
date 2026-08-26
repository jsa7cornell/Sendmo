import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import ShipmentDetailsCard, { type DetailCell } from "@/components/shipment/ShipmentDetailsCard";
import { formatCents, type LinkData } from "@/lib/api";
import { carrierDisplayName, speedDisplayName } from "@/lib/utils";
import { displayName } from "@/lib/name";
import type { SenderQuestion } from "./senderState";

interface Props {
  linkData: LinkData;
  /** The questions this link actually leaves open — see planSenderSteps. */
  questions: SenderQuestion[];
  onContinue: () => void;
}

// SPEC §8 Step 0.
//
// 2026-08-26: the intro states the shipment instead of narrating the flow. It
// used to open on a headline, a city, and a numbered list of the questions
// still to come — so everything the creator had already decided (the parcel,
// the ship-from address, the speed and the cap they're paying for) stayed
// invisible until the review step, five taps later.
//
// The card is the same block the creator saw before they paid and the same one
// the sender sees again on review (components/shipment/ShipmentDetailsCard), so
// the sender's first and last screen are one object. Half of it is blank on
// arrival, and the blanks ARE the questions — the creator's copy says "Sender
// fills in", this one says "You'll add this", in the same italic. That is why
// the numbered list is gone: it named the same open questions, in the same
// order, a second time.
//
// Rule 7 still holds — the TO cell is city/state, never the delivery street.
// The price cap is deliberately an exception to Rule 7's sibling (the payer's
// money is not the sender's business): a cap is not what the recipient is
// spending, it is the budget they granted, and a sender who can see it can
// understand why a too-expensive parcel gets turned away at the rates step.
// Exact rates stay hidden.
export default function SenderStepIntro({ linkData, questions, onContinue }: Props) {
  const recipientName = displayName(linkData.recipient_name);
  const recipient = recipientName || "the recipient";
  const headline = recipientName
    ? `${recipientName} shared a prepaid shipping label with you`
    : "You've been sent a prepaid shipping label";

  const asks = new Set(questions);

  // ── FROM ──────────────────────────────────────────────────
  const origin = linkData.origin_prefill;
  const fromCell: DetailCell = asks.has("origin") || !origin?.street1
    ? { key: "from", deferred: "You'll add this" }
    : { key: "from", primary: displayName(origin.name) || origin.name || "—", secondary: origin.street1 };

  // ── TO ────────────────────────────────────────────────────
  // Deferred destinations are the sender's to choose; everything else is the
  // creator's own address, shown as city/state only.
  const cityState = linkData.recipient_city && linkData.recipient_state
    ? `${linkData.recipient_city}, ${linkData.recipient_state}`
    : "";
  const toCell: DetailCell = linkData.needs_destination
    ? { key: "to", deferred: "You choose" }
    : { key: "to", primary: recipient, secondary: cityState };

  // ── PARCEL ────────────────────────────────────────────────
  const pkg = linkData.package_prefill;
  const parcelCell: DetailCell = asks.has("package") || !pkg
    ? { key: "parcel", deferred: "You'll describe it" }
    : {
        key: "parcel",
        primary: `${pkg.length_in}×${pkg.width_in}${pkg.height_in ? `×${pkg.height_in}` : ""} in`,
        // Weight only, exactly as the review step prints it. "set by <name>"
        // was tried here and cut: three possessives in one small card, and
        // what actually makes a sender notice someone else guessed their box
        // is seeing the dimensions, not being told whose they are.
        secondary: pkg.weight_oz ? `${Number((pkg.weight_oz / 16).toFixed(2))} lb` : "",
      };

  // ── VIA ───────────────────────────────────────────────────
  // "or faster" is literal, not softening: the rates endpoint filters to the
  // preferred tier AND everything quicker (rates/index.ts speedRank check).
  const speed = linkData.preferred_speed
    ? `${speedDisplayName(linkData.preferred_speed)} or faster`
    : null;
  const carrier = linkData.preferred_carrier && linkData.preferred_carrier !== "any"
    ? `${carrierDisplayName(linkData.preferred_carrier)} only`
    : null;
  const viaCell: DetailCell = speed
    ? { key: "via", primary: speed, secondary: carrier ?? `${recipient}'s preference` }
    : carrier
      ? { key: "via", primary: carrier, secondary: `${recipient}'s preference` }
      : { key: "via", deferred: "You'll pick" };

  const cells: DetailCell[] = [fromCell, toCell, parcelCell, viaCell];

  // Full width, last — same slot and same treatment the creator's card gives
  // its estimated-cost range, which is the other number in this product that
  // needs the room. Absent on any link without a cap.
  if (linkData.max_price_cents > 0) {
    cells.push({
      key: "cap",
      label: "prepaid up to",
      wide: true,
      primary: formatCents(linkData.max_price_cents),
    });
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">{headline}</h1>
      </div>

      <div className="space-y-2">
        <ShipmentDetailsCard title="Shipment Details" cells={cells} />
        <p className="max-w-md text-xs text-muted-foreground">
          Shipping is prepaid by {recipient} — you're not charged.
        </p>
      </div>

      <Button
        onClick={onContinue}
        className="w-full rounded-xl shadow-sm text-base py-6"
      >
        Get Started
        <ArrowRight className="w-4 h-4 ml-1" />
      </Button>
    </div>
  );
}
