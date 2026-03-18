import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Copy, Link2, MapPin, Zap, Shield, CreditCard,
  Package, Truck, CheckCircle2, ExternalLink, Settings,
  LogOut, User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import type { Shipment } from "@/lib/types";

// ─── Status config ──────────────────────────────────────────

type DisplayStatus = "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "return_to_sender" | "cancelled";

const STATUS_CONFIG: Record<DisplayStatus, { label: string; color: string; icon: typeof Package }> = {
  label_created: { label: "Label Created", color: "bg-purple-100 text-purple-700 border-purple-200", icon: Package },
  in_transit: { label: "In Transit", color: "bg-blue-100 text-blue-700 border-blue-200", icon: Truck },
  out_for_delivery: { label: "Out for Delivery", color: "bg-blue-100 text-blue-700 border-blue-200", icon: Truck },
  delivered: { label: "Delivered", color: "bg-green-100 text-green-700 border-green-200", icon: CheckCircle2 },
  return_to_sender: { label: "Returned", color: "bg-orange-100 text-orange-700 border-orange-200", icon: Package },
  cancelled: { label: "Cancelled", color: "bg-red-100 text-red-700 border-red-200", icon: Package },
};

// ─── Component ──────────────────────────────────────────────

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const [copied, setCopied] = useState(false);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loadingShipments, setLoadingShipments] = useState(true);
  const [showUserMenu, setShowUserMenu] = useState(false);

  // Fetch real shipments for the authenticated user
  useEffect(() => {
    async function fetchShipments() {
      if (!user) return;

      const { data, error } = await supabase
        .from("shipments")
        .select("*, sendmo_links!inner(user_id)")
        .eq("sendmo_links.user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (!error && data) {
        setShipments(data as Shipment[]);
      }
      setLoadingShipments(false);
    }

    fetchShipments();
  }, [user]);

  const shortUrl = "sendmo.co/s/k8Hj2mNp4x"; // placeholder until links are fetched

  function handleCopy() {
    navigator.clipboard.writeText(`https://${shortUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatCents(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="min-h-screen bg-gradient-to-b from-background to-muted/50"
    >
      <div className="container max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage your label links, payments, and shipments</p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" className="rounded-xl gap-2" onClick={() => window.location.href = "/onboarding"}>
              <Link2 className="w-4 h-4" />
              New Link
            </Button>

            {/* User menu */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
              >
                <User className="w-4 h-4 text-muted-foreground" />
                <span className="hidden sm:inline text-muted-foreground max-w-[160px] truncate">
                  {user?.email}
                </span>
              </button>

              {showUserMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowUserMenu(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute right-0 top-full mt-1 z-20 w-56 bg-card rounded-xl border border-border shadow-lg p-1"
                  >
                    <div className="px-3 py-2 border-b border-border mb-1">
                      <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                    </div>
                    <button
                      onClick={signOut}
                      className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/5 rounded-lg transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign out
                    </button>
                  </motion.div>
                </>
              )}
            </div>
          </div>
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
                <MapPin className="w-3 h-3" /> San Francisco, CA
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                <Zap className="w-3 h-3" /> Standard
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                <Shield className="w-3 h-3" /> Cap: $100
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
                <span className="text-[10px] font-bold text-white">VISA</span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">&bull;&bull;&bull;&bull; 4242</p>
                <p className="text-xs text-muted-foreground">Expires 12/29</p>
              </div>
            </div>

            {/* Balance */}
            <div className="flex items-center justify-between bg-muted/50 rounded-xl px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground">SendMo Balance</p>
                <p className="text-lg font-bold text-foreground">$0.00</p>
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

          {loadingShipments ? (
            <div className="p-12 text-center">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Loading shipments...</p>
            </div>
          ) : shipments.length === 0 ? (
            <div className="p-12 text-center">
              <Package className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No shipments yet</p>
              <p className="text-xs text-muted-foreground mt-1">When someone uses your label link, shipments will appear here</p>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-5 py-3 font-medium">Status</th>
                      <th className="px-5 py-3 font-medium">Carrier</th>
                      <th className="px-5 py-3 font-medium">Amount</th>
                      <th className="px-5 py-3 font-medium">Created</th>
                      <th className="px-5 py-3 font-medium">Tracking</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipments.map((s) => {
                      const statusCfg = STATUS_CONFIG[s.status] ?? STATUS_CONFIG.label_created;
                      const StatusIcon = statusCfg.icon;
                      return (
                        <tr key={s.id} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
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
                          <td className="px-5 py-3 font-medium">{formatCents(s.display_price_cents)}</td>
                          <td className="px-5 py-3 text-muted-foreground">{formatDate(s.created_at)}</td>
                          <td className="px-5 py-3">
                            {s.tracking_number ? (
                              <span className="text-primary text-xs font-mono flex items-center gap-1">
                                {s.tracking_number.slice(0, 14)}...
                                <ExternalLink className="w-3 h-3" />
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs">&mdash;</span>
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
                  const statusCfg = STATUS_CONFIG[s.status] ?? STATUS_CONFIG.label_created;
                  const StatusIcon = statusCfg.icon;
                  return (
                    <div key={s.id} className="p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{formatDate(s.created_at)}</span>
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          statusCfg.color,
                        )}>
                          <StatusIcon className="w-3 h-3" />
                          {statusCfg.label}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{s.carrier} — {s.service}</span>
                        <span className="font-medium text-foreground">{formatCents(s.display_price_cents)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}
