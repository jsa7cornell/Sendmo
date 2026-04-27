import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import LinksEditor, { defaultFlexValue, type FlexFormValue } from "@/components/links/LinksEditor";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import type { SpeedTier } from "@/lib/types";

interface LoadedRow {
  id: string;
  status: string;
  preferred_speed: string | null;
  preferred_carrier: string | null;
  max_price_cents: number;
  size_hint: string | null;
  recipient_address: {
    name: string;
    street1: string;
    street2: string | null;
    city: string;
    state: string;
    zip: string;
    is_verified: boolean;
  } | null;
}

export default function LinksEdit() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [initial, setInitial] = useState<FlexFormValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [notEditable, setNotEditable] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !id) return;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("sendmo_links")
        .select(`
          id, status, preferred_speed, preferred_carrier, max_price_cents, size_hint,
          recipient_address:addresses!recipient_address_id (
            name, street1, street2, city, state, zip, is_verified
          )
        `)
        .eq("id", id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (cancelled) return;

      if (error || !data) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      const row = data as unknown as LoadedRow;
      if (row.status !== "active" && row.status !== "draft") {
        setNotEditable(row.status);
        setLoading(false);
        return;
      }

      const addr = Array.isArray(row.recipient_address) ? row.recipient_address[0] : row.recipient_address;
      const v: FlexFormValue = {
        ...defaultFlexValue(),
        address: addr ? {
          name: addr.name || "",
          street: [addr.street1, addr.street2].filter(Boolean).join(", "),
          city: addr.city,
          state: addr.state,
          zip: addr.zip,
          verified: !!addr.is_verified,
        } : defaultFlexValue().address,
        speed_preference: (row.preferred_speed as SpeedTier) || "standard",
        preferred_carrier: row.preferred_carrier || "any",
        price_cap: Math.round(row.max_price_cents / 100),
        size_hint: (row.size_hint as FlexFormValue["size_hint"]) ?? null,
        email: user.email ?? "",
      };
      setInitial(v);
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [user, id]);

  if (notFound) return <Navigate to="/dashboard" replace />;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/50">
      <AppHeader />
      {loading ? (
        <div className="max-w-xl mx-auto px-4 py-16 text-center">
          <Loader2 className="w-6 h-6 text-primary animate-spin mx-auto" />
        </div>
      ) : notEditable ? (
        <div className="max-w-xl mx-auto px-4 py-16 text-center">
          <p className="text-foreground font-medium">This link is no longer editable.</p>
          <p className="text-sm text-muted-foreground mt-1">Status: {notEditable}</p>
        </div>
      ) : (
        <LinksEditor mode="edit" initialValue={initial} linkId={id ?? null} />
      )}
    </div>
  );
}
