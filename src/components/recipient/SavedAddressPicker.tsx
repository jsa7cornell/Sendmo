import { useEffect, useState } from "react";
import { BookUser, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { dedupeAddresses, type AddressRow, type SavedAddress } from "@/lib/savedAddresses";
import { cn } from "@/lib/utils";

// "Use a saved address" for people who have more than one (2026-08-23).
//
// Until now the shortcut silently took the single most recent row, so a user
// with a home address and their mum's got whichever they happened to type
// last, with no way to see or change it.
//
// Option A of the three designs: the link expands a list IN PLACE under the
// field it fills. No modal, and the whole set is visible at once — which holds
// because the list is deduped (see lib/savedAddresses), so it is one entry per
// distinct address rather than one per shipment ever made.
//
// ─── What this deliberately does NOT do ───
//
// It does not infer who is sending. The single-address version set
// sender='other' on the destination step and sender='self' on the origin step,
// both reasoning "this is YOUR saved address, so you must be the other party".
// That inference was only ever sound because there was exactly one address and
// it was assumed to be the account holder's. Picking from a list of four —
// which may include a friend's — implies nothing about who is shipping, so
// the picker fills fields and leaves `sender` alone. Skipping a question still
// resolves it, which is where the flow actually learns the answer.

interface Props {
  /** Fills the form with the chosen address. */
  onSelect: (addr: SavedAddress) => void;
  /** Copy for the trigger; the two steps ask for different things. */
  label?: string;
}

export default function SavedAddressPicker({ onSelect, label = "Use a saved address" }: Props) {
  const { user } = useAuth();
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);

    (async () => {
      // Newest first so dedupeAddresses keeps the most recently typed name and
      // phone for each distinct address. The cap is generous rather than
      // precise — it bounds the payload for someone with hundreds of
      // shipments, and dedupe collapses it to a handful of entries.
      const { data } = await supabase
        .from("addresses")
        .select("id, name, street1, street2, city, state, zip, phone, is_verified, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);

      if (cancelled) return;
      setAddresses(dedupeAddresses((data ?? []) as AddressRow[]));
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [user]);

  // Nothing to offer: signed out, still loading, or genuinely no saved rows.
  if (!user || loading || addresses.length === 0) return null;

  const triggerClasses =
    "inline-flex items-center gap-1.5 text-sm font-semibold text-primary rounded-lg px-2 py-1 -ml-2 transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={triggerClasses}>
        <BookUser className="w-4 h-4" aria-hidden="true" />
        {label}
        {/* The count is the whole point of the change — it is what tells
            someone with two addresses that a choice exists at all. */}
        {addresses.length > 1 && (
          <span className="font-normal text-muted-foreground">({addresses.length})</span>
        )}
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted border-b border-border">
        <span className="text-xs font-semibold">Choose an address</span>
        <span className="text-[11px] text-muted-foreground">
          {addresses.length} saved
        </span>
      </div>

      <ul className="max-h-64 overflow-y-auto">
        {addresses.map((addr, i) => (
          <li key={addr.id}>
            <button
              type="button"
              onClick={() => { onSelect(addr); setOpen(false); }}
              className={cn(
                "w-full text-left px-3 py-2.5 transition-colors hover:bg-muted/60",
                "focus-visible:outline-none focus-visible:bg-muted/60",
                i > 0 && "border-t border-border",
              )}
            >
              <span className="block text-sm font-medium truncate">
                {addr.name || "Saved address"}
                {i === 0 && (
                  <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-primary bg-primary/10 rounded px-1.5 py-0.5">
                    Last used
                  </span>
                )}
              </span>
              <span className="block text-xs text-muted-foreground truncate">
                {addr.street}, {addr.city} {addr.state}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="w-full flex items-center gap-1.5 px-3 py-2.5 border-t border-border text-sm font-semibold text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:bg-primary/5"
      >
        <Plus className="w-4 h-4" aria-hidden="true" />
        Enter a new address
      </button>
    </div>
  );
}
