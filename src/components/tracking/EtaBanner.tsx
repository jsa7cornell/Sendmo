// Pre-drop-off ETA banner. Reads server-authoritative promised_delivery_date; does not compute. Per 2026-05-19_unify-confirmation-into-tracking proposal, blocking finding #5.

import { carrierDisplayName } from "@/lib/utils";

interface EtaBannerProps {
  promisedDeliveryDate: string | null;  // ISO date string from tracking response
  carrier: string;                       // e.g. "USPS"
  service?: string;                      // formatted service display name, e.g. "Ground Advantage"
}

function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

export default function EtaBanner({ promisedDeliveryDate, carrier, service }: EtaBannerProps) {
  if (!promisedDeliveryDate) return null;

  const displayCarrier = carrierDisplayName(carrier);
  const formattedDate = formatShortDate(promisedDeliveryDate);
  const subline = service
    ? `${displayCarrier} ${service} · per carrier estimate`
    : `${displayCarrier} · per carrier estimate`;

  return (
    <div
      className="flex items-center gap-1.5 mt-1 mb-3.5 rounded-[14px] border border-[hsl(214,89%,80%)] pl-2 pr-3.5 py-2.5"
      style={{
        background: "linear-gradient(180deg, hsl(214, 89%, 96%) 0%, hsl(214, 89%, 94%) 100%)",
      }}
    >
      {/* Walking-person SVG scene */}
      <div className="shrink-0 w-[84px] h-14 flex items-center justify-center" aria-hidden="true">
        <svg viewBox="0 0 100 60" xmlns="http://www.w3.org/2000/svg" className="w-[84px] h-14">
          {/* Dashed ground line */}
          <line x1="5" y1="55" x2="95" y2="55" stroke="hsl(210, 14%, 70%)" strokeWidth="1" strokeDasharray="3 3" />
          {/* Motion lines */}
          <g stroke="hsl(214, 89%, 65%)" strokeWidth="1.5" strokeLinecap="round" opacity="0.55">
            <line x1="6" y1="22" x2="20" y2="22" />
            <line x1="10" y1="32" x2="22" y2="32" />
            <line x1="4" y1="42" x2="16" y2="42" />
          </g>
          {/* Person + package */}
          <g transform="translate(35,8)">
            {/* Head */}
            <circle cx="14" cy="7" r="5" fill="#f4d4b1" stroke="#3a3a3a" strokeWidth="0.8" />
            {/* Hair */}
            <path d="M9 5 Q14 1 19 5 L19 7 Q14 4 9 7 Z" fill="#3a3a3a" />
            {/* Torso */}
            <path d="M8 13 L20 13 L19 28 L9 28 Z" fill="#214b91" stroke="#13325a" strokeWidth="0.8" />
            {/* Left arm */}
            <path d="M9 15 L4 26" stroke="#f4d4b1" strokeWidth="2.4" strokeLinecap="round" />
            {/* Right arm (holding package) */}
            <path d="M19 15 L25 22" stroke="#f4d4b1" strokeWidth="2.4" strokeLinecap="round" />
            {/* Package (isometric box) */}
            <g transform="translate(22,18)">
              <path d="M0 4 L9 1 L9 11 L0 13 Z" fill="#c98e3e" stroke="#7d5520" strokeWidth="0.6" />
              <path d="M0 4 L9 1 L18 4 L9 7 Z" fill="#e5b06b" stroke="#7d5520" strokeWidth="0.6" />
              <path d="M9 7 L18 4 L18 11 L9 13 Z" fill="#b97c34" stroke="#7d5520" strokeWidth="0.6" />
              <rect x="2" y="1.5" width="5" height="3.5" rx="0.3" transform="skewY(-26)" fill="white" stroke="#214b91" strokeWidth="0.4" />
            </g>
            {/* Left leg */}
            <path d="M11 28 L7 42" stroke="#3a3a3a" strokeWidth="2.4" strokeLinecap="round" />
            {/* Right leg */}
            <path d="M17 28 L22 41" stroke="#3a3a3a" strokeWidth="2.4" strokeLinecap="round" />
            {/* Left foot */}
            <ellipse cx="6" cy="42" rx="2.6" ry="1.2" fill="#1a1a1a" />
            {/* Right foot */}
            <ellipse cx="23" cy="41" rx="2.6" ry="1.2" fill="#1a1a1a" />
          </g>
        </svg>
      </div>

      {/* Text body */}
      <div className="flex-1 text-[13px] leading-tight">
        <strong className="block text-[13.5px] text-foreground font-semibold">
          Drop off today → arrives{" "}
          <span className="text-primary font-bold">{formattedDate}</span>
        </strong>
        <span className="block text-[11px] text-muted-foreground mt-0.5">{subline}</span>
      </div>
    </div>
  );
}
