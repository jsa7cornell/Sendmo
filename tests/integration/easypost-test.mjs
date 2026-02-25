#!/usr/bin/env node

/**
 * EasyPost Comprehensive Integration Test
 * ────────────────────────────────────────
 * Tests rate generation and label creation across 200 address combinations
 * with all EasyPost shipping methods via deployed Supabase Edge Functions.
 *
 * Usage:
 *   node tests/integration/easypost-test.mjs                  # full run
 *   node tests/integration/easypost-test.mjs --rates-only     # skip label purchases
 *   node tests/integration/easypost-test.mjs --limit 10       # test only first N pairs
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

// ─── Parse CLI flags ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const RATES_ONLY = args.includes("--rates-only");
const LIMIT_IDX = args.indexOf("--limit");
const LIMIT = LIMIT_IDX !== -1 ? parseInt(args[LIMIT_IDX + 1], 10) : Infinity;

// ─── Load environment ───────────────────────────────────────────────────────

function loadEnv() {
    try {
        const envFile = readFileSync(join(PROJECT_ROOT, ".env.local"), "utf-8");
        const vars = {};
        for (const line of envFile.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1) continue;
            vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
        return vars;
    } catch {
        console.error("❌ Could not read .env.local — make sure it exists at project root");
        process.exit(1);
    }
}

const env = loadEnv();
const BASE_URL = env.VITE_SUPABASE_URL;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;

if (!BASE_URL) {
    console.error("❌ VITE_SUPABASE_URL not found in .env.local");
    process.exit(1);
}

const RATES_URL = `${BASE_URL}/functions/v1/rates`;
const LABELS_URL = `${BASE_URL}/functions/v1/labels`;
const CONCURRENCY = 3;
const DELAY_BETWEEN_BATCHES_MS = 400;

// ─── Address Data (20 From × 10 To = 200 Pairs) ────────────────────────────

const FROM_ADDRESSES = [
    { name: "Alice Johnson", street1: "388 Townsend St", city: "San Francisco", state: "CA", zip: "94107" },
    { name: "Bob Williams", street1: "1000 Wilshire Blvd", city: "Los Angeles", state: "CA", zip: "90017" },
    { name: "Carol Davis", street1: "350 5th Ave", city: "New York", state: "NY", zip: "10118" },
    { name: "Dan Miller", street1: "233 S Wacker Dr", city: "Chicago", state: "IL", zip: "60606" },
    { name: "Eve Garcia", street1: "1600 Smith St", city: "Houston", state: "TX", zip: "77002" },
    { name: "Frank Brown", street1: "2 E Jefferson St", city: "Phoenix", state: "AZ", zip: "85004" },
    { name: "Grace Wilson", street1: "1500 Market St", city: "Philadelphia", state: "PA", zip: "19102" },
    { name: "Hank Martinez", street1: "100 Military Plaza", city: "San Antonio", state: "TX", zip: "78205" },
    { name: "Ivy Thomas", street1: "1500 Marilla St", city: "Dallas", state: "TX", zip: "75201" },
    { name: "Jack Anderson", street1: "202 C St", city: "San Diego", state: "CA", zip: "92101" },
    { name: "Karen Lee", street1: "1437 Bannock St", city: "Denver", state: "CO", zip: "80202" },
    { name: "Leo Clark", street1: "600 4th Ave", city: "Seattle", state: "WA", zip: "98104" },
    { name: "Mia Robinson", street1: "1 City Hall Sq", city: "Boston", state: "MA", zip: "02201" },
    { name: "Nick Hall", street1: "1 Public Square", city: "Nashville", state: "TN", zip: "37201" },
    { name: "Olivia King", street1: "1221 SW 4th Ave", city: "Portland", state: "OR", zip: "97204" },
    { name: "Pete Young", street1: "495 S Main St", city: "Las Vegas", state: "NV", zip: "89101" },
    { name: "Quinn Scott", street1: "3500 Pan American Dr", city: "Miami", state: "FL", zip: "33133" },
    { name: "Rita Adams", street1: "55 Trinity Ave SW", city: "Atlanta", state: "GA", zip: "30303" },
    { name: "Sam Baker", street1: "350 S 5th St", city: "Minneapolis", state: "MN", zip: "55415" },
    { name: "Tina Turner", street1: "2 Woodward Ave", city: "Detroit", state: "MI", zip: "48226" },
];

const TO_ADDRESSES = [
    { name: "Ursula Vega", street1: "301 W 2nd St", city: "Austin", state: "TX", zip: "78701" },
    { name: "Vic Nguyen", street1: "600 E 4th St", city: "Charlotte", state: "NC", zip: "28202" },
    { name: "Wendy Patel", street1: "90 W Broad St", city: "Columbus", state: "OH", zip: "43215" },
    { name: "Xander Cruz", street1: "200 E Washington St", city: "Indianapolis", state: "IN", zip: "46204" },
    { name: "Yara Singh", street1: "117 W Duval St", city: "Jacksonville", state: "FL", zip: "32202" },
    { name: "Zoe Kim", street1: "200 E Santa Clara St", city: "San Jose", state: "CA", zip: "95113" },
    { name: "Aaron Lopez", street1: "200 Texas St", city: "Fort Worth", state: "TX", zip: "76102" },
    { name: "Bella Wright", street1: "125 N Main St", city: "Memphis", state: "TN", zip: "38103" },
    { name: "Cody Harris", street1: "100 N Holliday St", city: "Baltimore", state: "MD", zip: "21202" },
    { name: "Diana Reed", street1: "200 E Wells St", city: "Milwaukee", state: "WI", zip: "53202" },
];

// 5 intentionally bad addresses sprinkled in as extra from addresses
const BAD_FROM_ADDRESSES = [
    { name: "Bad Address 1", street1: "99999 Nonexistent Blvd", city: "Fakeville", state: "ZZ", zip: "00000" },
    { name: "Bad Address 2", street1: "", city: "", state: "", zip: "" },
    { name: "Bad Address 3", street1: "123", city: "A", state: "XX", zip: "abcde" },
    { name: "Missing Fields", street1: "100 Main St", city: "Somewhere", state: "CA", zip: "" },
    { name: "Bad Zip", street1: "200 Market St", city: "San Francisco", state: "CA", zip: "11111" },
];

// ─── Parcel Sizes ───────────────────────────────────────────────────────────

const PARCEL_SIZES = [
    { name: "Small Envelope", length: 12, width: 9, height: 1, weight_oz: 4 },
    { name: "Medium Box", length: 12, width: 10, height: 8, weight_oz: 32 },
    { name: "Large Heavy Box", length: 20, width: 15, height: 12, weight_oz: 160 },
];

// ─── Build the 200+ test pairs ─────────────────────────────────────────────

function buildTestPairs() {
    const pairs = [];

    // Cross-product: 20 from × 10 to = 200 pairs (rotating parcel sizes)
    let parcelIdx = 0;
    for (const from of FROM_ADDRESSES) {
        for (const to of TO_ADDRESSES) {
            pairs.push({
                from: { ...from, country: "US", phone: "5551234567" },
                to: { ...to, country: "US", phone: "5559876543" },
                parcel: PARCEL_SIZES[parcelIdx % PARCEL_SIZES.length],
                pairLabel: `${from.city},${from.state} → ${to.city},${to.state}`,
            });
            parcelIdx++;
        }
    }

    // Add bad address pairs (5 bad from → first to address)
    for (const bad of BAD_FROM_ADDRESSES) {
        pairs.push({
            from: { ...bad, country: "US", phone: "5550000000" },
            to: { ...TO_ADDRESSES[0], country: "US", phone: "5559876543" },
            parcel: PARCEL_SIZES[0],
            pairLabel: `[BAD] ${bad.name} → ${TO_ADDRESSES[0].city},${TO_ADDRESSES[0].state}`,
            expectFailure: true,
        });
    }

    return pairs;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

const defaultHeaders = {
    "Content-Type": "application/json",
    ...(ANON_KEY ? { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } : {}),
};

async function fetchWithRetry(url, body, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: defaultHeaders,
                body: JSON.stringify(body),
            });
            const data = await res.json();
            return { ok: res.ok, status: res.status, data };
        } catch (err) {
            if (attempt === retries) {
                return { ok: false, status: 0, data: { error: err.message } };
            }
            // Wait before retry (exponential backoff)
            await sleep(1000 * (attempt + 1));
        }
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function runInBatches(items, batchSize, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
        if (i + batchSize < items.length) {
            await sleep(DELAY_BETWEEN_BATCHES_MS);
        }
    }
    return results;
}

// ─── Test Runner ────────────────────────────────────────────────────────────

async function testRates(pair, index, total) {
    const startMs = Date.now();
    const result = {
        index: index + 1,
        pairLabel: pair.pairLabel,
        parcel: pair.parcel.name,
        fromState: pair.from.state,
        toState: pair.to.state,
        expectFailure: pair.expectFailure || false,
        rateSuccess: false,
        rateCount: 0,
        carriers: [],
        services: [],
        cheapestPrice: null,
        shipmentId: null,
        rates: [],
        error: null,
        durationMs: 0,
    };

    try {
        const res = await fetchWithRetry(RATES_URL, {
            from_address: pair.from,
            to_address: pair.to,
            parcel: pair.parcel,
        });

        result.durationMs = Date.now() - startMs;

        if (!res.ok || res.data.error) {
            result.error = res.data.error || `HTTP ${res.status}`;
            return result;
        }

        const rates = res.data.rates || [];
        result.rateSuccess = true;
        result.rateCount = rates.length;
        result.carriers = [...new Set(rates.map((r) => r.carrier))];
        result.services = rates.map((r) => `${r.carrier}/${r.service}`);
        result.cheapestPrice = rates.length > 0 ? Math.min(...rates.map((r) => r.display_price)) : null;
        result.shipmentId = rates.length > 0 ? rates[0].easypost_shipment_id : null;
        result.rates = rates;
    } catch (err) {
        result.error = err.message;
        result.durationMs = Date.now() - startMs;
    }

    return result;
}

async function testLabel(rateInfo, index, total) {
    const startMs = Date.now();
    const result = {
        index: index + 1,
        pairLabel: rateInfo.pairLabel,
        carrier: rateInfo.carrier,
        service: rateInfo.service,
        price: rateInfo.display_price,
        labelSuccess: false,
        trackingNumber: null,
        labelUrl: null,
        error: null,
        durationMs: 0,
    };

    try {
        const res = await fetchWithRetry(LABELS_URL, {
            easypost_shipment_id: rateInfo.easypost_shipment_id,
            easypost_rate_id: rateInfo.easypost_rate_id,
        });

        result.durationMs = Date.now() - startMs;

        if (!res.ok || res.data.error) {
            result.error = res.data.error || `HTTP ${res.status}`;
            return result;
        }

        result.labelSuccess = true;
        result.trackingNumber = res.data.tracking_number;
        result.labelUrl = res.data.label_url;
        result.carrier = res.data.carrier || rateInfo.carrier;
        result.service = res.data.service || rateInfo.service;
    } catch (err) {
        result.error = err.message;
        result.durationMs = Date.now() - startMs;
    }

    return result;
}

// ─── Progress Logging ───────────────────────────────────────────────────────

function progressBar(current, total, width = 30) {
    const pct = Math.round((current / total) * 100);
    const filled = Math.round((current / total) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    return `[${bar}] ${pct}% (${current}/${total})`;
}

// ─── Markdown Report Generator ─────────────────────────────────────────────

function generateReport(rateResults, labelResults, totalDurationMs) {
    const lines = [];
    const now = new Date().toISOString();

    // Rate stats
    const rateSuccesses = rateResults.filter((r) => r.rateSuccess);
    const rateFailures = rateResults.filter((r) => !r.rateSuccess);
    const expectedFailures = rateFailures.filter((r) => r.expectFailure);
    const unexpectedFailures = rateFailures.filter((r) => !r.expectFailure);
    const allCarriers = [...new Set(rateSuccesses.flatMap((r) => r.carriers))].sort();
    const allServices = [...new Set(rateSuccesses.flatMap((r) => r.services))].sort();
    const totalRates = rateSuccesses.reduce((sum, r) => sum + r.rateCount, 0);
    const avgRateTime = rateResults.length > 0
        ? Math.round(rateResults.reduce((s, r) => s + r.durationMs, 0) / rateResults.length)
        : 0;

    // Label stats
    const labelSuccesses = labelResults.filter((r) => r.labelSuccess);
    const labelFailures = labelResults.filter((r) => !r.labelSuccess);
    const avgLabelTime = labelResults.length > 0
        ? Math.round(labelResults.reduce((s, r) => s + r.durationMs, 0) / labelResults.length)
        : 0;

    // ─── Header ───────────────────
    lines.push("# EasyPost Integration Test Report");
    lines.push("");
    lines.push(`**Generated:** ${now}  `);
    lines.push(`**Total Duration:** ${(totalDurationMs / 1000).toFixed(1)}s  `);
    lines.push(`**Mode:** ${RATES_ONLY ? "Rates Only" : "Rates + Labels"}  `);
    lines.push(`**Edge Functions Base:** \`${BASE_URL}\`  `);
    lines.push("");

    // ─── Summary ──────────────────
    lines.push("## Summary");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Address Pairs Tested | ${rateResults.length} |`);
    lines.push(`| Rate Requests Succeeded | ✅ ${rateSuccesses.length} / ${rateResults.length} |`);
    lines.push(`| Rate Requests Failed (unexpected) | ${unexpectedFailures.length > 0 ? "❌ " : ""}${unexpectedFailures.length} |`);
    lines.push(`| Rate Requests Failed (expected bad addr) | ${expectedFailures.length} |`);
    lines.push(`| Total Individual Rates Returned | ${totalRates} |`);
    lines.push(`| Avg Rates Per Successful Pair | ${rateSuccesses.length > 0 ? (totalRates / rateSuccesses.length).toFixed(1) : "—"} |`);
    lines.push(`| Unique Carriers | ${allCarriers.length} (${allCarriers.join(", ")}) |`);
    lines.push(`| Unique Services | ${allServices.length} |`);
    lines.push(`| Avg Rate Request Duration | ${avgRateTime}ms |`);

    if (!RATES_ONLY) {
        lines.push(`| Labels Purchased | ✅ ${labelSuccesses.length} / ${labelResults.length} |`);
        lines.push(`| Label Failures | ${labelFailures.length > 0 ? "❌ " : ""}${labelFailures.length} |`);
        lines.push(`| Avg Label Purchase Duration | ${avgLabelTime}ms |`);
    }
    lines.push("");

    // ─── Carrier × Service Matrix ─
    lines.push("## Carrier & Service Breakdown");
    lines.push("");

    const serviceStats = {};
    for (const r of rateSuccesses) {
        for (const rate of r.rates) {
            const key = `${rate.carrier} / ${rate.service}`;
            if (!serviceStats[key]) {
                serviceStats[key] = { carrier: rate.carrier, service: rate.service, count: 0, prices: [], deliveryDays: [] };
            }
            serviceStats[key].count++;
            serviceStats[key].prices.push(rate.display_price);
            if (rate.delivery_days != null) serviceStats[key].deliveryDays.push(rate.delivery_days);
        }
    }

    const sortedServices = Object.values(serviceStats).sort((a, b) => a.carrier.localeCompare(b.carrier) || a.service.localeCompare(b.service));

    if (sortedServices.length > 0) {
        lines.push("| Carrier | Service | Times Seen | Min Price | Max Price | Avg Price | Avg Days |");
        lines.push("|---------|---------|-----------|-----------|-----------|-----------|----------|");
        for (const s of sortedServices) {
            const minP = Math.min(...s.prices).toFixed(2);
            const maxP = Math.max(...s.prices).toFixed(2);
            const avgP = (s.prices.reduce((a, b) => a + b, 0) / s.prices.length).toFixed(2);
            const avgD = s.deliveryDays.length > 0
                ? (s.deliveryDays.reduce((a, b) => a + b, 0) / s.deliveryDays.length).toFixed(1)
                : "—";
            lines.push(`| ${s.carrier} | ${s.service} | ${s.count} | $${minP} | $${maxP} | $${avgP} | ${avgD} |`);
        }
    } else {
        lines.push("*No rates were returned.*");
    }
    lines.push("");

    // ─── Parcel Size Breakdown ────
    lines.push("## Results by Parcel Size");
    lines.push("");

    for (const parcelSize of PARCEL_SIZES) {
        const parcelRates = rateSuccesses.filter((r) => r.parcel === parcelSize.name);
        const parcelFails = rateFailures.filter((r) => r.parcel === parcelSize.name && !r.expectFailure);
        lines.push(`### ${parcelSize.name} (${parcelSize.length}×${parcelSize.width}×${parcelSize.height}in, ${parcelSize.weight_oz}oz)`);
        lines.push(`- Pairs tested: ${parcelRates.length + parcelFails.length}`);
        lines.push(`- Rates succeeded: ${parcelRates.length}`);
        lines.push(`- Rates failed: ${parcelFails.length}`);
        if (parcelRates.length > 0) {
            const pPrices = parcelRates.flatMap((r) => r.rates.map((x) => x.display_price));
            if (pPrices.length > 0) {
                lines.push(`- Price range: $${Math.min(...pPrices).toFixed(2)} – $${Math.max(...pPrices).toFixed(2)}`);
            }
        }
        lines.push("");
    }

    // ─── Rate Failures ────────────
    if (unexpectedFailures.length > 0) {
        lines.push("## ❌ Unexpected Rate Failures");
        lines.push("");
        lines.push("| # | Route | Parcel | Error | Duration |");
        lines.push("|---|-------|--------|-------|----------|");
        for (const f of unexpectedFailures) {
            lines.push(`| ${f.index} | ${f.pairLabel} | ${f.parcel} | ${escMd(f.error)} | ${f.durationMs}ms |`);
        }
        lines.push("");
    }

    if (expectedFailures.length > 0) {
        lines.push("## ⚠️ Expected Failures (Bad Addresses)");
        lines.push("");
        lines.push("| # | Route | Error | Graceful? |");
        lines.push("|---|-------|-------|-----------|");
        for (const f of expectedFailures) {
            const graceful = f.error && !f.error.includes("Internal server error");
            lines.push(`| ${f.index} | ${f.pairLabel} | ${escMd(f.error)} | ${graceful ? "✅ Yes" : "❌ No"} |`);
        }
        lines.push("");
    }

    // ─── Label Results ────────────
    if (!RATES_ONLY && labelResults.length > 0) {
        lines.push("## Label Purchase Results");
        lines.push("");

        if (labelFailures.length > 0) {
            lines.push("### ❌ Label Failures");
            lines.push("");
            lines.push("| Route | Carrier | Service | Price | Error | Duration |");
            lines.push("|-------|---------|---------|-------|-------|----------|");
            for (const f of labelFailures) {
                lines.push(`| ${f.pairLabel} | ${f.carrier} | ${f.service} | $${f.price?.toFixed(2) || "?"} | ${escMd(f.error)} | ${f.durationMs}ms |`);
            }
            lines.push("");
        }

        // Label success summary by carrier/service
        const labelByService = {};
        for (const l of labelSuccesses) {
            const key = `${l.carrier}/${l.service}`;
            if (!labelByService[key]) labelByService[key] = { count: 0, carrier: l.carrier, service: l.service };
            labelByService[key].count++;
        }

        lines.push("### ✅ Label Successes by Service");
        lines.push("");
        lines.push("| Carrier | Service | Labels Created |");
        lines.push("|---------|---------|---------------|");
        for (const [, v] of Object.entries(labelByService).sort()) {
            lines.push(`| ${v.carrier} | ${v.service} | ${v.count} |`);
        }
        lines.push("");

        // Sample labels
        const sampleLabels = labelSuccesses.slice(0, 10);
        if (sampleLabels.length > 0) {
            lines.push("### Sample Labels (first 10)");
            lines.push("");
            lines.push("| Route | Carrier | Service | Tracking | Label URL |");
            lines.push("|-------|---------|---------|----------|-----------|");
            for (const l of sampleLabels) {
                lines.push(`| ${l.pairLabel} | ${l.carrier} | ${l.service} | \`${l.trackingNumber}\` | [View](${l.labelUrl}) |`);
            }
            lines.push("");
        }
    }

    // ─── Error Catalog ────────────
    const allErrors = [
        ...rateFailures.filter((r) => !r.expectFailure).map((r) => r.error),
        ...labelFailures.map((r) => r.error),
    ];

    if (allErrors.length > 0) {
        const errorCounts = {};
        for (const e of allErrors) {
            const key = e || "Unknown error";
            errorCounts[key] = (errorCounts[key] || 0) + 1;
        }

        lines.push("## Error Catalog");
        lines.push("");
        lines.push("| Error | Occurrences |");
        lines.push("|-------|-------------|");
        for (const [err, count] of Object.entries(errorCounts).sort((a, b) => b[1] - a[1])) {
            lines.push(`| ${escMd(err)} | ${count} |`);
        }
        lines.push("");
    }

    // ─── All Rate Results Table ───
    lines.push("## Full Rate Results");
    lines.push("");
    lines.push("<details><summary>Click to expand all 200+ rows</summary>");
    lines.push("");
    lines.push("| # | Route | Parcel | OK? | Rates | Carriers | Cheapest | Time |");
    lines.push("|---|-------|--------|-----|-------|----------|----------|------|");
    for (const r of rateResults) {
        const ok = r.rateSuccess ? "✅" : (r.expectFailure ? "⚠️" : "❌");
        const carriers = r.carriers.join(", ") || "—";
        const cheapest = r.cheapestPrice != null ? `$${r.cheapestPrice.toFixed(2)}` : "—";
        lines.push(`| ${r.index} | ${r.pairLabel} | ${r.parcel} | ${ok} | ${r.rateCount} | ${carriers} | ${cheapest} | ${r.durationMs}ms |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");

    return lines.join("\n");
}

function escMd(str) {
    if (!str) return "—";
    return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const totalStart = Date.now();

    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║    EasyPost Comprehensive Integration Test              ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log("");

    const allPairs = buildTestPairs();
    const pairs = allPairs.slice(0, LIMIT);

    console.log(`📋 Test pairs: ${pairs.length} (of ${allPairs.length} total)`);
    console.log(`📦 Parcel sizes: ${PARCEL_SIZES.map((p) => p.name).join(", ")}`);
    console.log(`🔗 Edge Functions: ${BASE_URL}`);
    console.log(`🏷️  Mode: ${RATES_ONLY ? "Rates Only" : "Rates + Labels"}`);
    console.log(`⚡ Concurrency: ${CONCURRENCY}`);
    console.log("");

    // ═══ Phase 1: Rate Generation ═══════════════════════════════════════════

    console.log("━━━ Phase 1: Rate Generation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    let completedRates = 0;
    const rateResults = await runInBatches(pairs, CONCURRENCY, async (pair) => {
        const result = await testRates(pair, pairs.indexOf(pair), pairs.length);
        completedRates++;
        const status = result.rateSuccess
            ? `✅ ${result.rateCount} rates (${result.carriers.join(",")})`
            : (result.expectFailure ? `⚠️ Expected fail` : `❌ ${result.error?.slice(0, 60)}`);
        process.stdout.write(`\r  ${progressBar(completedRates, pairs.length)} ${status.padEnd(60)}`);
        return result;
    });

    console.log("\n");

    const rateSuccessCount = rateResults.filter((r) => r.rateSuccess).length;
    const rateFailCount = rateResults.filter((r) => !r.rateSuccess && !r.expectFailure).length;
    console.log(`  ✅ Rates succeeded: ${rateSuccessCount}`);
    console.log(`  ❌ Rates failed (unexpected): ${rateFailCount}`);
    console.log(`  ⚠️  Rates failed (expected): ${rateResults.filter((r) => r.expectFailure).length}`);
    console.log("");

    // ═══ Phase 2: Label Purchases ═══════════════════════════════════════════

    let labelResults = [];

    if (!RATES_ONLY) {
        // Collect all rates for label purchase
        // IMPORTANT: We can only buy ONE rate per shipment (buying a rate = buying the shipment)
        // So for each shipment (address pair), we buy the CHEAPEST rate only
        const labelTasks = [];
        const seenShipments = new Set();

        for (const r of rateResults) {
            if (!r.rateSuccess || r.rates.length === 0) continue;

            // Find cheapest rate for this shipment
            const cheapest = r.rates.reduce((min, rate) =>
                rate.display_price < min.display_price ? rate : min
            );

            // Avoid buying the same shipment twice
            if (seenShipments.has(cheapest.easypost_shipment_id)) continue;
            seenShipments.add(cheapest.easypost_shipment_id);

            labelTasks.push({
                ...cheapest,
                pairLabel: r.pairLabel,
            });
        }

        console.log(`━━━ Phase 2: Label Purchases ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`  📝 Purchasing ${labelTasks.length} labels (cheapest rate per pair)...`);
        console.log("");

        let completedLabels = 0;
        labelResults = await runInBatches(labelTasks, CONCURRENCY, async (task) => {
            const result = await testLabel(task, labelTasks.indexOf(task), labelTasks.length);
            completedLabels++;
            const status = result.labelSuccess
                ? `✅ ${result.trackingNumber}`
                : `❌ ${result.error?.slice(0, 50)}`;
            process.stdout.write(`\r  ${progressBar(completedLabels, labelTasks.length)} ${status.padEnd(60)}`);
            return result;
        });

        console.log("\n");

        const labelSuccessCount = labelResults.filter((r) => r.labelSuccess).length;
        const labelFailCount = labelResults.filter((r) => !r.labelSuccess).length;
        console.log(`  ✅ Labels created: ${labelSuccessCount}`);
        console.log(`  ❌ Labels failed: ${labelFailCount}`);
        console.log("");
    }

    // ═══ Generate Report ════════════════════════════════════════════════════

    const totalMs = Date.now() - totalStart;
    const report = generateReport(rateResults, labelResults, totalMs);

    const reportPath = join(__dirname, "easypost-results.md");
    writeFileSync(reportPath, report, "utf-8");

    console.log(`━━━ Report ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  📄 Report saved to: ${reportPath}`);
    console.log(`  ⏱️  Total duration: ${(totalMs / 1000).toFixed(1)}s`);
    console.log("");
    console.log("Done! ✨");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
