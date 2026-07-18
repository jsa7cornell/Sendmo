import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams, Link } from "react-router-dom";
import { Printer, ArrowLeft, ExternalLink, AlertCircle, Info } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import HowToShipStrip from "@/components/tracking/HowToShipStrip";
import { Button } from "@/components/ui/button";
import { supabase as supabaseClient } from "@/lib/supabase";
import { logLabelPrint } from "@/lib/api";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

// Label print page (proposal 2026-07-17_label-print-page, decided 2026-07-17).
// Replaces the raw-file-in-a-tab Print flow with a SendMo-owned print page:
// layout presets, printer-config tips, drop-off strip, and an always-present
// raw-label fallback link that can't break.
//
// Verified fact the whole design rests on: the carrier label is a 4x6 PORTRAIT
// PNG at 300dpi (image/png, 1200x1800), hosted on S3 with NO CORS. So we place
// it in an <img> and size it with print CSS — no pdf.js, no fetch, no CORS.

type Preset = "half" | "label4x6" | "full";

const PRESET_KEY = "sendmo:printPreset";
const PRESETS: { id: Preset; label: string; hint: string }[] = [
  { id: "label4x6", label: "4×6 label", hint: "Native 4×6, top-left. The carrier label untouched — prints the same on any printer." },
  { id: "half", label: "Half sheet", hint: "Label rotated onto the top half of a Letter page — fold or tear, save paper." },
  { id: "full", label: "Full page", hint: "Enlarged to fill a Letter page — biggest and easiest to read." },
];

// Same sessionStorage key TrackingPage uses, so print-count logging carries the
// anonymous cancel-token identity proof when present.
function readCancelToken(publicCode: string): string | null {
  try {
    return sessionStorage.getItem(`sendmo:cancel_token:${publicCode}`);
  } catch {
    return null;
  }
}

interface PrintData {
  public_code: string;
  label_url: string | null;
  carrier: string | null;
  service: string | null;
  item_description?: string | null;
  is_test?: boolean;
}

