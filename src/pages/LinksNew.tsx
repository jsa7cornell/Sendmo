import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import LinksEditor, { defaultFlexValue, type FlexFormValue } from "@/components/links/LinksEditor";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";

export default function LinksNew() {
  const { user } = useAuth();
  const [initial, setInitial] = useState<FlexFormValue | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      const [{ data: profile }, { data: recentAddr }] = await Promise.all([
        supabase.from("profiles").select("email, full_name").eq("id", user.id).single(),
        supabase
          .from("addresses")
          .select("name, street1, street2, city, state, zip, is_verified")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (cancelled) return;

      const v = defaultFlexValue();
      if (recentAddr) {
        v.address = {
          name: recentAddr.name || profile?.full_name || "",
          street: [recentAddr.street1, recentAddr.street2].filter(Boolean).join(", "),
          city: recentAddr.city,
          state: recentAddr.state,
          zip: recentAddr.zip,
          verified: !!recentAddr.is_verified,
        };
      }
      v.email = profile?.email ?? user.email ?? "";
      setInitial(v);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [user]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />
      {loading ? (
        <div className="max-w-xl mx-auto px-4 py-16 text-center">
          <Loader2 className="w-6 h-6 text-primary animate-spin mx-auto" />
        </div>
      ) : (
        <LinksEditor mode="create" initialValue={initial} linkId={null} />
      )}
    </div>
  );
}
