# SendMo — Decision Log & Integration Gotchas

> AI agents: Read this file alongside CLAUDE.md. It captures **why** decisions were made and **hard-won** debugging knowledge. Before ending any session, propose additions here if you discovered anything new.

---

## How to Use This File

When an agent discovers something important — an API quirk, a "why did we choose X", a bug pattern — it should propose an addition to this file using the following format:

```markdown
### [YYYY-MM-DD] Short title
**Category:** Architecture | EasyPost | Stripe | Supabase | Testing | Security
**Context:** What situation led to this discovery.
**Decision/Finding:** What was decided or discovered.
**Why:** The reasoning or evidence.
**Watch out:** What breaks if you ignore this.
```

---

## Architecture Decisions

### [2026-03-18] Admin mode: PIN gate → sessionStorage → floating toolbar (Option A)
**Category:** Architecture
**Context:** John needs to create real (live) labels for testing and personal use before Stripe/auth are built, but the test/live toggle must be invisible to regular users.
**Decision/Finding:** `/admin` page now requires a 4-digit PIN (hardcoded as `2026` for now). On success, sets `sessionStorage.sendmo_admin = 'true'`. The `/onboarding` page checks this flag and shows a floating toolbar at bottom-right with "Test" (default) and "Live Comp" modes. When "Live Comp" is selected, `live_mode: true` is passed to the `rates` and `labels` Edge Functions, which use the live EasyPost API key.
**Why:** Simplest approach that works before auth ships. PIN gate means regular users never see the toggle. sessionStorage clears on tab close.
**Watch out:** (1) The PIN is hardcoded in client JS — this is temporary, replace with role-based check when auth ships. (2) `live_mode: true` is accepted by Edge Functions from any caller — add server-side admin token validation before launch. (3) Live labels cost real money on EasyPost. (4) No comp ledger entry yet — add `payment_method: 'comp'` to payments table when the transaction system is built.

### [2026-03-18] Rate fetch debounce must use refs to avoid infinite loops
**Category:** Architecture
**Context:** `RecipientStepFullShipping` uses a `useEffect` to debounce rate fetches when package details change. The initial implementation put `onUpdate` (a state setter) and the full `state` object in the dependency array of a `useCallback`. When rates came back and `onUpdate` set new rates in state, this recreated the callback, re-triggered the effect, and caused an infinite fetch loop (hundreds of 400 errors hitting the rates API).
**Decision/Finding:** Use `useRef` for `onUpdate` and `state` inside the effect. Only put primitive, rate-triggering values (address verified/street, dimensions, weight, packaging type) in the dependency array. This ensures re-fetches only happen when the user actually changes package details — not when rate results arrive.
**Why:** React's `useEffect` reruns when any dependency changes reference. Callback functions and objects change reference every render. Refs are stable across renders.
**Watch out:** This pattern is needed anywhere a debounced API call writes results back to the same state it reads from. If you add new fields that should trigger rate re-fetch, add them to the explicit dependency list — not via `state` object spread.

### [2026-03-18] Stripe stubbed with MockPaymentForm — real EasyPost test labels generated
**Category:** Architecture | Stripe
**Context:** Stripe integration is deferred, but the Full Label flow needs to generate a real label to prove the pipeline works end-to-end.
**Decision/Finding:** `RecipientStepPayment` contains a `MockPaymentForm` sub-component that renders decorative card fields (readonly, Stripe test card prefilled) with a visible "Test Mode" badge. On click, it simulates a 1.5s payment delay, then calls the real `labels` Edge Function (EasyPost test mode, free). No Stripe SDK loaded, no PaymentIntent created.
**Why:** Decouples label generation testing from payment integration. EasyPost test mode is free and produces real tracking numbers + PDF labels.
**Watch out:** When replacing with real Stripe: (1) swap MockPaymentForm for `<Elements>` + `<PaymentElement>`, (2) call `payments/authorize` before `labels`, (3) remove the simulated delay. The mock is clearly marked with `// TODO: Replace with <Elements>` comments.

