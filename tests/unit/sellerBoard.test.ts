import { describe, it, expect } from "vitest";
import { soldAwaitingPrint } from "@/lib/sellerBoard";

// PR8: the "Sold — needs label printed" group is exactly (buyer_email set,
// status label_created) — a seller's OWN shipments and post-scan sales must
// never appear in it.

describe("soldAwaitingPrint", () => {
  const rows = [
    { id: "sale-fresh", buyer_email: "b@x.co", status: "label_created" },
    { id: "sale-scanned", buyer_email: "b@x.co", status: "in_transit" },
    { id: "own-shipment", buyer_email: null, status: "label_created" },
    { id: "sale-delivered", buyer_email: "b@x.co", status: "delivered" },
  ];

  it("keeps only paid-not-yet-scanned sales", () => {
    expect(soldAwaitingPrint(rows).map((r) => r.id)).toEqual(["sale-fresh"]);
  });

  it("empty in, empty out", () => {
    expect(soldAwaitingPrint([])).toEqual([]);
  });
});
