import { useParams, Link } from "react-router-dom";
import AppHeader from "@/components/AppHeader";
import { useState, useEffect } from "react";
import { Package, Truck, CheckCircle2, AlertCircle, Clock, ArrowLeft, MapPin, Calendar } from "lucide-react";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

interface TrackingEvent {
  message: string;
  status: string;
  datetime: string;
  location: string | null;
}

interface TrackingData {
  tracking_number: string;
  carrier: string;
  service: string;
  status: string;
  estimated_delivery: string | null;
  events: TrackingEvent[];
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

function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function formatDeliveryDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

export default function TrackingPage() {
  const { trackingNumber } = useParams<{ trackingNumber: string }>();
  const [data, setData] = useState<TrackingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!trackingNumber) return;
    setLoading(true);
    // No auth header — tracking function is deployed with --no-verify-jwt
    fetch(`${BASE_URL}/functions/v1/tracking?number=${encodeURIComponent(trackingNumber)}`)
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
  const currentStepIndex = data ? TIMELINE_STEPS.indexOf(data.status) : -1;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader
        actions={
          <span className="text-sm text-muted-foreground">Track Package</span>
        }
      />

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
            <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ArrowLeft className="w-4 h-4" /> Back to SendMo
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
                  {data.estimated_delivery && data.status !== "delivered" && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Calendar className="w-3.5 h-3.5" />
                      Expected {formatDeliveryDate(data.estimated_delivery)}
                    </p>
                  )}
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

            {/* Progress bar */}
            <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
              <h2 className="text-sm font-semibold text-foreground mb-4">Progress</h2>
              <div className="space-y-0">
                {TIMELINE_STEPS.map((step, i) => {
                  const stepConfig = STATUS_CONFIG[step];
                  const StepIcon = stepConfig.icon;
                  const isComplete = i <= currentStepIndex;
                  const isCurrent = i === currentStepIndex;
                  return (
                    <div key={step} className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                          isComplete ? "bg-primary text-white" : "bg-muted text-muted-foreground"
                        } ${isCurrent ? "ring-2 ring-primary/30" : ""}`}>
                          <StepIcon className="w-4 h-4" />
                        </div>
                        {i < TIMELINE_STEPS.length - 1 && (
                          <div className={`w-0.5 h-8 ${i < currentStepIndex ? "bg-primary" : "bg-border"}`} />
                        )}
                      </div>
                      <div className="pt-1">
                        <p className={`text-sm font-medium ${isComplete ? "text-foreground" : "text-muted-foreground"}`}>
                          {stepConfig.label}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Live tracking events */}
            {data.events.length > 0 && (
              <div className="bg-card rounded-2xl border border-border shadow-sm p-6">
                <h2 className="text-sm font-semibold text-foreground mb-4">Tracking History</h2>
                <div className="space-y-0">
                  {data.events.map((event, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <div className={`w-2.5 h-2.5 rounded-full mt-1.5 ${
                          i === 0 ? "bg-primary" : "bg-border"
                        }`} />
                        {i < data.events.length - 1 && (
                          <div className="w-0.5 h-10 bg-border" />
                        )}
                      </div>
                      <div className="pb-4">
                        <p className={`text-sm ${i === 0 ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                          {event.message}
                        </p>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                          <span>{formatEventDate(event.datetime)}</span>
                          {event.location && (
                            <span className="flex items-center gap-0.5">
                              <MapPin className="w-3 h-3" />
                              {event.location}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ArrowLeft className="w-4 h-4" /> Back to SendMo
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
