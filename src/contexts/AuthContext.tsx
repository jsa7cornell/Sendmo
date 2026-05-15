import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type AdminMode = "test" | "live_comp" | "live_charge";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAdmin: boolean;
  /** Admin toolbar state from profiles.admin_active_mode. 'test' for non-admins. */
  adminActiveMode: AdminMode;
  /** Calls set_admin_active_mode() RPC. No-op for non-admins. */
  setAdminActiveMode: (mode: AdminMode) => Promise<{ error: string | null }>;
  /** Derived: server has acknowledged this user can hit Stripe LIVE keys. */
  liveMode: boolean;
  /** Derived: bypass Stripe entirely (live label, no charge). */
  compMode: boolean;
  signIn: (email: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminActiveMode, setAdminActiveModeState] = useState<AdminMode>("test");

  // Ensure profile row exists and is populated from OAuth metadata.
  // A DB trigger (handle_new_user) auto-inserts {id, email} on auth.users insert,
  // so we backfill full_name/avatar_url here when Google/OAuth provides them.
  // Also reads `role` so the client can render admin UI conditionally — the
  // server still enforces role-based access independently (see _shared/auth.ts).
  const ensureProfile = useCallback(async (u: User) => {
    const meta = (u.user_metadata ?? {}) as {
      full_name?: string;
      name?: string;
      avatar_url?: string;
      picture?: string;
    };
    const fullName = meta.full_name ?? meta.name ?? null;
    const avatarUrl = meta.avatar_url ?? meta.picture ?? null;

    const { data } = await supabase
      .from("profiles")
      .select("id, full_name, avatar_url, role, admin_active_mode")
      .eq("id", u.id)
      .single();

    if (!data) {
      await supabase.from("profiles").insert({
        id: u.id,
        email: u.email,
        full_name: fullName,
        avatar_url: avatarUrl,
      });
      setIsAdmin(false);
      setAdminActiveModeState("test");
      return;
    }

    setIsAdmin(data.role === "admin");
    const mode = (data.admin_active_mode as AdminMode | null) ?? "test";
    setAdminActiveModeState(mode === "live_comp" || mode === "live_charge" ? mode : "test");

    const update: Record<string, string> = {};
    if (fullName && !data.full_name) update.full_name = fullName;
    if (avatarUrl && !data.avatar_url) update.avatar_url = avatarUrl;
    if (Object.keys(update).length > 0) {
      await supabase.from("profiles").update(update).eq("id", u.id);
    }
  }, []);

  useEffect(() => {
    // In Supabase JS v2, onAuthStateChange fires INITIAL_SESSION on subscription
    // setup, so getSession() is redundant. Calling both simultaneously causes a
    // race: when the JWT is expired, both try to exchange the same refresh token.
    // With "Detect and revoke potentially compromised refresh tokens" ON, the
    // second exchange is treated as a replay attack and the session is revoked,
    // silently signing the user out. Single listener eliminates the race.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) ensureProfile(s.user);
      else setIsAdmin(false);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [ensureProfile]);

  const signIn = useCallback(async (email: string) => {
    // ?welcome=1 triggers a transient "Signed in as X" toast on /dashboard.
    // One-shot — Dashboard strips the param on first paint.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard?welcome=1`,
      },
    });
    return { error: error?.message ?? null };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard?welcome=1`,
      },
    });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  // Admin toolbar setter — calls the server-side RPC (Phase B B2 fix).
  // Server enforces profiles.role='admin' check; non-admins get an error
  // they can't actually trigger from the UI (toolbar is admin-only).
  // Optimistic local update for instant UI; reverted if the RPC errors.
  const setAdminActiveMode = useCallback(async (mode: AdminMode) => {
    const prior = adminActiveMode;
    setAdminActiveModeState(mode);
    const { error } = await supabase.rpc("set_admin_active_mode", { new_mode: mode });
    if (error) {
      setAdminActiveModeState(prior);
      return { error: error.message };
    }
    return { error: null };
  }, [adminActiveMode]);

  const liveMode = isAdmin && (adminActiveMode === "live_comp" || adminActiveMode === "live_charge");
  const compMode = isAdmin && adminActiveMode === "live_comp";

  return (
    <AuthContext.Provider value={{
      user, session, loading, isAdmin,
      adminActiveMode, setAdminActiveMode, liveMode, compMode,
      signIn, signInWithGoogle, signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
