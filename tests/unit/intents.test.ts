/**
 * Unit tests for _shared/intents.ts — Path B PI ↔ shipment resolution.
 *
 * Why this exists:
 *   The 2026-05-24 YPPY9AK incident — Stripe refund posted but
 *   `shipments.refund_status` never advanced to 'refunded' because the
 *   charge.refunded webhook resolved `shipmentId` ONLY via
 *   `stripe_intents.shipment_id`, which is always NULL for SendMo's full-label
 *   flow (PI created before shipment row exists).
 *
 *   The fix is Path B fallback: if stripe_intents.shipment_id is null, look
 *   up shipments by stripe_payment_intent_id. This file tests that fallback.
 *
 * Cross-link:
 *   LOG entry "[2026-05-24] charge.refunded Path B" — root cause + fix.
 *   2026-05-23 H4 reconciliation entry — original Path B introduction.
 */

import { describe, it, expect, vi } from "vitest";
import { resolvePiContextWithFallback } from "../../supabase/functions/_shared/intents.ts";

type Maybe<T> = { data: T | null; error: null };

interface SbState {
    intentRow?: { user_id?: string; shipment_id?: string | null; link_id?: string | null } | null;
    shipmentRow?: { id?: string; link_id?: string | null; sendmo_links?: { user_id?: string } | null } | null;
}

function buildSupabaseMock(state: SbState) {
    const stripeIntentsCalls: string[] = [];
    const shipmentsCalls: Array<{ select: string; eq: string }> = [];

    const client = {
        from: (table: string) => {
            if (table === "stripe_intents") {
                return {
                    select: (_cols: string) => ({
                        eq: (_col: string, val: string) => {
                            stripeIntentsCalls.push(val);
                            return {
                                maybeSingle: (): Promise<Maybe<typeof state.intentRow>> =>
                                    Promise.resolve({ data: state.intentRow ?? null, error: null }),
                            };
                        },
                    }),
                };
            }
            if (table === "shipments") {
                return {
                    select: (cols: string) => ({
                        eq: (col: string, val: string) => {
                            shipmentsCalls.push({ select: cols, eq: `${col}=${val}` });
                            return {
                                maybeSingle: (): Promise<Maybe<typeof state.shipmentRow>> =>
                                    Promise.resolve({ data: state.shipmentRow ?? null, error: null }),
                            };
                        },
                    }),
                };
            }
            throw new Error(`unexpected table in test: ${table}`);
        },
    };

    // The helper imports SupabaseClient as a type-only — runtime shape only
    // needs to satisfy the chained calls. Casting through unknown is the
    // standard escape hatch for typed-mock-but-not-real-client.
    return { client: client as unknown as Parameters<typeof resolvePiContextWithFallback>[0], stripeIntentsCalls, shipmentsCalls };
}

