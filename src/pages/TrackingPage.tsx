import { useParams, Link } from "react-router-dom";
import { useState, useEffect } from "react";
import { Package, Truck, CheckCircle2, AlertCircle, Clock, ArrowLeft } from "lucide-react";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

interface TrackingData {
  tracking_number: string;
  carrier: string;
  service: string;
  status: string;
  created_at: string;
  updated_at: string;
}

const STATUS_CONFIG: Record<string, { label: string; icon: typeof Package; color: string; bgColor: string }> = {
  label_created: { label: "Label Created", icon: Clock, color: "text-muted-foreground", bgColor: "bg-muted" },
  in_transit: { label: "In Transit", icon: Truck, color: "text-primary", bgColor: "bg-primary/10" },
  out_for_delivery: { label: "Out for Delivery", icon: Truck, color: "text-success", bgColor: "bg-success/10" },
  delivered: { label: "Delivered", icon: CheckCircle2, color: "text-success", bgColor: "bg-success/10" },
  return_to_sender: { label: "Returned", icon: AlertCircle, color: "text-destructive", bgColor: "bg-destructive/10" },
  cancelled: { label: "Cancelled", icon: AlertCircle, color: "text-destructive", bgColor: "bg-destructive/10" },
};

const TIMELINE_STEPS = ["label_created", "in_transit", "out_for_delivery", "delivered"];

export default function TrackingPage() {
  const { trackingNumber } = useParams<{ trackingNumber: string }>();
  const [data, setData] = useState<TrackingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!trackingNumber) return;
    setLoading(true);
    fetch(`${BASE_URL}/functions/v1/tracking?number=${encodeURIComponent(trackingNumber)}`, {
      headers: { Authorization: `Bearer ${ANON_KEY}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Tracking number not found");
        }
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [trackingNumber]);

  const config = data ? STATUS_CONFIG[data.status] || STATUS_CONFIG.label_created : null;
  const StatusIcon = config?.icon || Package;

  // Determine which timeline steps are complete
  const currentStepIndex = data ? TIMELINE_STEPS.indexOf(data.status) : -1;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/" className="text-primary font-bold text-xl tracking-tight">SendMo</Link>
          <span className="text-muted-foreground text-sm">/ Track Package</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        {loading && (
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center">
            <div className="animate-pulse text-muted-foreground">Looking up tracking information...</div>
          </div>
        )}

        {error && (
          <div className="bg-card rounded-2xl border border-border shadow-sm p-8 text-center space-y-4">
            <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">Tracking not found</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Link
              to="/"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to SendMo
            </Link>
          </div>
        )}

        {data && config && (
          <div className="space-y-6">
            {/* Status card */}
            <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
              <div className="flex items-center gap-4 mb-6">
                <div className={`w-14 h-14 rounded-xl ${config.bgColor} flex items-center justify-center`}>
                  <StatusIcon className={`w-7 h-7 ${config.color}`} />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-foreground">{config.label}</h1>
                  <p className="text-sm text-muted-foreground">
                    Last updated {new Date(data.updated_at).toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Details */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Tracking Number</span>
                  <p className="text-sm font-semibold text-primary mt-1 break-all">{data.tracking_number}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Carrier</span>
                  <p className="text-sm font-medium text-foreground mt-1">{data.carrier}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Service</span>
                  <p className="text-sm font-medium text-foreground mt-1">{data.service}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Shipped</span>
                  <p className="text-sm font-medium text-foreground mt-1">
                    {new Date(data.created_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
              <h2 className="text-sm font-semibold text-foreground mb-4">Shipment Timeline</h2>
              <div className="space-y-0">
                {TIMELINE_STEPS.map((step, i) => {
                  const stepConfig = STATUS_CONFIG[step];
                  const StepIcon = stepConfig.icon;
                  const isComplete = i <= currentStepIndex;
                  const isCurrent = i === currentStepIndex;
                  return (
                    <div key={step} className="flex items-start gap-3">
                      {/* Line + dot */}
                      <div className="flex flex-col items-center">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center ${
                            isComplete ? "bg-primary text-white" : "bg-muted text-muted-foreground"
                          } ${isCurrent ? "ring-2 ring-primary/30" : ""}`}
                        >
                          <StepIcon className="w-4 h-4" />
                        </div>
                        {i < TIMELINE_STEPS.length - 1 && (
                          <div
                            className={`w-0.5 h-8 ${
                              i < currentStepIndex ? "bg-primary" : "bg-border"
                            }`}
                          />
                        )}
                      </div>
                      {/* Label */}
                      <div className="pt-1">
                        <p
                          className={`text-sm font-medium ${
                            isComplete ? "text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          {stepConfig.label}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <Link
              to="/"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to SendMo
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
