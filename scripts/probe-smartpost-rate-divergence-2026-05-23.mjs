#!/usr/bin/env node
// Empirical probe: does FedEx Smart Post quote a floor rate when given
// degenerate (zero) parcel inputs, while USPS GroundAdvantage and UPS
// Ground hold steady?
//
// Background: shipment GC37EXG (2026-05-20) was quoted on Smart Post at
// $7.49 but billed by EasyPost at $19.23 (a 156% gap). The rate.fetched
// event_log proved weight=32 oz at quote time — so weight=0 is NOT the
// cause for that shipment. Parcel dims were not logged in the older
// rates Edge Function, so we cannot retrospectively verify whether
// dim=0 was sent. This probe simulates the three permutations against
// the live EasyPost test API and prints each carrier-service quote so
// we can see who's dim-weight-sensitive and who isn't.
//
// USAGE (matches scripts/backfill-*.mjs op-read pattern, not op-run):
//   eval $(op signin)
//   EASYPOST_TEST_API_KEY=$(op read 'op://Secrets/EASYPOST_TEST_API_KEY/credential') \
//     node scripts/probe-smartpost-rate-divergence-2026-05-23.mjs
//
// Uses the TEST key — no real money moves, no real labels purchased.

const KEY = process.env.EASYPOST_TEST_API_KEY;
if (!KEY) {
  console.error("ERROR: EASYPOST_TEST_API_KEY not set in env.");
  console.error("Source it from 1Password — see USAGE block at top of this file.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(KEY + ":").toString("base64");

// Residential pair — long-distance, Smart Post-eligible.
const FROM = {
  name: "SendMo Probe",
  company: "SendMo",
  phone: "4155551234",
  street1: "1234 Market St",
  city: "San Francisco",
  state: "CA",
  zip: "94103",
  country: "US",
};
const TO = {
  name: "Recipient Probe",
  company: "Recipient",
  phone: "6175551234",
  street1: "1234 Cambridge St",
  city: "Cambridge",
  state: "MA",
  zip: "02139",
  country: "US",
};

const FIXTURES = [
  { label: "REAL: 12x9x3 in, 32 oz",        length: 12, width: 9, height: 3, weight: 32 },
  { label: "ZERO DIMS: 0x0x0 in, 32 oz",    length: 0,  width: 0, height: 0, weight: 32 },
  { label: "ZERO WEIGHT: 12x9x3 in, 0 oz",  length: 12, width: 9, height: 3, weight: 0  },
];

async function fetchRates(fx) {
  const body = {
    shipment: {
      from_address: FROM,
      to_address: TO,
      parcel: {
        length: fx.length,
        width:  fx.width,
        height: fx.height,
        weight: fx.weight,
      },
    },
  };
  const res = await fetch("https://api.easypost.com/v2/shipments", {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    return { error: data.error?.message ?? `HTTP ${res.status}`, messages: data.messages ?? [] };
  }
  return {
    rates: data.rates ?? [],
    messages: data.messages ?? [],
    shipment_id: data.id,
  };
}

function pickServices(rates) {
  // Group by (carrier, service) and capture the lowest rate per service.
  const map = new Map();
  for (const r of rates) {
    const key = `${r.carrier}/${r.service}`;
    const rate = parseFloat(r.rate);
    if (!map.has(key) || rate < map.get(key).rate) {
      map.set(key, { carrier: r.carrier, service: r.service, rate, days: r.delivery_days });
    }
  }
  return [...map.values()].sort((a, b) => a.rate - b.rate);
}

(async () => {
  console.log("=== EasyPost Smart Post rate-divergence probe ===");
  console.log(`From ${FROM.zip} → To ${TO.zip}\n`);

  const results = [];
  for (const fx of FIXTURES) {
    process.stdout.write(`Fetching: ${fx.label} ... `);
    const r = await fetchRates(fx);
    if (r.error) {
      console.log(`ERROR — ${r.error}`);
      if (r.messages.length) console.log("  messages:", r.messages);
      results.push({ fx, error: r.error });
      continue;
    }
    console.log(`${r.rates.length} rates (eps_id=${r.shipment_id})`);
    if (r.messages.length) console.log("  carrier_messages:", r.messages.map(m => `[${m.carrier}] ${m.message}`));
    results.push({ fx, services: pickServices(r.rates) });
  }

  // Pretty-print comparison: carrier/service → fixture-1 / fixture-2 / fixture-3
  console.log("\n=== Rate comparison (USD, base EasyPost rate, no SendMo markup) ===\n");
  const allKeys = new Set();
  for (const r of results) {
    if (!r.services) continue;
    for (const s of r.services) allKeys.add(`${s.carrier}/${s.service}`);
  }

  // Headers
  const colWidth = 22;
  const padR = (s, n) => String(s).padEnd(n);
  console.log(padR("carrier/service", 42), FIXTURES.map(f => padR(f.label.split(":")[0], colWidth)).join(" | "));
  console.log("-".repeat(42 + (colWidth + 3) * FIXTURES.length));

  for (const key of [...allKeys].sort()) {
    const cells = results.map(r => {
      if (!r.services) return padR("(err)", colWidth);
      const hit = r.services.find(s => `${s.carrier}/${s.service}` === key);
      return padR(hit ? `$${hit.rate.toFixed(2)}` : "—", colWidth);
    });
    console.log(padR(key, 42), cells.join(" | "));
  }

  console.log("\nReading the table:");
  console.log("  - If FedEx/SmartPost drops sharply on ZERO DIMS vs REAL → dim-weight is the lever.");
  console.log("  - If USPS GroundAdvantage and UPS Ground hold steady across fixtures → confirms Smart Post is the outlier.");
  console.log("  - If ZERO WEIGHT errors out for all carriers → weight=0 is rejected upstream (good).");
})();
