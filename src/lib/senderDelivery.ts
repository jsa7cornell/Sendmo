// Delivery estimate copy for the sender's review screen.
//
// OQ2 of the 2026-08-19 flow-redesign proposal, resolved by the reviewer:
// show dates, HEDGED — "Estimated Aug 21–23", never a bare "Arrives Aug 21".
// A day count ("arrives in ~3 days") forces mental arithmetic at the moment
// the sender is choosing a speed; a date range answers the question they
// actually have. But `ShippingRate.estimated_days` carries no cutoff or
// guarantee semantics from the carrier, and an unhedged promise on the
// confirm screen is support load — with no support team to absorb it.
//
// The arithmetic is deliberately dumb. Carriers count business days and
// observe holidays; modelling either would invent precision the input does
// not have. Instead: plain calendar days from today, widened by a two-day
// tail, with the hedge word carrying the uncertainty. If that ever needs to
// be exact, the fix is a carrier-provided delivery date, not a better
// calendar here.
//
// Cutoff assumption, stated once: day 0 is the day the label is bought. A
// label bought after the carrier's daily pickup effectively starts the next
// day, which the two-day tail absorbs rather than models.

const TAIL_DAYS = 2;

function addDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

// LOCAL time throughout, deliberately. An earlier cut did the arithmetic
// with setDate/getDate (local) and read it back with getUTCDate + a UTC
// formatter — which pushes every evening order in a negative UTC offset to
// the following day. For California that is not an edge case, it is every
// order after 5pm. The user's "today" is their own.
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });

function monthOf(d: Date): string {
  return MONTH.format(d);
}

/**
 * "Estimated Aug 21–23", or null when the carrier gave no estimate — in
 * which case the caller renders nothing rather than guessing.
 *
 * `from` is injectable so the tests are not time-dependent; production passes
 * nothing and gets today.
 */
export function formatDeliveryEstimate(
  estimatedDays: number | null | undefined,
  from: Date = new Date(),
): string | null {
  if (estimatedDays === null || estimatedDays === undefined) return null;
  if (!Number.isFinite(estimatedDays) || estimatedDays < 0) return null;

  const earliest = addDays(from, Math.floor(estimatedDays));
  const latest = addDays(earliest, TAIL_DAYS);

  const sameMonth = monthOf(earliest) === monthOf(latest);
  return sameMonth
    ? `Estimated ${monthOf(earliest)} ${earliest.getDate()}–${latest.getDate()}`
    : `Estimated ${monthOf(earliest)} ${earliest.getDate()} – ${monthOf(latest)} ${latest.getDate()}`;
}
