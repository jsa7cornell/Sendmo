import type { AddressInput } from "@/lib/types";

// The "address book" is an append-only log, not a curated list.
//
// Every link creation INSERTS a new addresses row, and edits use
// insert-new-row + repoint-FK so shipment history keeps pointing at the
// address as it was (supabase/functions/links/index.ts). So a user who has
// shipped to the same friend five times owns five near-identical rows, and a
// picker that lists the table raw shows the same address five times.
//
// Dedupe is therefore not a nicety — it is what makes a picker usable at all.

/** A saved address plus the row metadata the picker needs. */
export interface SavedAddress extends AddressInput {
  id: string;
  /** Newest first; the most recent row of a group wins. */
  createdAt: string;
}

/** The shape Supabase returns from the addresses table. */
export interface AddressRow {
  id: string;
  name: string | null;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  zip: string;
  phone: string | null;
  is_verified: boolean | null;
  created_at: string;
}

/**
 * Identity for deduping. Street + zip, aggressively normalised: the same
 * address typed twice differs by case, punctuation and whitespace far more
 * often than by anything meaningful.
 *
 * Deliberately NOT including name — "Mum" and "Jane Doe" at one address are
 * the same place, and showing it twice is the problem being solved. The most
 * recent row supplies the name, which is the one the user typed last.
 *
 * Deliberately NOT including street2. A unit number distinguishes real
 * addresses, so `4B` and `4C` on one street must stay separate rows.
 */
export function addressKey(row: Pick<AddressRow, "street1" | "street2" | "zip">): string {
  const norm = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${norm(row.street1)}|${norm(row.street2)}|${norm(row.zip)}`;
}

/**
 * Collapse the log into one entry per distinct address, newest first.
 *
 * Rows arrive newest-first from the query; the first occurrence of each key
 * therefore wins, carrying the most recently typed name and phone. Rows with
 * no street are dropped — they cannot be selected into a form usefully and
 * exist only from partially-filled drafts.
 */
export function dedupeAddresses(rows: AddressRow[]): SavedAddress[] {
  const seen = new Set<string>();
  const out: SavedAddress[] = [];

  for (const row of rows) {
    if (!row.street1) continue;
    const key = addressKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: row.id,
      createdAt: row.created_at,
      name: row.name ?? "",
      street: row.street1,
      city: row.city,
      state: row.state,
      zip: row.zip,
      phone: row.phone ?? "",
      verified: !!row.is_verified,
    });
  }

  return out;
}
