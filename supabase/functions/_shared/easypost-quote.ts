// EasyPost shipment-create (the quote call) — ONE client for every caller.
//
// Extracted from rates/index.ts (PR10, seller-link launch §3: "extract it to
// _shared/ rather than forking a second client"): the price-band computation
// needs the exact same quote the buyer will later see, and a second inline
// fetch would drift. `fetch` is injectable so Vitest drives every branch
// without network (easypost-rates.ts precedent).
//
// This helper never throws — the quote path runs inside link creation, which
// must not fail because EasyPost hiccupped.

import { safeFetchJson, type FetchLike } from "./easypost-rates.ts";

export interface QuoteAddress {
    name?: string | null;
    street1?: string | null;
    street2?: string | null;
    city: string;
    state: string;
    zip: string;
    country?: string | null;
    phone?: string | null;
}

export interface QuoteParcel {
    length: number;
    width: number;
    height: number;
    weight_oz: number;
}

export interface QuoteRate {
    id: string;
    carrier: string;
    service: string;
    /** EasyPost's base rate, dollars-as-string (their wire shape). */
    rate: string;
}

export interface QuoteResult {
    ok: boolean;
    shipmentId: string | null;
    rates: QuoteRate[];
    /** EasyPost's error message when !ok (or when 0 rates came back). */
    error: string | null;
}

// Same field semantics as rates/'s buildAddress (name/company defaults —
// some carriers require company even for a quote), so band quotes and buyer
// quotes rate identically.
export function buildQuoteAddress(a: QuoteAddress): Record<string, unknown> {
    return {
        name: a.name || "Recipient",
        company: a.name || "Recipient",
        ...(a.phone ? { phone: a.phone } : {}),
        ...(a.street1 ? { street1: a.street1 } : {}),
        ...(a.street2 ? { street2: a.street2 } : {}),
        city: a.city,
        state: a.state,
        zip: a.zip,
        country: a.country || "US",
    };
}

/**
 * The one EasyPost shipment-create (quote) wire call. Addresses arrive
 * PREBUILT — rates/ keeps its own buildAddress (request-shaped), the band
 * uses buildQuoteAddress — so the shared thing is exactly what must never
 * fork: URL, body shape, auth, and throw-safety.
 */
export async function quoteShipmentRaw(params: {
    apiKey: string;
    from: Record<string, unknown>;
    to: Record<string, unknown>;
    parcel: QuoteParcel;
    reference?: string | null;
    fetchImpl?: FetchLike;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON body, Response.json() contract
}): Promise<{ ok: boolean; status: number | null; data: any }> {
    return await safeFetchJson(
        "https://api.easypost.com/v2/shipments",
        {
            method: "POST",
            headers: {
                Authorization: "Basic " + btoa(params.apiKey + ":"),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                shipment: {
                    ...(params.reference ? { reference: params.reference } : {}),
                    from_address: params.from,
                    to_address: params.to,
                    parcel: {
                        length: params.parcel.length,
                        width: params.parcel.width,
                        height: params.parcel.height,
                        weight: params.parcel.weight_oz,
                    },
                },
            }),
        },
        params.fetchImpl ?? fetch,
    );
}

export async function createQuoteShipment(params: {
    apiKey: string;
    from: QuoteAddress;
    to: QuoteAddress;
    parcel: QuoteParcel;
    /** Stamped as shipment.reference (link-binding backstop). */
    reference?: string | null;
    fetchImpl?: FetchLike;
}): Promise<QuoteResult> {
    const result = await quoteShipmentRaw({
        apiKey: params.apiKey,
        from: buildQuoteAddress(params.from),
        to: buildQuoteAddress(params.to),
        parcel: params.parcel,
        reference: params.reference,
        fetchImpl: params.fetchImpl,
    });
    if (!result.ok || result.data?.error) {
        return {
            ok: false,
            shipmentId: result.data?.id ?? null,
            rates: [],
            error: result.data?.error?.message ?? `EasyPost quote failed (HTTP ${result.status ?? "none"})`,
        };
    }
    const rates: QuoteRate[] = Array.isArray(result.data?.rates)
        ? result.data.rates
            .filter((r: Record<string, unknown>) => r && r.id && r.rate)
            .map((r: Record<string, unknown>) => ({
                id: String(r.id),
                carrier: String(r.carrier ?? ""),
                service: String(r.service ?? ""),
                rate: String(r.rate),
            }))
        : [];
    return { ok: true, shipmentId: result.data?.id ?? null, rates, error: rates.length === 0 ? "no rates returned" : null };
}
