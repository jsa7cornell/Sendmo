import { useState } from "react";
import {
  Copy, Link2, MapPin, Zap, Shield, CreditCard,
  Package, Truck, CheckCircle2, ExternalLink, Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ─── Mock Data (replace with Supabase queries when auth ships) ──

const MOCK_LINK = {
  shortCode: "k8Hj2mNp4x",
  status: "active" as const,
  speed: "Standard",
  distance: "Regional",
  priceCap: "$100",
  insurance: "None",
  destination: "San Francisco, CA",
};

const MOCK_WALLET = {
  cardBrand: "Visa",
  cardLast4: "4242",
  cardExpiry: "12/29",
  balance: "$0.00",
};

type ShipmentStatus = "label_created" | "in_transit" | "delivered";

interface MockShipment {
  id: string;
  sendmoId: string;
  from: string;
  status: ShipmentStatus;
  carrier: string;
  service: string;
  amount: string;
  created: string;
  tracking: string | null;
}

const MOCK_SHIPMENTS: MockShipment[] = [
  {
    id: "1", sendmoId: "SM-20260318-001",
    from: "John D. — San Francisco, CA",
    status: "delivered", carrier: "USPS", service: "Priority Mail",
    amount: "$9.19", created: "Mar 15, 2026", tracking: "9400111899223456789012",
  },
  {
    id: "2", sendmoId: "SM-20260317-002",
    from: "Sarah K. — Oakland, CA",
    status: "in_transit", carrier: "UPS", service: "Ground",
    amount: "$7.18", created: "Mar 17, 2026", tracking: "1Z999AA10123456784",
  },
  {
    id: "3", sendmoId: "SM-20260318-003",
    from: "Mike R. — Palo Alto, CA",
    status: "label_created", carrier: "FedEx", service: "Home Delivery",
    amount: "$12.45", created: "Mar 18, 2026", tracking: null,
  },
];

const STATUS_CONFIG: Record<ShipmentStatus, { label: string; color: string; icon: typeof Package }> = {
  label_created: { label: "Label Created", color: "bg-purple-100 text-purple-700 border-purple-200", icon: Package },
  in_transit: { label: "In Transit", color: "bg-blue-100 text-blue-700 border-blue-200", icon: Truck },
  delivered: { label: "Delivered", color: "bg-green-100 text-green-700 border-green-200", icon: CheckCircle2 },
};

// ─── Component ──────────────────────────────────────────────

export default function Dashboard() {
  const [copied, setCopied] = useState(false);
  const link = MOCK_LINK;
  const wallet = MOCK_WALLET;
  const shipments = MOCK_SHIPMENTS;

  const shortUrl = `sendmo.co/s/${link.shortCode}`;

  function handleCopy() {
    navigator.clipboard.writeText(`https://${shortUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <div className="container max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage your label links, payments, and shipments</p>
          </div>
          <Button variant="outline" className="rounded-xl gap-2" onClick={() => window.location.href = "/onboarding"}>
            <Link2 className="w-4 h-4" />
            New Link
          </Button>
        </div>

        {/* Top row: Link + Wallet */}
        <div className="grid gap-5 md:grid-cols-2 mb-8">
          {/* My Label Link */}
          <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Link2 className="w-4 h-4 text-primary" />
                My Label Link
              </h2>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs border-success/50 text-success bg-success/10">
                  Active
                </Badge>
                <button className="text-muted-foreground hover:text-foreground transition-colors">
                  <Settings className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Link URL */}
            <div className="flex items-center gap-2 bg-muted/50 rounded-xl px-3 py-2.5 mb-4">
              <span className="text-sm font-mono text-foreground flex-1 truncate">{shortUrl}</span>
              <Button variant="ghost" size="sm" onClick={handleCopy} className="rounded-lg gap-1.5 shrink-0">
                <Copy className="w-3.5 h-3.5" />
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>

            {/* Preference pills */}
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                <MapPin className="w-3 h-3" /> {link.destination}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                <Zap className="w-3 h-3" /> {link.speed}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                <Shield className="w-3 h-3" /> Cap: {link.priceCap}
              </span>
            </div>
          </div>

          {/* My Wallet */}
          <div className="bg-card rounded-2xl border border-border shadow-sm p-5">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4">
              <CreditCard className="w-4 h-4 text-primary" />
              My Wallet
            </h2>

            {/* Card on file */}
            <div className="flex items-center gap-3 bg-muted/50 rounded-xl px-4 py-3 mb-3">
              <div className="w-10 h-7 rounded bg-gradient-to-br from-blue-600 to-blue-800 flex items-center justify-center">
                <span className="text-[10px] font-bold text-white">{wallet.cardBrand.toUpperCase()}</span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">•••• {wallet.cardLast4}</p>
                <p className="text-xs text-muted-foreground">Expires {wallet.cardExpiry}</p>
              </div>
            </div>

            {/* Balance */}
            <div className="flex items-center justify-between bg-muted/50 rounded-xl px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground">SendMo Balance</p>
                <p className="text-lg font-bold text-foreground">{wallet.balance}</p>
              </div>
              <Badge variant="outline" className="text-xs">Coming Soon</Badge>
            </div>
          </div>
        </div>

        {/* Shipments Table */}
        <div className="bg-card rounded-2xl border border-border shadow-sm">
          <div className="p-5 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Package className="w-4 h-4 text-primary" />
              Shipments
            </h2>
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-5 py-3 font-medium">ID</th>
                  <th className="px-5 py-3 font-medium">From</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Carrier</th>
                  <th className="px-5 py-3 font-medium">Amount</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                  <th className="px-5 py-3 font-medium">Tracking</th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => {
                  const statusCfg = STATUS_CONFIG[s.status];
                  const StatusIcon = statusCfg.icon;
                  return (
                    <tr key={s.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{s.sendmoId}</td>
                      <td className="px-5 py-3">{s.from}</td>
                      <td className="px-5 py-3">
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
                          statusCfg.color,
                        )}>
                          <StatusIcon className="w-3 h-3" />
                          {statusCfg.label}
                        </span>
                      </td>
                      <td className="px-5 py-3">{s.carrier} — {s.service}</td>
                      <td className="px-5 py-3 font-medium">{s.amount}</td>
                      <td className="px-5 py-3 text-muted-foreground">{s.created}</td>
                      <td className="px-5 py-3">
                        {s.tracking ? (
                          <button className="text-primary hover:underline text-xs font-mono flex items-center gap-1">
                            {s.tracking.slice(0, 10)}…
                            <ExternalLink className="w-3 h-3" />
                          </button>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-border/50">
            {shipments.map((s) => {
              const statusCfg = STATUS_CONFIG[s.status];
              const StatusIcon = statusCfg.icon;
              return (
                <div key={s.id} className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono text-muted-foreground">{s.sendmoId}</span>
                    <span className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      statusCfg.color,
                    )}>
                      <StatusIcon className="w-3 h-3" />
                      {statusCfg.label}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{s.from}</p>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{s.carrier} — {s.service}</span>
                    <span className="font-medium text-foreground">{s.amount}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Empty state (shown when no shipments) */}
          {shipments.length === 0 && (
            <div className="p-12 text-center">
              <Package className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No shipments yet</p>
              <p className="text-xs text-muted-foreground mt-1">When someone uses your label link, shipments will appear here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