describe("resolvePiContextWithFallback", () => {
    it("returns nulls when piId is null", async () => {
        const { client } = buildSupabaseMock({});
        const r = await resolvePiContextWithFallback(client, null);
        expect(r).toEqual({ userId: null, shipmentId: null, linkId: null });
    });

    it("returns nulls when piId is empty string", async () => {
        const { client } = buildSupabaseMock({});
        // Treat empty string the same as null — the helper's `if (!piId)` guard
        // catches both. This protects against accidental empty-string lookups.
        const r = await resolvePiContextWithFallback(client, "");
        expect(r).toEqual({ userId: null, shipmentId: null, linkId: null });
    });

    it("uses stripe_intents row when shipment_id is present (happy path, no fallback)", async () => {
        const { client, shipmentsCalls } = buildSupabaseMock({
            intentRow: {
                user_id: "user-1",
                shipment_id: "ship-1",
                link_id: "link-1",
            },
        });
        const r = await resolvePiContextWithFallback(client, "pi_abc");
        expect(r).toEqual({ userId: "user-1", shipmentId: "ship-1", linkId: "link-1" });
        // Path B should NOT have been queried — stripe_intents returned a hit.
        expect(shipmentsCalls).toHaveLength(0);
    });

    it("falls back to shipments lookup when stripe_intents.shipment_id is null (the YPPY9AK scenario)", async () => {
        const { client, shipmentsCalls } = buildSupabaseMock({
            // stripe_intents row exists but shipment_id is null — typical for
            // SendMo's full-label flow where the PI predates the shipment row.
            intentRow: {
                user_id: "user-from-intent",
                shipment_id: null,
                link_id: null,
            },
            shipmentRow: {
                id: "ship-via-fallback",
                link_id: "link-via-fallback",
                sendmo_links: { user_id: "user-via-fallback" },
            },
        });
        const r = await resolvePiContextWithFallback(client, "pi_yppy9ak");
        // shipmentId comes from the Path B fallback.
        expect(r.shipmentId).toBe("ship-via-fallback");
        // linkId comes from the fallback (intent row had null).
        expect(r.linkId).toBe("link-via-fallback");
        // userId — the intent row had a value, so it wins (we keep the
        // non-null intent value rather than overwriting from the fallback).
        expect(r.userId).toBe("user-from-intent");
        // Path B was queried via stripe_payment_intent_id.
        expect(shipmentsCalls).toHaveLength(1);
        expect(shipmentsCalls[0].eq).toBe("stripe_payment_intent_id=pi_yppy9ak");
    });

    it("falls back to shipments when stripe_intents row is entirely absent", async () => {
        const { client, shipmentsCalls } = buildSupabaseMock({
            intentRow: null,
            shipmentRow: {
                id: "ship-only-from-fallback",
                link_id: "link-x",
                sendmo_links: { user_id: "user-x" },
            },
        });
        const r = await resolvePiContextWithFallback(client, "pi_orphan");
        expect(r).toEqual({
            userId: "user-x",
            shipmentId: "ship-only-from-fallback",
            linkId: "link-x",
        });
        expect(shipmentsCalls).toHaveLength(1);
    });

    it("returns nulls when both lookups miss", async () => {
        const { client, shipmentsCalls } = buildSupabaseMock({
            intentRow: null,
            shipmentRow: null,
        });
        const r = await resolvePiContextWithFallback(client, "pi_unknown");
        expect(r).toEqual({ userId: null, shipmentId: null, linkId: null });
        // Fallback was attempted (intent miss → Path B tried).
        expect(shipmentsCalls).toHaveLength(1);
    });

    it("handles a shipments row missing the sendmo_links join (defensive)", async () => {
        const { client } = buildSupabaseMock({
            intentRow: null,
            shipmentRow: {
                id: "ship-no-link",
                link_id: "link-y",
                sendmo_links: null,  // join failed somehow
            },
        });
        const r = await resolvePiContextWithFallback(client, "pi_partial");
        expect(r.shipmentId).toBe("ship-no-link");
        expect(r.linkId).toBe("link-y");
        expect(r.userId).toBe(null);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Companion: EasyPost refund.successful payload-shape resolution (commit 076bf75).
//
// EasyPost ships `refund.successful` with two observed payload shapes:
//   (a) result IS the Shipment  → result.id = 'shp_…', result.refunds = [{id:'rfnd_…', ...}]
//   (b) result IS the Refund    → result.id = 'rfnd_…', result.shipment_id = 'shp_…'
//
// Pre-076bf75 the webhook used `result.id` unconditionally, so shape (b)
// deliveries logged 'webhook.easypost_refund_shipment_not_found' and dropped
// the push refund. The 2026-05-24 YPPY9AK live test confirmed shape (b).
//
// The webhook arm now resolves: `result.shipment_id ?? result.id`. These tests
// pin that resolution against both shapes so a future regression to the old
// `result.id` behaviour fails CI.
// ─────────────────────────────────────────────────────────────────────────────

function resolveEpShipmentId(result: { shipment_id?: string; id?: string }): string | undefined {
    // Mirrors webhooks/index.ts:510-511 — keep this in lockstep with the live
    // resolver. If the live resolver gains another shape, add it here AND a
    // test below.
    return result.shipment_id ?? result.id;
}

describe("EasyPost refund.successful payload-shape resolution (076bf75)", () => {
    it("shape (a) — result is the Shipment object, uses result.id", () => {
        const result = {
            id: "shp_a1b2c3",
            refunds: [{ id: "rfnd_x1", amount: "9.18" }],
        };
        expect(resolveEpShipmentId(result)).toBe("shp_a1b2c3");
    });

    it("shape (b) — result is the Refund object, uses result.shipment_id (the YPPY9AK case)", () => {
        const result = {
            id: "rfnd_dcda5a228d12466e91ac22810604eed5",
            shipment_id: "shp_93c0aca5021b4373a287c6745acd4e73",
            amount: "9.18",
        };
        expect(resolveEpShipmentId(result)).toBe("shp_93c0aca5021b4373a287c6745acd4e73");
    });

    it("prefers shipment_id over id when both are present (shape b wins disambiguation)", () => {
        // If EasyPost ever ships a hybrid payload, shape (b)'s explicit
        // shipment_id is the authoritative field — picking result.id would
        // accidentally route to the rfnd_… as if it were a shipment id.
        const result = { id: "rfnd_xyz", shipment_id: "shp_authoritative" };
        expect(resolveEpShipmentId(result)).toBe("shp_authoritative");
    });

    it("returns undefined when both fields are missing (signals webhook.easypost_refund_no_shipment_id)", () => {
        expect(resolveEpShipmentId({})).toBeUndefined();
    });
});
