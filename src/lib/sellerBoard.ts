// The seller's three-state board (PR8, seller-link launch §2.4). All three
// states already exist in the data — this is selection, not new state:
//   generated        → sendmo_links.status='active', no shipment yet (Links tab)
//   sold, not shipped → shipments.status='label_created' AND buyer_email set
//   shipped          → 'in_transit' and onward (the ordinary shipments table)
//
// buyer_email IS the seller-sale discriminator (F1) until PR11 retires it.

export interface SoldBoardRow {
  buyer_email: string | null;
  status: string;
}

/** The "Sold — needs label printed" group: paid sales awaiting the seller's print. */
export function soldAwaitingPrint<T extends SoldBoardRow>(shipments: T[]): T[] {
  return shipments.filter(
    (s) => !!s.buyer_email && s.status === "label_created",
  );
}
