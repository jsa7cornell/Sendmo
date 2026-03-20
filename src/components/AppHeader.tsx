import { Package, LogOut } from "lucide-react";
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
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="rounded-xl text-sm"
        onClick={() => navigate("/dashboard")}
      >
        My Account
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-xl px-2 text-muted-foreground"
        onClick={signOut}
        title="Sign out"
      >
        <LogOut className="w-4 h-4" />
      </Button>
    </div>
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