### [2026-03-19] Service name display — explicit mapping table over regex parsing
**Category:** Architecture
**Context:** EasyPost returns service names in inconsistent casing: camelCase (`Groundadvantage`, `Upsgroundsavergreaterthan1lb`), ALL_CAPS_UNDERSCORE (`FEDEX_2_DAY`), and TitleCase (`Priority`). The original `serviceDisplayName()` only handled underscores.
**Decision/Finding:** Added a lookup table of 30+ known EasyPost service names → human-readable display names (e.g., `Upsgroundsavergreaterthan1lb` → "Ground Saver"). Falls back to camelCase splitting + title-casing for unknown services.
**Why:** Regex alone can't turn "Upsgroundsavergreaterthan1lb" into "Ground Saver" — that requires explicit mapping. The lookup table is fast and deterministic.
**Watch out:** When new carriers/services appear in EasyPost, they'll fall through to the regex fallback (which is usually readable enough). Add explicit mappings for any that look ugly.

### [2026-03-18] Edge Functions use `from_address`/`to_address` and `weight_oz` — not `from`/`to`/`weight`
**Category:** EasyPost
**Context:** The `api.ts` client initially sent `from`/`to` and `weight`, but the `rates` and `labels` Edge Functions expect `from_address`/`to_address` and `weight_oz`.
**Decision/Finding:** `api.ts` now matches the Edge Function field names exactly. The `parcel` object sends `weight_oz` (total ounces) not `weight` (ambiguous units).
**Why:** Field name mismatch caused silent 400 errors from the Edge Functions.
**Watch out:** When adding new API functions, always read the Edge Function's `await req.json()` destructuring to confirm exact field names before writing the client call.

### [2026-03-18] Guestimator speed keyword ordering — economy before express
**Category:** Architecture
**Context:** The Magic Guestimator parses urgency keywords to suggest a speed tier. "no rush" should match economy, but "rush" also appears in the express keyword list. If express keywords are checked first, "no rush" false-matches as express.
**Decision/Finding:** Check economy keywords (including multi-word "no rush") before express keywords (including single-word "rush"). Order: economy → standard → express.
**Why:** Multi-word phrases are more specific than single words and should take priority.
**Watch out:** When adding new keywords, consider substring conflicts. Always put longer/multi-word phrases in groups that are checked first.

### [2026-03-18] Build Full Prepaid Label path first, compatible with Flexible Link
**Category:** Architecture
**Context:** Project had many starts and stops. Backend is 100% built but frontend is all stubs. Need to ship something real ASAP — John wants to send a label to his mom.
**Decision/Finding:** Build the Full Prepaid Label recipient path first (Steps 0→1→10→11→12). Flexible Link shares Steps 0 and 1, so building shared components first ensures compatibility. Stripe is stubbed initially (frontend mock + backend placeholder) to unblock the flow.
**Why:** Full Label is the simplest end-to-end path (recipient enters everything, pays, gets PDF). It exercises addresses, rates, labels, and payment — all the core APIs. Flexible Link adds Steps 20-23 later using the same page component with branching logic.
**Watch out:** The `RecipientOnboarding.tsx` page must use step-based state management that supports both paths from the start. Don't hardcode Full Label assumptions into shared components.

