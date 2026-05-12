import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isAdmin: boolean;
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
      .select("id, full_name, avatar_url, role")
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
      return;
    }

    setIsAdmin(data.role === "admin");

    const update: Record<string, string> = {};
    if (fullName && !data.full_name) update.full_name = fullName;
    if (avatarUrl && !data.avatar_url) update.avatar_url = avatarUrl;
    if (Object.keys(update).length > 0) {
      await supabase.from("profiles").update(update).eq("id", u.id);
    }
  }, []);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) ensureProfile(s.user);
      else setIsAdmin(false);
      setLoading(false);
    });

    // Listen for auth changes
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
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
      },
    });
    return { error: error?.message ?? null };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
      },
    });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, loading, isAdmin, signIn, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
