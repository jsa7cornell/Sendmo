import { Navigate } from "react-router-dom";
import { Loader2, WifiOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOnline } from "@/hooks/useOnline";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const online = useOnline();

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // Offline with no session: hold rather than bounce to /login. A missing
  // session while offline is far more likely "auth state not restorable right
  // now" than "signed out" — the redirect resumes when connectivity returns.
  if (!session && !online) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <WifiOff className="w-6 h-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            You&apos;re offline — we&apos;ll pick up where you left off once you reconnect.
          </p>
        </div>
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  return <>{children}</>;
}
