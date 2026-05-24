import { carrierDisplayName } from "@/lib/utils";

// Per-family Details renderer for /t/<public_code>.
// Decided 2026-05-13 — tracking-page-ia-polish.
//
// Each family has its own field set. The page renders one DetailsCard per
// view; the family prop drives which rows appear.
//
// Naming consistency: SendMo ID is the bold/blue identifier (the brand
// anchor); carrier "Tracking #" is demoted and only appears in F2 where
// the carrier has actually scanned it. F3 hides the carrier number entirely
// — it's a dead identifier post-void.

interface Props {
  family: 1 | 2 | 3;
  data: {
    public_code: string;
    tracking_number: string | null;
    carrier: string | null;
    service: string | null;
    item_description: string | null;
    from_city: string | null;
    from_state: string | null;
    to_city: string | null;
    to_state: string | null;
    created_at: string;
    cancelled_at?: string | null;
    is_test?: boolean;
  };
}

function formatLocation(city: string | null, state: string | null): string | null {
  if (!city && !state) return null;
  return [city, state].filter(Boolean).join(", ");
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-xs text-muted-foreground uppercase tracking-wider">{label}</dt>
      <dd className={`text-sm text-foreground ${mono ? "font-mono" : ""}`}>{value}</dd>
    </>
  );
}

export default function DetailsCard({ family, data }: Props) {
  const fromLoc = formatLocation(data.from_city, data.from_state);
  const toLoc = formatLocation(data.to_city, data.to_state);

  return (
    <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
      <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">Details</h3>
      <dl className="grid grid-cols-[110px_1fr] gap-y-2 items-baseline">
        <Row label="SendMo ID" value={<span className="font-bold text-primary tracking-wider">{data.public_code}</span>} mono />

        {data.item_description && <Row label="Item" value={data.item_description} />}

        {fromLoc && toLoc && <Row label="From → To" value={`${fromLoc} → ${toLoc}`} />}
        {fromLoc && !toLoc && <Row label="From" value={fromLoc} />}
        {!fromLoc && toLoc && <Row label="To" value={toLoc} />}

        {data.carrier && (
          <Row label="Carrier" value={data.service ? `${carrierDisplayName(data.carrier)} · ${data.service}` : carrierDisplayName(data.carrier)} />
        )}

        {/* F2 surfaces the carrier tracking # — actionable for "View on USPS".
            F1 hides it (not scanned yet — would 404). F3 hides it (dead number). */}
        {family === 2 && data.tracking_number && !data.is_test && (
          <Row label="Tracking #" value={<span className="break-all">{data.tracking_number}</span>} mono />
        )}

        {/* Timestamps differ per family. F1 says "Created"; F2 says "Shipped";
            F3 says "Label created" (NEVER "Shipped" — the package never went). */}
        {family === 1 && <Row label="Created" value={formatAbsolute(data.created_at)} />}
        {family === 2 && <Row label="Shipped" value={formatAbsolute(data.created_at)} />}
        {family === 3 && <Row label="Label created" value={formatAbsolute(data.created_at)} />}
      </dl>
    </div>
  );
}
