// EasyPost rate resolution + rerate recovery for the label buy path.
//
// Extracted 2026-08-24 after a customer was charged $19.91, shown EasyPost's
// bare "The requested resource could not be found.", and auto-refunded
// (pi_2U86OtxS6gsndgF32b3CL2gc — see LOG). EasyPost answers a rate it can no
// longer sell with 404 NOT_FOUND, and its documented remedy is to re-rate the
// shipment rather than dead-end
// (https://docs.easypost.com/docs/shipments/rates — POST /shipments/:id/rerate).
//
// Lives in _shared/ rather than inline in labels/index.ts for the same reason
// pricing.ts and ledger.ts do: labels/index.ts calls Deno.serve at module load,
// so nothing in it is reachable from Vitest. `fetch` is injected so the tests
// drive every branch without network. Truth table: tests/unit/easypostRates.test.ts.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResolvedRate {
    cents: number;
    carrier: string;
    service: string;
}

export interface FreshRate extends ResolvedRate {
    id: string;
}

const EP = "https://api.easypost.com/v2";

/** Cents from an EasyPost rate object, or null when it isn't a usable amount. */
function shapeRate(r: Record<string, unknown> | null | undefined): ResolvedRate | null {
    if (!r) return null;
    const cents = Math.round(parseFloat(String(r.rate ?? "0")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return null;
    return {
        cents,
        carrier: String(r.carrier ?? ""),
        service: String(r.service ?? ""),
    };
}

/**
 * Resolve a rate on a shipment: per-rate endpoint first, shipment payload as
 * fallback (the two-step both the flex cap check and the buy-time gate have
 * always used, hoisted here so they agree and the buy path can reuse the
 * carrier+service for a rerate).
 *
 * null means the rate is genuinely not on the shipment — NOT "couldn't check".
 * A null here predicts a 404 from /buy, so callers must treat it as a signal
 * and never as a reason to skip a price check.
 */
export async function lookupRate(
    shipmentId: string,
    rateId: string,
    authHeader: string,
    fetchImpl: FetchLike = fetch,
): Promise<ResolvedRate | null> {
    try {
        const rateResp = await fetchImpl(`${EP}/shipments/${shipmentId}/rates/${rateId}`, {
            headers: { Authorization: authHeader },
        });
        if (rateResp.ok) return shapeRate(await rateResp.json());

        const shipResp = await fetchImpl(`${EP}/shipments/${shipmentId}`, {
            headers: { Authorization: authHeader },
        });
        if (!shipResp.ok) return null;
        const shipData = await shipResp.json();
        return shapeRate((shipData.rates || []).find((r: { id: string }) => r.id === rateId));
    } catch {
        return null;
    }
}

/**
 * Regenerate a shipment's rates and return the one matching carrier+service.
 *
 * Matching is exact on BOTH fields on purpose: the customer chose and paid for
 * a specific service, so a rerate may only ever hand back that same service at
 * a fresh id. Returns null when the service is gone, so the caller refunds
 * instead of substituting.
 */
export async function rerateAndMatch(
    shipmentId: string,
    carrier: string,
    service: string,
    authHeader: string,
    fetchImpl: FetchLike = fetch,
): Promise<FreshRate | null> {
    if (!carrier || !service) return null;
    try {
        const resp = await fetchImpl(`${EP}/shipments/${shipmentId}/rerate`, {
            method: "POST",
            headers: { Authorization: authHeader, "Content-Type": "application/json" },
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const match = (data.rates || []).find(
            (r: { carrier: string; service: string }) => r.carrier === carrier && r.service === service,
        );
        const shaped = shapeRate(match);
        if (!shaped || !match?.id) return null;
        return { id: String(match.id), ...shaped };
    } catch {
        return null;
    }
}

/**
 * The price ceiling a rerated rate must respect before we retry the buy.
 * Identical formula to the buy-time gate in labels/index.ts — a rerate that
 * comes back above what the customer's payment supports is a rate CHANGE, not
 * a retry, and belongs on the refund path.
 *
 * Returns Infinity when there is no charge to protect (comp labels).
 */
export function rerateRetryCapCents(params: {
    gateDisplayCents: number;
    isComp: boolean;
    stripeFeePct: number;
    stripeFeeFlatCents: number;
    minNetMarginPct: number;
}): number {
    if (params.isComp || params.gateDisplayCents <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor(
        params.gateDisplayCents * (1 - params.stripeFeePct - params.minNetMarginPct)
        - params.stripeFeeFlatCents,
    );
}