export default function LabelPrintPage() {
  const { code } = useParams<{ code: string }>();
  const [data, setData] = useState<PrintData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // Screen-preview scale. The sheet is a physical 8.5in (816px @96dpi); cap the
  // preview at 0.44 on wide screens but shrink to fit narrow phones so the page
  // never scrolls horizontally (iPhone SE @320 would otherwise overflow ~55px).
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.44);
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Guard against transient 0-width measurements (mount / hidden / reflow):
    // clientWidth 0 would compute scale 0 and collapse the preview until the
    // next resize. Ignore non-positive widths and keep the prior scale.
    const compute = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(Math.min(0.44, w / (8.5 * 96)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    // Window listeners back up the observer for viewport/orientation changes.
    window.addEventListener("resize", compute);
    window.addEventListener("orientationchange", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
      window.removeEventListener("orientationchange", compute);
    };
  }, [data, imgFailed]);

  const [preset, setPreset] = useState<Preset>(() => {
    try {
      const saved = localStorage.getItem(PRESET_KEY);
      if (saved === "half" || saved === "label4x6" || saved === "full") return saved;
    } catch { /* localStorage unavailable — fall through to default */ }
    return "label4x6"; // default: the untouched carrier label. Half-sheet is
    // promoted to default once it's physically print+scan-proven (see LOG).
  });

  useEffect(() => {
    try { localStorage.setItem(PRESET_KEY, preset); } catch { /* no-op */ }
  }, [preset]);

  useEffect(() => {
    if (!code) return;
    setLoading(true);
    (async () => {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const headers: Record<string, string> = {};
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      return fetch(`${BASE_URL}/functions/v1/tracking?code=${encodeURIComponent(code)}`, { headers });
    })()
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Tracking not found");
        }
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [code]);

  const activeHint = useMemo(() => PRESETS.find((p) => p.id === preset)?.hint ?? "", [preset]);

  async function handlePrint() {
    // Fire-and-forget print-count log (optimistic on-click per decision OQ3).
    // Never block the print dialog on the network call.
    if (code) {
      (async () => {
        try {
          const { data: { session } } = await supabaseClient.auth.getSession();
          await logLabelPrint(code, {
            accessToken: session?.access_token,
            cancelToken: readCancelToken(code) ?? undefined,
          });
        } catch { /* logging is best-effort; printing proceeds regardless */ }
      })();
    }
    window.print();
  }

  const labelUrl = data?.label_url ?? null;

  return (
    <div className="min-h-screen bg-background">
      {/* Print CSS — screen shows a scaled Letter-sheet preview; print emits
          the real thing at physical inches. Isolation via visibility so only
          #print-root reaches the page. */}
      <style>{`
        @media screen {
          .paper {
            transform: scale(var(--s, 0.44));
            transform-origin: top left;
            background: #fff;
            box-shadow: 0 1px 8px rgba(0,0,0,0.15);
          }
          .preview-wrap {
            width: calc(8.5in * var(--s, 0.44));
            height: calc(11in * var(--s, 0.44));
            overflow: hidden;
            margin: 0 auto;
          }
        }
        .paper {
          position: relative;
          width: 8.5in;
          height: 11in;
        }
        .label-group { position: absolute; }
        .sheet-label4x6 .label-group { top: 0.5in; left: 0.5in; }
        .sheet-label4x6 .label-group img { width: 4in; height: 6in; display: block; }

        .sheet-half .label-group { top: 0.5in; left: 0.5in; }
        .sheet-half .rot-wrap {
          width: 6in; height: 4in;
          display: flex; align-items: center; justify-content: center;
        }
        /* 4x6 portrait img rotated 90deg about its centre fills a 6x4 box —
           no scaling, so the barcode stays at native size. */
        .sheet-half .rot-wrap img { width: 4in; height: 6in; transform: rotate(90deg); display: block; }
        .sheet-half .fold {
          position: absolute; top: 5.5in; left: 0.4in; right: 0.4in;
          border-top: 1px dashed #b0b0b0;
        }
        .sheet-half .fold span {
          position: absolute; top: -0.09in; right: 0; font-size: 8pt; color: #999; background: #fff; padding: 0 4px;
        }

        .sheet-full .label-group { inset: 0; display: flex; align-items: center; justify-content: center; }
        .sheet-full .label-group img { width: 6.667in; height: 10in; display: block; }

        /* Item description printed in the blank sheet area, never over the label.
           4x6: to the right of the label. Half-sheet: in the empty bottom half.
           Full-page: no room (label fills the sheet) → hidden. */
        .item-desc {
          position: absolute;
          font-family: system-ui, -apple-system, sans-serif;
          color: #111;
          box-sizing: border-box;
        }
        .item-desc .k {
          font-size: 9pt; text-transform: uppercase; letter-spacing: 0.04em; color: #666;
        }
        .item-desc .v { font-size: 13pt; font-weight: 600; margin-top: 2px; word-break: break-word; }
        .sheet-label4x6 .item-desc { top: 0.6in; left: 5in; width: 3in; }
        .sheet-half .item-desc { top: 6in; left: 0.5in; width: 7.5in; }
        .sheet-full .item-desc { display: none; }

        @media print {
          @page { size: letter portrait; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          body * { visibility: hidden !important; }
          #print-root, #print-root * { visibility: visible !important; }
          #print-root { position: absolute; top: 0; left: 0; }
          .paper { transform: none !important; box-shadow: none !important; }
          .preview-wrap { width: auto; height: auto; overflow: visible; margin: 0; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print">
        <AppHeader />
      </div>

      <main className="max-w-2xl mx-auto px-4 py-8">
        {loading && (
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center no-print">
            <div className="animate-pulse text-muted-foreground">Loading your label…</div>
          </div>
        )}

        {error && (
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center space-y-4 no-print">
            <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">Label not found</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ArrowLeft className="w-4 h-4" /> Back to SendMo
            </Link>
          </div>
        )}

        {data && !labelUrl && (
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center space-y-2 no-print">
            <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">No label to print yet</h2>
            <p className="text-sm text-muted-foreground">This shipment doesn't have a printable label.</p>
            <Link to={`/t/${code}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ArrowLeft className="w-4 h-4" /> Back to tracking
            </Link>
          </div>
        )}

        {data && labelUrl && (
          <div className="space-y-5" ref={contentRef}>
            {/* Header + back link */}
            <div className="no-print flex items-center justify-between">
              <h1 className="text-xl font-bold text-foreground">Print your label</h1>
              <Link to={`/t/${code}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <ArrowLeft className="w-4 h-4" /> Tracking
              </Link>
            </div>

            {data.is_test && (
              <div className="no-print bg-amber-50 border border-amber-300 rounded-xl p-3 text-xs text-amber-800">
                Test label — not a real shipment. Fine to print for a dry run.
              </div>
            )}

            {/* Preset picker */}
            <div className="no-print">
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPreset(p.id)}
                    aria-pressed={preset === p.id}
                    className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
                      preset === p.id
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{activeHint}</p>
            </div>

            {/* Preview (screen) → real sheet (print) */}
            {imgFailed ? (
              <div className="no-print bg-card rounded-2xl border border-border shadow-sm p-6 text-center space-y-3">
                <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto" />
                <p className="text-sm text-muted-foreground">
                  We couldn't render a preview here — but your label file is fine. Open it below and print from there.
                </p>
              </div>
            ) : (
              <div className="preview-wrap" id="print-root" style={{ ["--s" as string]: scale } as CSSProperties}>
                <div className={`paper sheet-${preset}`}>
                  <div className="label-group">
                    {preset === "half" ? (
                      <div className="rot-wrap">
                        <img src={labelUrl} alt="Shipping label" onError={() => setImgFailed(true)} />
                      </div>
                    ) : (
                      <img src={labelUrl} alt="Shipping label" onError={() => setImgFailed(true)} />
                    )}
                  </div>
                  {preset === "half" && (
                    <div className="fold"><span>fold / tear</span></div>
                  )}
                  {/* Item description printed in the blank sheet area (never over
                      the label). Hidden on full-page via CSS (no room). */}
                  {data.item_description && (
                    <div className="item-desc">
                      <div className="k">Contents</div>
                      <div className="v">{data.item_description}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Print button */}
            <div className="no-print">
              <Button className="w-full rounded-xl py-6 text-base font-semibold" onClick={handlePrint}>
                <Printer className="w-5 h-5 mr-2" /> Print label
              </Button>
            </div>

            {/* Printer-config tips */}
            <div className="no-print bg-card rounded-2xl border border-border shadow-sm p-5">
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold text-foreground">Printer settings that matter</h3>
              </div>
              <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-5">
                <li><span className="font-medium text-foreground">Scale: 100% / "Actual size"</span> — never "Fit to page." A shrunk barcode can fail to scan.</li>
                <li>Turn <span className="font-medium text-foreground">off</span> headers &amp; footers (date/URL) in the print dialog.</li>
                <li>Paper size <span className="font-medium text-foreground">Letter</span>, portrait. Any printer works — no label printer needed.</li>
                <li>Black &amp; white is fine. Make sure the barcode prints crisp and unsmudged.</li>
              </ul>
            </div>

            {/* Always-present raw-label fallback (decision OQ4/OQ5) — a dumb
                link that can't break, guarding every failure mode above. */}
            <div className="no-print rounded-2xl border border-dashed border-border p-4 text-sm">
              <p className="text-muted-foreground">
                Trouble printing?{" "}
                <a
                  href={labelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    if (code) {
                      supabaseClient.auth.getSession().then(({ data: { session } }) =>
                        logLabelPrint(code, {
                          accessToken: session?.access_token,
                          cancelToken: readCancelToken(code) ?? undefined,
                        }).catch(() => { /* best-effort */ }),
                      );
                    }
                  }}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  Open the raw label file <ExternalLink className="w-3.5 h-3.5" />
                </a>{" "}
                and print or save it with your browser.
              </p>
            </div>

            {/* Drop-off guidance (reused) */}
            <div className="no-print">
              <HowToShipStrip carrier={data.carrier} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
