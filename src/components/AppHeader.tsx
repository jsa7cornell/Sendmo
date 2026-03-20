import { useState, useRef, useEffect } from "react";
import { Package, LogOut, User, ChevronDown, Settings } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";

interface Props {
  /** Override the entire right-side action slot */
  actions?: React.ReactNode;
}

export default function AppHeader({ actions }: Props) {
  const { user, signOut } = useAuth();
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
          <Package className="w-5 h-5 text-primary" />
          <span className="text-lg font-bold text-foreground">SendMo</span>
        </Link>
        <div>{actions !== undefined ? actions : defaultRight}</div>
      </div>
    </header>
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
