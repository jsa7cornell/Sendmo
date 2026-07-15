// Schema-column audit — static regression guard for the "select a column
// that doesn't exist" bug class.
//
// Why this exists (2026-07-14): the webhooks shipment.invoice arm selected
// shipments.user_id — a column that doesn't exist — so EVERY carrier
// adjustment errored at runtime and was swallowed as "shipment_not_found"
// (H2 fully dead in prod, silently). Edge functions are in no tsconfig and
// unit tests mock the Supabase client, so nothing static or mocked can catch
// a column-name/schema mismatch. This test closes that gap: it scans every
// .from("table") chain under supabase/functions/ and validates the column
// names in .select("…") strings, filter-method first-args, and
// .insert/.update/.upsert object-literal keys against the schema snapshot
// below. The same sweep found 3 more live bugs the day it was written
// (stripe-webhook Email B fallback, tracking-admin ledger select, links
// audit-log insert).
//
// SNAPSHOT MAINTENANCE: after any migration that adds/renames columns,
// regenerate with:
//   SELECT table_name, string_agg(column_name, ',' ORDER BY column_name)
//   FROM information_schema.columns WHERE table_schema='public'
//   GROUP BY table_name ORDER BY table_name;
// and update SCHEMA below. A missing new column shows up as a failure here
// naming the exact file:line — that's the test doing its job.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SCHEMA: Record<string, string[]> = {
  addresses: ["city","country","created_at","easypost_id","id","is_verified","label","name","phone","state","street1","street2","user_id","zip"],
  balances: ["amount_cents","created_at","id","updated_at","user_id"],
  carrier_adjustments: ["captured_weight_oz","claimed_weight_oz","created_at","delta_cents","expected_credit_cents","id","reason","recovery_status","recovery_tx_id","resolved_at","shipment_id","source","source_event_id"],
  event_logs: ["actor_id","created_at","duration_ms","entity_id","entity_type","event_type","id","properties","session_id","severity","source"],
  holds: ["amount_cents","authorized_at","capture_target_cents","captured_at","expires_at","id","link_id","mode","status","stripe_intent_id","voided_at"],
  link_state_events: ["actor_user","created_at","event","id","link_id","metadata","reason"],
  notification_contacts: ["address","channel","created_at","id","role","shipment_id"],
  notifications_log: ["channel","contact_id","created_at","error_message","event_type","id","provider_id","shipment_id","status"],
  payment_methods: ["bank_name","brand","created_at","deleted_at","exp_month","exp_year","funding_source","id","is_default","last4","mode","stripe_payment_method_id","user_id"],
  profiles: ["admin_active_mode","avatar_url","created_at","daily_budget_cents","email","full_name","id","phone","role","stripe_customer_id_live","stripe_customer_id_test","updated_at","weekly_budget_cents"],
  recon_state: ["key","last_cursor","last_run_at","updated_at"],
  refunds: ["amount_cents","created_at","easypost_void_id","id","mode","reason","shipment_id","status","stripe_payment_intent_id","stripe_refund_id"],
  sendmo_links: ["created_at","expires_at","id","is_test","last_decline_email_at","link_type","max_price_cents","notes","preferred_carrier","preferred_speed","recipient_address_id","sender_name","short_code","size_hint","status","updated_at","user_id","weight_hint_oz"],
  shipments: ["cancel_token","cancelled_at","carrier","carrier_refund_id","created_at","delivered_at","display_price_cents","easypost_refund_status","easypost_shipment_id","easypost_tracker_id","escrow_id","height_in","id","is_live","is_test","item_description","label_url","length_in","link_id","payment_method","promised_delivery_date","public_code","rate_cents","recipient_address_id","refund_status","refund_submitted_at","sender_address_id","service","status","stripe_payment_intent_id","tracking_number","updated_at","weight_oz","width_in"],
  stripe_intents: ["amount_cents","cancellation_reason","capture_method","captured_cents","created_at","funding_source","id","idempotency_key","intent_kind","intent_role","last_event_at","last_payment_error_code","link_id","mode","payment_method_id","shipment_id","statement_descriptor_suffix","status","stripe_intent_id","transfer_group","updated_at","user_id"],
  transactions: ["amount_cents","created_at","description","funding_source","id","idempotency_key","link_id","mode","shipment_id","stripe_charge_id","stripe_intent_id","type","user_id"],
  user_wallet_balance: ["balance_cents","last_movement_at","mode","user_id"],
  webhook_events: ["created_at","event_id","event_type","id","payload","processed","source"],
};

const FUNCTIONS_DIR = join(__dirname, "..", "..", "supabase", "functions");

interface Finding { file: string; line: number; table: string; via: string; col: string; }

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Top-level columns from a .select() string; skips embedded relation blocks
 *  (rel:other_table(cols) — different table), aliases, !inner hints, casts. */
