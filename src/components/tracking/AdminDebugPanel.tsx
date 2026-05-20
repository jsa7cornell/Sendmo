// Inline admin debug panel rendered at the bottom of /t/<public_code>.
// "Ask 4" of the tracking-page-ia-polish proposal. Hits the role-gated
// tracking-admin edge function — NOT the public /tracking response — so
// privileged fields are isolated behind their own auth check.
//
// Collapsible (<details>) so it doesn't dominate the page when not needed.
// Lazy fetch on first expand. Refresh button + refetch-from-EasyPost button.
import { useState } from "react";
import { ChevronRight, RefreshCw, ExternalLink, AlertCircle } from "lucide-react";
import { supabase as supabaseClient } from "@/lib/supabase";
import { fetchTrackingAdmin, type AdminTrackingPayload } from "@/lib/api";

interface Props {
  publicCode: string;
}

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return null;
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function Row({ label, value, mono, multiline }: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <>
      <dt className="text-mf text-muted-foreground">{label}</dt>
      <dd className={`${mono ? "font-mono" : ""} ${multiline ? "break-all" : "truncate"} text-foreground`}>
        {value ?? <span className="text-muted-foreground italic">null</span>}
      </dd>
    </>
  );
}

function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export default function AdminDebugPanel({ publicCode }: Props) {
  const [payload, setPayload] = useState<AdminTrackingPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load(refetch?: "easypost") {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session?.access_token) {
        throw new Error("Not signed in");
      }
      const data = await fetchTrackingAdmin(publicCode, {
        accessToken: session.access_token,
        refetch,
      });
      setPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Lazy-fetch on first expand. <details>'s native onToggle fires after the
  // open state changes; we hook the summary click instead to fire fetch
  // synchronously alongside the visual expand.
  function handleSummaryClick() {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && !payload && !loading) {
      load();
    }
  }

  return (
    <details
      open={open}
      className="mt-8 bg-card rounded-2xl border border-purple-200 shadow-sm overflow-hidden"
    >
      <summary
        className="cursor-pointer px-4 py-3 flex items-center justify-between gap-2 list-none select-none"
        onClick={(e) => { e.preventDefault(); handleSummaryClick(); }}
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-purple-100 text-purple-700 text-[10px] font-bold">A</span>
          Admin debug
          <span className="text-[10px] text-muted-foreground font-normal">(only visible to admins)</span>
        </span>
        <div className="flex items-center gap-2">
          {open && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); load(); }}
                className="text-xs border border-border rounded-lg px-2 py-1 text-foreground hover:bg-muted/40 inline-flex items-center gap-1"
                disabled={loading}
                aria-label="Refresh admin data"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); load("easypost"); }}
                className="text-xs border border-border rounded-lg px-2 py-1 text-foreground hover:bg-muted/40"
                disabled={loading}
              >
                ⟳ Refetch from EasyPost
              </button>
            </>
          )}
          <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        </div>
      </summary>

      {open && (
        <div className="p-4 space-y-4 text-xs border-t border-border">
          {loading && !payload && (
            <p className="text-muted-foreground italic">Loading admin data…</p>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Couldn't load admin data</p>
                <p className="text-muted-foreground">{error}</p>
              </div>
            </div>
          )}
          {payload && (
            <>
              {/* Identifiers */}
              <Section title="Identifiers">
                <dl className="grid grid-cols-[160px_1fr] gap-y-1">
                  <Row label="shipment.id" value={payload.identifiers.shipment_id} mono multiline />
                  <Row label="public_code" value={payload.identifiers.public_code} mono />
                  <Row label="tracking_number" value={payload.identifiers.tracking_number} mono multiline />
                  <Row label="easypost_shipment_id" value={payload.identifiers.easypost_shipment_id} mono multiline />
                  <Row label="easypost_tracker_id" value={payload.identifiers.easypost_tracker_id} mono multiline />
                  <Row label="stripe_payment_intent_id" value={payload.identifiers.stripe_payment_intent_id} mono multiline />
                  <Row label="cancel_token" value={payload.identifiers.cancel_token ?? "—"} mono />
                  <Row label="carrier_refund_id" value={payload.identifiers.carrier_refund_id} mono multiline />
                </dl>
              </Section>

              {/* Mode + state */}
              <Section title="Mode + state">
                <dl className="grid grid-cols-[160px_1fr] gap-y-1">
                  <Row label="is_test" value={String(payload.mode.is_test)} mono />
                  <Row label="is_live" value={String(payload.mode.is_live)} mono />
                  <Row label="payment_method" value={payload.mode.payment_method} />
                  <Row label="carrier" value={payload.mode.carrier} />
                  <Row label="service" value={payload.mode.service} />
                  <Row label="status" value={payload.state.status} mono />
                  <Row label="refund_status" value={payload.state.refund_status} mono />
                </dl>
              </Section>

              {/* Timeline */}
              <Section title="Timeline">
                <dl className="grid grid-cols-[160px_1fr] gap-y-1">
                  {(["created_at","updated_at","cancelled_at","refund_submitted_at","delivered_at","promised_delivery_date"] as const).map((k) => {
                    const v = payload.timeline[k];
                    const rel = relativeTime(v);
                    return (
                      <Row
                        key={k}
                        label={k}
                        value={v ? <>{v} <span className="text-muted-foreground">({rel})</span></> : null}
                        mono
                      />
                    );
                  })}
                </dl>
              </Section>

              {/* Parent link */}
              {payload.link && (
                <Section title="Parent link">
                  <dl className="grid grid-cols-[160px_1fr] gap-y-1">
                    <Row label="link.id" value={payload.link.id} mono multiline />
                    <Row label="short_code" value={payload.link.short_code} mono />
                    <Row label="link_type" value={payload.link.link_type} />
                    <Row label="status" value={payload.link.status} mono />
                    <Row label="user_id (owner)" value={payload.link.user_id} mono multiline />
                  </dl>
                </Section>
              )}

              {/* Parcel + money */}
              <Section title="Parcel + money">
                <dl className="grid grid-cols-[160px_1fr] gap-y-1">
                  <Row label="weight_oz" value={payload.parcel.weight_oz} mono />
                  <Row label="dimensions (in)" value={`${payload.parcel.length_in ?? "?"} × ${payload.parcel.width_in ?? "?"} × ${payload.parcel.height_in ?? "?"}`} mono />
                  <Row label="item_description" value={payload.parcel.item_description} multiline />
                  <Row label="rate_cents (carrier)" value={`${payload.money.rate_cents} (${dollars(payload.money.rate_cents)})`} mono />
                  <Row label="display_price_cents" value={`${payload.money.display_price_cents} (${dollars(payload.money.display_price_cents)})`} mono />
                </dl>
              </Section>

              {/* Transactions ledger */}
              <Section title={`Transactions ledger (${payload.transactions.length})`}>
                {payload.transactions.length === 0 ? (
                  <p className="text-muted-foreground italic">No ledger rows for this shipment.</p>
                ) : (
                  <table className="w-full font-mono border border-border rounded-lg overflow-hidden">
                    <thead className="bg-muted/50">
                      <tr className="text-muted-foreground text-[10px] text-left">
                        <th className="px-2 py-1.5">Type</th>
                        <th className="px-2 py-1.5 text-right">Amount</th>
                        <th className="px-2 py-1.5">Mode</th>
                        <th className="px-2 py-1.5">Idempotency key</th>
                        <th className="px-2 py-1.5">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payload.transactions.map((t) => (
                        <tr key={t.id} className="border-t border-border">
                          <td className="px-2 py-1.5 text-foreground">{t.type}</td>
                          <td className="px-2 py-1.5 text-right text-foreground">
                            {t.amount_cents} ({dollars(t.amount_cents)})
                          </td>
                          <td className="px-2 py-1.5 text-foreground">{t.mode}</td>
                          <td className="px-2 py-1.5 text-muted-foreground break-all">{t.idempotency_key ?? "—"}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{new Date(t.created_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              {/* Event log */}
              <Section title={`Event log (last ${payload.event_logs.length})`}>
                {payload.event_logs.length === 0 ? (
                  <p className="text-muted-foreground italic">No event_logs rows for this shipment.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-[11px]">
                    {payload.event_logs.map((e) => (
                      <li key={e.id} className="border border-border rounded px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`font-semibold ${e.severity === "error" ? "text-destructive" : e.severity === "warn" ? "text-amber-700" : "text-foreground"}`}>
                            {e.event_type}
                          </span>
                          <span className="text-muted-foreground">
                            {new Date(e.created_at).toLocaleString()}
                            {e.duration_ms != null && <> · {e.duration_ms}ms</>}
                          </span>
                        </div>
                        {Object.keys(e.properties || {}).length > 0 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-muted-foreground text-[10px]">properties</summary>
                            <pre className="mt-1 p-2 bg-muted/30 rounded text-[10px] whitespace-pre-wrap break-all">
                              {JSON.stringify(e.properties, null, 2)}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* EasyPost refetch result */}
              {payload.easypost && (
                <Section title="EasyPost — live shipment object">
                  <pre className="p-2 bg-muted/30 rounded text-[10px] whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
                    {JSON.stringify(payload.easypost.shipment, null, 2)}
                  </pre>
                </Section>
              )}

              {/* Footer — meta + deep link to /admin */}
              <div className="pt-3 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Queried {relativeTime(payload._meta.queried_at) ?? payload._meta.queried_at}</span>
                <a
                  href={`/admin?shipment=${encodeURIComponent(payload.identifiers.shipment_id)}`}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Open in /admin <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </>
          )}
        </div>
      )}
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="uppercase tracking-wider text-muted-foreground font-semibold mb-2 text-[10px]">{title}</h4>
      {children}
    </div>
  );
}
