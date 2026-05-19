// "Need help" mailto link for /t/<public_code> — rendered inside DetailsCard footer.
// Proposal: 2026-05-19_unify-confirmation-into-tracking — Key design decision #7 + John directive #3.
// Builds a pre-filled mailto:support@sendmo.co URL with shipment context.
// Body is capped at 1200 chars to avoid truncation on iOS Mail (proposal N7).

import { HelpCircle } from "lucide-react";

interface HelpLinkProps {
  shipmentContext: {
    trackingNumber: string;
    fromCity?: string;
    fromState?: string;
    toCity?: string;
    toState?: string;
    status?: string;            // e.g. "In transit (last scan Sacramento, CA)"
    deliveredAt?: string;       // ISO or pretty
  };
}

const MAX_BODY_CHARS = 1200;

function buildMailto(ctx: HelpLinkProps["shipmentContext"]): string {
  const subject = `Help with shipment ${ctx.trackingNumber}`;

  const lines: string[] = [
    "Hi SendMo,",
    "",
    "I need help with my shipment.",
    "",
    `Tracking: ${ctx.trackingNumber}`,
  ];

  const fromCity = ctx.fromCity?.trim();
  const fromState = ctx.fromState?.trim();
  const toCity = ctx.toCity?.trim();
  const toState = ctx.toState?.trim();

  if (fromCity || fromState) {
    lines.push(`From: ${[fromCity, fromState].filter(Boolean).join(", ")}`);
  }
  if (toCity || toState) {
    lines.push(`To: ${[toCity, toState].filter(Boolean).join(", ")}`);
  }
  if (ctx.status) {
    lines.push(`Status: ${ctx.status}`);
  }
  if (ctx.deliveredAt) {
    lines.push(`Delivered: ${ctx.deliveredAt}`);
  }

  lines.push("", "What I need:", "");

  let body = lines.join("\n");

  // Truncate cleanly to MAX_BODY_CHARS (N7: long bodies break on iOS Mail)
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
  }

  return `mailto:support@sendmo.co?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export default function HelpLink({ shipmentContext }: HelpLinkProps) {
  const href = buildMailto(shipmentContext);

  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 text-muted-foreground text-xs font-medium hover:text-primary hover:underline"
    >
      <HelpCircle size={12} />
      Need help
    </a>
  );
}
