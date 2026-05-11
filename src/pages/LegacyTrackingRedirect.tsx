import { useParams, useNavigate, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { AlertCircle, ArrowLeft } from "lucide-react";
import AppHeader from "@/components/AppHeader";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

/**
 * Redirects old `/track/<carrier_tracking_number>` URLs (which are in
 * every tracking-update email sent before 2026-05-11) to the canonical
 * `/t/<public_code>` URL. Single-render redirect via `navigate(... { replace: true })`
 * so the browser back button doesn't get a useless intermediate entry.
 *
 * If the lookup fails (number not found in DB or the response is missing
 * a public_code — shouldn't happen after migrations 014/015), render an
 * error state. We do NOT fall back to rendering the old TrackingPage
 * under the legacy URL because that path now requires a public_code.
 */
export default function LegacyTrackingRedirect() {
  const { trackingNumber } = useParams<{ trackingNumber: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!trackingNumber) return;
    fetch(`${BASE_URL}/functions/v1/tracking?number=${encodeURIComponent(trackingNumber)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Tracking number not found");
        }
        return res.json();
      })
      .then((data: { public_code?: string }) => {
        if (!data.public_code) {
          throw new Error("Tracking number not found");
        }
        navigate(`/t/${data.public_code}`, { replace: true });
      })
      .catch((err: Error) => setError(err.message));
  }, [trackingNumber, navigate]);

  if (error) {
    return (
      <div className="min-h-screen bg-background">
        <AppHeader actions={<span className="text-sm text-muted-foreground">Track Package</span>} />
        <main className="max-w-2xl mx-auto px-4 py-8">
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center space-y-4">
            <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">Tracking not found</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ArrowLeft className="w-4 h-4" /> Back to SendMo
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader actions={<span className="text-sm text-muted-foreground">Track Package</span>} />
      <main className="max-w-2xl mx-auto px-4 py-8">
        <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center">
          <div className="animate-pulse text-muted-foreground">Redirecting to tracking page…</div>
        </div>
      </main>
    </div>
  );
}