function parseSelectCols(sel: string): string[] {
  const s = sel.replace(/\s+/g, " ");
  const cols: string[] = [];
  let depth = 0, tok = "";
  for (const ch of s) {
    if (ch === "(") { depth++; tok = ""; continue; }
    if (ch === ")") { depth--; continue; }
    if (depth > 0) continue;
    if (ch === ",") { if (tok.trim()) cols.push(tok.trim()); tok = ""; }
    else tok += ch;
  }
  if (tok.trim()) cols.push(tok.trim());
  return cols
    .map((c) => (c.includes(":") ? c.split(":", 2)[1].trim() : c))
    .filter((c) => c && c !== "*" && !c.includes("!") && c !== "count")
    .map((c) => c.split("::")[0].trim());
}

/** Extract the balanced {...} object literal starting at `start` (index of '{'),
 *  with nested object/array bodies blanked so only top-level keys remain. */
function topLevelObjectBody(text: string, start: number): string | null {
  let depth = 0, out = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") { depth++; if (depth === 1) continue; }
    if (ch === "}" || ch === "]") { depth--; if (depth === 0) return out; }
    out += depth === 1 ? ch : ch === "\n" ? "\n" : " "; // blank nested bodies, keep line count
  }
  return null;
}

function audit(): Finding[] {
  const findings: Finding[] = [];
  const fromRe = /\.from\(\s*["']([a-z_]+)["']\s*\)/g;
  const selectRe = /\.select\(\s*(["'`])([\s\S]*?)\1/g;
  const filterRe = /\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|order|contains)\(\s*["']([a-zA-Z0-9_.]+)["']/g;
  const writeRe = /\.(insert|update|upsert)\(\s*\{/g;
  const keyRe = /(^|[,{\n])\s*([a-z_][a-z0-9_]*)\s*:/gi;

  for (const file of walk(FUNCTIONS_DIR)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(FUNCTIONS_DIR, file);
    let m: RegExpExecArray | null;
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(text)) !== null) {
      const table = m[1];
      const line = text.slice(0, m.index).split("\n").length;
      if (!(table in SCHEMA)) {
        findings.push({ file: rel, line, table, via: "from", col: "<unknown table>" });
        continue;
      }
      const valid = new Set(SCHEMA[table]);
      // Chain chunk: from the .from() to the next .from() (or +1500 chars).
      let chunk = text.slice(m.index + m[0].length, m.index + m[0].length + 1500);
      const nxt = chunk.search(/\.from\(\s*["']/);
      if (nxt !== -1) chunk = chunk.slice(0, nxt);

      let sm: RegExpExecArray | null;
      selectRe.lastIndex = 0;
      while ((sm = selectRe.exec(chunk)) !== null) {
        // Template-literal selects with ${…} are dynamic — skip those tokens.
        for (const col of parseSelectCols(sm[2])) {
          if (col.includes("${")) continue;
          const base = col.split(".")[0];
          if (!valid.has(base)) findings.push({ file: rel, line, table, via: "select", col });
        }
      }
      let fm: RegExpExecArray | null;
      filterRe.lastIndex = 0;
      while ((fm = filterRe.exec(chunk)) !== null) {
        const raw = fm[2];
        const base = raw.split("->")[0].split(".")[0];
        // dotted path = embedded-resource filter (other table) — validate only
        // that the base is a known table instead of a column of `table`.
        if (raw.includes(".")) {
          if (!(base in SCHEMA)) findings.push({ file: rel, line, table, via: fm[1], col: raw });
          continue;
        }
        if (!valid.has(base)) findings.push({ file: rel, line, table, via: fm[1], col: raw });
      }
      let wm: RegExpExecArray | null;
      writeRe.lastIndex = 0;
      while ((wm = writeRe.exec(chunk)) !== null) {
        const body = topLevelObjectBody(chunk, wm.index + wm[0].length - 1);
        if (!body) continue;
        let km: RegExpExecArray | null;
        keyRe.lastIndex = 0;
        while ((km = keyRe.exec(body)) !== null) {
          const k = km[2];
          if (!valid.has(k)) findings.push({ file: rel, line, table, via: wm[1], col: k });
        }
      }
    }
  }
  return findings;
}

describe("edge-function schema column audit", () => {
  it("references only columns that exist in the prod schema snapshot", () => {
    const findings = audit();
    const msg = findings
      .map((f) => `supabase/functions/${f.file}:${f.line}  table=${f.table}  via=${f.via}  UNKNOWN: ${f.col}`)
      .join("\n");
    expect(findings, `\nUnknown column references (schema snapshot in this test file):\n${msg}\n`).toEqual([]);
  });

  it("sanity: the audit itself sees the codebase (non-trivial scan)", () => {
    // Guard against a silent no-op (e.g. FUNCTIONS_DIR moved): the scan must
    // cover a realistic number of files or the first assertion means nothing.
    const files = walk(FUNCTIONS_DIR);
    expect(files.length).toBeGreaterThan(20);
  });
});
