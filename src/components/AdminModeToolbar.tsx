import { useState } from "react";
import { useAuth, type AdminMode } from "@/contexts/AuthContext";

// Global admin mode toolbar (Phase B B2 fix, 2026-05-13). Backed by
// profiles.admin_active_mode + the set_admin_active_mode() RPC — never
// trusts client state for mode. Three modes:
//   - Test         (default): EasyPost TEST + Stripe TEST
//   - Live Comp    (amber): EasyPost LIVE, no Stripe charge
//   - Live Charge  (red): EasyPost LIVE + real Stripe charge
//
// Rendered in two surfaces because the app has two header conventions:
//   (a) AppHeader.tsx for pages that use the shared shell
//   (b) Dashboard.tsx (and similar) which have their own inline header
//
// Self-gates on isAdmin — renders nothing for non-admins.
export default function AdminModeToolbar() {
  const { isAdmin, profileLoaded, adminActiveMode, setAdminActiveMode } = useAuth();
  const [pending, setPending] = useState<AdminMode | null>(null);

  if (!profileLoaded || !isAdmin) return null;

  const labels: Record<AdminMode, string> = {
    test: "Test",
    live_comp: "Live Comp",
    live_charge: "Live Charge",
  };
  const styles: Record<AdminMode, string> = {
    test: "bg-primary/10 text-primary border border-primary/30",
    live_comp: "bg-amber-100 text-amber-800 border border-amber-300",
    live_charge: "bg-destructive/10 text-destructive border border-destructive/30",
  };

  async function handleClick(m: AdminMode) {
    if (m === adminActiveMode || pending) return;
    setPending(m);
    const { error } = await setAdminActiveMode(m);
    setPending(null);
    if (error) {
      console.error("[AdminModeToolbar] set_admin_active_mode failed:", error);
    }
  }

  return (
    <div className="hidden sm:flex items-center gap-1 text-[11px]">
      <span className="font-medium text-muted-foreground mr-1">Mode</span>
      {(["test", "live_comp", "live_charge"] as const).map((m) => (
        <button
          key={m}
          onClick={() => handleClick(m)}
          disabled={pending !== null}
          className={`px-2 py-0.5 rounded-md font-medium transition-colors ${
            adminActiveMode === m ? styles[m] : "text-muted-foreground hover:bg-muted"
          } ${pending === m ? "opacity-50" : ""}`}
          aria-pressed={adminActiveMode === m}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}