### [2026-03-18] Supabase project survives pause but DNS goes offline
**Category:** Supabase
**Context:** Supabase project `fkxykvzsqdjzhurntgah` was paused due to inactivity. On restore, DNS took a few minutes to propagate. The anon key in `.env.local` uses a non-standard format (`sb_publishable_...` instead of `eyJ...` JWT).
**Decision/Finding:** After restore, all 8 migrations were still applied (only migration 008 needed pushing — it hadn't been applied before the pause). All 9 Edge Functions remained ACTIVE and deployed. Database tables exist but are empty (no test data).
**Why:** Supabase preserves migrations and Edge Functions across project pauses. Data in tables is also preserved but the project had no data to begin with.
**Watch out:** After restoring a paused project, always verify: (1) DNS resolves, (2) tables exist, (3) Edge Functions are listed as ACTIVE. The anon key format may vary — test it with a real API call, don't just check the format.

### [2026-03-18] Previous stack (Next.js/Prisma) was abandoned — current stack is Supabase Edge Functions
**Category:** Architecture
**Context:** An earlier iteration of SendMo used Next.js 14 + Prisma ORM + Vercel Postgres + single index.html frontend with dark navy/teal design. This was completely replaced.
**Decision/Finding:** Current stack: React/Vite/TS + Tailwind/shadcn frontend, Supabase Edge Functions (Deno) backend, Supabase PostgreSQL, clean blue/white design. No Prisma, no Next.js, no dark theme.
**Why:** Supabase Edge Functions offer zero cold-start, co-located DB access, and simpler deployment. React/Vite is faster to develop with than a single-file approach.
**Watch out:** Old session notes referencing Prisma, Next.js API routes, dark navy design, or "buyer/seller" terminology are from the abandoned stack. Current terminology: "recipient" (creates link, pays) and "sender" (clicks link, ships).

### [2026-02-25] DB insertions for third-party operations (EasyPost) should be fire-and-forget
**Category:** Architecture | EasyPost | Supabase
**Context:** When a user buys a label from EasyPost, the operation succeeds but we also need to persist to the database to track shipments. Previously, failure to sync would result in orphaned records.
**Decision/Finding:** The `labels` Edge Function injects a fire-and-forget call (no `await`) to call the `admin_insert_shipment()` RPC using the service role *after* EasyPost succeeds. We must return the label URL and tracking number to the user immediately, even if the DB write fails or takes a long time.
**Why:** The critical path is delivering the label to the user. A DB outage or latency spike on our end should not prevent a user from seeing the label they just paid for. By using fire-and-forget DB writes to a robust RPC with full FK handling, we separate the external API transaction from our internal bookkeeping.
**Watch out:** If a DB insert fails, the `labels` function relies on structured logging (`label.db_persisted` vs. `label.db_persist_error`) to record the outcome. This ensures an audit trail. We must monitor these logs.


### [2026-02-24] Use Supabase Edge Functions for all backend logic
**Category:** Architecture  
**Context:** Needed a scalable backend without managing servers.  
**Decision:** All server logic lives in Supabase Edge Functions (Deno/TypeScript). No Express server, no separate API service.  
**Why:** Zero cold-start penalty vs. Lambda, co-located with DB, native Deno secrets management, easy local dev with `supabase functions serve`.  
**Watch out:** Deno imports use URL syntax (`import x from "npm:package"`), not Node `require()`. Third-party packages must be Deno-compatible.

### [2026-02-24] White-label EasyPost — never expose carrier branding to users
**Category:** Architecture  
**Context:** SendMo is a white-label shipping product.  
**Decision:** EasyPost must never appear in any user-facing UI, error messages, or email copy. All policies (refunds, cancellations, tracking) are presented as "SendMo policies."  
**Why:** Brand integrity and competitive sensitivity.  
**Watch out:** Error messages from EasyPost API often include carrier names. Always strip/replace before returning to frontend.

### [2026-02-24] Two-file documentation system (PRD.md + CLAUDE.md + DECISIONS.md)
**Category:** Architecture  
**Context:** Multiple overlapping PRD versions were causing confusion.  
**Decision:** Consolidate all product knowledge into `PRD.md`, developer/agent instructions into `CLAUDE.md`, and decision rationale into `DECISIONS.md`.  
**Why:** Single source of truth for each audience. Agents always know where to look.  
**Watch out:** Never let a fourth "source of truth" accumulate. Update the three canonical files, not random new ones.

### [2026-02-25] Server-side state is always truth — never derive critical decisions from client-provided data
**Category:** Architecture  
**Context:** The `cancel-label` v1 accepted `live_mode` from the client request body to decide whether to call the real carrier API. This was wrong — a malicious or buggy client could set `live_mode=true` on a test label, causing a real carrier API call, or `live_mode=false` on a live label, bypassing the carrier entirely.  
**Decision/Principle:**  
> **Any decision that affects server behavior or data integrity must be derived from server-side sources (DB, env vars, JWT claims) — never from client-provided parameters.**  

Specific rules that follow from this principle:
1. `is_test` is a DB column set at creation time — never sent by the client
2. User identity/role is read from JWT claims — never from a request body `user_id`
3. Pricing is computed server-side from rates — never trusted from the client
4. Refund eligibility is checked from DB state — not from a client-asserted status  
**Watch out:** Watch for any Edge Function that accepts a parameter that could change a security or financial outcome. If the client can provide it, the server must re-validate it from a trusted source.

---

## EasyPost Integration Gotchas

### [2026-02-25] Luma AI Select is for Headless Automation, not UI highlighting
**Category:** EasyPost  
**Context:** Explored using EasyPost Luma AI to add a "Recommended" badge to the best shipping rate in the Sender UI.  
**Decision/Finding:** Decided to hold off on Luma AI for now. Luma AI Select is designed primarily to *automatically purchase* the best rate based on dashboard rules, replacing the UI choice entirely ("Autopilot"). It is not designed to simply flag a rate as "recommended" in an array of options.  
**Why:** Implementing Luma just to highlight a UI option adds unnecessary orchestration complexity. If we want UI badges, a simple custom server-side rule (e.g., "cheapest under 4 days") is better. If we want to use Luma, we should pivot the Sender UX to "Autopilot" and remove the carrier choice entirely.  
**Watch out:** If this feature is revisited, decide on the UX goal first. If keeping the list of choices, build a custom backend rule. If removing choices, use Luma AI.

### [2026-02-24] USPS requires `EndShipper` — causes `ProviderEndShipper` error if missing
**Category:** EasyPost  
**Context:** USPS label purchases were failing with a cryptic `ProviderEndShipper` error.  
**Decision/Finding:** USPS requires an `EndShipper` object in the EasyPost buy request. This is not required for UPS or FedEx.  
**Why:** USPS regulation — the entity responsible for the shipment must be declared.  
**Watch out:** The `EndShipper` must use the `SB_SERVICE_ROLE_KEY` env var (not `SUPABASE_SERVICE_ROLE_KEY`). Also, the EndShipper address must match a real, verified business address.

### [2026-02-24] EasyPost address verification — "soft warning" vs "hard error"
**Category:** EasyPost  
**Context:** Rural addresses were being rejected even though they're valid and deliverable.  
**Decision/Finding:** EasyPost returns a `verifiable` flag. If `verifiable: false` but Google Maps confirms the address exists, treat it as a **soft warning** (accepted with a note) not a hard rejection.  
**Why:** Rural Route addresses, RFD addresses, and some PO Boxes pass USPS delivery but fail EasyPost's street-level verification.  
**Watch out:** Don't block the user flow for soft warnings. Return `{ verified: true, warning: "...", address_type: "rural" }`. Log as `address.soft_warning` event.

### [2026-02-24] EasyPost Google Fallback — when EasyPost rejects but Google confirms
**Category:** EasyPost  
**Context:** Some valid addresses were being hard-rejected by EasyPost's verifier.  
**Decision/Finding:** Implemented a Google Maps geocoding fallback. If EasyPost rejects AND Google confirms the address exists with high confidence, accept with a warning.  
**Why:** EasyPost's verifier is strict for non-standard address formats. Google's geocoder is more permissive and often correct.  
**Watch out:** Log all fallback events as `address.google_fallback` for monitoring. Track the fallback rate — if it spikes, something upstream changed in EasyPost's behavior.

### [2026-02-24] PO Box and Military (APO/FPO/DPO) — USPS only
**Category:** EasyPost  
**Context:** PO Box addresses were being offered UPS/FedEx rates that would always fail.  
**Decision/Finding:** Detect PO Box and APO/FPO/DPO addresses in the `addresses` function. Return `{ is_po_box: true }` or `{ is_military: true }` and `usps_only: true`.  
**Why:** UPS and FedEx do not deliver to PO Boxes or military addresses. Offering those rates leads to purchase failures.  
**Watch out:** Filter non-USPS rates in the `rates` function when `usps_only: true`. Log `address_type` in all events for audit queries.

### [2026-02-24] Same address validation — sender = recipient must be blocked
**Category:** EasyPost  
**Context:** Edge case testing revealed a user could accidentally configure the same address for both sender and recipient.  
**Decision/Finding:** Added frontend validation to block identical from/to addresses before calling the rates API.  
**Why:** EasyPost will return rates for same-address shipments (technically valid), but they're always user errors.  
**Watch out:** Compare normalized addresses (lowercase, trimmed) not raw strings.

---

## Supabase / Database Gotchas

### [2026-02-24] Use `SB_SERVICE_ROLE_KEY` not `SUPABASE_SERVICE_ROLE_KEY` in Edge Functions
**Category:** Supabase  
**Context:** Supabase CLI injects `SUPABASE_SERVICE_ROLE_KEY` automatically in local dev, but production secrets use a custom name.  
**Decision/Finding:** This project uses `SB_SERVICE_ROLE_KEY` as the env var name for the service role key in Edge Functions.  
**Why:** Avoids collision with Supabase's auto-injected local variable; explicit name makes it clear this is a secret you must set manually.  
**Watch out:** After deploying a new function, always run `npx supabase secrets set SB_SERVICE_ROLE_KEY=...`. Forgetting this causes silent auth failures.

### [2026-02-24] RLS policies block service role writes — use the service client
**Category:** Supabase  
**Context:** Edge functions were failing to write test data to the database even with RLS "disabled."  
**Decision/Finding:** RLS applies to the `anon` and `authenticated` roles. The service role bypasses RLS, but only if you create the client with the service role key: `createClient(url, serviceRoleKey)`.  
**Why:** Default Edge Function client uses the `anon` key. You must explicitly create a second client for admin operations.  
**Watch out:** Never use the service role client for user-facing operations. Only use it in admin functions or background jobs.

### [2026-02-24] Foreign key constraints — insert order matters
**Category:** Supabase  
**Context:** Label creation was failing with FK constraint violations.  
**Decision/Finding:** Insert order: `profiles` → `addresses` → `sendmo_links` → `shipments` → `payments`. Violating this order causes FK errors.  
**Why:** Each table references the previous one. The DB enforces referential integrity.  
**Watch out:** In tests, always seed in this order. In the `labels` function, always verify the upstream records exist before inserting.

### [2026-02-25] System user pattern — well-known UUID for pre-auth label records
**Category:** Supabase  
**Context:** All label records during the label-test phase need a valid FK to `profiles`, but real Supabase Auth (magic link) hasn't shipped yet. The old hack used a hardcoded fake UUID `b0000000-...` inserted ad hoc from the `test-db-insert` Edge Function.  
**Decision/Finding:** Migration `004_system_user_and_helpers.sql` inserts a well-known system/admin identity into `auth.users` + `profiles`:
- UUID: `00000000-0000-0000-0000-000000000001`
- Email: `admin@sendmo.co`, full_name: `SendMo Admin`

All label-test shipments use `p_user_id = '00000000-0000-0000-0000-000000000001'`. When real auth ships, the label flow passes the actual `auth.uid()` — no other code changes.  
**Why:** Reproducible, auditable, idempotent (`ON CONFLICT DO NOTHING`). Admin queries via service role always bypass RLS so the system user's records are always readable for reporting. No separate "admin" RLS policy needed.  
**Watch out:** The system user UUID is a sentinel — never issue it to real users. Direct SQL insert into `auth.users` only works in service-role migrations (`npx supabase db push`). If you recreate the DB, the migration re-runs and the row is silently skipped on conflict.

### [2026-02-25] `admin_insert_shipment()` RPC — transactional FK-ordered insert
**Category:** Supabase  
**Context:** Edge Functions calling the anon Supabase client can't insert into tables protected by RLS. The old approach was three separate round-trips from TypeScript with careful ordering and error recovery. Any step failure left orphaned rows.  
**Decision/Finding:** Created a `SECURITY DEFINER` PostgreSQL function `admin_insert_shipment(p_user_id, ...)` that performs all inserts atomically in FK order:
```
addresses (from) → addresses (to) → sendmo_links → shipments
```
Returns the new `shipments.id`. Called via `supabase.rpc('admin_insert_shipment', {...})` with the anon client — the function body runs as its owner (service role), bypassing RLS entirely.  
**Why:** Atomicity (all rows committed or none), single network round-trip, FK ordering guaranteed by the function, no orphaned rows on partial failure. Also future-proof: passing a different `p_user_id` at call time is the only change needed when real auth users arrive.  
**Watch out:** `GRANT EXECUTE ... TO anon, authenticated` is required — without it, the anon client gets a `permission denied` even though the function is SECURITY DEFINER. The function is in `public` schema; do not move it to a private schema without re-granting.

---

## Testing Gotchas

### [2026-02-24] Always write a regression test BEFORE fixing a bug
**Category:** Testing  
**Context:** Bugs were being fixed without tests, leading to regressions.  
**Decision:** Rule 12 in CLAUDE.md — write the regression test first (red), then fix (green).  
**Why:** Forces you to understand the failure mode before changing code. Guarantees the bug is caught if reintroduced.  
**Watch out:** The test must fail without the fix and pass with it. Don't write tests that pass either way.

### [2026-02-24] EasyPost TEST key is `EZTKxxxx` prefix — LIVE key charges real money
**Category:** Testing  
**Context:** Developers could accidentally use the live EasyPost key during development.  
**Decision/Finding:** Always validate that the API key starts with `EZTK` before making EasyPost calls in development. Refuse to proceed if it starts with `EZak` (live key).  
**Why:** Live EasyPost labels cost real money and cannot be easily refunded during testing.  
**Watch out:** This check should be in the Edge Function OR enforced by having separate `.env.local` and `.env.production` files with different keys.

---

## Label Cancellation / Refund Gotchas

### [2026-02-25] Label void eligibility — check `shipment.status` AND `refund_status`
**Category:** EasyPost  
**Context:** The cancel-label function needed robust eligibility guards.  
**Decision/Finding:** A label can only be voided if: (1) `shipment.status = 'label_created'`, (2) `refund_status = 'none'`, (3) `easypost_shipment_id` is present.  
**Why:** EasyPost rejects void requests after the carrier scans the package. Our DB guards must mirror this constraint.  
**Watch out:** EasyPost refund processing takes 2–4 weeks. Update `refund_status` to `submitted` immediately upon successful void API call, not `refunded`. A webhook will eventually confirm when the refund is processed.

### [2026-02-25] EasyPost test labels cannot be refunded via API — is_test is a DB attribute, not a client mode
**Category:** Architecture / EasyPost  
**Context:** After implementing cancel-label, admin void attempts on test labels returned "Label void request was rejected by the carrier." The first fix (v1) was to accept `live_mode` from the client and simulate success in test mode. This was wrong — it allowed the client to determine server behavior.  
**Decision:** `is_test` is a boolean column on `shipments`, set **server-side at creation time** by the function that knows which API key was used. It is never derived from client-provided parameters.  
**Fix applied:**
- Migration `005_add_is_test_to_shipments.sql` — adds `is_test BOOLEAN NOT NULL DEFAULT false`
- `test-db-insert` — always sets `is_test: true` (these records always use the test key)
- `labels` — should set `is_test: !isLive` when writing the shipment record (Phase 1 production path)
- `cancel-label` — removed `live_mode` from the request API; reads `is_test` from DB instead
- `Admin.tsx` — removed heuristic guessing (email patterns, tracking prefixes); reads `sh.is_test` from DB
- `CancelLabelModal` — removed `live_mode` from the POST body entirely  
**Why:** The client cannot be trusted to determine whether a shipment is real or synthetic. That decision is made once, by the server, at creation time, and stored durably in the DB.  
**Watch out:** Test labels get a clear, honest rejection: "Test labels cannot be voided. Void is only available for live shipments." No silent simulation — behavior is deterministic and honest.

---

## Logging / Observability Gotchas

### [2026-02-25] `log()` is fire-and-forget — don't await it on the critical path
**Category:** Architecture  
**Context:** Logging was being awaited, adding latency to every API response.  
**Decision/Finding:** The `log()` helper in `_shared/logger.ts` should never be awaited on the critical path. Use `log({...})` without `await`.  
**Why:** Log ingestion latency (DB write) should not block the user-facing response.  
**Watch out:** This means log failures are silent. Add a try/catch inside `logger.ts` itself to swallow errors gracefully.

---

*Last updated: 2026-03-19 | Add new entries at the top of each category section.*
