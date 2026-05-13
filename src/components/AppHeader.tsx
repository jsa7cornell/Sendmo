import { useState, useRef, useEffect } from "react";
import { LogOut, User, ChevronDown, Settings } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth, type AdminMode } from "@/contexts/AuthContext";
import SendMoLogo from "@/components/SendMoLogo";

interface Props {
  /** Override the entire right-side action slot */
  actions?: React.ReactNode;
}

export default function AppHeader({ actions }: Props) {
  const { user, signOut, isAdmin, adminActiveMode, setAdminActiveMode } = useAuth();
  const navigate = useNavigate();

  const defaultRight = user ? (
    <UserMenu
      displayName={user.user_metadata?.full_name || user.email?.split("@")[0] || "Account"}
      onAccount={() => navigate("/dashboard")}
      onSignOut={signOut}
    />
  ) : (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="rounded-xl text-sm"
        onClick={() => navigate("/faq")}
      >
        FAQ
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="rounded-xl text-sm"
        onClick={() => navigate("/login")}
      >
        Sign In
      </Button>
    </div>
  );

  return (
    <header className="border-b border-border bg-card">
      <div className="container max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link
          to="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <SendMoLogo className="w-7 h-7" />
          <span className="text-lg font-bold text-foreground">SendMo</span>
        </Link>
        <div className="flex items-center gap-3">
          {isAdmin && (
            <AdminModeToolbar mode={adminActiveMode} onModeChange={setAdminActiveMode} />
          )}
          <div>{actions !== undefined ? actions : defaultRight}</div>
        </div>
      </div>
    </header>
  );
}

// ─── Admin mode toolbar ─────────────────────────────────────
//
// Global admin toggle (Phase B B2 fix). Renders to the left of the user
// menu in the app header. Backed by profiles.admin_active_mode + the
// set_admin_active_mode() RPC — never trusts client state for mode.
// Three modes: Test (default), Live Comp (real label, no charge),
// Live Charge (real label, real charge — Phase C onward).

function AdminModeToolbar({
  mode,
  onModeChange,
}: {
  mode: AdminMode;
  onModeChange: (m: AdminMode) => Promise<{ error: string | null }>;
}) {
  const [pending, setPending] = useState<AdminMode | null>(null);
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
    if (m === mode || pending) return;
    setPending(m);
    const { error } = await onModeChange(m);
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
            mode === m ? styles[m] : "text-muted-foreground hover:bg-muted"
          } ${pending === m ? "opacity-50" : ""}`}
          aria-pressed={mode === m}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  );
}

// ─── User dropdown menu ─────────────────────────────────────

function UserMenu({
  displayName,
  onAccount,
  onSignOut,
}: {
  displayName: string;
  onAccount: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors px-2 py-1.5 rounded-lg hover:bg-muted/50"
      >
        <User className="w-4 h-4 text-muted-foreground" />
        {displayName}
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-48 bg-card rounded-xl border border-border shadow-lg py-1 z-50">
          <button
            onClick={() => { setOpen(false); onAccount(); }}
            className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-muted/50 flex items-center gap-2.5"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
            My Account
          </button>
          <div className="border-t border-border my-1" />
          <button
            onClick={() => { setOpen(false); onSignOut(); }}
            className="w-full text-left px-4 py-2.5 text-sm text-destructive hover:bg-destructive/5 flex items-center gap-2.5"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
