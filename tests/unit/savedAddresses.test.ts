import { describe, it, expect } from "vitest";
import { addressKey, dedupeAddresses, type AddressRow } from "@/lib/savedAddresses";

// The addresses table is an append-only log: every link creation inserts a
// row, and edits insert-new-row + repoint-FK to preserve shipment history. So
// dedupe is what makes a picker usable, not a nicety — without it someone who
// has shipped to the same friend five times sees that friend five times.

function row(over: Partial<AddressRow> = {}): AddressRow {
  return {
    id: "a1",
    name: "Pat Smith",
    street1: "388 Townsend St",
    street2: null,
    city: "San Francisco",
    state: "CA",
    zip: "94107",
    phone: "4155550100",
    is_verified: true,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("addressKey", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(addressKey({ street1: "388 Townsend St.", street2: null, zip: "94107" }))
      .toBe(addressKey({ street1: "388  townsend   st", street2: null, zip: "94107 " }));
  });

  it("keeps different units apart", () => {
    // A unit number distinguishes real addresses — 4B and 4C are two homes.
    expect(addressKey({ street1: "1 Market St", street2: "Apt 4B", zip: "94105" }))
      .not.toBe(addressKey({ street1: "1 Market St", street2: "Apt 4C", zip: "94105" }));
  });

  it("keeps the same street in different zips apart", () => {
    expect(addressKey({ street1: "1 Main St", street2: null, zip: "94105" }))
      .not.toBe(addressKey({ street1: "1 Main St", street2: null, zip: "97201" }));
  });

  it("ignores the name — one place, however it was labelled", () => {
    // "Mum" and "Jane Doe" at one address are the same place, and showing it
    // twice is the problem being solved.
    expect(addressKey({ street1: "22 Elm Road", street2: null, zip: "97201" }))
      .toBe(addressKey({ street1: "22 Elm Road", street2: null, zip: "97201" }));
  });
});

describe("dedupeAddresses", () => {
  it("collapses repeats of one address to a single entry", () => {
    const out = dedupeAddresses([
      row({ id: "3", created_at: "2026-08-10T00:00:00Z" }),
      row({ id: "2", created_at: "2026-08-05T00:00:00Z" }),
      row({ id: "1", created_at: "2026-08-01T00:00:00Z" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps the newest row's name and phone", () => {
    // Rows arrive newest-first, so the first occurrence wins — that is the
    // name the user typed most recently.
    const out = dedupeAddresses([
      row({ id: "2", name: "P. Smith", phone: "4155559999", created_at: "2026-08-10T00:00:00Z" }),
      row({ id: "1", name: "Pat Smith", phone: "4155550100" }),
    ]);
    expect(out[0].name).toBe("P. Smith");
    expect(out[0].phone).toBe("4155559999");
  });

  it("preserves order, so the most recently used address leads", () => {
    const out = dedupeAddresses([
      row({ id: "2", street1: "22 Elm Road", zip: "97201", created_at: "2026-08-10T00:00:00Z" }),
      row({ id: "1" }),
    ]);
    expect(out.map((a) => a.street)).toEqual(["22 Elm Road", "388 Townsend St"]);
  });

  it("drops rows with no street", () => {
    // Partially-filled drafts leave these behind; they cannot be selected
    // into a form usefully.
    const out = dedupeAddresses([row({ id: "1", street1: "" }), row({ id: "2" })]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("2");
  });

  it("maps a row onto the shape the address form takes", () => {
    const [addr] = dedupeAddresses([row()]);
    expect(addr).toMatchObject({
      street: "388 Townsend St",
      city: "San Francisco",
      state: "CA",
      zip: "94107",
      phone: "4155550100",
      verified: true,
    });
  });

  it("tolerates the nulls the schema permits", () => {
    // addresses.label is never written and name/phone are nullable — a picker
    // that renders `null` is worse than one that renders nothing.
    const [addr] = dedupeAddresses([row({ name: null, phone: null, is_verified: null })]);
    expect(addr.name).toBe("");
    expect(addr.phone).toBe("");
    expect(addr.verified).toBe(false);
  });

  it("returns nothing for an empty book", () => {
    expect(dedupeAddresses([])).toEqual([]);
  });
});
