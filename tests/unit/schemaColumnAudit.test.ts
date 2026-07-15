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

// UNIQUE_INDEXES — snapshot of every UNIQUE index on the SCHEMA tables, with
// its column-set and whether it is PARTIAL (has a WHERE predicate). Pulled from
// prod (fkxykvzsqdjzhurntgah) 2026-07-15 via:
//   SELECT t.relname, i.relname, ix.indpred IS NOT NULL AS partial,
//          (SELECT array_agg(a.attname ORDER BY k.ord)
//             FROM unnest(ix.indkey) WITH ORDINALITY k(attnum,ord)
//             JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum) AS cols
//   FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid
//        JOIN pg_class t ON t.oid=ix.indrelid
//        JOIN pg_namespace n ON n.oid=t.relnamespace
//   WHERE n.nspname='public' AND ix.indisunique AND t.relname IN (<SCHEMA tables>);
//
// Why this exists: supabase-js `.upsert(..., { onConflict })` emits Postgres
// `ON CONFLICT (cols)` — which can only infer a NON-partial unique index. If
// onConflict targets a column-set that only has a PARTIAL unique index (WHERE
// predicate), Postgres raises 42P10 at runtime (supabase-js can't emit the
// predicate). That was bug 4: `carrier_adjustments` onConflict:"source_event_id"
// against a partial index. It's since migrated to a plain unique index
// (`carrier_adjustments_source_event_id_key`), so the check below PASSES today.
// SNAPSHOT MAINTENANCE: re-run the query above after any index migration.
const UNIQUE_INDEXES: Record<string, { cols: string[]; partial: boolean }[]> = {
  addresses: [{ cols: ["id"], partial: false }],
  balances: [{ cols: ["id"], partial: false }, { cols: ["user_id"], partial: false }],
  carrier_adjustments: [{ cols: ["id"], partial: false }, { cols: ["source_event_id"], partial: false }],
  event_logs: [{ cols: ["id"], partial: false }],
  holds: [{ cols: ["id"], partial: false }, { cols: ["stripe_intent_id"], partial: false }],
  link_state_events: [{ cols: ["id"], partial: false }],
  notification_contacts: [{ cols: ["id"], partial: false }],
  notifications_log: [
    { cols: ["shipment_id","contact_id","event_type"], partial: true },
    { cols: ["shipment_id","event_type","provider_id"], partial: true },
    { cols: ["id"], partial: false },
  ],
  payment_methods: [
    { cols: ["id"], partial: false },
    { cols: ["user_id","stripe_payment_method_id"], partial: false },
    { cols: ["user_id","mode"], partial: true },
  ],
  profiles: [{ cols: ["id"], partial: false }],
  recon_state: [{ cols: ["key"], partial: false }],
  refunds: [{ cols: ["id"], partial: false }, { cols: ["stripe_refund_id"], partial: false }],
  sendmo_links: [{ cols: ["id"], partial: false }, { cols: ["short_code"], partial: false }],
  shipments: [{ cols: ["id"], partial: false }, { cols: ["public_code"], partial: false }],
  stripe_intents: [
    { cols: ["idempotency_key"], partial: false },
    { cols: ["id"], partial: false },
    { cols: ["stripe_intent_id"], partial: false },
  ],
  transactions: [{ cols: ["idempotency_key"], partial: false }, { cols: ["id"], partial: false }],
  user_wallet_balance: [], // derived VIEW — no unique index
  webhook_events: [{ cols: ["event_id"], partial: false }, { cols: ["id"], partial: false }],
};

const FUNCTIONS_DIR = join(__dirname, "..", "..", "supabase", "functions");
const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

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

// ── Check 1: onConflict vs partial unique index ──────────────────────────────
// Scan every .from("table")…upsert(…, { onConflict: "col[,col2]" }) in the edge
// functions and assert the onConflict column-set matches a NON-partial unique
// index in UNIQUE_INDEXES[table]. A match against only a partial index (or no
// unique index) becomes a static failure instead of a runtime 42P10 (bug 4).
interface OnConflictProblem { file: string; line: number; table: string; onConflict: string; why: string; }

function eqSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

function auditOnConflict(): { problems: OnConflictProblem[]; scanned: number } {
  const problems: OnConflictProblem[] = [];
  let scanned = 0;
  const fromRe = /\.from\(\s*["']([a-z_]+)["']\s*\)/g;
  const onConflictRe = /onConflict\s*:\s*["']([^"'`]+)["']/g;

  for (const file of walk(FUNCTIONS_DIR)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(FUNCTIONS_DIR, file);
    let m: RegExpExecArray | null;
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(text)) !== null) {
      const table = m[1];
      // Chain chunk: from this .from() to the next .from() (or +1500 chars).
      let chunk = text.slice(m.index + m[0].length, m.index + m[0].length + 1500);
      const nxt = chunk.search(/\.from\(\s*["']/);
      if (nxt !== -1) chunk = chunk.slice(0, nxt);
      // Only upsert chains carry onConflict; skip everything else.
      if (!chunk.includes("onConflict")) continue;

      let om: RegExpExecArray | null;
      onConflictRe.lastIndex = 0;
      while ((om = onConflictRe.exec(chunk)) !== null) {
        scanned++;
        const line = text.slice(0, m.index).split("\n").length;
        const cols = om[1].split(",").map((c) => c.trim()).filter(Boolean);
        const indexes = UNIQUE_INDEXES[table] ?? [];
        const full = indexes.some((ix) => !ix.partial && eqSet(ix.cols, cols));
        if (full) continue;
        const partialOnly = indexes.some((ix) => ix.partial && eqSet(ix.cols, cols));
        problems.push({
          file: rel, line, table, onConflict: om[1],
          why: partialOnly
            ? "target has no full unique index (partial index needs its WHERE predicate, which supabase-js can't emit → runtime 42P10)"
            : "target matches no unique index in UNIQUE_INDEXES (onConflict inference will fail → runtime 42P10)",
        });
      }
    }
  }
  return { problems, scanned };
}

// ── Check 2: RPC / migration function-body column references ──────────────────
// Walk supabase/migrations/*.sql, and for each CREATE … FUNCTION body scan the
// NARROW, low-false-positive forms only: alias.column references where the alias
// is bound to a known public.<table> via FROM/JOIN in the SAME body. This is the
// class that hid bug 7 (033's `si.stripe_payment_intent_id` join against
// stripe_intents, which has no such column).
//
// SUPERSESSION — latest-definition-wins: a function may be redefined by a later
// migration (CREATE OR REPLACE). Migration 033 defines resolve_recovery_lock
// with the bug-7 column; migration 040 supersedes it with the correct
// `si.stripe_intent_id`. Both files live in the dir, so a naive scan of 033 would
// fail the test on a historical, already-superseded bug. We therefore scan ONLY
// the highest-numbered migration that defines each function name (the principled
// choice — no hand-maintained allowlist of superseded files to rot).
interface BodyProblem { file: string; func: string; alias: string; table: string; col: string; }

// Idents that are never a table alias (trigger pseudo-rows, dynamic SQL, keywords).
const ALIAS_STOP = new Set(["new", "old", "tg", "public", "pg_catalog", "information_schema"]);

function extractFunctions(text: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rest = text.slice(m.index);
    const tagM = /\bAS\s+(\$[a-z0-9_]*\$)/i.exec(rest);
    if (!tagM) continue;
    const tag = tagM[1];
    const bodyStart = rest.indexOf(tag, tagM.index) + tag.length;
    const bodyEnd = rest.indexOf(tag, bodyStart);
    if (bodyEnd === -1) continue;
    out.push({ name: m[1].toLowerCase(), body: rest.slice(bodyStart, bodyEnd) });
  }
  return out;
}

function migNum(file: string): number {
  const base = file.split("/").pop() ?? file;
  const n = parseInt(base.slice(0, 3), 10);
  return Number.isNaN(n) ? -1 : n;
}

function auditMigrationBodies(): { problems: BodyProblem[]; scannedFuncs: number } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  // Pass 1: for each function name, find the highest migration number defining it.
  const latest: Record<string, number> = {};
  const parsed: { file: string; num: number; funcs: { name: string; body: string }[] }[] = [];
  for (const f of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    const funcs = extractFunctions(text);
    const num = migNum(f);
    parsed.push({ file: f, num, funcs });
    for (const fn of funcs) latest[fn.name] = Math.max(latest[fn.name] ?? -1, num);
  }

  const problems: BodyProblem[] = [];
  let scannedFuncs = 0;
  const bindRe = /(?:FROM|JOIN)\s+public\.([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  const refRe = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;

  for (const { file, num, funcs } of parsed) {
    for (const { name, body } of funcs) {
      if (latest[name] !== num) continue; // superseded — skip (latest-wins)
      scannedFuncs++;
      // Strip -- line comments so column names inside comments aren't scanned.
      const src = body.replace(/--[^\n]*/g, "");
      // Bind aliases (and the bare table name) → table, only for known tables.
      const aliases: Record<string, string> = {};
      let bm: RegExpExecArray | null;
      bindRe.lastIndex = 0;
      while ((bm = bindRe.exec(src)) !== null) {
        const table = bm[1].toLowerCase();
        if (!(table in SCHEMA)) continue;
        aliases[table] = table; // allow full-table-name qualifier
        const alias = bm[2]?.toLowerCase();
        // Guard: the "alias" slot can capture a following SQL keyword; only bind
        // short, non-keyword identifiers.
        if (alias && !ALIAS_STOP.has(alias) && !/^(on|where|group|order|using|set|loop|and|or|as|when|then|for|update|select)$/.test(alias)) {
          aliases[alias] = table;
        }
      }
      // Check alias.column references against the schema of the bound table.
      let rm: RegExpExecArray | null;
      refRe.lastIndex = 0;
      while ((rm = refRe.exec(src)) !== null) {
        const alias = rm[1].toLowerCase();
        const col = rm[2].toLowerCase();
        if (ALIAS_STOP.has(alias)) continue;
        const table = aliases[alias];
        if (!table) continue; // unresolved alias — skip (narrow, no false positives)
        if (!SCHEMA[table].includes(col)) {
          problems.push({ file, func: name, alias, table, col });
        }
      }
    }
  }
  return { problems, scannedFuncs };
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

  it("upsert onConflict targets a full (non-partial) unique index (bug 4)", () => {
    const { problems, scanned } = auditOnConflict();
    // Sanity: the scan must actually see the upserts (guard against a no-op).
    expect(scanned, "auditOnConflict saw no onConflict options — scan is a no-op").toBeGreaterThan(3);
    const msg = problems
      .map((p) => `supabase/functions/${p.file}:${p.line}  table=${p.table}  onConflict="${p.onConflict}"  via=onConflict ${p.why}`)
      .join("\n");
    expect(problems, `\nonConflict targets with no full unique index:\n${msg}\n`).toEqual([]);
  });

  it("RPC / migration function bodies reference only columns that exist (bug 7)", () => {
    const { problems, scannedFuncs } = auditMigrationBodies();
    // Sanity: the scan must actually parse function bodies (guard against a no-op).
    expect(scannedFuncs, "auditMigrationBodies parsed no function bodies").toBeGreaterThan(3);
    const msg = problems
      .map((p) => `supabase/migrations/${p.file}  fn=${p.func}()  ${p.alias}(→${p.table}).${p.col}  UNKNOWN column`)
      .join("\n");
    expect(problems, `\nUnknown column refs in migration function bodies:\n${msg}\n`).toEqual([]);
  });
});
