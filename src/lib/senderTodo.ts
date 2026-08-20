// The one-line note on the payment summary saying what the other person still
// has to do. Copy decided by John, 2026-08-19, from a side-by-side mockup.
//
// Two decisions are baked in and both were corrections, not preferences:
//
//   "The person printing the label will…" rather than "They'll…" — "they" has
//   no antecedent on this screen for a creator who skipped the destination and
//   has never named anyone.
//
//   "We'll charge your card once they ship." replaced "You're only charged
//   when they ship — up to $100, never more." The old sentence was FALSE: the
//   cap bounds each use, not the link's lifetime (links/index.ts sets neither
//   expires_at nor max_shipments for flexible links), so a link used three
//   times bills three times. The cap now appears only in the Total row, where
//   "Up to $100" is scoped correctly to one shipment.
//
// Pure and exported so the sentence has one definition and a unit test,
// rather than being assembled inline in JSX across seven branches.

export interface DeferredFields {
  destination: boolean;
  origin: boolean;
  package: boolean;
}

const SUBJECT = "The person printing the label will";

export function senderTodoSentence(d: DeferredFields): string | null {
  const { destination, origin, package: pkg } = d;

  // Nothing deferred: a prepaid label, complete. The summary still renders —
  // it is the last thing a creator sees before paying — but there is no
  // outstanding work to describe.
  if (!destination && !origin && !pkg) return null;

  if (destination && origin && pkg) return `${SUBJECT} fill in the addresses and the package.`;
  if (destination && origin) return `${SUBJECT} add both addresses.`;
  if (destination && pkg) return `${SUBJECT} add the delivery address and describe the package.`;
  if (origin && pkg) return `${SUBJECT} add the ship-from address and describe the package.`;
  if (destination) return `${SUBJECT} add the delivery address.`;
  if (origin) return `${SUBJECT} add the ship-from address.`;
  return `${SUBJECT} describe the package.`;
}

/** Follows the sentence above; also shown alone on a fully-specced link. */
export const CHARGE_NOTE = "We'll charge your card once they ship.";
