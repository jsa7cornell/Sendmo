# SendMo — Log (Decisions & Deploys)

This file combines two critical logs: **Decisions & Gotchas** (why decisions were made, hard-won debugging knowledge) and **Deploy Log** (what shipped to production and when).

Agents should read this alongside PLAYBOOK.md. Before ending any session, propose additions here if you discovered anything new.

---

## Decisions & Gotchas

### [2026-05-13] Tracking page IA polish — family composition + Phase 2 print logging + admin affordance
**Category:** UX | Tracking | Print audit | Schema
**Cross-link:** [proposals/2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md](proposals/2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md). Decided 2026-05-13 — T1=(a) (item_description ships via migration 021), T2=(i) (anonymous-allowed item visibility).

**Context:** After today's round-1 polish (commit `65192c6`, the CancelledShipmentBanner + AppHeader fix) John flagged that the page still felt disjointed — same fact shown 3 times (banner + status card + progress), "Shipped: May 13" on a label that never shipped, no instructions on what to do with a printed PDF. Wrote an implementation proposal, ran it through a fresh-eyes review session. Reviewer caught two real blockers (B1: `item_description` doesn't exist on `shipments`; B2: `from_city/state, to_city/state` live on the joined `addresses` table, not denormalized) plus a privacy blocker (B3: `item_description` exposure is a separate threat-model from the Round-2 PDF-PII Option (a)). T1+T2 escalated to John, decided 2026-05-13.

**Decision/Finding:**

**Family-based composition** — page now dispatches per state (F1 Ready-to-Ship / F2 In-Motion / F3 Cancelled) rather than a single skeleton with hidden blocks. Each family has one hero (no banner + status-card duplication), one details card with family-specific field config, and family-specific action surfaces. Status hero hides for F3 entirely (the rich CancelledShipmentBanner is the hero). The reviewer was right that this is the right architectural call — round-1 polish had hit the structural ceiling of the toggle-skeleton.

**Print logging — Phase 2** ([`label-print/index.ts`](supabase/functions/label-print/index.ts)). New POST endpoint with the same 3-path auth shape as `cancel-label` (JWT / X-Cancel-Token / anonymous). Writes a `label.printed` row to `event_logs` with `properties.{actor, user_id, ip, user_agent, session_id, public_code}`. Anonymous viewers can log (intentional — over-indexing on who-printed-it per John's call). `is_test=true` shipments return early without writing (N1 — avoids polluting event_logs with synthetic prints). Rate limit 10/min per (ip + public_code). The user-facing chip is a simple "Printed N times" count; the rich actor data lives in the audit row for admin/support investigation. Phase 2.1 future enhancement: enrich the chip for authorized viewers with last-actor labels.

**Schema** — Migration 021 adds `shipments.item_description TEXT NULL`. Labels function persists `parcel.description` via a follow-up UPDATE after the canonical RPC (deliberately not adding an `admin_insert_shipment` parameter — the 2026-05-13 orphan-shipment incident proved that RPC-signature changes are a brittle pattern). SenderFlow's buy call passes the description. Tracking response embeds addresses via PostgREST FK relations (`sender_address:addresses!sender_address_id(city,state)`) — never denormalized columns. Surfaces `from_city / from_state / to_city / to_state` (city+state only; never street1 per PLAYBOOK Rule 7).

**Tracking response (B4 + N2 fixes):**
- `shipment_id` returned only when caller is admin (server-side `profiles.role='admin'` JWT check) — keeps public response slim.
- The three event_logs queries (cancelled-actor + print-count + last-printed) run via `Promise.all` after the shipment SELECT. Cancelled-state tracking GETs now 1 round-trip for the event_logs batch, not 3.

**Shared auth helper** ([`_shared/actor.ts`](supabase/functions/_shared/actor.ts)). Extracted from cancel-label's inline 3-path logic into a typed `deriveActor()`. label-print uses it; cancel-label can migrate in a follow-up. Single source of truth for the auth shape that took three Q&A rounds to land on cancel-label.

**UI polish (N4 + N5 + PP3 + PP4):**
- **Dropped the carrier-adjustment $0.00 stub** entirely. Reviewer was right — Phase G's shape is a `carrier_adjustments` table with per-event rows, not a column read. When Phase G lands it adds the UI in its own PR with the correct SUM-from-table semantics.
- `PrintAnotherLabelCTA` renders only for `status === 'cancelled'` (not `return_to_sender` — printing a new label doesn't fix a returning package). Does NOT set `sendmo_just_voided_for_change` — cold-landing on a cancelled page is a fresh start, not a continuation.
- Carrier tracking number hidden on F1 (USPS hasn't scanned yet — would 404) and F3 (dead number post-void). Only F2 shows it, paired with "View on USPS site" deep-link.
- F3 timestamp label says "Label created" (NEVER "Shipped" — the package never shipped).

**Admin affordance** ([`AdminAffordanceFooter.tsx`](src/components/tracking/AdminAffordanceFooter.tsx)). Quiet "Admin debug →" link at the bottom, gated by `isAdmin`. Deep-links to `/admin?shipment=<id>` when the server returned `shipment_id` (admin caller); falls back to `/admin` otherwise. Full inline admin panel is **Ask 4 — separate proposal**.

**Reprint reassurance copy** (industry-pattern correction). Old copy said "single shipment, don't reprint" — wrong on carrier mechanics. Pirate Ship / Shippo / Easyship all allow unlimited reprints until carrier scan. New copy: *"Safe to reprint — your card was charged once. The label locks when USPS scans the package."*

**Watch out:**
- **Migration 021 must apply before edge function deploys** — the labels function and tracking function both reference `item_description`. The GitHub Action deploys functions on push; the migration runs separately via the Supabase dashboard (per Rule 0.5 — agents don't write to prod DB). **Apply order:** (1) John runs migration 021 in Supabase dashboard; (2) GitHub Action picks up the edge-function deploys from the push. Same recurrence pattern as 2026-05-13 orphan-shipment — code references schema before schema applied → 500s. The labels function's UPDATE on `item_description` is in a try/catch (non-fatal) so this fails open, but the tracking function's SELECT will fail outright if the column isn't there.
- **Address join coverage gap.** The PostgREST embed expects every shipment to have both `sender_address_id` + `recipient_address_id` populated. Orphan-recovered rows from 2026-05-13 used the canonical RPC, which populates them — so coverage should be 100%. If a future codepath skips the RPC, From/To rows will render as blank (graceful — the DetailsCard hides the rows on null).
- **Item description privacy** — anonymous URL-holders see item_description per T2=(i). If a sender enters something sensitive ("PrEP medication", "engagement ring"), anyone with the forwarded URL learns it. Flagged for future-revisit if abuse pattern emerges; the round-2 Option (a) PDF-PII decision was specifically *not* extended to cover this.
- **Print logging is anonymous-allowed**, rate-limited 10/min/IP. A bad actor with the share URL can dirty the log. Mitigated by rate limit; accepted that the log is advisory, not enforcement.
- **No Ask 4 yet.** Admin affordance footer is a stub that deep-links to `/admin?shipment=<id>`. The `/admin` page does not yet read the `?shipment=` query param — wire-up TBD in the Ask 4 proposal.

**Tests:** 300 unit tests pass (was 257; +43 — DetailsCard 11, PrintAnotherLabelCTA 6, AdminAffordanceFooter 3, HowToShipStrip 3, logLabelPrint 6, actor.test 4 contract + 7 deriveActor (gated `skipIf` on Deno-import resolution), ShipmentLabelSection +5). `npx tsc -b --noEmit` clean. Updated 1 existing test (ShipmentLabelSection's old "single shipment" copy → "Safe to reprint" + privacy caveat).

**Files touched:**
- [supabase/migrations/021_shipments_item_description.sql](supabase/migrations/021_shipments_item_description.sql) — NEW.
- [supabase/functions/_shared/actor.ts](supabase/functions/_shared/actor.ts) — NEW (shared 3-path auth helper).
- [supabase/functions/label-print/index.ts](supabase/functions/label-print/index.ts) — NEW (Phase 2 print logging endpoint).
- [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts) — persist `parcel.description` → `item_description` via follow-up UPDATE.
- [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts) — addresses via PostgREST embed; `item_description`, `from/to_city/state`, `print_count`, `last_printed_at`, admin-gated `shipment_id`; event_logs queries parallelized via `Promise.all`; `easypost_shipment_id` added to SELECT (latent bug fix — refund-poll block was reading a column that wasn't in the SELECT).
- [src/lib/api.ts](src/lib/api.ts) — new `logLabelPrint()` client; `buyLabel()` gains optional `parcel.description` arg.
- [src/pages/SenderFlow.tsx](src/pages/SenderFlow.tsx) — passes `parcel.description` to `buyLabel`.
- [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx) — family composition; print logging wired with optimistic increment + rollback (N3); admin affordance footer rendered for `isAdmin`.
- [src/components/tracking/ShipmentLabelSection.tsx](src/components/tracking/ShipmentLabelSection.tsx) — print-count chip; reprint-reassurance copy.
- [src/components/tracking/DetailsCard.tsx](src/components/tracking/DetailsCard.tsx) — NEW.
- [src/components/tracking/HowToShipStrip.tsx](src/components/tracking/HowToShipStrip.tsx) — NEW.
- [src/components/tracking/PrintAnotherLabelCTA.tsx](src/components/tracking/PrintAnotherLabelCTA.tsx) — NEW.
- [src/components/tracking/AdminAffordanceFooter.tsx](src/components/tracking/AdminAffordanceFooter.tsx) — NEW.
- [tests/unit/](tests/unit/) — 5 new test files + 1 updated.

**Deploy order:**
1. **John runs `supabase/migrations/021_shipments_item_description.sql` in the Supabase dashboard SQL editor** (Rule 0.5 — agents don't write to prod DB).
2. Push to main → GitHub Action auto-deploys `tracking`, `labels`, `label-print` (changed). Verify via `gh run list --workflow="Deploy Supabase Edge Functions"`.
3. Vercel auto-deploys frontend on the same push.
4. Verify the dogfood URLs (`/t/NEC7J3E` cancelled, `/t/Z7BCPTY` test-delivered, `/t/71NF1E8` live-delivered, `/t/RA2W2NG` live-in-flight).

**Follow-ups (flagged, not bundled):**
- Ask 4 — full inline admin debug panel with role-gated endpoint.
- Phase 2.1 — enrich print-count chip for authorized viewers with last-actor labels.
- Phase G — populate carrier-adjustment line on F2 Paid row.
- cancel-label refactor to use `_shared/actor.ts` (zero behavior change; just dedup).
- `/admin?shipment=<id>` read-side wiring.

---

### [2026-05-13] Two-step refund + lazy EasyPost poll on `/t/<code>`
**Category:** Cancellation | Stripe | Refund safety | EasyPost
**Cross-link:** [proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md](proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md) + [proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) §11 #1.

**Context:** John surfaced a real failure mode during the 2026-05-13 dogfood after cancelling `NEC7J3E`: the cancel-label function fired Stripe `createRefund` the instant EasyPost accepted the void request. EasyPost's "submitted" only means *queued* with the carrier — USPS/UPS take 1–2 weeks to actually verify the label wasn't scanned and credit the cost back to SendMo's EasyPost account. If the customer's card is refunded immediately and USPS later rejects the void (label was scanned), SendMo eats the refund + the carrier cost. The current behavior would have bitten the first real-money cancel.

Same dogfood: John asked whether we could proactively check EasyPost's refund status rather than only waiting for a (currently unwired) webhook.

**Decision/Finding:**
- **`cancel-label/index.ts` no longer calls Stripe `createRefund`.** The function still posts to EasyPost `/v2/shipments/<id>/refund` to submit the carrier void, but the Stripe block is gone. The `createRefund` import is replaced with a documenting comment so the next reader sees the deferral, not a missing dependency. The refund_status assignment becomes a clean three-way:
  - `epRefundStatus === 'rejected'` → `'rejected'` (label was already scanned)
  - no Stripe PI → `'not_applicable'` (comp; final state)
  - has Stripe PI → `'submitted'` (Phase E happy path; tracking-poll will fire Stripe later)
- **`tracking/index.ts` gained a lazy refund poll.** When a `/t/<code>` page view loads a shipment with `refund_status='submitted'` and an `easypost_shipment_id`, the function calls `GET /v2/shipments/<id>` and reads the latest `refund_status`. Three outcomes:
  - EP says `refunded` AND shipment has `stripe_payment_intent_id` → call Stripe `createRefund` with the same idempotency key cancel-label would have used (`refund_${easypost_shipment_id}_user_cancel`). Stripe-webhook then advances `refund_status='submitted' → 'refunded'` on `charge.refunded` per the existing Phase A pattern.
  - EP says `refunded` AND no Stripe PI (comp) → update DB `refund_status='not_applicable'` and we're done.
  - EP says `rejected` → update DB `refund_status='rejected'`.
  - EP says `submitted` (still pending) → no action.
- **User-facing cancel message updated** in `cancel-label` to set realistic expectations: *"Cancellation in progress. The carrier typically confirms within 1–2 weeks; once confirmed, your refund will be issued automatically to the original card."* Old copy said "a few minutes to a few days" which was incorrect for the carrier-confirmation window.

**Why this shape:**
- **Idempotency via Stripe's own key dedup.** Multiple page loads during the window between EP-confirms and Stripe-webhook-fires could re-call `createRefund`. Stripe's idempotency_key handling makes repeat calls return the existing Refund object — no duplicate charges. No new DB column needed to dedup our side.
- **Page-view-triggered poll is sufficient at MVP scale.** Today's universe: 4 active live shipments. Even when the active set grows, anyone who cares about a refund will visit `/t/<code>` at some point. For shipments nobody visits (a real edge), the WISHLIST has a cron-poll item — defer until volume justifies it.
- **EasyPost refund webhook (push-based) is the proper end state**, lazy poll is the safety net. WISHLIST entry filed for the webhook verification + wiring; until EP's exact event names are confirmed (`refund.successful`? bundled into `tracker.updated`?), the lazy poll is the only mechanism that closes the carrier-confirmation loop without infrastructure work.

**Watch out:**
- **`cancel.stripe_refund_initiated` and `cancel.stripe_refund_failed` event_logs now come from `tracking/index.ts`** (source=`'tracking'`), not from cancel-label. The cancel-label function emits a single `shipment.cancelled` row at cancel time; the Stripe-initiation log appears later, separately, when the EP refund confirms via the poll. Grep queries that filtered by `source='cancel-label'` for refund-initiation events will miss the new path. Search by `event_type IN ('cancel.stripe_refund_initiated', 'cancel.stripe_refund_failed')` instead.
- **No active dogfood path exists today** — zero Stripe-paid shipments exist in the database, so the Stripe-refund branch in the tracking poll is dormant. First exercise will be Phase E (real flex-link payments). The comp branch (mark `not_applicable` when EP confirms) is exercisable: visit `/t/NEC7J3E` once USPS confirms the void and the page will sync `refund_status='not_applicable'`. (Today USPS hasn't confirmed yet — refund_status will stay `not_applicable` from the original cancel.)
- **Wait — actually NEC7J3E is already `not_applicable`** because the existing cancel-label set that immediately for comp shipments via the `!stripe_payment_intent_id` branch. The poll only changes state for shipments where EP's response differs from our DB. For comp shipments where we already marked `not_applicable`, the poll is a no-op. Confirmed safe.
- **`shipment.refund_status` is mutated in-memory after the poll** so the response body reflects current state. This is a local-object mutation, not a refetch — if other functions on the read path rely on the original DB-loaded value, they'd see the new value. Today nothing else reads `shipment.refund_status` after the poll block, but if a future agent adds something, they should be aware.
- **EasyPost API call is silent-fail.** Network errors, missing key, HTTP non-200 — all swallowed in the catch block, page renders from DB state. Acceptable for MVP; should be louder in production observability later.
- **Stripe refund call is idempotent but logs every attempt.** If a shipment sits at `refund_status='submitted'` for days with the carrier-confirmed state, every page view fires `cancel.stripe_refund_initiated`. Stripe itself dedupes the Refund object; our log gets one row per page view in the window between EP-confirmed and Stripe-webhook-fired. Acceptable but worth knowing — if `event_logs` for this event type look noisy, that's why.

**Tests:** 257 unit tests pass (was 245; +12 net since last commit — the polish agent landed component tests in parallel). `npx tsc -b --noEmit` clean. No new tests added for this change because the new logic lives in Edge Functions (Deno) which aren't covered by vitest; the existing `cancelLabel.test.ts` pure-helper tests still pass since I didn't touch the eligibility predicates.

**Deploy:** `npx supabase functions deploy cancel-label --no-verify-jwt && npx supabase functions deploy tracking --no-verify-jwt`. Vercel auto-deploys the client on push (no client changes in this commit, so nothing client-side to verify post-deploy).

**Verification after deploy:**
1. New cancellation: `/t/<code>` shows updated "1–2 weeks" copy in the confirm dialog and post-cancel banner ✓ (UI-only test).
2. For a shipment in `refund_status='submitted'`: a `/t/<code>` page view triggers a `GET /v2/shipments/<id>` against EasyPost. Verify in `event_logs` via `SELECT event_type, properties, created_at FROM event_logs WHERE event_type LIKE 'cancel.ep_%' OR event_type LIKE 'cancel.stripe_%' ORDER BY created_at DESC LIMIT 5`. Today: no rows expected because all current cancels are already at terminal `not_applicable`. First entries will appear when a Stripe-paid shipment cancels (Phase E).

**Files touched:**
- [supabase/functions/cancel-label/index.ts](supabase/functions/cancel-label/index.ts) — removed Stripe `createRefund` block, simplified `refundStatusToWrite` decision tree, updated user-facing message
- [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts) — added lazy refund poll block with three outcome branches
- [WISHLIST.md](WISHLIST.md) — promoted "Stripe refund on label void" to [~] partial, filed two new follow-ups (EP webhook wiring; cron-poll for stale submitted shipments)

---

### [2026-05-13] Tracking page UX polish — Ask 1 / 2 / 3 from John dogfood
**Category:** UX | Tracking | Cancel-flow
**Context:** Handoff [`proposals/2026-05-13_tracking-page-ux-polish-handoff.md`](proposals/2026-05-13_tracking-page-ux-polish-handoff.md) — three asks from the 2026-05-13 dogfood pass on `/t/<public_code>`, the canonical shipment-management surface. Cross-links the decided cancel-flow proposal [`proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md`](proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md).

**Decision/Finding:**

**Ask 3 — AppHeader user/login on `/t/<code>`.** [`TrackingPage.tsx`](src/pages/TrackingPage.tsx) was passing `actions={<span>Track Package</span>}` to `<AppHeader>`, which overrode the default `UserMenu`/`Sign In` slot. Dropped the `actions` prop. AppHeader's default behavior now renders: signed-in → user menu; anonymous → FAQ + Sign In buttons. The decorative "Track Package" label was duplicative with the body's status banner/card.

**Ask 2 — Cancellation timestamp + actor on the cancelled-state page.** New component [`CancelledShipmentBanner.tsx`](src/components/tracking/CancelledShipmentBanner.tsx) renders: void title + body, relative + absolute cancel time (with hover tooltip), actor label, and a refund-status chip (`submitted` / `refunded` / `rejected` / `not_applicable`).

- **Actor lookup:** tracking edge function ([`supabase/functions/tracking/index.ts`](supabase/functions/tracking/index.ts)) now reads the latest `event_logs` row where `event_type='shipment.cancelled' AND entity_type='shipment' AND entity_id=<shipment.id>` and surfaces `properties.actor` as `cancelled_by_actor` on the response. Option (b) from the handoff — no migration, single extra read for cancelled shipments only (small minority of tracking fetches).
- **Actor → UI copy:** `admin` → "Cancelled by SendMo admin"; `link_owner` + `viewer_is_recipient` → "Cancelled by you"; `link_owner` + recipient-viewer-false → "Cancelled by the recipient"; `session_token` / `email_token` → "Cancelled by the sender".
- **`cancelled_at` is sourced from the `shipments` row directly** (already populated by `cancel-label`). Tracking response now includes it.
- **Audit-row future-proofing:** [`supabase/functions/cancel-label/index.ts`](supabase/functions/cancel-label/index.ts) now writes `properties.user_id = callerId` on the `shipment.cancelled` event_logs row. Not surfaced in UI today — just captured so future agents can resolve a display name when actor is `admin` or `link_owner`. Anonymous (session/email-token) cancellations land with `user_id = null`.

**Ask 1 — State-aware UI polish.** Replaced the single `TERMINAL_BANNERS` branch with two paths: `status === 'cancelled'` → new `CancelledShipmentBanner` (rich, with metadata); `status === 'return_to_sender'` → existing red banner pattern. Other states (in_transit / out_for_delivery / delivered / label_created / test / fresh) were already well-handled; resisted the urge to repaint per the handoff.

**Refund-chip mapping (matches proposal §2.3):**
| `refund_status` | Visual |
|---|---|
| `submitted` | amber chip "Cancellation in progress — refund pending" |
| `refunded` | emerald chip "Refund of $X.XX issued" (uses `amount_paid_cents` if present, else "Refund issued") |
| `rejected` | destructive chip "Cancellation rejected — please contact support" |
| `not_applicable` | neutral chip "No charge was made" |
| `none` | not rendered (defensive — shouldn't reach cancelled state with `refund_status='none'`) |

**Watch out:**
- **Edge-function deploy required.** The tracking function changes (`cancelled_by_actor`, `cancelled_at`) and the cancel-label audit change (`user_id`) are server-side. Vercel auto-deploys handle the front-end on push, but `supabase functions deploy tracking --no-verify-jwt` and `supabase functions deploy cancel-label --no-verify-jwt` must run separately. **Until deployed, the UI gracefully degrades** — `cancelled_by_actor` returns undefined and the actor row simply doesn't render. The relative timestamp still renders once `cancelled_at` is exposed.
- **Preview verification was blocked.** Dev server requires `op run --env-file=.env.tpl -- npm run dev` to inject Supabase env vars; plain `npm run dev` (what `preview_start` uses) renders a blank screen. Type-check + 257 unit tests (+12 new in `CancelledShipmentBanner.test.tsx`) provide correctness coverage; manual visual verification falls to John on the staging URLs (`/t/NEC7J3E` for cancelled + not_applicable).
- **Anonymous-third-party still sees Print/Download** (no Cancel) per the Round-2 privacy decision (Option a). Not regressed.
- **No new migration.** `shipments.cancelled_at` and `event_logs.properties.actor` already exist; no schema change needed.

**Tests:** 257 unit tests pass (was 245; +12 in [tests/unit/CancelledShipmentBanner.test.tsx](tests/unit/CancelledShipmentBanner.test.tsx) covering all four actor variants, all five refund-status visuals, relative-time rendering, and the no-metadata graceful-degradation case). `npx tsc -b --noEmit` clean.

**Files touched:**
- [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx) — drop `actions` prop on AppHeader; route `status='cancelled'` to new banner; surface `cancelled_at` / `cancelled_by_actor` in the `TrackingData` interface.
- [src/components/tracking/CancelledShipmentBanner.tsx](src/components/tracking/CancelledShipmentBanner.tsx) — NEW.
- [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts) — select `cancelled_at`; look up latest `shipment.cancelled` event_logs row for actor; surface both on response.
- [supabase/functions/cancel-label/index.ts](supabase/functions/cancel-label/index.ts) — write `properties.user_id = callerId` on the audit row.
- [tests/unit/CancelledShipmentBanner.test.tsx](tests/unit/CancelledShipmentBanner.test.tsx) — NEW.

**Follow-ups (flag, don't bundle):**
- **Dashboard "Created on" copy** for orphan-recovered shipments shows the recovery timestamp, not the EasyPost-buy time. Cosmetic.

---

### [2026-05-13] Orphan-shipment recovery + Cancel works without `label_url`
**Category:** Recovery | UX | Data integrity
**Context:** Dogfood pass surfaced that 4 EasyPost LIVE labels John printed on 2026-05-12 (22:48 – 23:48 UTC) don't appear in his Dashboard. Cross-checked the EasyPost CSV export against `shipments` via MCP: **zero matches**. Pulled `event_logs` for the same window — each EasyPost `label.created` was followed by `label.db_persist_error`. Two distinct error shapes:
- **22:48 / 23:22 / 23:24:** `Could not find the function public.admin_insert_shipment(... p_from_country, p_from_state, p_from_street2, ...)` — note `p_from_name` and `p_from_street1` MISSING from the labels-function call. The frontend was still sending the old address shape.
- **23:48:** Same RPC-not-found error, but with full `p_from_name` + `p_from_street1` present — meaning the labels-function code had updated but the RPC schema cache hadn't picked up migration 018 yet.
- **00:28 on 2026-05-13:** `column reference "public_code" is ambiguous` — migration 018 applied, migration 019 not yet.
- **00:40 onward:** persists succeeded (`CG7FWV3`, then `Z7BCPTY` at 05:22).

4 live shipments orphaned: EasyPost has them and was paid; our DB has zero record; they couldn't be cancelled through the UI because they didn't exist in `shipments`.

**Decision/Finding:**

**Code fix — Cancel renders without `label_url`** ([`ShipmentLabelSection.tsx`](src/components/tracking/ShipmentLabelSection.tsx)). The component's `labelUrl: string` became `string | null`. The label-preview + Print + Download row is now conditional inside the component — when `null`, an "Label PDF not available" notice renders along with the Share button (which shares the `/t/<code>` URL, not the PDF). Cancel + Cancel & start over still render based on `canCancel` regardless of label_url. [`TrackingPage.tsx`](src/pages/TrackingPage.tsx)'s `data.label_url` gate was dropped — the section is now mounted whenever `status === 'label_created'` and non-terminal. This unblocks the orphan recovery (where label_url=NULL) without requiring a label-URL backfill.

**Recovery script** ([`scripts/recover-orphan-shipments-2026-05-12.sql`](scripts/recover-orphan-shipments-2026-05-12.sql)). 4 sequential `SELECT * FROM admin_insert_shipment(...)` calls — uses the canonical RPC so the resulting rows have proper public_codes, short_codes, addresses, sendmo_links (full_label, in_use), and is_live=true / is_test=false. `p_label_url := NULL` for all four. `p_easypost_tracker_id := NULL` (webhook lookup uses tracking_number anyway, so this is fine — when EasyPost scans the package the webhook will flip status to `in_transit` correctly).

**Why John runs the SQL, not the agent.** Supabase MCP is read-only in this project — `execute_sql` errors with `cannot execute INSERT in a read-only transaction`. Even though Rule 0.5 strictly targets destructive ops (and INSERTs are additive), the MCP enforcement closes the path regardless. John pastes the script into the Supabase dashboard SQL editor (project `fkxykvzsqdjzhurntgah`). Post-run verification SQL is included at the bottom of the file (read-only — safe for MCP to run from agent after John completes the inserts).

**Why label_url is NULL:** The EasyPost API has the URL on each shipment object, but the recovery doesn't fetch it because (a) it would require shipping out a one-shot Edge Function that uses the LIVE EasyPost key, and (b) John already has the printed labels locally. The orphans exist mostly so they can be **cancelled**, which only needs `easypost_shipment_id` (present). If a label_url backfill is wanted later, it's a small one-shot Edge Function (`recover-label-urls`) that calls `GET /v2/shipments/<id>` and UPDATEs.

**Watch out:**
- **The 5th orphan** (`shp_7adb9b1c33914f16bb239c26d1fa1509` at 00:28 UTC 2026-05-13) is in `event_logs` but NOT in John's EasyPost CSV export. Per John's call we're NOT recovering it; if it turns out to have been a real print, run a single follow-up `admin_insert_shipment` call.
- **Re-running the recovery script is not idempotent.** Each call generates a fresh `public_code` and `short_code`. If a row succeeds and you re-run, Postgres will reject on `easypost_shipment_id UNIQUE` (no — wait: `easypost_shipment_id` is NOT unique in the schema; this could double-insert). Operationally: run the script once. If a single statement errors mid-way, comment out the completed ones before re-running. **TODO follow-up:** add a UNIQUE constraint on `shipments.easypost_shipment_id` to make recovery scripts idempotent. Today's behavior allows duplicate rows on retry, which is a latent data-integrity gap.
- **Recovered shipments will reach `delivered` via the webhook** when EasyPost eventually scans the package. The `webhooks/index.ts` lookup is by `tracking_number` so the orphans will get status updates normally. The link revival → `completed` flip will also fire correctly.
- **Recovery rows show in admin report as live margin.** Per Phase A: the `transactions` ledger only writes `charge` rows via stripe-webhook (which won't fire for these because the labels were comp-mode Live Comp, no Stripe PI). So the recovered shipments have no `transactions` row at all — they're invisible to margin reporting until a Phase E true-charge run lands. For these specific 4, that's correct (they were live-mode but uncharged by Stripe — equivalent to comp). Comp-grant entries weren't written either (the labels function's `transactions.insert` only fires when `dbShipmentId` is set, which it wasn't for the orphans). Net: the comp_grant ledger entries for these 4 are **lost forever** — small data hygiene gap, not actionable.

**Tests:** 245 unit tests pass (was 244; +1 — `ShipmentLabelSection.test.tsx` gains a `labelUrl=null` case verifying Print/Download hide, the recovery-note shows, and Share still renders). `npx tsc -b --noEmit` clean.

**Files touched:**
- [src/components/tracking/ShipmentLabelSection.tsx](src/components/tracking/ShipmentLabelSection.tsx) (labelUrl nullable + conditional PDF row + recovery note + warning gated)
- [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx) (drop the data.label_url gate)
- [tests/unit/ShipmentLabelSection.test.tsx](tests/unit/ShipmentLabelSection.test.tsx) (new labelUrl=null test)
- [scripts/recover-orphan-shipments-2026-05-12.sql](scripts/recover-orphan-shipments-2026-05-12.sql) (NEW — one-shot recovery, John runs in dashboard)

---

### [2026-05-13] Test-mode visibility on Dashboard + tracking page
**Category:** UX | Dogfood | Test-mode hygiene
**Context:** Dogfood pass surfaced a real confusion: `K6SX3ES` showed "Delivered" on `/t/<code>` but USPS had no record of the tracking number. Investigation via Supabase MCP: every shipment generated since the launch-blocker fix is `is_test=true` (EasyPost test API). Test-mode tracking numbers look like real USPS numbers (`9434600208303112218294`) and EasyPost's test trackers auto-advance through `label_created → in_transit → delivered` regardless of physical reality. The "View on USPS site" link goes to a 404 because USPS never saw the synthetic number. Two product calls came out of the dogfood:
- **Test-mode shipments should be visibly labeled** so users know not to trust the data.
- **No "test-cancel" stub.** The proper way to dogfood Cancel/Change is Live Comp (real EasyPost label, no Stripe charge). Adding an `is_test` bypass to `cancel-label` would fork prod code for marginal iteration speed — Live Comp tests the actual EasyPost void path and costs nothing.

**Decision/Finding:**
- **Tracking response gains `is_test: boolean`** ([`tracking/index.ts`](supabase/functions/tracking/index.ts)). Existing `shipments.is_test` column; just surfaces it to the client.
- **`/t/<public_code>` test banner** ([`TrackingPage.tsx`](src/pages/TrackingPage.tsx)). Amber `FlaskConical` banner at the top of the page: *"Test label — not a real shipment. This was generated against EasyPost's test API. The tracking number looks real but USPS has never seen it. Statuses on this page auto-advance and aren't tied to anything physical."*
- **"View on USPS site" link hidden** for `is_test=true` shipments (was sending users to a guaranteed 404).
- **Cancel/Change buttons hidden** for `is_test=true` shipments. The cancel-label function already rejects test shipments with a 422 (since Phase A); the new gate in `canCancel` derivation matches the server's behavior instead of offering a click that fails. Dogfooding Cancel/Change is **only** via Live Comp from now on.
- **Dashboard TEST pill** ([`Dashboard.tsx`](src/pages/Dashboard.tsx)). Small amber pill next to the SendMo Label ID column (both desktop table + mobile cards). Hover tooltip: "Test-mode label — synthetic tracking number; not a real shipment."

**Why no test-cancel stub:**
- The cost of the fork: two cancel code paths (real EasyPost void + synthetic UI-only). State machines drift in subtle ways. `event_logs` and admin reports start needing mode filters everywhere. Stripe-webhook coordination only fires on real refunds; the test path lies about what happened.
- The benefit: faster UI iteration. But the UI is already unit-testable (`tests/unit/cancelLabelDialog.test.tsx` + `cancelAuth` derivation), and Live Comp is a 30-second click-through from `/onboarding` → admin toolbar → Live Comp → walk through Full Prepaid Label.
- The real EasyPost void endpoint, called by Live Comp cancels, is the integration we actually want to exercise. A stubbed test path skips that entirely.

**Watch out:**
- **EasyPost test-mode auto-advance is FAST.** Today's two test shipments hit `delivered` within hours. If you generate a test label and want to inspect the `label_created` state in the UI, you have a small window. The TEST banner shows up regardless, but the Cancel buttons are hidden anyway (because of the new gate), so the auto-advance behavior is less of a problem in practice now.
- **One live shipment in the entire DB.** `71NF1E8` from 2026-03-18. Every other row is `is_test=true`. Phase E and beyond will start writing real `is_live=true` rows.
- **Test pill is a `<span>`, not a link.** Don't add an `onClick` later that mutates the row — it's a label, not a control.

**Tests:** Existing 244 unit tests still pass. No new tests; the test-mode gate is visual + one boolean check in `canCancel` (already covered indirectly).

**Files touched:**
- [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts) (response: `is_test`)
- [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx) (TEST banner, hide carrier link, gate canCancel, FlaskConical import)
- [src/pages/Dashboard.tsx](src/pages/Dashboard.tsx) (TEST pill in desktop table + mobile cards)

**Deploy:** `npx supabase functions deploy tracking --no-verify-jwt`. Vercel auto-deploys the client on push.

---

### [2026-05-13] Cancel-flow Phase B slice 1 — `/t/<public_code>` is the single shipment-management surface
**Category:** UX | Dashboard | Consolidation
**Proposal:** [proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md](proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md) §2.7 Phase B items 2 (Dashboard-side cancel) + 3 (state messages).
**Context:** Phase A landed two cancel UIs on Dashboard — the new `CancelLabelDialog` reachable via `/t/<code>` click-through, and the older `CancelLabelModal` reachable via the inline "Void Label" link in the Actions column. Dogfood feedback: redundant; the modal used SPEC §13.1's outdated "credited to your SendMo account" copy while the new dialog used the post-Stripe-§11-#1 "refund to your card" copy. Decided to consolidate around `/t/<public_code>` as the single management surface (Option A from the dogfood discussion). Plus three concurrent UX fixes: honest status copy for `label_created` rows, From/To both rendered (was Sender-only), and Tracking column renamed to "SendMo Label ID" for white-label consistency.

**Decision/Finding:**
- **Dashboard consolidation.** [`Dashboard.tsx`](src/pages/Dashboard.tsx):
  - `Actions` column **removed**. `Cancel*` modal/state/handler/import all retired. Admin's `/admin` still uses `CancelLabelModal.tsx` — file kept.
  - `Tracking` column renamed to **`SendMo Label ID`** (white-label rule — never surface carrier branding when SendMo's own identifier exists). The cell is still a Link to `/t/<public_code>`.
  - Single new `From` column + new `To` column. Both pulled from the per-shipment `addresses` rows (PostgREST embedded resource via `sender_address:addresses!sender_address_id(name)` + `recipient_address:addresses!recipient_address_id(name)`), with fallback to `sendmo_links.sender_name` for older full-label rows.
  - **Honest status copy:** `statusWithDate()` was unconditionally using `updated_at` and rendering `"Shipped on Mar 18"` for `label_created` rows. That was a lie when the package hadn't moved. Now branches: `label_created` uses `created_at` and reads `"Created on Mar 18 · awaiting carrier scan"`; transitional/terminal statuses still use `updated_at`.
- **Share button** on [`ShipmentLabelSection.tsx`](src/components/tracking/ShipmentLabelSection.tsx). Print stays as the primary; Download and Share now share a 2-col secondary row. Share prefers `navigator.share()` on mobile (native share sheet), falls back to `navigator.clipboard.writeText()` with a 2s "Copied" confirmation. The shared URL is `${origin}/t/<public_code>` — safe to share publicly, same surface the label-confirmation email already advertises.
- **Recipient + sender both already cancel on `/t/<code>`.** John's request to surface this — verified Phase A's `canCancel` derivation in TrackingPage.tsx already covers it: `label_created AND (isAdmin OR viewer_is_recipient OR sessionStorage cancel_token)`. The recipient is signed in as the link owner → `viewer_is_recipient=true` (server-derived from JWT vs `sendmo_links.user_id`). The sender holds the cancel_token (sessionStorage on Confirm, or `?cancel=<hex>` from the future email transport). No code change needed; the audit trail in `event_logs` already distinguishes the actor (`actor='admin'|'link_owner'|'session_token'|'email_token'`).

**Why this shape:**
- One canonical surface beats two. `/t/<public_code>` is the bookmark-friendly URL John already chose in Round 2 of the sender-flow proposal; everything related to a shipment belongs there.
- The hashed Crockford-base32 `public_code` provides URL-as-capability auth for view-and-print (anyone with the URL can print). Cancel auth is layered on top via the per-shipment `cancel_token` so the print-share doesn't accidentally also grant cancel.
- Renaming Tracking → "SendMo Label ID" reinforces the white-label rule in PLAYBOOK §"Label Cancellation / Void" — we never surface carrier branding when our own identifier exists, and "tracking" was confusable with the carrier's tracking number.
- Honest `label_created` copy was free to fix. The "Shipped on" wording dated back to migration 001 era when status was directly tied to label-buy and there was no `label_created` vs in_transit distinction.

**Watch out:**
- **Address-name fallback chain matters.** Full-label rows minted before the address-shape fix (2026-05-12 Track 1+3 closeout) had a `addressToApi` boundary that silently dropped `street1` when undefined. The shipments that DID land in production for the Feb–Mar 2026 era should have `addresses` rows because the labels function inserts addresses *before* attempting the shipments insert. But if any rows landed without a populated address, `s.sender_address?.name` will fall through to `sendmo_links.sender_name` (the canonical full-label sender), then to `"Unknown"`. No null-pointer surface.
- **Bare `null` recipient on a row reads as `—`.** Flex links pre-2026-05-11 (sender-flow wizard launch) may have shipments without populated `recipient_address` — defensive fallback renders an em-dash. Should be rare; surface only if dogfood shows it.
- **CancelLabelModal still imported from `/admin`.** The file lives. If someone deletes it later, audit `/admin` first — that's the only remaining caller (Admin.tsx:5).
- **Share button uses `navigator.share`'s typed cast.** `Navigator.share` isn't in Deno-deploy or some older browser type lib variants; the typed-cast pattern (`navigator as Navigator & { share: (...) => Promise<void> }`) bypasses without breaking older browsers — graceful fallback to clipboard.
- **No accessToken in Dashboard.** Removed the unused `accessToken` state alongside the Modal retirement. AuthContext + Supabase client handle JWT for the user's own queries; nothing in Dashboard reaches the cancel-label function directly anymore.
- **Phase B items still deferred** (proposal §2.7): cancel notification email template + dispatcher, `/s/<short_code>` friendly per-state messages for `in_use`/`completed`/`expired`/`cancelled`, and multi-billing-per-link admin report audit. The recipient-initiated cancel path is now end-to-end via the `/t/<code>` surface itself, which closes the larger of the deferred items.

**Tests:** 244 passed / 0 failed (was 243; +1 — added a Share-button assertion to `tests/unit/ShipmentLabelSection.test.tsx` and updated the "Download PDF" label match to the shortened "Download"). `npx tsc -b --noEmit` clean.

**Files touched:**
- [src/pages/Dashboard.tsx](src/pages/Dashboard.tsx) (column rename, From/To, "Created on" copy, Actions column removed, CancelLabelModal/cancelTarget/handleCancelled/accessToken retired)
- [src/components/tracking/ShipmentLabelSection.tsx](src/components/tracking/ShipmentLabelSection.tsx) (Share button + handleShare; Download label shortened)
- [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx) (passes `shareUrl` to ShipmentLabelSection)
- [tests/unit/ShipmentLabelSection.test.tsx](tests/unit/ShipmentLabelSection.test.tsx) (Share button test + updated Download label match)

---

### [2026-05-12] Cancel-flow Phase A — user-facing Cancel + Change on `/t/<public_code>`
**Category:** Feature | Cancellation | UX | Auth | Schema | Stripe coordination
**Proposal:** [proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md](proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md)
**Context:** `/t/<public_code>` had Print + Download but no way for a sender or recipient to back out of a label they just generated. SPEC §13.1 had user-facing void as "Post-MVP" but the user need surfaces every dogfood. The proposal went through three rounds of in-session Q&A which materially reshaped it from the original draft — email-token auth replaces the originally-proposed cross-origin cookie (`SameSite=Lax` doesn't survive `*.supabase.co` → `sendmo.co`), `refund_status='submitted'` becomes the legitimate "cancellation in progress" state (no partial-cancels rule from John), the `sendmo_links` lifecycle is rebuilt from scratch (used→in_use rename, new `completed` state, revival semantics), and the Stripe Phase A migration that landed earlier the same day forces cancel-label to defer ledger writes to `stripe-webhook` (sole-writer rule, proposal §3.4 round-1 B4). Cross-link: builds on Stripe Phase A entry below and the launch-blocker closeout above it.

**Decision/Finding:**
- **Three-path auth** in [`cancel-label/index.ts`](supabase/functions/cancel-label/index.ts) (full rewrite):
  - (1) JWT — admin OR link-owner (existing).
  - (2) `X-Cancel-Token` header — for just-shipped sender (sessionStorage) AND returning sender (email-token captured via `?cancel=<hex>`).
  - (3) Body `cancel_token` field — same primitive, fallback in case of header stripping.
  Constant-time hex compare; per-IP+public_code rate limit (5 req / 60s in-memory).
- **Async refund state machine.** Cancel-label calls Stripe's `createRefund` when `shipments.stripe_payment_intent_id` is present and writes `refund_status='submitted'`. The `stripe-webhook` handler (sole ledger writer per Phase A) already writes the `-refund` transaction row on `charge.refunded`; this PR adds the corresponding `UPDATE shipments SET refund_status='refunded' WHERE refund_status='submitted'` so the state machine closes. Comp shipments (no PI) land in `not_applicable` immediately. UI surfaces "Cancellation in progress" copy during the gap.
- **Link lifecycle implemented for the first time.** Migration [`020_cancel_token_and_link_lifecycle.sql`](supabase/migrations/020_cancel_token_and_link_lifecycle.sql) renames the `sendmo_links.status` enum's `'used'` → `'in_use'` and adds `'completed'`. The `admin_insert_shipment` RPC body is updated in-place to write `'in_use'` (was `'used'`). Pre-migration the DB had 20 rows at `used`; the migration UPDATEs them all to `in_use` before adding the new CHECK constraint. Three writers actually exist in the codebase now:
  - `labels/index.ts` flips flex links `active → in_use` after a successful buy (full-label links are minted at `in_use` by the RPC).
  - `cancel-label/index.ts` flips `in_use → active` after a successful carrier void, **only when no other non-terminal shipment exists on the link** (multi-billing per link is structurally supported; revival respects in-flight shipments).
  - `webhooks/index.ts` (EasyPost) flips `in_use → completed` on a terminal carrier status (`delivered` / `return_to_sender`), same "no other non-terminal" guard.
- **`shipments.cancel_token TEXT`** new column, hex random set at label-buy time, nulled on consumption. Indexed (partial, `WHERE cancel_token IS NOT NULL`). Returned in the labels response body and stashed in `sessionStorage[\`sendmo:cancel_token:${publicCode}\`]` by `SenderFlow.handleConfirm`. The same key is populated by `TrackingPage` when `?cancel=<hex>` lands in the URL (email-token transport) — one source of truth for both transports.
- **UI on `/t/<code>`:** new [`CancelLabelDialog.tsx`](src/components/tracking/CancelLabelDialog.tsx) (pure presenter, shadcn AlertDialog pattern) + Cancel/Change row inside [`ShipmentLabelSection.tsx`](src/components/tracking/ShipmentLabelSection.tsx) (de-emphasized below the single-use warning; only renders when `canCancel` is true). [`TrackingPage.tsx`](src/pages/TrackingPage.tsx) derives `canCancel = label_created AND (isAdmin OR viewer_is_recipient OR sessionStorage cancel_token present)` and holds the dialog state. After successful Cancel → bump `refetchTick` to refresh into the existing terminal banner. After successful Change → set `sendmo_just_voided_for_change` flag in sessionStorage and `navigate('/s/<short>', { replace: true })`. SenderFlow reads the flag on mount and shows "Previous label voided. Let's try again." as a banner once.
- **Required email** at [`SenderStepReview.tsx`](src/components/sender/SenderStepReview.tsx) (was optional). Copy under the field: *"It's important to have a reachable email in case you want to change your shipment."* Email is now load-bearing for cancel auth in the "came back later" case, which justifies the friction.
- **Tracking response** ([`tracking/index.ts`](supabase/functions/tracking/index.ts)) gains `refund_status`, `paid: boolean` (derived from `stripe_payment_intent_id != null`), and `amount_paid_cents: number | null` (today `null`; populated in Phase E when real charges flow). The cancel dialog uses these for refund-amount copy.
- **Webhook diagnostic block reverted.** [`webhooks/index.ts`](supabase/functions/webhooks/index.ts) — the TEMP DIAGNOSTIC block from commit `0968a60` is removed. Prefix-strip fix (commit `71919f1`) was verified-by-design 2026-05-12; this revert is the cleanup pass that closes the Track 2 follow-up. If a `webhook.easypost_status_updated` event hasn't landed yet, the diagnostic data we already captured is enough.

**Why this shape:**
- Email-token over cookie — `SameSite=Lax` is not same-site across `*.supabase.co` and `sendmo.co` (different registrable domains); `SameSite=None; Secure` invites Safari/Brave third-party blocking. The header-based token path works uniformly across browsers and gives us a durable "came back to it tomorrow" path via email which the cookie window wouldn't have.
- Async state machine over synchronous — John's "no partial cancels, in-process is fine" rule. The Phase A sole-ledger-writer rule lined up with this naturally: cancel-label initiates, webhook advances, UI shows pending state in between.
- Single state-machine for both link types — the difference between full-label and flex is just *who clicks what when*, not the underlying lifecycle. Full-label links are minted at `in_use` (RPC); flex links go `active → in_use` on buy. Both revive to `active` on cancel and end at `completed` on delivery.
- Optimistic link revival — option (iii) per the proposal. If carrier later rejects the void after we revived, worst case is two real labels exist (recipient charged twice). John accepted that tradeoff over "freeze the link for 2-4 weeks pending carrier confirmation."

**Watch out:**
- **Migration 020 is John's run.** Per Rule 0.5 the agent doesn't `DROP FUNCTION` / `UPDATE` / constraint changes against prod. Migration file is in `supabase/migrations/020_*.sql`. Apply via Supabase dashboard SQL editor (project `fkxykvzsqdjzhurntgah`). The Edge Function deploys are gated on this — if the functions deploy before the migration runs, anything that writes `'in_use'` (labels, cancel-label) will violate the OLD `CHECK` constraint and reject the insert/update.
- **Edge Function deploy order matters:** migration first, then `labels`, `cancel-label`, `stripe-webhook`, `webhooks`, `tracking` (each with `--no-verify-jwt`, per the long-standing gotcha — `config.toml` pins them but the deploy CLI doesn't read it for the flag).
- **EasyPost-only fallback for the refund_status write.** Inside cancel-label, when there's no Stripe PI, the EP refund_status value (`submitted` / `refunded` / `rejected` / `not_applicable`) is informational only — we always write `refund_status='not_applicable'` for the comp case because no money moved. This is deliberate to keep the comp UX honest ("no refund is needed") and avoid the SPEC §13.1 admin-report optics of a comp showing as "refunded."
- **Stripe refund failure after carrier void.** If `createRefund` throws after EasyPost already voided, we DO NOT roll back the carrier void (you can't un-void). We set `refund_status='rejected'` and let admin recovery drive the manual refund. Surfaced loud in `event_logs` as `cancel.stripe_refund_failed` (severity=error). This is the only partial-cancel state the system can land in, and it's deliberate — the carrier outcome is the irreversible side.
- **Phase B follow-ups deferred** (out of scope for this PR per proposal §2.7):
  (1) Cancel notification email (`labelCancelledEmail` template + `dispatchCancelNotifications` shared helper) — today the recipient learns about cancel by visiting `/t/<code>` or Dashboard.
  (2) Dashboard-side "Cancel" button — backend already supports the link-owner JWT path; UI add is its own beat.
  (3) `/s/<short_code>` friendly per-state messages — distinguishing `in_use` ("track at /t/<code>") from `completed`/`expired`/`cancelled`. Today the `links` function rejects `in_use` for flex with "this link has already been used" (good enough; needs polish).
  (4) Multi-billing-per-link audit of admin report + Dashboard summaries.
- **`refundService.ts` shape unchanged.** This proposal's refund path is server-side inside `cancel-label`, not the future `processRefund` client wrapper. The stub there is still for an admin-initiated refund endpoint that doesn't exist yet (Phase F).
- **Rate limit is in-memory, per-function-instance.** Edge Functions scale out, so the 5-req/60s limit is per-instance, not global. Real abuse mitigation needs a Postgres-backed limiter (future). For now, the limiter primarily protects against an unintended retry loop, not a distributed attacker.
- **Cookie-attack vector closed.** The original draft proposed a `sendmo_just_shipped_<public_code>` cookie. The header/sessionStorage replacement means no cookies at all in the cancel flow — nothing to fingerprint, nothing to leak via cross-domain redirects.

**Tests:** 7 new in [`tests/unit/cancelLabelDialog.test.tsx`](tests/unit/cancelLabelDialog.test.tsx) — mode-switching, dynamic refund copy ("$5.87" vs "no charge was made" vs "refund the charge"), onConfirm-once, Keep-label doesn't fire onConfirm. Full unit suite: **243 passed / 0 failed** (was 236 pre-PR). `npx tsc -b --noEmit` clean.

**Deploy order (John's steps):**
1. Apply migration 020 in the Supabase dashboard SQL editor. Verify with the SELECTs at the bottom of the file (cancel_token column exists; zero `'used'` rows in sendmo_links; CHECK constraint includes `in_use`/`completed`).
2. Deploy Edge Functions one at a time, each with `--no-verify-jwt`:
   - `npx supabase functions deploy labels --no-verify-jwt`
   - `npx supabase functions deploy cancel-label --no-verify-jwt`
   - `npx supabase functions deploy stripe-webhook --no-verify-jwt`
   - `npx supabase functions deploy webhooks --no-verify-jwt`
   - `npx supabase functions deploy tracking --no-verify-jwt`
3. Vercel auto-deploys the client on push to `main`.
4. Smoke test: Live Comp flex label → land on `/t/<code>?fresh=1` → click Cancel & start over → confirm → `/s/<short>` shows banner + address pre-filled.

**Files touched:**
- [supabase/migrations/020_cancel_token_and_link_lifecycle.sql](supabase/migrations/020_cancel_token_and_link_lifecycle.sql) (new — agent deliverable, John runs it)
- [supabase/functions/cancel-label/index.ts](supabase/functions/cancel-label/index.ts) (full rewrite — three-path auth, Stripe refund, link revival, audit log, rate limit)
- [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts) (mint cancel_token + flex link `active→in_use` flip + return cancel_token in response)
- [supabase/functions/stripe-webhook/index.ts](supabase/functions/stripe-webhook/index.ts) (`charge.refunded` also flips `shipments.refund_status`)
- [supabase/functions/webhooks/index.ts](supabase/functions/webhooks/index.ts) (diagnostic block reverted; terminal-status `in_use → completed` flip added)
- [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts) (response adds `refund_status`, `paid`, `amount_paid_cents`)
- [src/components/tracking/CancelLabelDialog.tsx](src/components/tracking/CancelLabelDialog.tsx) (new — pure presenter)
- [src/components/tracking/ShipmentLabelSection.tsx](src/components/tracking/ShipmentLabelSection.tsx) (Cancel/Change row + onClick props)
- [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx) (cancel-token sessionStorage helpers, `?cancel=` URL capture, dialog state, derivation)
- [src/pages/SenderFlow.tsx](src/pages/SenderFlow.tsx) (stash cancel_token on success + "Previous label voided" banner)
- [src/components/sender/SenderStepReview.tsx](src/components/sender/SenderStepReview.tsx) (email required + new copy)
- [src/lib/api.ts](src/lib/api.ts) (`cancelShipment` helper)
- [src/lib/types.ts](src/lib/types.ts) (`LabelResult.cancel_token`)
- [tests/unit/cancelLabelDialog.test.tsx](tests/unit/cancelLabelDialog.test.tsx) (new — 7 tests)
- [proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md](proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md) (revised + decided in-session)
- [proposals/README.md](proposals/README.md) (active-proposals entry updated)

---

### [2026-05-12] Launch-blocker session closeout — Tracks 1, 3 fully verified; Track 2 deployed pending EasyPost natural-retry confirmation
**Category:** Launch blocker | Closeout | RPC | Webhooks | Infra
**Cross-link:** Builds on the same-day Stripe Phase A entry below and the Track 1 + 3 entry below it. Closes [WISHLIST.md](WISHLIST.md) blockers #1 and #3; Track 2 marked closed pending one real EasyPost POST hitting the deployed prefix-strip fix.

**Full bug chain surfaced during the test-mode end-to-end verification of Track 1 + 3.** What started as "two pre-existing bugs" surfaced six additional latent issues, each of which had to be cleared before the Label-and-Link → Share Link → /t/<public_code> path worked end-to-end:

1. **Migration 019 — OUT-param shadowing.** Migration 018's `RETURNS TABLE(id, public_code, short_code)` had OUT params with the same names as `shipments.public_code` and `sendmo_links.short_code`. Inside the function body, `WHERE public_code = v_public_code` was ambiguous between OUT and column. Latent in 014 — only surfaced now that the function was actually reachable. Fix: [019_fix_admin_insert_shipment_ambiguity.sql](supabase/migrations/019_fix_admin_insert_shipment_ambiguity.sql) renames OUT params with `out_` prefix; labels function reads `out_id` / `out_public_code` / `out_short_code`.
2. **Missing sender name on Full Label.** The Ship From step never collected a sender name — `originAddress.name` was always undefined, so the RPC saw 28 params instead of 29 (missing `p_from_name`). Fix: use `SmartAddressInput`'s `nameLabel` / `nameHint` props to override the default "Recipient Name (probably your name!)" copy with "Sender's name" (cleaner than the bespoke field that snuck in at first). `useRecipientFlow.ts` step-10 validation now requires `originAddress.name`. Validation test fixture grew a `name` field.
3. **Stripe publishable keys missing from Vercel.** `VITE_STRIPE_PUBLISHABLE_KEY_TEST` and `VITE_STRIPE_PUBLISHABLE_KEY_LIVE` weren't set in Vercel env vars, so `StripePaymentForm` silently rendered no card-input element (Stripe.js `getStripe()` returned `Promise.resolve(null)`). Set both in Vercel for Production/Preview/Development. **Publishable keys are designed to be public — they're NOT Rule-0 secrets** (still set via the Vercel UI, not chat, for the audit trail).
4. **Resend SMTP — sendmo.co domain newly verified.** Supabase Auth's OTP send failed with `550 The sendmo.co domain is not verified` at 10:50 AM PDT; verification completed 7 minutes later at 10:57 AM PDT. Not actually a code bug — just timing — but verifying took most of the morning of 2026-05-12 (separate domain-verification thread, not this session). Recorded here so future agents debugging Auth email don't re-explore the same path.
5. **`/s/<code>` full-label viewer-link redirect.** The `/s/:shortCode` resolver (`SenderFlow.tsx` + `links` Edge Function) was hard-coded to reject `status='used'` as "this link has already been used." Correct semantics for flex-links (single-shot redemption); wrong for full-label links, which are minted with `status='used'` because the label was already bought at link-creation time. Fix: `links` function now skips the `used` rejection when `link_type='full_label'` and looks up the bound shipment's `public_code` to return. `SenderFlow.tsx` redirects to `/t/<public_code>` (the tracking page) before mounting the flex-link wizard.
6. **`tracking` Edge Function column drift.** `selectFields` referenced a non-existent `shipments.label_pdf_url` column — actual column is `label_url`. Whole SELECT errored → 404 "Tracking code not found" for *every* shipment. Fix: rename to `label_url` in both `selectFields` and the response payload assignment.
7. **Track 2 (HMAC) root cause identified.** Diagnostic logging on the webhook handler captured the actual `X-Hmac-Signature` header value from a real EasyPost POST: `hmac-sha256-hex=<64-char hex>`. Our verifier compared the raw header value (with prefix intact) against our computed hex digest, producing `signature_mismatch` on every event even with the correct secret. Fix: strip the `hmac-sha256-hex=` algorithm prefix before timing-safe compare. **Deployed but not yet verified end-to-end** — synthetic curl replay fails because EasyPost's exact body bytes (compact, 570 chars) can't be reproduced from the dashboard's pretty-printed display. Validation deferred to the next natural EasyPost retry (~hours).

**End-to-end verification (Track 1 + 3) — test-mode shipment `9400100208303112184245`:**
- `shipments` row: `id=319f671d-…`, `public_code=CG7FWV3` ✓
- `sendmo_links` row: `short_code=4rk8h4o3w8`, `link_type=full_label`, `status=used` ✓
- `event_logs`: `label.db_persisted` ✓ (first one since 2026-03-18 — 57 days)
- `sendmo.co/s/4rk8h4o3w8` → redirects to `/t/CG7FWV3` → tracking page renders ✓

**Webhook diagnostic logging left in place.** The expanded `webhook.hmac_invalid` logging (computed hex/b64, provided signature, body preview, header names) is still deployed and should be reverted once a real EasyPost retry confirms the prefix-strip fix. Revert TODO: remove the diagnostic block in `supabase/functions/webhooks/index.ts` and redeploy.

**Commits (in order):**
- [3d7973c](https://github.com/jsa7cornell/Sendmo/commit/3d7973c) — migration 018 + initial Track 1 + 3 fixes
- [b59886b](https://github.com/jsa7cornell/Sendmo/commit/b59886b) — sender-name field (bespoke input)
- [ddc9625](https://github.com/jsa7cornell/Sendmo/commit/ddc9625) — use SmartAddressInput.nameLabel instead
- [d4d102a](https://github.com/jsa7cornell/Sendmo/commit/d4d102a) — placeholder copy fix
- [0e8411a](https://github.com/jsa7cornell/Sendmo/commit/0e8411a) — migration 019 (ambiguity)
- [20330b1](https://github.com/jsa7cornell/Sendmo/commit/20330b1) — full-label viewer-link redirect
- [4ea9ff8](https://github.com/jsa7cornell/Sendmo/commit/4ea9ff8) — tracking fn label_pdf_url → label_url
- [0968a60](https://github.com/jsa7cornell/Sendmo/commit/0968a60) — webhook diagnostic logging (TEMP, revert post-verification)
- [71919f1](https://github.com/jsa7cornell/Sendmo/commit/71919f1) — webhook HMAC prefix strip

**Edge Function deploy reality:** these don't auto-deploy on `git push` like Vercel does — each `supabase/functions/<name>/**` change needs a separate `npx supabase functions deploy <name> --project-ref fkxykvzsqdjzhurntgah`. Today we deployed `labels` (twice), `links`, `tracking`, and `webhooks` (twice). Worth adding a GitHub Action that does this automatically on push — would have saved ~6 context switches today. Flagged for follow-up (not yet filed in WISHLIST).

**Notes for future agents:**
- **PostgreSQL OUT param shadowing is a real gotcha.** When `RETURNS TABLE(<name> <type>, ...)` declares an OUT param with the same name as a table column you reference inside the function body, PL/pgSQL raises ambiguity at runtime — not at function-creation time. Prefer `out_<name>` prefixes on RETURNS TABLE for any function that touches a table with same-named columns.
- **Don't fail-loud on the rates path.** I almost wrote `addressToApi` to throw on missing `name`, then realized `fetchRates` also calls it. Throwing there would block the rates step before the payment step where name is actually required. Resolution: keep `name` optional at the boundary, enforce via step-10 validation in `useRecipientFlow.getValidationErrors`. Lesson: a boundary that's used by multiple call sites should validate the *intersection* of their requirements, not the union.
- **EasyPost webhook signature format:** V1 (`X-Hmac-Signature`) is `hmac-sha256-hex=<64-char hex>` of the raw body bytes. V2 (`X-Hmac-Signature-V2`) incorporates `X-Timestamp` + `X-Path` + body to prevent replay attacks. V1 is what we verify today; V2 support is worth a follow-up for replay protection.
- **Supabase MCP read-only mode** suffices for diagnostic work — every query we ran today was a SELECT. Migration runs still go through John per Rule 0.5.

---

### [2026-05-12] Launch blockers Track 1 + 3 — `admin_insert_shipment` overload collision + real Share Link
**Category:** Database | Launch blocker | RPC | Address handling
**Cross-link:** [WISHLIST.md](WISHLIST.md) launch blockers #1 and #3 (filed in commit [3a0371d](https://github.com/jsa7cornell/Sendmo/commit/3a0371d)); follows [2026-05-12 Stripe Phase A](#2026-05-12-stripe-phase-a--transactions-ledger-replaces-payments-comp-labels-now-book-negative-margin) which surfaced both bugs during smoke test.

**Three pre-existing bugs, one combined fix:**

1. **Overload collision** — production `admin_insert_shipment` had multiple sibling overloads (008's UUID-returning + 014's TABLE-returning + a partially-applied 012). PostgREST couldn't resolve the call, returning "function not found." Result: zero `label.db_persisted` rows since 2026-03-18 (~57 days of EasyPost label buys never written to `shipments`).
2. **`addressToApi` silent drop** — `src/lib/api.ts` mapped `addr.street → street1` but never validated `addr.street` was defined. `JSON.stringify` silently dropped the undefined key, so the RPC param lookup failed against any signature requiring `p_from_street1`.
3. **Comp path bypassed `addressToApi` entirely** — inline `buyCompLabel` in [RecipientStepPayment.tsx](src/components/recipient/RecipientStepPayment.tsx) passed `state.originAddress` raw (shape `{name, street, city, state, zip}`), so the labels function received `from_address.street = "..."` but `from_address.street1` was undefined. This is the actual culprit for the Live Comp smoke-test failure, layered on top of #1 and #2.

**What shipped:**
- [supabase/migrations/018_fix_admin_insert_shipment_overloads.sql](supabase/migrations/018_fix_admin_insert_shipment_overloads.sql) — `pg_proc` loop drops every existing overload, then recreates the canonical 29-param version with `RETURNS TABLE(id, public_code, short_code)`. Adding `short_code` to the return shape closes launch blocker #3: the link row is already minted inside the RPC, just never surfaced. **John's step to run** via Supabase dashboard SQL editor on project `fkxykvzsqdjzhurntgah` per Rule 0.5.
- [src/lib/api.ts](src/lib/api.ts) — `addressToApi` now throws if any of `street/city/state/zip` is missing. Fail-loud at the boundary so the next address-shape regression surfaces at the call site, not as a PostgREST 404.
- [src/components/recipient/RecipientStepPayment.tsx](src/components/recipient/RecipientStepPayment.tsx) — `buyCompLabel` now routes `state.originAddress`/`state.destinationAddress` through `addressToApi`. Share Link card uses `labelResult.short_code` and only renders when a real code is present (no more `sendmo.co/s/test` fallback).
- [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts) — reads `short_code` from the RPC return row, threads through to the response body.
- [src/lib/types.ts](src/lib/types.ts) — `LabelResult.short_code` added.

**Audit results:**
- `npx tsc -b --noEmit` → exit 0.
- `npx vitest run --root . --dir tests/unit` → 236 passed / 0 failed.

**Acceptance (post-migration, to verify when John runs it):**
1. `SELECT count(*) FROM event_logs WHERE event_type = 'label.db_persisted' AND created_at > now() - interval '5 minutes';` ≥ 1 after a fresh Live Comp.
2. `SELECT * FROM transactions WHERE type = 'comp_grant' ORDER BY created_at DESC LIMIT 1;` returns the new row (closes Phase A's deferred smoke-test acceptance).
3. `SELECT * FROM shipments ORDER BY created_at DESC LIMIT 1;` shows non-null `public_code`.
4. Label & Link step renders `sendmo.co/s/<real-short-code>` (not `sendmo.co/s/test`).
5. Visiting that link resolves the sender flow.

**Track 2 (EasyPost webhook HMAC) is separate** — still open pending secret reconciliation between Supabase and the EasyPost dashboard. Not bundled here because Track 2 is a config/rotation question, not a code change.

**Notes for future agents:**
- Function overloads in Postgres are silent landmines under PostgREST. When changing an RPC signature, prefer `DROP FUNCTION` via a `pg_proc` discovery loop over `DROP FUNCTION IF EXISTS(<exact-signature>)` — the exact-signature form is a no-op if the historical apply order on prod differs from your local expectation.
- Any new boundary mapper (`addressToApi`-style) should fail loudly on missing fields. `JSON.stringify` dropping `undefined` is the kind of silent-data-loss bug that takes 57 days to discover.

---

### [2026-05-12] Stripe Phase A — `transactions` ledger replaces `payments`; comp labels now book negative margin
**Category:** Database | Stripe | Payments | Phase A
**Cross-link:** [`proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md`](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) §3.1, §3.4, §4.3, §6 Phase A.

**Context:** Phase A of the decided Stripe integration plan. Single atomic migration drops the legacy `payments` table and stands up the proposal's full schema: `transactions` (append-only ledger, Rule 16), `stripe_intents` (Stripe state mirror), `payment_methods` (Phase B+ saved cards), `holds` (Phase E flex-link authorizations), `refunds` (Phase F), `carrier_adjustments` (Phase G). Adds the Phase-3 forward-compat slots on `shipments` (`stripe_payment_intent_id`, `escrow_id`) and the server-derived `is_test` column on `sendmo_links` per round-1 B3. Backfills `shipments.payment_method` from `payments` before the DROP, then backfills the `transactions` ledger from `payments` so historical comp + Stripe-test rows survive the table drop as ledger entries.

**What shipped:**
- [supabase/migrations/017_stripe_phase_a_transactions_ledger.sql](supabase/migrations/017_stripe_phase_a_transactions_ledger.sql) — one atomic file. Postgres wraps migrations in a single transaction; if any statement errors, the whole thing rolls back and we're at 016. All-or-nothing per proposal §6 Phase A round-2 N5.
- [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts) — the two fire-and-forget `payments.insert(...).then(...)` blocks (~line 741, ~line 777 pre-edit) collapsed into a single **awaited** `transactions.insert` for the comp path only. The Stripe-charge ledger row is **no longer written by labels** — per proposal §3.4 + round-1 B4 the `stripe-webhook` function is the sole writer for charge/refund/chargeback rows. Reconciliation's 24h grace (§5.4) tolerates the in-flight window between label issuance and webhook arrival.
- [supabase/functions/stripe-webhook/index.ts](supabase/functions/stripe-webhook/index.ts) — full rewrite. UPSERTs `stripe_intents` on `payment_intent.succeeded` / `payment_intent.payment_failed`. Appends `+charge` on `payment_intent.succeeded`, `−refund` on `charge.refunded` (plus UPSERTs `refunds`), `−chargeback` on `charge.dispute.created`. Idempotency_key uses `stripe.${event.id}:<kind>`; UNIQUE constraint dedups Stripe retries. Also fixes a latent bug in the original dedup query — `webhook_events` was being checked on `id` (the local UUID PK) instead of `event_id` (the Stripe event id); pre-existing dedup never worked.
- [supabase/functions/admin-report/index.ts](supabase/functions/admin-report/index.ts) — joins `transactions` (filtered by `mode` query-string, default `live`) instead of `payments`. Mode filter is client-side after the PostgREST join.
- [src/pages/Admin.tsx](src/pages/Admin.tsx) — derives `collected_cents` from `SUM(charge)`, applies refund deltas, and for pure comp shipments sets `margin = comp_grant` (negative). Closes the WISHLIST item "Comp labels should show negative margin."
- [src/lib/refundService.ts](src/lib/refundService.ts) — stub still throws but the type signature now references `chargeTransactionId` (the `transactions.id` of the originating type='charge' row) instead of `paymentId`. Phase F populates the wire call.
- [src/lib/types.ts](src/lib/types.ts) — `Payment` interface replaced with `Transaction` + `TransactionType` + `FundingSource` + `LedgerMode` types matching the new schema.

**Audit results (acceptance criteria):**
- `grep -rn "from('payments')\|payments\.insert\|payments\.update" supabase/ src/` → **0 hits**. Verified pre-commit.
- `npx tsc -b --noEmit` → exit 0.
- `npx vitest run --root . --dir tests/unit` → **236 passed, 0 failed** (all 21 test files).
- `cancel-label` was audited and contains zero `payments` references already; no changes needed there. The deferred `proposals/2026-05-11_label-cancel-and-change.md` is on ice — not touched.

**End-to-end smoke test result (2026-05-12 evening):** Migration 017 applied cleanly via Supabase dashboard SQL editor. Append-only trigger verified — `UPDATE transactions SET amount_cents = 0` raised the expected `P0001` exception. All three Edge Functions deployed without error. Backfill from legacy `payments` table produced exactly **one** `comp_grant` ledger row (the March-18 historical dogfood comp, `amount_cents = -1129`, idempotency_key `backfill.fc9ac8d1-…-comp_grant`).

**The fresh Live Comp smoke test (the ledger row from a new label) did NOT produce a new `comp_grant` row** — but the cause is two pre-existing latent bugs unrelated to Phase A:

1. **`admin_insert_shipment` RPC overload collision.** Production has TWO overloads of the function sitting alongside each other (confirmed via `information_schema.parameters` — every base param appears twice). Migration 014's `DROP FUNCTION IF EXISTS` targeted a 29-param signature from migration 012 that may not have applied cleanly; the surviving 28-param version from migration 008 is still in place. PostgREST can't resolve the call, returns "function not found." `event_logs` shows **only one `label.db_persisted` row in the entire history** (March 18) — meaning every label since then has been bought from EasyPost but never written to `shipments`. The labels function's comp_grant insert is correctly gated on `shipmentId`, so when the RPC returns null, the ledger insert skips — exactly as designed.
2. **Frontend address-shape bug.** `addressToApi` in `src/lib/api.ts:63-71` maps `addr.street → street1`, but at runtime `addr.street` is `undefined`, so JSON serialization drops `street1` from the labels call body. This compounds with the overload collision: even if only one function existed, the call would still fail to match a signature that requires `p_from_street1`/`p_to_street1`.

**Plus two additional discoveries from the same smoke test:**

3. **EasyPost webhook HMAC verification rejecting every event** — 9 `webhook.hmac_invalid` rows in `event_logs` between 22:49–22:54. Tracking updates aren't landing for any shipment.
4. **Share Link on Label & Link step is hardcoded `sendmo.co/s/test`** — the Full Label flow doesn't write a `sendmo_links` row, so there's no real short_code to surface (already filed 2026-05-12 as launch blocker via [73958d5](https://github.com/jsa7cornell/Sendmo/commit/73958d5)).

All three new discoveries are filed in `WISHLIST.md` as launch blockers and are tracked separately from Phase A.

**Phase A status: shipped, with smoke-test acceptance deferred to follow-up.** The migration + ledger schema + RLS + trigger + Edge Function rewrites are all live and correct. Phase B (save card on file via SetupIntent) is unblocked from a schema perspective and can begin in parallel with the launch-blocker fixes. The launch-blocker fixes are pre-existing bugs that Phase A's smoke test surfaced — they would have blocked launch regardless of when discovered.

**Backfill design (executed inside the migration transaction):**
1. `comp_grant` rows for any `payments.payment_method='comp'` row — amount NEGATIVE = `-ABS(shipments.rate_cents OR payments.amount_cents)`.
2. `charge` rows for any `payments.payment_method IN ('card','balance') AND status='captured'` — amount POSITIVE = `payments.amount_cents`, carries the `stripe_payment_intent_id`.
3. `refund` rows for any `payments.status='refunded' OR shipments.refund_status='refunded'` — amount NEGATIVE.
- `idempotency_key` = `backfill.<payments.id>.<kind>` (UNIQUE so re-runs are no-ops).
- `mode` derived from `shipments.is_live`, never trusted from any client.
- Actual row counts will be recorded by John when the migration runs against prod via the Supabase dashboard SQL editor — this PR ships the code change; the database mutation is John's step per Rule 0.5.

**Rule 16 enforcement (`transactions` append-only):**
- Layer 1: `REVOKE UPDATE, DELETE` from `anon`, `authenticated`, `service_role`. `GRANT SELECT, INSERT` to `service_role` only.
- Layer 2: `BEFORE UPDATE / DELETE` trigger raises `'transactions is append-only (Rule 16). UPDATE/DELETE blocked. Record a compensating row instead (type=adjustment).'`
- Verification test (manual, post-migration): `UPDATE transactions SET amount_cents = 0 WHERE id = '<any-row>';` should error.

**Rollback story:** none beyond Postgres' implicit transaction. The migration is one BEGIN/COMMIT-wrapped file. If any statement errors on prod, the entire thing rolls back and the DB is at migration 016. There is no partial-state recovery path — the fix is to repair the failing statement in `017` and re-run from a clean state.

**Deploy order (matters):**
1. **Open Supabase dashboard SQL editor (project `fkxykvzsqdjzhurntgah`)**. Paste contents of `017_stripe_phase_a_transactions_ledger.sql`. Run. Verify success.
2. Verify tables exist: `SELECT count(*) FROM transactions;` Verify backfill: `SELECT type, count(*), SUM(amount_cents) FROM transactions GROUP BY type;`
3. Verify trigger fires: try `UPDATE transactions SET amount_cents = 0 WHERE id = (SELECT id FROM transactions LIMIT 1);` — should raise.
4. Verify RLS: as the system user, attempt to SELECT another user's row — should return empty.
5. Deploy functions: `labels`, `stripe-webhook`, `admin-report` — one at a time.
6. Smoke test: open `/admin` as John; report renders; comp shipments show negative margin.
7. Generate one Live Comp label end-to-end; verify exactly one new `transactions` row appears with `type='comp_grant'` and negative `amount_cents`.

**Why the migration step is John's (not the agent's):**
Per `~/AI Brain/CLAUDE.md` Rule 0.5, irreversible production DB ops have severity equal to Rule 0 (leaked secrets). Both are non-undoable. After the 2026-05-04 prod-DB-wipe incident, agents do not execute `DROP TABLE` / `TRUNCATE` / `prisma migrate reset` / hand-rolled `psql` against production. The migration file is the agent's deliverable; running it against `fkxykvzsqdjzhurntgah` is John's step.

**What this unblocks:**
- **Phase B** (save card on file via SetupIntent) — no remaining decisions.
- **Phase C** (live charge dogfood) — blocked only on the separate role-based admin auth side-quest (already landed 2026-05-11 per migration 016) + Stripe live keys (John's external setup).
- **Phase D + F** (public launch + refunds) — no remaining decisions.
- **Phase E** (flex-link auth/capture) — needs the mandate-UI work from the §11 #10 decision.
- **Phase G** (carrier adjustment recovery) — schema slot now present; impl is Phase G's own work.
- **Phase 2 / H** (prepaid balance + ACH topup) — schema and `user_wallet_balance` view ship in this PR; UI is Phase 2/H.

**Notes for future agents:**
- Webhook is the **sole writer** for `transactions` rows of type `charge`, `refund`, `chargeback`. If you find yourself wanting to write a charge row from a function other than `stripe-webhook`, re-read proposal §3.4 — you're about to recreate the split-brain bug round-1 B4 was added to prevent.
- The labels function only writes `comp_grant` rows. That insert is **awaited**, never fire-and-forget (round-2 B2).
- Every row in `transactions`, `stripe_intents`, `holds`, `refunds`, `payment_methods` carries a `mode` column. Every reconciliation query MUST filter by `mode='live'` or test data will pollute live margin.
- `user_wallet_balance` is a regular view (not materialized) — Phase 2 reads it for the dashboard wallet card. If it gets slow past ~1M ledger rows, materialize it; the read shape doesn't change.
- The `escrow_id UUID` slot on `shipments` is a Phase-3 forward-compat column. Don't drop it just because Phase 3 is years away — the FK constraint to `escrows(id)` is added when that table ships.

---

### [2026-05-12] CI was red on `main` for 21 commits — three test files had drifted from their subjects, not a real failure
**Category:** Tests | Tech debt | CI hygiene
**Context:** While shipping the account-creation-timing iteration, noticed that GitHub Actions had been failing on every push to `main` for ~21 consecutive commits (since 2026-04-19's `feat(routing): path-scoped onboarding URLs`). Vercel deploys never gated on this so production was always fine, but the CI signal had been worthless for a month. Three test files were the entire problem:

- [tests/unit/recipientFlowContext.test.tsx](tests/unit/recipientFlowContext.test.tsx) — rendered `RecipientFlowProvider` without wrapping in `<AuthProvider>`. The provider's internal `useAuth()` call threw on every render. Also used the obsolete flat `/onboarding/:step` route shape and the old `address` slug naming.
- [tests/unit/stepRouting.test.ts](tests/unit/stepRouting.test.ts) — called `slugToStep(slug)` and `firstIncompleteSlug` (functions that no longer exist in that shape). The current API is `slugToStep(path, slug)` and `firstIncompleteUrl(completedSteps, path)`.
- [tests/unit/emailTemplates.test.ts](tests/unit/emailTemplates.test.ts) — `trackingUpdateEmail` gained a required `carrierTracking` parameter at position 3 some time ago, but the tests kept passing args one slot off. Also asserted lowercase status labels ("in transit") against Title-Case source output ("In Transit").

**Decision/Finding:** repaired all three files in a separate test-only commit ([a6b6dff](https://github.com/jsa7cornell/Sendmo/commit/a6b6dff)). Zero touches to `src/` or `supabase/functions/`. Full unit suite went from 27 failing / 196 passing → **0 failing / 236 passing**. CI flipped green on the next push (run [25754754391](https://github.com/jsa7cornell/Sendmo/actions/runs/25754754391)) — first green main in 21 commits.

**Why this matters:** the actual code these tests covered (RecipientFlowContext, stepRouting, email templates) was working in production the whole time. The tests just hadn't been updated when the underlying APIs changed. The "tests broken" signal was indistinguishable from "code broken" in CI; that's the kind of background noise that trains you to ignore CI, which means the next *real* regression slips through.

**Watch out — soft rule for future drift:**
- **Test files have a code-side counterpart that may move.** When you rename a function, change its signature, or rename a slug, grep `tests/unit/` for the symbol *and* fix matches in the same commit. The CI failure is the late signal; the test edit at refactor time is the cheap one.
- **CI red for >1 commit is a real bug to investigate**, not background noise to filter out. The longer it stays red the harder it is to tell the difference between drift like this and a real regression buried under stale-test noise.
- **Vercel's build is the production gate; GitHub Actions is the regression gate.** They serve different purposes. A green Vercel doesn't mean the regression gate is working.

---

### [2026-05-12] Resend domain verification was silently failing for 2 months — label-confirmation emails never went out
**Category:** Email | Resend | Silent failure
**Context:** While wiring the Supabase Auth SMTP for the new "Confirm your email" template (proposal 2026-05-11_account-creation-timing), the first `signInWithOtp` from `/login` returned 500 with auth log: `gomail: could not send email 1: 550 The sendmo.co domain is not verified. Please, add and verify your domain on https://resend.com/domains`.

**Root cause:** the `sendmo.co` domain was added to Resend ~2 months ago but never finished verifying. All three required DNS records (DKIM, SPF MX, SPF TXT) showed "Failed" — Cloudflare DNS never got the records added. The domain sat in "Pending → Failed" state, ignored, until something actually tried to send from `noreply@sendmo.co`.

**The silent-failure surface:** [supabase/functions/_shared/resend.ts:26](supabase/functions/_shared/resend.ts:26) uses `from = "SendMo <noreply@sendmo.co>"` for every email sent by Edge Functions (label-confirmation, tracking updates). The labels function's `sendEmail()` call is fire-and-forget — the catch logs `email.label_confirmation_error` to `event_logs` but never surfaces to the user, never alerts John. **Every label-confirmation email since the domain was added has been silently rejected by Resend.** The LOG entry from 2026-03 (`Email notifications (Resend)`) said "sendmo.co domain verified" — that was wishful; verification was started but never completed.

**Fix:** clicked Resend's **Auto configure** button on the Domains page → granted Resend OAuth access to Cloudflare → Resend wrote all three DNS records itself → status flipped from "Failed" to "Verified" in <5 minutes. After verification, the `/login` magic-link flow worked end-to-end (subject "Confirm your email for SendMo", From `SendMo <noreply@sendmo.co>`, link + 6-digit code in the body).

**Watch out:**
- **Resend domain verification is independent of API key validity.** Edge Functions can authenticate against Resend with a valid API key and *still* have every send rejected if the domain isn't verified. The 401/403 you'd expect from "auth broke" never fires — Resend returns 200 from the HTTP API and 550 from SMTP.
- **`onboarding@resend.dev` works without domain verification** (Resend's sandbox sender). If you ever see emails going through during the unverified-domain window, check whether the From address was the sandbox fallback. The labels function does **not** fall back to sandbox — it sends from sendmo.co or fails silently.
- **Fire-and-forget email sends mask domain issues.** Consider surfacing `email.label_confirmation_error` rates in the admin report so a Resend regression isn't invisible. Today the only signal is John not getting his own test-label emails.
- **Auto configure is Cloudflare-specific.** It only appears when Resend detects Cloudflare as your DNS provider. For other DNS providers you'd add three records (DKIM TXT `resend._domainkey`, SPF MX `send`, SPF TXT `send`) by hand. Resend's UI shows the exact values; just match them at the DNS provider.

**Backfill question (open):** label-confirmation emails for the past ~2 months of test/dogfood shipments never arrived. The `event_logs` table has the receipts (`event_type = 'email.label_confirmation_error'`). Worth a follow-up to (a) count the missed emails, (b) decide whether to resend them, and (c) audit `notification_contacts` rows that were inserted with the expectation that the email would arrive.

**Files touched:** none in repo — entirely Supabase dashboard (email template) + Resend dashboard (Auto configure) + Cloudflare DNS (records added by Resend OAuth).

---

### [2026-05-12] Custom SMTP via Resend was already wired for noreply@sendmo.co — just needed the domain to verify
**Category:** Email | Auth | Reference
**Context:** During the account-creation-timing iteration we needed to confirm that Supabase Auth emails (the new "Confirm your email" template) would send from `sendmo.co`, not from `noreply@mail.app.supabase.io` (the default).

**Decision/Finding:** Custom SMTP was already enabled in Supabase **Authentication → Email Templates → SMTP Settings**:
- Host: `smtp.resend.com`
- Port: `465` (SMTPS)
- Username: `resend`
- Sender email: `noreply@sendmo.co`
- Sender name: `SendMo`
- Min interval per user: `1 second`

Once the Resend domain finished verifying (see entry above), all paths went green: Supabase renders the template → hands rendered email to Resend via SMTP → Resend sends from `noreply@sendmo.co` → recipient inbox.

**Watch out:**
- **Don't conflate "API key in Supabase secrets" with "SMTP configured in Supabase Auth."** They're separate. API key (used by Edge Functions via Resend's HTTP API) lives in `SUPABASE_SERVICE_ROLE_KEY` / Edge Function env. SMTP credentials (used by Supabase Auth itself for `signInWithOtp`, password reset, etc.) live in the Auth dashboard's SMTP panel and never appear in Edge Function code. Both need to be valid for the full system to work.
- **Free tier Supabase locks session expiry at "never."** The Inactivity Timeout / Time-box Session knobs are Pro-only and greyed out on Free. Sessions persist indefinitely until the user signs out or storage is cleared — refresh tokens roll forward automatically. No action needed for "max out session length"; you're already there.

---

### [2026-05-12] Account-creation iteration #2: Google CTA at step 1, verify step reframed as "Confirm your email", link+code dual path
**Category:** Auth | Onboarding | UX
**Proposal:** [proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md](proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md) — design iteration *on top of* the 2026-05-11 implementation; not a new proposal.

**Context:** John flagged in dogfood-review that the original PR's UX was wrong on three points: (1) framing the step as account creation rather than email verification, (2) placing the Google CTA at the verify step *after* the user has already typed their email (defeats the purpose of the shortcut), and (3) leaning on OTP-only when a magic link is materially lower-friction for users who'd rather tap than type. The fix is a UX-only iteration — no proposal changes, no Phase A blocker shifts.

**Decision/Finding:**
- **Google CTA moves to step 1 (destination), above the email field.** [RecipientStepAddress.tsx](src/components/recipient/RecipientStepAddress.tsx) renders Google as the primary affordance, then an "or type your email" divider, then the email input. OAuth redirectTo is the current step-1 URL — sessionStorage-backed flow data preserves typed destination across the roundtrip. On return, the email field locks to the Google identity (disabled, "Signed in as {email}" copy). Only renders for the full-label path; flex is untouched.
- **Verify step (step 11) reframed.** [RecipientStepEmailVerifySupabase.tsx](src/components/recipient/RecipientStepEmailVerifySupabase.tsx) headline changes from "Check your email" → **"Confirm your email"**, with the explicit "Just making sure {email} is yours" framing. Goal: this isn't account creation, it's address verification. The Google CTA is removed from this surface (it lives at step 1 now).
- **Magic-link + 6-digit code in the same email.** `signInWithOtp` calls now pass `emailRedirectTo: ${origin}/onboarding/full-label/verify?confirmed=1` so the link click lands back on the verify step in the same tab — Supabase processes the session, the verify component's auth-detection useEffect notices a live session whose email matches `state.email`, marks `email_verified=true`, and auto-advances to payment. Same end state as typing the code, no flicker, no context loss. (Cross-device link click is the only thing not covered — the email copy points the user to use the code instead.)
- **Auto-skip verify when already authenticated.** [RecipientFlowContext.tsx](src/contexts/RecipientFlowContext.tsx) now: (a) auto-marks `email_verified=true` whenever a live session's email matches `data.email`, (b) `tryAdvance(10)` detects this and jumps `11 → 12` in the URL directly, marking step 11 complete so the back button still works. Returning users (active session, scenario A) and Google-CTA users (just OAuth'd at step 1) both skip the verify screen entirely.
- **Login page (`/login`) copy mirrors the new framing.** [Login.tsx](src/pages/Login.tsx) — "Continue with Google, or get a confirmation link + code by email" subheading; submit button is "Email me a link + code"; the success screen says "We sent a link + 6-digit code … Tap the link to sign in instantly, or open the email and use the code." No structural changes — already had the right shape (Google above email).

**Tests:** updated [tests/unit/RecipientStepEmailVerifySupabase.test.tsx](tests/unit/RecipientStepEmailVerifySupabase.test.tsx) — 7 tests still pass. Renamed "renders the OTP entry UI" → "renders the confirm-your-email UI" (copy change). Resend test now asserts the `emailRedirectTo` is the verify step. Added a new test asserting **no** Google CTA renders on the verify step (it lives at step 1). `npx tsc -b --noEmit` clean. Full unit run: 195 passing / 27 failing — all 27 are pre-existing pre-iteration failures.

**Why this shape:**
- Google-CTA-above-email is a real UX hint: "this is the recommended path; the field below is the fallback." Putting Google below the email means people type their address before they notice the shortcut exists, and at that point they're committed.
- "Verify the email" vs "Verify your account" framing matters. The latter sounds like a security step; the former sounds like a delivery-confirmation step (which is what it actually is). Users intuitively understand "we just need to make sure jane@example.com is real" much faster than "verify your email to continue." Notion + Substack engineering blogs both call this out specifically.
- Magic link + OTP in the same email is the dual-affordance pattern. The link is for users on the same device (one tap, no typing). The code is for users on a different device than where they typed, or who'd rather paste than tap. The Supabase template emits both — the user picks.

**John parallel actions for this iteration (still TODO):**
1. **Edit the Supabase Magic Link email template** to include BOTH `{{ .Token }}` (6-digit code) and `{{ .ConfirmationURL }}` (tap-to-confirm link), with friendly "verify your email" framing copy. Today's template is link-only — the verify step would receive a link the user can't paste as a code. **Hard blocker for deploy.**
2. **Extend Supabase refresh-token inactivity timeout** (Authentication → Sessions → "Inactivity timeout"). Default 30 days is too short for a shipping app where re-engagement is monthly-quarterly. Push to the Free-tier maximum (or whatever Supabase caps at) so returning users actually stay signed in. Next time we're in the browser I can find the exact knob and confirm the cap.
3. **Verify "Allow manual linking" toggle** — currently OFF. Not blocking; flip it on as cheap insurance for the future Phase B Customer-dedup story (lets us call `linkIdentity()` programmatically if auto-linking ever falls short).

**Watch out:**
- **Cross-device link click is not synced.** If the user types their email on laptop and taps the link on their phone, the phone is now signed in but the laptop tab still shows the OTP input. The email copy points them at the code path instead. A Realtime subscription on `auth.users` filtered by email could close this gap (~80 LOC additive follow-up) — punted for v1 because dogfood will tell us whether it matters.
- **`/login` page still uses AuthContext's `signIn()` which redirects to `/dashboard`.** That's right for /login but means if a user goes through /login mid-shipment (unusual), they leave the funnel. Step-1 Google CTA solves this by redirecting back to step 1; /login keeps its dashboard redirect.
- **The verify-step auto-skip in tryAdvance modifies completedSteps in a slightly hairy way** (push step 11 alongside the current step so back-navigation works). Worth a glance if anyone touches step routing again.
- **Disabled email input when `user` is set** — the user can't edit the email at step 1 once Google is in play. Intentional (the email-on-file = the OAuth identity), but means a sign-out flow is the only way to switch identities. Acceptable for now; if it becomes a complaint, "use a different email" should sign-out + re-prompt.

**Files touched (this iteration):**
- [src/components/recipient/RecipientStepAddress.tsx](src/components/recipient/RecipientStepAddress.tsx) (Google CTA above email; OAuth-return locks email; emailRedirectTo on OTP send)
- [src/components/recipient/RecipientStepEmailVerifySupabase.tsx](src/components/recipient/RecipientStepEmailVerifySupabase.tsx) (reframe "Confirm your email"; drop Google CTA; ?confirmed=1 query-param handler; emailRedirectTo on Resend)
- [src/contexts/RecipientFlowContext.tsx](src/contexts/RecipientFlowContext.tsx) (auto-mark email_verified when session.email matches; tryAdvance skips step 11 when already verified)
- [src/pages/Login.tsx](src/pages/Login.tsx) (copy tweaks to match "link + code" framing)
- [tests/unit/RecipientStepEmailVerifySupabase.test.tsx](tests/unit/RecipientStepEmailVerifySupabase.test.tsx) (router wrapper; Resend assertion; no-Google-CTA assertion; updated headline assertion)

**Deploy steps:** push to main. No Edge Function changes in this iteration (labels + payments JWT plumbing from the 2026-05-11 entry still applies unchanged). Vercel auto-deploys. The Supabase template edit (John task #1 above) MUST land before users actually use the verify step in production — otherwise the link works fine but the code path is broken.

**Preview note:** I did not verify this iteration in a live browser preview. The dev server requires Supabase credentials injected via `op run --env-file=.env.tpl -- npm run dev`; the preview harness starts `npm run dev` directly so the Supabase client fails to initialize and the React tree never mounts. tsc + unit tests pass; full visual verification is John's first manual run-through post-deploy.

---

### [2026-05-11] Full Prepaid Label flow auto-creates Supabase auth user via OTP between rates and payment
**Category:** Auth | Onboarding | Architecture | Stripe-Phase-A unblocker
**Proposal:** [proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md](proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md) (Pattern A, T1 parallel + T2 between-rates-and-payment with step-1-priming)
**Context:** Full Label path was `destination → shipping → payment → label` and never created an `auth.users` row, so recipients couldn't return to manage their shipment, and Stripe Phase B's "one Customer per `auth.users.id`" dedup story had no key to dedupe on. Last open blocker on Stripe Phase A per the Stripe proposal §11 #4.

**Decision/Finding:**
- New step 11 `verify` lands between shipping (10) and payment (now 12; label is now 13). [stepRouting.ts](src/lib/stepRouting.ts) renumbered; the legacy [useRecipientFlow.ts](src/hooks/useRecipientFlow.ts) FULL_LABEL_STEPS + progress mapping mirrored. Validation: step 11 (full-label) requires `state.email_verified`.
- New component [RecipientStepEmailVerifySupabase.tsx](src/components/recipient/RecipientStepEmailVerifySupabase.tsx) — Supabase-native `signInWithOtp` + `verifyOtp({type:"email"})`. Includes "Continue with Google" + a 6-digit paste-friendly code input + Resend + "Use a different email" (back to step 1). Per author-response B1, **a separate component from the bespoke `RecipientStepEmailVerify.tsx` flex flow uses** — the flex `email_verifications`-table flow is intentionally untouched (LOG 2026-03-19 explained why; rewriting in place would have given flex an unintended session at step 21).
- **OTP fires on step-1 email blur** (T2 implementation upgrade): [RecipientStepAddress.tsx](src/components/recipient/RecipientStepAddress.tsx) silently calls `signInWithOtp({email})` on blur for the full-label flow once the email is valid. By the time the user finishes shipping + rate selection (~30–90s), the code is in their inbox. Idempotent via `lastPrimedEmail` ref + 60s throttle (Supabase rate limit).
- **B2 lock-to-OAuth-email:** if the user picks Google and returns signed in with a different email than typed, the verify component locks `state.email + verification_email` to the OAuth identity and surfaces a disclosure ("Signed in as `<x>`. Shipment notifications will go to that address."). Either way, mark `email_verified=true` and auto-advance.
- **OAuth roundtrip survives** via sessionStorage persistence in [RecipientFlowContext.tsx](src/contexts/RecipientFlowContext.tsx) (`sendmo:recipient_flow:v1`). Without this, redirecting to accounts.google.com would blow away destination + rate selection + everything else. Cleared implicitly by sessionStorage's per-tab lifetime.
- **JWT plumbing for `auth.uid()` propagation (B5):** `post()` helper takes optional `accessToken`; [`buyLabel`](src/lib/api.ts) and [`createPaymentIntent`](src/lib/api.ts) both accept it. [`RecipientStepPayment.tsx`](src/components/recipient/RecipientStepPayment.tsx) reads `useAuth().session?.access_token` and passes through to both calls. The labels function ([`supabase/functions/labels/index.ts`](supabase/functions/labels/index.ts)) and payments function ([`supabase/functions/payments/index.ts`](supabase/functions/payments/index.ts)) now resolve `callerUserId` from the bearer token; labels uses it as `admin_insert_shipment.p_user_id` (preference order: resolvedLink → callerUserId → system placeholder) and on the `payments` row insert, payments stamps `metadata.user_id` on the PI for Phase B Stripe Customer dedup groundwork.
- **B4 (comp-mode placeholder):** verified migration 004 already inserts the system-user `profiles` row (`00000000-…-0001`), so Stripe Phase A migration 012's `transactions.user_id NOT NULL REFERENCES profiles(id)` FK is already satisfied for comp-path writes. No new migration in this PR.

**Tests:** 7 new unit tests in [tests/unit/RecipientStepEmailVerifySupabase.test.tsx](tests/unit/RecipientStepEmailVerifySupabase.test.tsx) — UI render, verifyOtp call, error surfacing, Resend, Google OAuth, "Use different email" → onBack, verified success state. Updated 5 [tests/unit/stepRouting.test.ts](tests/unit/stepRouting.test.ts) assertions for the new step (the rest of that test file remains broken on main and is pre-existing technical debt — uses an outdated `slugToStep(slug)` API that the source removed). `npx tsc -b --noEmit` clean. Unit run: 196 passing / 27 failing — all 27 failures are pre-existing on main (verified via `git stash` round-trip).

**Why this shape:** Pattern A is the right call (research §3 — Substack/Gumroad/Ghost converge on it for recipient-becomes-user products). Pre-priming the OTP at step 1 is the move John's call surfaced — turns the inbox-bounce friction into a glance. New component (rather than rewriting the shared one) keeps flex semantics frozen until a follow-up proposal explicitly owns flex's migration.

**John parallel actions (still TODO — proposal §10 + T1):**
1. **Verify Supabase Auth's email-OTP template sends a 6-digit code** (not a magic link). The verify step's UI promises a code; if the template is configured for magic link, the code input never receives anything. Pitfall #5 from the review.
2. **Verify "Link this identity to an existing user" is enabled on our Supabase plan** (T1). Per LOG.md 2026-05-10 the toggle was named but never tested. Concretely: OTP-sign-in with `john@example.com`, sign out, then Google sign-in with the same email → confirm a single `auth.users.id` row exists. If linking fails, a follow-up `profiles.email`-keyed merge step proposal must land before Phase B unblocks.
3. **Run the OTP-then-Google-same-email test in production after deploy** (proposal §10 verification step 3, promoted from "noted" to "required").

**Watch out:**
- **Stripe Phase A is now unblocked.** Don't start Phase A in this session — separate work per the brief.
- **Comp-mode admin path still uses the system-user placeholder** when `resolvedLink` is null (admin opens /onboarding directly without a flex link). That's by design: Live Comp is admin-impersonating-the-recipient and we don't want to attribute the comp shipment to the admin's personal balance. callerUserId could land in `payments.user_id` for admin comp specifically — left alone here so admin comp accounting stays as it was.
- **sessionStorage persistence has a quiet failure mode:** if the user opens the same flow in two tabs, both write to the same key and last-write-wins. Acceptable today (single-user product); revisit if it ever surprises someone.
- **OAuth roundtrip lands back on the verify URL** because the component sets `redirectTo: window.location.href`. If that URL ever changes (e.g., flow redesign), the OAuth-return UX breaks silently — there's no test for the post-redirect handler since it requires a real Supabase OAuth callback.
- **OTP-step abandonment isn't yet instrumented** (proposal C2 deferred — author-response accepted). Add a `recipient.email_verify.abandoned` PostHog event when volume reaches signal.
- **Two parallel OTP paths in production now** (bespoke `email_verifications` for flex, Supabase-native for full-label). Per proposal C3, removed by end of Stripe Phase A — not indefinite.

**Files touched:**
- [src/lib/stepRouting.ts](src/lib/stepRouting.ts) (FULL_LABEL maps + progress mapping)
- [src/hooks/useRecipientFlow.ts](src/hooks/useRecipientFlow.ts) (FULL_LABEL_STEPS + progress + step-11 validation)
- [src/contexts/RecipientFlowContext.tsx](src/contexts/RecipientFlowContext.tsx) (sessionStorage persist/load)
- [src/components/recipient/RecipientStepAddress.tsx](src/components/recipient/RecipientStepAddress.tsx) (`maybePrimeOtp` on email blur, full-label only; copy update)
- [src/components/recipient/RecipientStepEmailVerifySupabase.tsx](src/components/recipient/RecipientStepEmailVerifySupabase.tsx) (new)
- [src/components/recipient/RecipientStepPayment.tsx](src/components/recipient/RecipientStepPayment.tsx) (pass JWT to buyLabel + StripePaymentForm)
- [src/components/recipient/StripePaymentForm.tsx](src/components/recipient/StripePaymentForm.tsx) (accept + forward `accessToken`)
- [src/lib/api.ts](src/lib/api.ts) (auth-aware `post()`, `createPaymentIntent`, `buyLabel`)
- [src/pages/RecipientOnboarding.tsx](src/pages/RecipientOnboarding.tsx) (render new verify step at 11; payment/label at 12/13)
- [supabase/functions/payments/index.ts](supabase/functions/payments/index.ts) (resolve callerUserId, stamp `metadata.user_id` on PI)
- [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts) (resolve callerUserId, prefer it for `shipments.user_id` + `payments.user_id`)
- [tests/unit/RecipientStepEmailVerifySupabase.test.tsx](tests/unit/RecipientStepEmailVerifySupabase.test.tsx) (new — 7 tests)
- [tests/unit/stepRouting.test.ts](tests/unit/stepRouting.test.ts) (5 assertions updated for the renumber)

**Deploy steps:** push to main (Vercel auto-deploys client). Edge fns: `supabase functions deploy payments` + `supabase functions deploy labels` — both already had explicit `[functions.X]` entries in `config.toml` (verified — no `verify_jwt` regression risk per the 2026-05-11 entries).

---

### [2026-05-11] Admin toolbar gains 3rd mode "Live Charge"; "Live Comp" repaired to match its name
**Category:** Stripe | Admin | Architecture
**Proposal:** [proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) §6 Phase C + §11 #5
**Context:** The admin toolbar on `/onboarding` had two modes — Test and Live Comp. PLAYBOOK has always documented Live Comp as "real label, NO Stripe charge (comp)." But the code at `RecipientStepPayment.tsx` passed `liveMode={liveMode}` straight to `StripePaymentForm` and never set `comp: true` on the `buyLabel` call. **The mode named "Live Comp" actually charged real cards in Stripe live mode.** A name/behavior mismatch that went unnoticed because John had been using the existing path effectively for testing.
**Decision/Finding:**
- `AdminMode` is now `"test" | "live_comp" | "live_charge"`:
  - **test**: EasyPost test + Stripe test (unchanged)
  - **live_comp**: EasyPost LIVE + no Stripe (real label, amber comp button, admin JWT gates `comp:true` server-side)
  - **live_charge**: EasyPost LIVE + Stripe LIVE charge (what the prior "live_comp" actually did)
- `RecipientOnboarding` derives `liveMode = mode in {live_comp, live_charge}` and `compMode = mode === live_comp`, passes both as props.
- `RecipientStepPayment` branches on `compMode` — renders an amber "Generate Comp Label" button instead of `<StripePaymentForm>`. The button POSTs to `/labels` directly with `Authorization: Bearer ${session.access_token}` so the labels function's admin gate (the role check added 2026-05-11 in commit `f137b06`, hardened further by the sender-flow session's labels rewrite) accepts the `comp:true` claim.
- PLAYBOOK §"Admin Mode" rewritten to document all three modes + the rename.

**Why:** The 3-mode UX is what the Stripe proposal §6 Phase C calls for (Live Charge needed for Phase C dogfooding). Repairing Live Comp's broken intent at the same time costs ~5 extra LOC and stops the documentation lie. The comp button does its own raw fetch (not `buyLabel()` in `api.ts`) on purpose: the shared `post()` helper always sends `ANON_KEY`, which has no user identity, so the comp gate would reject. Keeping the bearer-JWT path local to this one button avoids global helper changes.

**Watch out:**
- **Live Charge is irreversible by design** — a real card is hit. Use a small-dollar rate first (USPS Ground Advantage short hop ≈ $5–6). Confirm in the Stripe dashboard before walking away.
- The labels function's comp gate (hardened by the sender-flow session) requires the caller to be EITHER an admin user (JWT + `profile.role='admin'`) OR a valid active flex link short code. Admin role bootstrapping was done in migration 016.
- The 3rd mode does NOT yet honor an env-allowlist of "real-charge-allowed users" (Stripe proposal round-1 P3 / §6 Phase C). Today the only admin is John, so the practical allowlist is "John." When more admins exist, this should tighten — `PAYMENTS_ALLOWED_USERS` env check is the proposal's pattern.
- **Live keys not configured yet.** Live Charge will hit `<StripePaymentForm liveMode={true}>` which calls `/payments` with `live_mode: true`. That requires `STRIPE_SECRET_KEY_LIVE` + `STRIPE_WEBHOOK_SECRET_LIVE` in Supabase secrets and `VITE_STRIPE_PUBLISHABLE_KEY_LIVE` in Vercel. None set yet — Phase 1 shipped test-only. Live Charge will fail with a clear error in the UI until John completes Stripe proposal §7 "Requires external setup."

### [2026-05-11] Sender flow Round 2 — `/t/<public_code>` becomes the shipment page (label + lifecycle + Ship-Again)
**Category:** Feature | UX | Privacy | Architecture
**Proposal:** [proposals/2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md](proposals/2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md) §11–§14 (Round 2)
**Context:** Round 1 shipped a 5-step wizard with a transient `step="done"` component — bookmarking `/s/<short_code>` started over, no stable per-shipment URL. John's dogfood surfaced: (1) per-label URL gap, (2) tracker widget belongs on top, (3) ship-again upsell. Round 2 promoted `/t/<public_code>` from tracker-only to **the shipment page**.

**Decision/Finding:**
- **One URL per shipment.** `SenderFlow.handleConfirm` now `navigate('/t/<public_code>?fresh=1', { replace: true })` on success. The Round-1 `step='done'` branch is removed; `SenderStepDone.tsx` is absorbed into the new tracking surface, not deleted-without-replacement. Re-using the existing TrackingPage's Progress card as the lifecycle hero (didn't build a parallel `ShipmentLifecycleCard.tsx` — extension over invention per PLAYBOOK Rule 6).
- **Server contract change** ([supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts)): response gains `label_url`, `link_short_code` (via new `sendmo_links!inner` join on `shipments.link_id`), and `viewer_is_recipient: boolean` (derived server-side from JWT vs. `sendmo_links.user_id` — link.user_id never returned to client). Authenticated callers now optionally send `Authorization: Bearer <session.access_token>` from `TrackingPage`; anonymous callers omit it.
- **New components in `src/components/tracking/`:**
  - [`ShipmentLabelSection.tsx`](src/components/tracking/ShipmentLabelSection.tsx) — label preview thumbnail, primary Print Label (PDF) CTA opening in new tab, secondary Download, single-use + privacy warning copy ("Anyone with this link can see the recipient's address. Don't share it publicly."), drop-off copy keyed to selected carrier. Renders only when `status === 'label_created'`.
  - [`ShipAgainCTA.tsx`](src/components/tracking/ShipAgainCTA.tsx) — upsell card linking to `/s/<short_code>` (sender's address pre-fills via existing `localStorage["sendmo:sender:v1"]`). Visibility is the layered signal from author-response B4: `(?fresh=1) ∨ (anonymous + saved sender) ∨ (authenticated AND !viewer_is_recipient)`; hidden for the authenticated link owner. `shouldShowShipAgain()` is a pure function with 6 dedicated tests.
- **Terminal-state banner.** When `status ∈ {cancelled, return_to_sender}`, lifecycle card hides and a red-coded `AlertCircle` banner shows ("This label was voided" / "The package is being returned"). The Progress card and label section both hide.
- **`?fresh=1` celebration handling.** `TrackingPage` uses `useSearchParams` to read `fresh=1` once on mount, then strips it with `setSearchParams({}, { replace: true })`. Celebration banner renders on first paint only; dismiss button hides it before the auto-strip lands. **No `history.replaceState` calls** — author-response B3, React Router primitives only.
- **Privacy decision (John, 2026-05-11):** Option (a) — `/t/<public_code>` keeps Print/Download accessible to anyone with the URL. Pair with the strengthened warning copy. Alternatives (b) device-gate or (c) auth-gate would have broken John's OQ#1 answer (link owner sees Print/Download) or the anonymous-sender model. Pre-launch dogfood is the right time to test "does anyone actually share the link?"; if abuse appears, hardening to (b)/(c) is a single conditional.
- **`admin_insert_shipment` `user_id` fix** ([supabase/functions/labels/index.ts](supabase/functions/labels/index.ts)): sender-flow flex-link shipments now pass `resolvedLink.user_id` instead of the system-user placeholder. Dashboard's `sendmo_links.user_id` join finally matches; the recipient sees their shipments. (Pre-existing bug surfaced during Round-2 dogfood. Shipped separately in commit `8bdd7f7`.)

**Tests:** 16 new unit tests across [tests/unit/ShipAgainCTA.test.tsx](tests/unit/ShipAgainCTA.test.tsx) (10 — full visibility matrix + rendering) and [tests/unit/ShipmentLabelSection.test.tsx](tests/unit/ShipmentLabelSection.test.tsx) (6 — Print/Download href, warning copy, carrier-keyed drop-off, unknown-carrier fallback). All passing alongside the 22 Round-1 tests = 38 sender-flow tests green. `npx tsc -b --noEmit` clean.

**Why this shape:** One URL per shipment beats two parallel surfaces. The viewer-state matrix (just-shipped sender, returning sender, recipient, anonymous third party) collapses cleanly into one page with conditional sections. The privacy decision was real (link sharing leaks address-on-PDF) but the alternatives broke load-bearing use cases John had already validated.

**Watch out:**
- **`label_url` is `null` on shipments persisted before this deploy** — the labels function has always written `label_pdf_url` per [migration 005](supabase/migrations/) (verified by grep), but historical rows from pre-Round-1 might lack it. The label section's `&& data.label_url` guard handles this gracefully (hides Print/Download); no broken-button surface. Future check: backfill from EasyPost if needed for any pre-existing shipments.
- **Mobile Safari celebration-banner timing.** `?fresh=1` strips inside a `useEffect` after first paint; if a slow mount races, the URL might briefly carry `?fresh=1` past the celebration display. Acceptable — the dismiss button works regardless and the strip is best-effort.
- **`viewer_is_recipient` requires the tracking fn to validate the JWT** — that's an extra `supabase.auth.getUser(token)` round-trip per authenticated request. Latency impact is small (~50ms) but worth noting if tracking gets called frequently from authenticated surfaces.
- **`sendmo_links!inner` join in the SELECT** — every shipment must have a `link_id`. Confirmed by [migration 001](supabase/migrations/001_initial_schema.sql) — `shipments.link_id` is `REFERENCES sendmo_links(id) NOT NULL`. If that ever changes, the inner join silently drops rows.
- **Round-1 `SenderStepDone.tsx` deletion.** No test file orphaned (verified: only `SenderStepIntro.test.tsx` + `senderState.test.ts` existed). The content moved into `ShipmentLabelSection` (label + warning + drop-off) and `TrackingPage` (shipment summary + back-to-home nav). Next agent reading Round-1's LOG entry will see the file referenced; this LOG entry is the back-pointer.

**Deploy steps:** `supabase functions deploy tracking --no-verify-jwt` (already done), then push to `main` (Vercel auto-deploys the client).

**Files touched:**
- [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts) (SELECT + JSON response + viewer_is_recipient derivation)
- [src/components/tracking/ShipmentLabelSection.tsx](src/components/tracking/ShipmentLabelSection.tsx) (new)
- [src/components/tracking/ShipAgainCTA.tsx](src/components/tracking/ShipAgainCTA.tsx) (new)
- [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx) (data interface + celebration banner + terminal-state banner + label section + Ship-Again CTA + authenticated JWT in tracking fetch)
- [src/pages/SenderFlow.tsx](src/pages/SenderFlow.tsx) (`navigate` on Confirm; `done` step removed)
- [src/components/sender/senderState.ts](src/components/sender/senderState.ts) (`SenderStep` no longer includes `"done"`; `SenderResult` removed — was unused after redirect)
- [src/components/sender/SenderStepDone.tsx](src/components/sender/SenderStepDone.tsx) (deleted; absorbed into ShipmentLabelSection + TrackingPage)
- [tests/unit/ShipAgainCTA.test.tsx](tests/unit/ShipAgainCTA.test.tsx) (new — 10 tests)
- [tests/unit/ShipmentLabelSection.test.tsx](tests/unit/ShipmentLabelSection.test.tsx) (new — 6 tests)

---

### [2026-05-11] verify_jwt regression — `links` GET 401'd in prod on first sender-flow dogfood
**Category:** Edge Functions | Deploy gotcha | Recurrence of the 2026-05-10 + 2026-05-11 verify_jwt pattern
**Context:** John clicked his own flex link `https://sendmo.co/s/mUgagu3HrS` immediately after the sender-flow wizard deploy. The page showed "Hmm, that link didn't work — Link not found (401)" instead of Step 0. The `links` function was returning 401 to the anon-key GET — not because the function rejected the call, but because the Supabase gateway was enforcing JWT verification on the function.

**Root cause:** `[functions.links]` was **missing entirely** from `supabase/config.toml`. Without an explicit entry Supabase defaults to `verify_jwt = true`. The sender flow was the first feature to actually call `fetchLink()` from an anonymous client; the recipient flow only POSTs to `/links` with a real Supabase Auth JWT, which the gateway happily accepted. So the bug had been latent since the function shipped — never exercised because no anon GET ever happened in production until the wizard launched.

**Fix:**
- Added `[functions.links] verify_jwt = false` to `supabase/config.toml`. The GET `?code=` path is intentionally public; POST + PATCH paths still validate the JWT internally via `supabase.auth.getUser(token)`, so flipping the gateway doesn't weaken auth on the privileged paths.
- Redeployed: `supabase functions deploy links --no-verify-jwt`.
- Verified: `curl https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/links?code=mUgagu3HrS` returns 200 (was 401).

**Why this keeps biting:**
- 2026-05-10 LOG entry "Edge Function deploys" named the pattern: `--no-verify-jwt` on the CLI invocation doesn't persist; only `config.toml` does.
- 2026-05-11 LOG entry "verify_jwt regression hit `tracking` + `webhooks`" caught it on two other functions. Same pattern.
- The lesson keeps not generalizing because there's no test in CI for "every public-facing function has `verify_jwt = false` documented." Every new function is one human-memory step away from this exact bug.

**Watch out — soft rule to harden:**
- **Before deploying any new Edge Function**, grep `config.toml` for the function name. If the section is absent, add it with the intended `verify_jwt` value. Default-true is fine for admin/auth'd functions but breaks anything anon-callable.
- A precommit hook or test could enforce: "every `supabase/functions/*/index.ts` directory has a matching `[functions.X]` section." Worth filing.

**Files touched:** [supabase/config.toml](supabase/config.toml).

---

### [2026-05-11] Sender flow wizard — flex links produce real EasyPost labels end-to-end
**Category:** Feature | UX | Security | Schema-adjacent
**Proposal:** [proposals/2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md](proposals/2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md)
**Context:** `/s/:shortCode` was a 4-step skeleton ending at "Label generation coming soon — Stripe payment integration in progress." Flex links had no functional sender path. Stripe Phase E (auth-at-link-creation + capture-at-label-buy) is blocked on Phase A which is blocked on §11 #4 (account-creation timing research) — so the sender flow was blocked indefinitely on a chained decision. Proposal routed around it via comp-only labels, server-hardened so the comp path is no longer a free-label exploit.

**Decision/Finding:**
- **5-step wizard** at `/s/:shortCode` matching SPEC §8 exactly: Intro → Package → Rates → Review → Done. New components in [src/components/sender/](src/components/sender/): `SenderStepIntro`, `SenderStepPackage` (origin + parcel + packaging type + sticky destination), `SenderStepRates` (no prices visible, "Preferred by {recipient}" badge), `SenderStepReview` (Edit buttons + email + AlertDialog-equivalent confirm), `SenderStepDone` (largest "Print Label (PDF)" CTA → opens EasyPost PDF in new tab, drop-off copy keyed to selected rate, `/t/<publicCode>` track link), `SenderProgressBar`, `senderState.ts` (typed state + helpers).
- **Server-side comp gate hardened** ([labels/index.ts:65-188](supabase/functions/labels/index.ts)): `comp: true` now requires EITHER an admin JWT (validated against `profiles.role`) OR a valid active flex-link short_code. Anonymous callers with `comp=true` are rejected 403. The pre-change behavior — "anyone with the function URL can mint free labels" — was a real exploit; this closes it.
- **Server resolves to_address + recipient_email** when `link_short_code` is present (B3). Client-supplied `to_address` is ignored; the function joins `sendmo_links → addresses` to get the canonical destination and `sendmo_links.user_id → profiles.email` for the label-confirmation email recipient. Sender client never sees recipient PII (Rule 7); also closes an attack surface where the sender could swap addresses.
- **Server-derived cap enforcement** (B5, PLAYBOOK Rule 14 fix): `display_price_cents` is no longer trusted from the client. Labels function fetches the rate from EasyPost (`GET /v2/shipments/{id}/rates/{rate_id}` with `/v2/shipments/{id}` fallback), applies the canonical markup formula (`rate × 1.15 + $1.00`), and compares to `link.max_price_cents`. Closes the "client tampers with display_price_cents" loophole AND the "rate shifts between rate fetch and label buy" race.
- **`admin_insert_shipment` RPC is now awaited** (B2) instead of fire-and-forget `.then()`. This lets the labels function return `public_code` + `shipment_id` in the response body (was previously only logged inside a `.then()` callback the client never saw). Email send remains fire-and-forget *inside* the awaited success branch. This shift lands the `await`-discipline mandated by Stripe Phase A round-2 B2 — Phase A inherits the change rather than coordinating it.
- **`buyLabel()` signature change** in [src/lib/api.ts](src/lib/api.ts:151): added a `link?: { short_code?: string }` parameter between `contacts` and `payment`. The one existing caller ([RecipientStepPayment.tsx:175](src/components/recipient/RecipientStepPayment.tsx)) passes `undefined` to keep its behavior unchanged.
- **`LabelResult`** ([src/lib/types.ts](src/lib/types.ts:183)) gained `public_code?: string | null` and `shipment_id?: string | null`.
- **localStorage versioning** for sender pre-fill: key is `sendmo:sender:v1`, payload carries a `version` field, reads tolerate mismatch by returning null. Three lines that prevent a 3-month-out regret.
- **Drop-off copy keyed to the SELECTED rate's carrier**, not `linkData.preferred_carrier` — verified by unit test. USPS / UPS / FedEx / DHL / fallback strings live in `senderState.dropOffCopy`.
- **`isPreferredRate`** re-uses the canonical `classifySpeedTier` from [src/lib/utils.ts](src/lib/utils.ts) (PLAYBOOK Rule 6: extend, don't invent).

**Tests:** 22 new unit tests across [tests/unit/senderState.test.ts](tests/unit/senderState.test.ts) (18 tests: localStorage round-trip incl. version-mismatch + malformed-JSON tolerance, speedTierForService, isPreferredRate, dropOffCopy carrier-keyed, isValidEmail) and [tests/unit/SenderStepIntro.test.tsx](tests/unit/SenderStepIntro.test.tsx) (4 tests: recipient-name rendering, generic fallback, Rule 7 privacy assertion, CTA wiring). `npx tsc -b --noEmit` clean. Pre-existing test failures on `main` (16 in `emailTemplates` + `stepRouting` + `recipientFlowContext`) are unchanged.

**Why:** Phase E was the "right" answer but indefinitely blocked. Comp-only with a hardened server-side gate produces a real working product John can dogfood today; when Phase E lands, the only client-side change is `{ comp: true }` → `{ payment_intent_id }` in [SenderFlow.tsx](src/pages/SenderFlow.tsx) `handleConfirm`. Step components, copy, layout, and tests all stay identical.

**Watch out:**
- **Migration needed for the `admin_insert_shipment` RPC's idempotency.** EasyPost `/buy` is idempotent server-side (same rate ID → same label), but `admin_insert_shipment` will create a duplicate `shipments` row if called twice with the same `easypost_shipment_id`. Network disconnect mid-Confirm + retry could hit this. The RPC currently has no UNIQUE constraint on `easypost_shipment_id`. Follow-up: add `UNIQUE` or change the RPC to be an upsert. Flagged but not blocking — the practical retry rate is low.
- **`comp` is now strictly gated, but legacy code paths can still mint comp labels via admin JWT.** That's correct behavior (the existing Live Comp admin toolbar mode still works). The change is that *anonymous* callers with `comp=true` are blocked. If anyone calls `/labels` from outside the new sender flow or the admin toolbar with `comp=true` they will now 403 — verify before deploy.
- **`SUPABASE_ANON_KEY` env var must be set on the labels function** for the comp-gate rejection of anon-key tokens to work. Without it the check still rejects (no token = reject), but the explicit "token === anonKey → reject" path won't fire. Setting it makes the rejection reason cleaner in logs.
- **Insurance banner on Step 0 was dropped.** SPEC §8 calls for a "green badge if recipient enabled protection" but the `sendmo_links.insurance` column documented in SPEC §12 does not actually exist in any migration (verified by `grep -r insurance supabase/migrations/` — zero hits). Adding the column is a future small migration; the banner can ship when the column does. Tracked in proposal §7 #2.
- **Mobile-Safari PDF behavior** is the failure mode the reviewer specifically flagged. Step 4's "Print Label (PDF)" uses `<a target="_blank">` to EasyPost's PDF URL — works reliably on mobile Safari where iframe-PDFs intermittently fail. Verified by inspection; full mobile dogfood pending John's pass on a real device.
- **`vitest.config.ts` `exclude` doesn't filter `.claude/worktrees/`** so `npm run test:unit` runs both the canonical suite and any worktree copies. The new tests passed in both. Per the 2026-05-11 admin-auth LOG entry: "worth fixing in the config — separate cleanup task." Still worth fixing.
- **The labels function is now 800+ lines.** It's doing flex-link resolution, comp gating, payment gating, EasyPost EndShipper creation, EasyPost label purchase, auto-refund on EasyPost failure, awaited RPC persistence, awaited notification_contacts insert, and still-fire-and-forget email + payments. Splitting this into discrete handlers is a future refactor — not blocking, but the file is approaching the size where "where does X happen" stops being grep-friendly.

**Files touched:**
- [src/components/sender/senderState.ts](src/components/sender/senderState.ts) (new)
- [src/components/sender/SenderProgressBar.tsx](src/components/sender/SenderProgressBar.tsx) (new)
- [src/components/sender/SenderStepIntro.tsx](src/components/sender/SenderStepIntro.tsx) (new)
- [src/components/sender/SenderStepPackage.tsx](src/components/sender/SenderStepPackage.tsx) (new)
- [src/components/sender/SenderStepRates.tsx](src/components/sender/SenderStepRates.tsx) (new)
- [src/components/sender/SenderStepReview.tsx](src/components/sender/SenderStepReview.tsx) (new)
- [src/components/sender/SenderStepDone.tsx](src/components/sender/SenderStepDone.tsx) (new)
- [src/pages/SenderFlow.tsx](src/pages/SenderFlow.tsx) (refactored from 545 lines → ~225 lines, pure orchestrator)
- [src/lib/api.ts](src/lib/api.ts) (`buyLabel` signature gains `link?` param)
- [src/lib/types.ts](src/lib/types.ts) (`LabelResult` gains `public_code` + `shipment_id`)
- [src/components/recipient/RecipientStepPayment.tsx](src/components/recipient/RecipientStepPayment.tsx) (pass `undefined` for new `link` param)
- [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts) (link resolution + comp gate + cap re-derive + awaited RPC + `public_code` in response)
- [tests/unit/senderState.test.ts](tests/unit/senderState.test.ts) (new — 18 tests)
- [tests/unit/SenderStepIntro.test.tsx](tests/unit/SenderStepIntro.test.tsx) (new — 4 tests)

**Deploy steps:**
1. `supabase functions deploy labels --no-verify-jwt` (per the 2026-05-10 verify_jwt gotcha — labels stays anon-callable for the sender flow).
2. Vercel auto-deploy from `main` for the client changes.
3. Dogfood pass: John creates a flex link via `/onboarding` → opens `/s/<code>` in an incognito window → walks through all 5 steps with test-mode EasyPost addresses → verifies PDF renders + drop-off copy matches selected carrier + `/t/<publicCode>` resolves.


### [2026-05-11] EasyPost webhook HMAC verification (Stripe proposal Phase 0)
**Category:** Security | EasyPost
**Context:** `webhooks/index.ts` accepted any POST with a `tracker.updated` body. Anyone who knew the URL could push fake status updates and corrupt shipment state. The Stripe proposal lists this as Phase 0 — must close before Phase A starts.
**Decision/Finding:**
- New `verifyEasypostHmac()` helper in [`supabase/functions/webhooks/index.ts`](supabase/functions/webhooks/index.ts) computes HMAC-SHA256 of the **raw** request body using `EASYPOST_WEBHOOK_HMAC_SECRET` and compares against the `X-Hmac-Signature` header (per round-2 N6 fix in the Stripe proposal).
- The handler now reads `await req.text()` for the raw bytes EasyPost signed, then `JSON.parse(rawBody)` for processing. Calling `req.json()` first would re-serialize and break byte-exact signature verification.
- Constant-time hex compare via a small `timingSafeEqual` to avoid timing side channels.
- **Rollout-safe enforcement:** when the secret is unset, verification is *skipped* and a `webhook.hmac_skipped` warning fires once per request. When the secret is set, verification is mandatory — missing or mismatched signatures return 401 with `webhook.hmac_invalid` logged. **No code redeploy needed to flip enforcement** — just set the secret.

**Why:** The skip-when-unset pattern lets us land the code in production immediately without risking dropped webhooks. John flips enforcement when (a) `EASYPOST_WEBHOOK_HMAC_SECRET` is set as a Supabase function secret AND (b) the same value is configured in the EasyPost dashboard webhook settings.

**Operational steps for John (one-time, in this order):**
1. EasyPost dashboard → Settings → Webhooks → edit the production endpoint → set or generate the "HMAC Secret". Copy the value.
2. Save to 1Password: new item `EasyPost Webhook HMAC Secret` in the Secrets vault (it didn't exist before — `op_session_preauth` assumption from the original LOG draft was wrong).
3. Set the secret on Supabase Edge Functions — copy/paste into the Supabase dashboard → Edge Functions → Secrets → add `EASYPOST_WEBHOOK_HMAC_SECRET`. (Or `supabase secrets set EASYPOST_WEBHOOK_HMAC_SECRET=… --project-ref fkxykvzsqdjzhurntgah` from a shell where the value is in env.)
4. Watch `event_logs` for 24–48h:
   ```sql
   SELECT event_type, properties, created_at FROM event_logs
   WHERE event_type LIKE 'webhook.hmac%' AND created_at > now() - INTERVAL '24 hours'
   ORDER BY created_at DESC;
   ```
   Expectation: zero `webhook.hmac_invalid`, zero `webhook.hmac_skipped`. If `webhook.hmac_invalid` shows up with `reason='signature_mismatch'`, the EasyPost and Supabase values don't match — re-check.

**Verification (post-deploy curl):**
```bash
# Should return 401 — invalid signature
curl -i -X POST https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/webhooks \
  -H 'X-Hmac-Signature: 00deadbeef' \
  -H 'Content-Type: application/json' \
  -d '{"description":"tracker.updated","result":{"tracking_code":"TEST","status":"in_transit"}}'

# Should return 200 — secret unset OR signature valid
# (real test requires the secret + a real EasyPost-signed body, easiest via the EP dashboard "Send Test Event" button)
```

**Watch out:**
- **`req.text()` vs `req.json()`:** must read text first. Multiple Edge Functions in the repo currently use `await req.json()` which makes them un-verifiable for any future webhook integration (Stripe being the most important — see `supabase/functions/stripe-webhook/index.ts` which should be audited for the same pattern). Filed as follow-up.
- **Header name is `X-Hmac-Signature`, not `x-easypost-hmac-signature`.** A previous draft of the Stripe proposal used the longer form; round-2 N6 corrected it. The handler accepts either casing per HTTP norms but EasyPost sends the title-case version.
- **The `webhook.hmac_skipped` log spam will be loud until John sets the secret.** That's intentional — better signal than silence. Drops to zero once enforcement turns on.

### [2026-05-11] Role-based admin auth replaces the hardcoded `2026` PIN gate
**Category:** Security | Auth | Architecture
**Context:** `/admin` was gated by a client-side `2026` PIN stored in `sessionStorage.sendmo_admin`. The PIN was theater — the `admin-report` Edge Function accepted any anon-key Bearer token, and `cancel-label` had a "no JWT = allow" code path that meant anyone with the function URL could void any label. Stripe proposal §11 #5 (decided 2026-05-11) requires real admin auth before Live Charge mode ships behind the admin toolbar.
**Decision/Finding:**
- New migration [`016_add_profile_role.sql`](supabase/migrations/016_add_profile_role.sql): `profiles.role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))` + partial index on admins + idempotent bootstrap `UPDATE profiles SET role='admin' WHERE email='jsa7cornell@gmail.com'`.
- New shared helper [`supabase/functions/_shared/auth.ts`](supabase/functions/_shared/auth.ts) — `requireAdmin(req, corsHeaders)` extracts Bearer JWT, validates via `supabase.auth.getUser(token)`, queries `profiles.role`, throws a `Response` (401/403/500) on failure.
- [`admin-report/index.ts`](supabase/functions/admin-report/index.ts) wrapped in `requireAdmin`. The anon-key shortcut in `Admin.tsx` (`Bearer ${ANON_KEY}`) replaced with `Bearer ${session.access_token}`.
- [`cancel-label/index.ts`](supabase/functions/cancel-label/index.ts) now requires a valid JWT and authorizes admin OR link-owner (server-side join on `sendmo_links.user_id`). The legacy "no JWT = allow" path is removed.
- `AuthContext` adds `isAdmin: boolean`, read from `profiles.role` during `ensureProfile()`.
- `Admin.tsx` replaces `AdminPinGate` with three states: `authLoading` → null, `!user` → redirect to `/login?redirectTo=/admin`, `!isAdmin` → friendly access-denied screen with email shown.
- `RecipientOnboarding.tsx` admin toolbar visibility now `useAuth().isAdmin`, not `sessionStorage.sendmo_admin`.
- The exports `isAdminSession()`, `ADMIN_PIN`, `ADMIN_SESSION_KEY`, `AdminPinGate` are all gone.

**Why:** Server-side enforcement closes the actual gap (the PIN was bypassable in 5 seconds with browser devtools). Role on `profiles` keeps the source of truth where the rest of the auth lives, not in environment variables or hardcoded UID lists. Bootstrapping John in the migration itself avoids a follow-up manual SQL run.

**Watch out:**
- **Migration 016 must be applied before /admin works for John.** The shipped Edge Functions reference `profiles.role`; without the column, `requireAdmin` throws 403 (role lookup fails silently). For regular users voiding their own labels, the ownership path still works (the role check failure leaves `isAdmin=false`, ownership check then matches). Only the admin surface is broken until migration lands.
- **`SUPABASE_DB_PASSWORD` must be set in the shell for `supabase db push --linked` to work.** The predeploy script doesn't include it and the CLI errors out without it. Alternative: apply via Supabase dashboard SQL editor (paste the migration contents).
- The role check is in two places (Edge Function + AuthContext), but the **client check is UX-only**. Anyone who flips `isAdmin` in DevTools gets the admin UI rendered but every server call still rejects. Don't move authorization into the client.
- Old worktrees in `.claude/worktrees/` get picked up by vitest because the `exclude` list in `vitest.config.ts` doesn't include `.claude/**`. Pass `--exclude '.claude/**'` to bypass when running locally. Worth fixing in the config — separate cleanup task.

### [2026-05-11] Stripe Phase 2 directional decisions locked in
**Category:** Stripe | Architecture
**Context:** Phase 1 (full-label test-mode charges, label auth gate, auto-refund-on-EasyPost-fail) shipped in commit `90aebca` on 2026-05-10. Before going live and before flex-link/Phase E coding begins, six of the eleven open §11 decisions in [`proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md`](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) needed John's call.

**Decisions:**
1. **Refund destination (proposal #1):** original card. Not balance. Cleans up the SPEC §13.1 contradiction; balance-refund pattern revisits if/when Phase 2 balance UI ships.
2. **Stripe fee absorption (proposal #2):** **flat $1 surcharge on every label, always.** Structurally different from the three options in the proposal — adds a fixed line item to absorb Stripe (≈$0.30) + support handling. Pricing formula becomes `DisplayPrice = EasyPostRate × 1.15 + $1.00`. PLAYBOOK.md §"Pricing" already reflects this — the standalone $1 is now load-bearing, not aspirational.
3. **Hold-exceeded policy on flex links (proposal #3):** **Debit-then-cap (D-then-C).** Sender's flow never blocks; gap is recovered via off-session debit on recipient's saved card, with notification after the fact. Implicitly picks (a) on proposal #10 — explicit mandate at link creation with a Stripe-compliant string ("authorize SendMo to debit up to $X for shipping cost variance through {date}"). Hard cap stays as §3.7 specifies ($10 lifetime per shipment, $20 per card per 24h).
4. **Account creation timing for full-label (proposal #4):** research first. Spawning a separate proposal-only session to survey Stripe/Substack/Gumroad/Shopify patterns before locking. Lands in `proposals/` for review.
5. **Live-mode admin UX (proposal #5):** **both.** Add the 3rd admin toolbar mode (Live Charge) for Phase C self-charge dogfooding **and** replace the PIN gate with role-based auth (`profile.role='admin'`) before Phase C goes live. Don't ship Live Charge behind a hardcoded PIN.
6. **Carrier adjustment caps (proposal #8):** stay with proposal recommendation — $2 absorb / $2–$10 auto-recover off-session / >$10 admin review. Per-shipment $10 lifetime cap, per-card $20/24h cap, per-user $50/7d cap. Final values reviewable post-Phase D data.

**Still open (deferred or not yet relevant):**
- #6 prepaid balance topup discount shape → Phase 2/H, not blocking MVP.
- #9 ACH credit timing → settle-then-credit per proposal recommendation, Phase H.
- #11 MTL/KYC scope → explicitly deferred to Phase H legal review.

**Why:** John's directional calls turn Phase A/C/E from "blocked on decisions" into "blocked only on code + Stripe live-mode setup." The $1 fee is the only one that materially deviates from the proposal — it requires a proposal revision pass and a pricing-display change in `src/lib/api.ts` `pickRecommendedRate` consumers + the FAQ pricing table.

**Watch out:**
- The $1 fee makes the "shipping costs ≈ post office" claim *less* true for very cheap labels — a $3.74 Ground Advantage shipment becomes ~$5.30 vs USPS retail ~$5.50, but a $4.50 Ground Advantage shipment becomes ~$6.18 vs retail ~$6.50. Margin is healthier, claim still holds, but the FAQ pricing table needs to use representative shipments where the math is favorable.
- D-then-C + mandate means the auto-debit consent (proposal #10) is **resolved as part of #3** — no separate decision needed. Implementation must put the mandate string in front of recipients at link creation, not buried in ToS.
- "Do both" on #5 means Phase C is blocked on the role-based auth work landing first. That's a side-quest, not part of Stripe proper. Track separately.
- Proposal still needs a round-3 revision to fold these in; status flips from `revised` to `decided` only after that revision lands.

### [2026-05-11] SendMo public tracking code — decoupled `/track` URL from carrier number
**Category:** Feature | Schema | Email | URL contract
**Proposal:** [proposals/2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md](proposals/2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md)
**Context:** Public tracking URL was `sendmo.co/track/<carrier_tracking_number>`. Three failure modes: (1) the lookup `.eq("tracking_number", n).single()` returns an arbitrary matching row on collision (worse than 404 — wrong shipment to wrong viewer; EasyPost test-mode fixtures and cross-mode shipments can produce duplicates), (2) void + reissue breaks URL stability, (3) the URL slug advertises the carrier, not SendMo. Reviewer surfaced the `.single()` severity during proposal review; original draft had under-described it as "404s on duplicates."
**Decision/Finding:**
- New `shipments.public_code` column — 7-char Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no I/L/O/U), UNIQUE, generated via `extensions.gen_random_bytes` + modulo (mirrors the migration-008 `sendmo_links.short_code` generator pattern). Migration [014](supabase/migrations/014_shipments_public_code.sql) adds the column + generator + backfill; migration [015](supabase/migrations/015_shipments_public_code_constraints.sql) flips to NOT NULL + UNIQUE with pre-checks. Split into two migrations to make recovery from partial backfill failure clean.
- `admin_insert_shipment` RPC return type changed from `UUID` → `RETURNS TABLE(id UUID, public_code TEXT)`. Caller is now [labels/index.ts](supabase/functions/labels/index.ts) — extracts row from the returned array and routes the label-confirmation email send **into the `.rpc(...).then()` callback** instead of running in parallel. Side benefit: fixes a latent bug where the email could fire even when DB persist failed.
- Canonical URL is now `sendmo.co/t/<code>` (e.g. `/t/H7K2P9`). Legacy `sendmo.co/track/<carrier_number>` becomes a 301-equivalent client redirect via new [LegacyTrackingRedirect.tsx](src/pages/LegacyTrackingRedirect.tsx) — calls `?number=<n>` (which still works, ordered `created_at DESC LIMIT 1` for collision safety), reads `public_code`, navigates with `{ replace: true }`. Every tracking-update email already in someone's inbox keeps working.
- [tracking/index.ts](supabase/functions/tracking/index.ts) accepts `?code=` OR `?number=`. `?code=` uses `.eq().single()` (UNIQUE column → correct). `?number=` uses `.eq().order("created_at desc").limit(1).maybeSingle()` — chosen over `.single()` because tracking_number is not unique and we want deterministic collision behavior, not "arbitrary row Postgres returns first."
- [webhooks/index.ts](supabase/functions/webhooks/index.ts) — EasyPost webhooks only carry the carrier tracking number, so the webhook lookup must stay on `tracking_number`. Changed from `.eq().single()` to `.eq()` + length check: 0 = log not_found, 1 = proceed, >1 = log `webhook.tracking_number_collision` with all matched IDs and bail without updating. Reviewer's blocker: prior behavior would have updated an arbitrary shipment and notified the wrong contacts on test-mode collision.
- Email templates ([_shared/email-templates.ts](supabase/functions/_shared/email-templates.ts)): both `labelConfirmationEmail()` and `trackingUpdateEmail()` now lead with the SendMo public_code as the prominent "Tracking" field (22px bold), with `{carrier} #{carrier_number}` as a small secondary line. URL slugs in buttons changed to `/t/<code>`.
- Dashboard ([Dashboard.tsx](src/pages/Dashboard.tsx)) shows the public_code as the tracking-cell label (replaces the truncated 14-char carrier number), with carrier+number on hover via `title`.
- Backfill verified: existing real shipment (`9434636208303383385717`) got `public_code: 71NF1E8`; both `?code=71NF1E8` and `?number=9434636208303383385717` resolve to the same row.
**Why:** Decoupling from the carrier number eliminates collision-on-arbitrary-row (the actual current bug, not a theoretical one), gives SendMo a brand-able URL surface (`/t/<code>` reads as SendMo, not USPS), creates URL stability across label voids/reissues, and unblocks future surfaces that need a URL before a carrier number exists (e.g. tracking page between Stripe charge and label purchase).
**Watch out:**
- **RPC signature change** is breaking for any other caller of `admin_insert_shipment`. Grepped repo — only [labels/index.ts](supabase/functions/labels/index.ts) calls it. If another path is ever added, it MUST destructure the return as `[{ id, public_code }]` not just `id`.
- **`.single()` vs `.maybeSingle()`** matters more than I previously appreciated. `.single()` is correct only when the WHERE clause is on a UNIQUE column. Code reviews should flag any `.eq("non_unique_column", x).single()` as a latent collision bug.
- **Webhook collision-bail behavior** is permissive by design — we don't auto-resolve, just surface to the event log. If `webhook.tracking_number_collision` ever fires in prod (it shouldn't with public_code as the canonical id going forward, but it could in test-mode), an admin needs to look at the matched shipment IDs and decide which one to update manually.
- **Legacy `/track/<number>` URLs in old emails** still work (redirect to `/t/<code>`). When they're rare enough — say, 6 months from now — the LegacyTrackingRedirect component can be deleted and the route can return a clean 404. Don't remove it earlier.
- **The proposal's review surfaced a deeper finding** worth carrying forward: every `.then()` callback on a Supabase write in a Deno Edge Function is a potential fire-and-forget hazard if Deno terminates the request before the promise resolves (per the 2026-04-26 LOG entry). The labels-fn email send is now correctly inside the RPC `.then()`, but anything else awaiting Supabase writes deserves a second look.
**Files touched:** [supabase/migrations/014_shipments_public_code.sql](supabase/migrations/014_shipments_public_code.sql), [supabase/migrations/015_shipments_public_code_constraints.sql](supabase/migrations/015_shipments_public_code_constraints.sql), [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts), [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts), [supabase/functions/webhooks/index.ts](supabase/functions/webhooks/index.ts), [supabase/functions/_shared/email-templates.ts](supabase/functions/_shared/email-templates.ts), [supabase/functions/_shared/notifications.ts](supabase/functions/_shared/notifications.ts), [src/App.tsx](src/App.tsx), [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx), [src/pages/LegacyTrackingRedirect.tsx](src/pages/LegacyTrackingRedirect.tsx) (new), [src/pages/Dashboard.tsx](src/pages/Dashboard.tsx).

### [2026-05-11] Delivery-performance badge on /track page + carrier deep links + email subject capitalization
**Category:** Feature | UX | Email
**Context:** Audit of the shipment-email pipeline + a real delivered-but-stuck-In-Transit shipment surfaced a cluster of small UX gaps: tracking-update email subjects rendered with lowercase status (`"in transit"`), the public `/track/<number>` page had no link to the carrier's own tracking site, and there was no signal — anywhere in the product — for whether a package actually arrived when the carrier promised it would.
**Decision/Finding:**
- **Capitalization** in `trackingUpdateEmail()` subjects ([_shared/email-templates.ts](supabase/functions/_shared/email-templates.ts)): removed `info.label.toLowerCase()`, now uses the title-cased label directly. Subjects now read `📦 Your package is In Transit — SendMo` (and the sender variant). Affects `tracking` + `webhooks` functions on redeploy.
- **Carrier deep links** in [TrackingPage.tsx](src/pages/TrackingPage.tsx): added `carrierTrackingUrl(carrier, number)` helper in [src/lib/utils.ts](src/lib/utils.ts) covering USPS, UPS, FedEx, DHL. Renders a small "View on {carrier} site ↗" link under the tracking number on the public tracking page. Unknown carrier → link hidden (no broken URL).
- **Dashboard tracking link** ([Dashboard.tsx](src/pages/Dashboard.tsx)): was already an in-app `<Link to="/track/...">` (good, no change needed there) but used a misleading `ExternalLink` (↗) icon. Swapped to `ChevronRight` (›) so the visual matches the in-app nav. The chain is now Dashboard row (›) → `/track/<number>` (↗) → carrier site.
- **Tracking-number identity:** confirmed the value stored in `shipments.tracking_number` IS the carrier's number, not a SendMo-minted one. SendMo doesn't issue its own tracking codes today. Discussed introducing one (`/t/<short_code>` mirroring the flexible-link `/s/<short_code>` pattern) — deferred pending proposal; not blocking.
- **Delivery-performance badge** ([TrackingPage.tsx](src/pages/TrackingPage.tsx), [tracking/index.ts](supabase/functions/tracking/index.ts), [labels/index.ts](supabase/functions/labels/index.ts), migration [012](supabase/migrations/012_promised_delivery_date.sql)): new column `shipments.promised_delivery_date DATE` snapshotted at label-purchase time from `selected_rate.delivery_date`. Tracking page now renders a colored badge on the status card when `status = 'delivered'`: `✨ N days early` (emerald), `🎯 Right on time` (blue), or `🐢 N days late` (amber). Badge hides silently when either date is missing (which includes every pre-migration row and any rate EasyPost didn't quote a delivery date on).
**Why:**
- Capitalization: pure polish; 30-second fix.
- Carrier link: trust signal. Users want to verify against the source of truth (USPS site) without typing the number themselves.
- Performance badge: lightweight delight that turns a passive status page into a moment. Also lays the data foundation for a future carrier-reliability rollup ("X% of USPS GroundAdvantage on or ahead of schedule").
**Watch out:**
- **Migration 012 changes the `admin_insert_shipment` RPC signature** — adds a new last param `p_promised_delivery_date DATE DEFAULT NULL`. The default makes it back-compatible with any caller that doesn't pass it, but [labels/index.ts](supabase/functions/labels/index.ts) was updated to pass it explicitly. If any other code path inserts shipments via this RPC, double-check it doesn't break.
- **No backfill** for pre-migration shipments — the badge will simply not render for them. A backfill is intentionally avoided: EasyPost's current `est_delivery_date` is "current estimate" not "promised at purchase," so backfilling would be semantically wrong (a late package would show as on-time because EasyPost updates the estimate as the package slips).
- **EasyPost `selected_rate.delivery_date` is not universal.** Some USPS ground services + most regional carriers omit it. Those shipments will silently skip the badge — acceptable for v1.
- **Deploy order matters:** apply migration 012 before redeploying `labels`, otherwise the RPC call with the new param will error. `supabase db push` first, then `supabase functions deploy labels --no-verify-jwt && supabase functions deploy tracking --no-verify-jwt`.
- **Date math uses UTC.** Both sides of the comparison are normalized to midnight UTC to avoid off-by-one from local TZ when a package is delivered close to midnight in the user's locale. Verified with same-day delivered = "Right on time."
**Files touched:** [supabase/migrations/012_promised_delivery_date.sql](supabase/migrations/012_promised_delivery_date.sql), [supabase/functions/labels/index.ts](supabase/functions/labels/index.ts), [supabase/functions/tracking/index.ts](supabase/functions/tracking/index.ts), [supabase/functions/_shared/email-templates.ts](supabase/functions/_shared/email-templates.ts), [src/pages/TrackingPage.tsx](src/pages/TrackingPage.tsx), [src/pages/Dashboard.tsx](src/pages/Dashboard.tsx), [src/lib/utils.ts](src/lib/utils.ts).

### [2026-05-11] verify_jwt regression hit `tracking` + `webhooks` (recurrence of the 2026-05-10 gotcha)
**Category:** Supabase | Gotcha | Deploy
**Context:** User reported a delivered USPS shipment (`9434636208303383385717`, sender "barb anderson") stuck on the Dashboard as "In Transit", and `https://sendmo.co/track/9434636208303383385717` showing "Package not found." Both symptoms had the same root cause: someone had redeployed both `tracking` and `webhooks` via a bare `supabase functions deploy <fn>`, which silently flipped them back to `verify_jwt: true` on the gateway — despite `supabase/config.toml` explicitly pinning both to `verify_jwt = false`. Config.toml's lock is local-only; it doesn't override the deploy CLI's default.
**Smoking gun:** `curl https://<ref>.supabase.co/functions/v1/tracking?number=test` → HTTP 401 (gateway-level rejection, function never ran). Compare with `place-details` which returned 405 (function ran, just wrong verb). Both functions were behind the same misconfiguration.
**Why both symptoms:**
- `tracking` 401 → browser's `fetch` to the function returns non-ok → [TrackingPage.tsx](src/pages/TrackingPage.tsx) throws "Tracking number not found" generically (it doesn't inspect status code).
- `webhooks` 401 → every EasyPost `tracker.updated` POST got rejected at the gateway → `shipments.status` never advanced → Dashboard read stale row.
**Fix:** `supabase functions deploy tracking --no-verify-jwt && supabase functions deploy webhooks --no-verify-jwt`. After redeploy, `tracking?number=...` returned 200 with `status: "delivered"` and synced the DB row in the same request (since the function polls live EasyPost on non-terminal rows, [tracking/index.ts:72-109](supabase/functions/tracking/index.ts)).
**Rule (reinforced):** `config.toml` is not enough on its own — the `--no-verify-jwt` flag must still be passed at deploy time for anon-callable functions. The local config locks intent; the flag locks the deploy. Use both. Consider a deploy-script wrapper that reads config.toml and injects the flag automatically.
**Watch list of anon-callable functions to never deploy without the flag:** `autocomplete`, `place-details`, `verify-address`, `otp`, `guestimate`, `rates`, `labels`, `tracking`, `webhooks`, `stripe-payment-intent`, `stripe-webhook`, `ingest`.

### [2026-05-10] Edge Function deploys: always pass `--no-verify-jwt` for anon-callable functions
**Category:** Supabase | Gotcha
**Context:** Redeployed `place-details` to add a ZIP regex fallback. Bare `supabase functions deploy place-details` defaulted to `verify_jwt: true`, which immediately broke address verification in prod — every place-details call started returning 401 Unauthorized because the new `sb_publishable_*` anon key isn't a JWT and Supabase's gateway rejects it under `verify_jwt: true`. Symptom: address dropdown selection followed by "Select an address from the dropdown" stuck on screen.
**Rule:** When deploying any Edge Function called by anonymous (logged-out) users — or by any client using the publishable anon key — pass `--no-verify-jwt`. Functions in this category today: `autocomplete`, `place-details`, `addresses`, `rates`, `labels`, `email`, `guestimate`, `links` (the GET path). Authenticated functions (`admin-report`, link CRUD POST/PATCH) keep `verify_jwt: true`.
**Why we don't have config.toml entries for them:** most functions aren't listed in `supabase/config.toml` so the deploy flag is the source of truth. Either add them to config.toml with `verify_jwt = false`, or always remember the flag. Fastest unbreak: redeploy with `--no-verify-jwt`.
**Verification after fix:** `fetch('/functions/v1/place-details', {place_id: ...})` returns 200 with full components (street/city/state/zip).

### [2026-05-10] Magic Guestimator upgraded to AI + "I'm Feeling Lucky" + auto-rate-recommendation
**Category:** Feature | LLM | UX
**Context:** The shipping page's "Magic Guestimator" was branded with a sparkle icon but was a 15-item hardcoded keyword lookup. Anything outside the list ("watch", "ceramic vase", "framed print", etc.) returned "Couldn't match." User reported it as "not working" because most realistic descriptions failed. Also: `speedHint` was being parsed and silently discarded; cheapest/fastest hints in the user's text were never applied to rate selection.
**Decision/Finding:**
- New Supabase Edge Function [`guestimate`](supabase/functions/guestimate/index.ts) calls Claude Haiku 4.5 with strict tool-use JSON output. Returns `{itemName, packaging, length_in, width_in, height_in, weight_lbs, speedHint, confidence, notes}`. Prompt biases toward overestimating dims/weight to avoid carrier adjustment fees.
- `parseGuestimation()` keyword logic deleted from [MagicGuestimator.tsx](src/components/recipient/MagicGuestimator.tsx); component now calls `fetchGuestimate()` with a loading state. Old `tests/unit/guestimator.test.ts` removed (tested keyword logic that no longer exists).
- New `pickRecommendedRate()` helper in [api.ts](src/lib/api.ts): `express` → fastest delivery; `economy` → cheapest; `standard`/null → cheapest among rates ≤5 days, fall back to absolute cheapest.
- New `recommendedSpeedHint` field on `RecipientFlowState` carries the AI's hint into the rates effect, which auto-selects the recommended rate when fresh rates arrive. Cleared when user manually picks a different rate so the recommendation doesn't override their choice on next refetch.
- New "I'm Feeling Lucky" button in [RecipientStepFullShipping.tsx](src/components/recipient/RecipientStepFullShipping.tsx) sits between the item description input and the packaging picker. Reads `state.itemDescription`, calls the same guestimate endpoint, fills everything, surfaces low/medium-confidence assumptions inline ("Assumed standard cylindrical vase…").
- Final estimate summary card added above "Continue to payment" showing carrier/service, ETA, and total — so the user sees the complete picture before committing.
**Why:** The keyword approach was fundamentally capped at 15 items; expanding it to 100 wouldn't fix vague descriptions. Haiku 4.5 reliably handles everything from "vintage Polaroid camera" to "framed 18x24 art print" with sensible padding. Cost is ~$0.001 per estimate (300 in / 150 out tokens) with prompt-cached system; effectively free at SendMo's volume.
**Watch out:**
- **Carrier adjustment fees are the real risk.** If Haiku under-estimates dims/weight, USPS/UPS measure the actual package at the warehouse and bill the difference back to SendMo (not the user). Mitigated by (a) prompt explicitly biasing toward larger/heavier when uncertain, (b) `confidence` field surfaced inline so users can spot weak guesses, (c) AI-recommended rate is auto-selected but always editable. Track adjustment incidents post-launch; if they spike, tighten prompt or move to confidence-gated auto-select.
- **No fallback to keyword matcher** — per product call. If the API errors (key missing, Anthropic down, network), the user sees the error and fills dims manually. The dimensions form is still right there.
- **Vercel AI Gateway considered, declined** — backend lives in Supabase Edge Functions (Deno). Routing through Vercel from there adds a hop for marginal benefit. Direct Anthropic call wins on simplicity until we add a 2nd AI feature, at which point the gateway pays for itself.
- **Smoke-tested via direct fetch** to the deployed function — UI verification was blocked because the running Vite server was rooted at the main repo path, not the worktree, so HMR didn't pick up the new `fetchGuestimate` export. Verified end-to-end through the function URL with sample inputs (cookbook, Polaroid camera, ceramic vase, dinner plates, framed print) — all returned sensible JSON. Full UI click-through needs to happen after merge or after restarting Vite from the worktree path.
**Setup:**
- `ANTHROPIC_API_KEY` set as a Supabase secret (`supabase secrets set ANTHROPIC_API_KEY=…`).
- Function deployed via `supabase functions deploy guestimate --no-verify-jwt --project-ref fkxykvzsqdjzhurntgah` from the worktree path.

### [2026-05-10] Google OAuth added alongside magic link
**Category:** Supabase | Architecture
**Context:** Stripe work needs a sturdier account-creation story than magic-link-only. Google OAuth is a low-friction second option without making magic link disappear.
**Decision/Finding:**
- Added `signInWithGoogle()` to [AuthContext](src/contexts/AuthContext.tsx) using `supabase.auth.signInWithOAuth({ provider: 'google', redirectTo: <origin>/dashboard })`. The existing `detectSessionInUrl: true` on the supabase client handles the callback; no new route required.
- Added a "Continue with Google" button above the email form on [Login.tsx](src/pages/Login.tsx) with brand-correct multi-color "G" SVG, divider with "or", and disabled-while-loading behavior.
- `ensureProfile()` now also writes `full_name` and `avatar_url` from `user_metadata` on first sign-in (Google fills `name`/`picture`, Supabase mirrors them as `full_name`/`avatar_url`). Magic-link users get nulls, same as before.
**Why:** Single source of truth for profile creation kept inside AuthContext so both paths converge on the same row shape. No new route or callback page; the OAuth redirect lands on `/dashboard` and the existing session listener picks it up.
**Watch out:**
- Account auto-linking by email is **not** the default in Supabase. If a user signs in with magic link first, then later with Google using the same email, Supabase creates a separate identity unless "Link this identity to an existing user" is enabled (or done manually). To verify after John completes the dashboard config: sign in via magic link with email X, sign out, sign in via Google with email X, check `auth.users` — same id = linked, different ids = duplicate. Document the actual behavior here once tested.
- The redirect URI for Google Cloud Console is the **Supabase project's** callback (`https://<project-ref>.supabase.co/auth/v1/callback`), not sendmo.co. The `redirectTo` we pass to `signInWithOAuth` is where Supabase sends the user *after* it processes the callback.
- **Profile-row creation race:** the DB trigger `handle_new_user` ([001_initial_schema.sql:268](supabase/migrations/001_initial_schema.sql:268)) inserts `{id, email}` only — no `full_name`/`avatar_url`. If `ensureProfile()` only inserted on `!data` it would never populate OAuth metadata, because the trigger already created the row. Fix: `ensureProfile()` now also runs an UPDATE backfilling `full_name`/`avatar_url` from `user_metadata` when those columns are NULL. Verified end-to-end 2026-05-10 with John's Google sign-in — row populated on second auth state change after the trigger inserted with nulls.

### Operational notes from setup
- **Google Cloud project:** consolidated into the existing `project-2697ea97-2d95-42b3-a8a` (renamed from "My First Project" → "SendMo"). Same project owns Maps API + Address Validation keys and now the OAuth client. Originally a second "SendMo" project was created and immediately shut down (sendmo-495916, in 30-day grace period). One project per app keeps billing + audit trail single.
- **OAuth client secret:** Google's new policy hides the secret after creation. If lost, you must add a new secret via the client detail page → "Additional information" panel → "Add secret". Old secrets should be disabled then deleted once the new one is verified working in Supabase. Stored in 1Password as `Google OAuth — SendMo Web` in the Secrets vault.

### Setup steps for John (Google Cloud + Supabase dashboard)
1. **Google Cloud Console** → APIs & Services → Credentials → Create OAuth 2.0 Client ID.
   - Application type: Web application.
   - Authorized JavaScript origins: `https://sendmo.co`, `http://localhost:5173`.
   - Authorized redirect URI: `https://fkxykvzsqdjzhurntgah.supabase.co/auth/v1/callback` (the Supabase project callback — not a sendmo.co URL).
   - Save the Client ID and Client Secret.
2. **Supabase dashboard** → Authentication → Providers → Google → toggle on.
   - Paste the Client ID and Client Secret from step 1.
   - Leave "Skip nonce check" off.
   - Save.
3. **Supabase dashboard** → Authentication → URL Configuration.
   - Site URL: `https://sendmo.co`.
   - Additional redirect URLs: include `http://localhost:5173/**` and `https://sendmo.co/**` (the app uses `${window.location.origin}/dashboard`).
4. **OAuth consent screen** in Google Cloud Console → fill in app name "SendMo", support email, logo, and add scopes `email`, `profile`, `openid`. Publish (or keep in testing and add yourself as a test user) before going live.
5. Test on `http://localhost:5173/login` → "Continue with Google" → land back on `/dashboard` with profile row populated.

---

When an agent discovers something important — an API quirk, a "why did we choose X", a bug pattern — propose an addition using this format:

```markdown
### [YYYY-MM-DD] Short title
**Category:** Architecture | EasyPost | Stripe | Supabase | Testing | Security
**Context:** What situation led to this discovery.
**Decision/Finding:** What was decided or discovered.
**Why:** The reasoning or evidence.
**Watch out:** What breaks if you ignore this.
```

### [2026-05-10] Brand identity shipped — V6-B "S with sender/receiver dots"
**Category:** Architecture
- Single source of truth: [src/assets/sendmo-logo.svg](src/assets/sendmo-logo.svg). React component at [src/components/SendMoLogo.tsx](src/components/SendMoLogo.tsx) inlines the same path so it tints/scales via Tailwind.
- Asset pipeline: [scripts/generate-brand-assets.mjs](scripts/generate-brand-assets.mjs) renders favicon.ico (16/32/48), favicon-32, apple-touch-icon (180), icon-192/512/maskable, og-image (1200×630). Re-run after editing the SVG. Uses `sharp` + `png-to-ico` (devDeps).
- Wired through: AppHeader, HeaderPreview, Index footer, index.html (favicons + theme-color + OG/Twitter meta), public/manifest.webmanifest (PWA), email-templates.ts header (img to https://sendmo.co/icon-192.png — only resolves after deploy).
- Removed placeholder vite.svg + react.svg.
- **Manual follow-up:** upload `public/icon-512.png` to Google Cloud Console → APIs & Services → OAuth consent screen (App logo). Min 120×120, square, <1 MB — 512×512 PNG fits.

### [2026-04-26] Notification system silently 100% broken — three independent bugs
**Category:** EasyPost | Architecture | Testing
**Context:** A real shipment (Barb Anderson, USPS `94346362083033...`) was stuck "In transit since Mar 19, 2026" in the dashboard despite being delivered. No tracking emails were ever sent. Investigation revealed the notification system had never worked for any shipment.
**Decision/Finding:** Three independent bugs were silently compounding:
1. **EasyPost `tracker.updated` webhook URL was never registered** in the EasyPost dashboard. `webhook_events` table had 0 rows from EasyPost. Status updates never pushed to us. Fixed by registering `https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/webhooks` (production env, all events).
2. **`notification_contacts` was empty for every shipment (17/17 missing).** Root cause: the labels Edge function expected `recipient_email`/`sender_email` in the request body, but the only caller (`buyLabel` in `src/lib/api.ts`) never sent them. So the contacts array was always empty, the insert never ran, and the webhook handler would have logged `notification.no_contacts` and skipped even if it had fired. Fixed by piping `state.email` (recipient) and a new `state.senderEmail` field through `buyLabel` → labels function. Also un-fire-and-forgot the insert and added explicit log events for empty/error cases.
3. **Webhook handler used wrong column name** when inserting into `webhook_events` (`provider` instead of `source`). Insert was failing silently — handler kept going via the `if (dupeErr?.code === '23505')` check and called dispatch anyway, but `webhook_events` would have stayed empty even if registered.
4. **Lazy-pull tracking path didn't dispatch notifications.** When someone visited `/track/<number>`, [tracking/index.ts](supabase/functions/tracking/index.ts) synced status to the DB but never called `dispatchNotifications`. Fixed by dispatching on `liveStatus !== shipment.status` (idempotent via `notifications_log` unique index, so safe alongside the webhook).

Also dropped the 30-minute TTL cache on the tracking endpoint — EasyPost API reads are free, and users want fresh location info every time they view the page. Tracking now always fetches live unless the shipment is in a terminal status (`delivered`/`return_to_sender`/`cancelled`).
**Why:** Each bug individually would have caused silent failure. The "fire-and-forget" pattern in `labels/index.ts` (warned about in the 2026-03-19 notification dispatcher entry) hid bug #2 for over a month; nobody noticed because the only signal was `console.error`. The webhook bug (#3) and the never-registered URL (#1) ensured we'd never hear from EasyPost. Bug #4 made the lazy-pull "fallback" not actually a notification fallback.
**Watch out:**
- (1) Any Edge Function `.then()` chain on a Supabase write is fire-and-forget in Deno — Deno may terminate the request before the promise resolves. Always `await` writes that matter, or wrap in `EdgeRuntime.waitUntil` if truly background work.
- (2) EasyPost webhook events MUST be checked end-to-end after registration: send a test event from the EasyPost dashboard, then `select count(*) from webhook_events where source='easypost';` should be ≥ 1. Don't trust "the handler is deployed" as proof.
- (3) The notification system's silent failure modes (`notification.no_contacts`, `notification.dispatch_error`) are easy to miss. Worth wiring an alert on `notifications_log` rows with `status='failed'` or sustained absence of `status='sent'` rows.
- (4) Sender email is still optional in the UI; if the recipient leaves it blank, only the recipient gets notifications. That's by design (the recipient is the person doing the flow), but worth knowing when debugging "sender didn't get email."
- (5) Old test shipments (the 17 created before the fix) won't be backfilled — they have no contacts, so they'll never email. New shipments only.

---

### Pricing & Rate Strategy

### [2026-03-19] EasyPost rate competitiveness — confirmed same tier as Pirate Ship
**Category:** Architecture
**Context:** John needed to know if EasyPost was giving competitive wholesale rates and whether SendMo's retail prices are competitive with Pirate Ship and similar services.
**Decision/Finding:** EasyPost provides USPS Merchant Discount Pricing, which sits in the same sub-commercial tier as Pirate Ship's USPS Connect eCommerce rates. Both are estimated at 40–48% below USPS retail for Priority Mail and 38–42% below retail for Ground Advantage. SendMo's *wholesale cost* is therefore on par with the lowest-cost competitors. The customer-facing price gap vs. Pirate Ship is entirely explained by our 15% markup — not inferior EasyPost rates.
**Why:** EasyPost and Pirate Ship both negotiated directly with USPS for sub-commercial access. Neither publishes exact rates. SendMo's pricing gap is a business model decision (margin vs. zero-fee rebate model), not a sourcing problem.
**Watch out:**
- (1) Pirate Ship charges zero markup (they earn carrier rebates), so they're structurally cheaper than us by exactly our markup %. Don't try to compete on price with them — differentiate on the link-based model.
- (2) Honest marketing claim: "Save 30–35% off USPS retail rates." This is true and defensible. Don't claim "cheapest rates."
- (3) UPS retail is heavily marked up — our EasyPost UPS rates may be 55–70% below UPS retail, which is a strong marketing story.
- (4) After each USPS rate change (~January and ~July), verify that EasyPost's merchant discount hasn't narrowed. Re-run RATE_ANALYSIS.md estimates.
- (5) Dollar margin is thin on cheap Ground Advantage shipments (~$0.49 on a $3.74 label). After Stripe's $0.30 flat fee, these labels could run at near-zero net margin — consider minimum charge threshold.
- (6) Full analysis in `RATE_ANALYSIS.md` — includes rate comparison tables, margin analysis, and marketing recommendations.

---

### Architecture Decisions

### [2026-03-19] Shared AppHeader component — single persistent nav for all pages
**Category:** Architecture
**Context:** Five+ pages each had their own inline `<nav>` elements with slightly different auth logic, button styles, and logo placements. Changing the header (adding a nav item, updating the logo) required editing every page.
**Decision/Finding:** Created `src/components/AppHeader.tsx` — a single auth-aware header used by all pages. Uses `useAuth()` to conditionally render "My Account" + sign-out (logged in) or "FAQ" + "Sign In" (logged out). Accepts an optional `actions` prop that completely replaces the right slot when provided.
**Why:** One component to update, consistent nav everywhere. The `actions` prop allows pages like TrackingPage to show a contextual label ("Track Package") instead of auth buttons, without forking the component.
**Watch out:** (1) `actions={undefined}` gives the default auth controls; `actions={null}` renders nothing in the right slot — be explicit. (2) AppHeader uses `useAuth()` and `useNavigate()` — it must be inside both `AuthProvider` and `BrowserRouter`. (3) The logo links to `/` — don't add a second home link elsewhere on the page.

### [2026-03-19] Flow badge reads from context — no prop drilling needed
**Category:** Architecture
**Context:** Once a user picks "Full Prepaid Label" or "Flexible Shipping Link" in onboarding, they need a persistent visual indicator of which flow they're in (especially since both share the same `/onboarding/*` URL space).
**Decision/Finding:** Added a pill badge directly in `RecipientOnboarding.tsx` that reads `data.path` from `RecipientFlowContext`. Shows a Package icon + "Full Prepaid Label" or Link2 icon + "Flexible Shipping Link". Hidden on step 0 (path choice) since the user hasn't chosen yet.
**Why:** The context is already available at the `RecipientOnboarding` layout level — no new props needed. Step components don't need to know about the badge at all.
**Watch out:** The badge renders only when `data.path && currentStep !== 0`. If a third path is added, update the badge's conditional rendering.

### [2026-03-19] AnimatePresence timing — screenshots during exit animation show stale content
**Category:** Testing
**Context:** When verifying step transitions via the preview tool, clicking a path choice card and immediately taking a screenshot showed the old step 0 content instead of the new step 1 address form.
**Decision/Finding:** `AnimatePresence mode="wait"` ensures the exit animation plays fully (0.25s) before the enter animation starts. Screenshots taken within that window capture the exiting content, making the new step appear blank.
**Why:** This is expected Framer Motion behavior, not a bug. The transition duration is 0.25s (set in RecipientOnboarding.tsx).
**Watch out:** When testing step transitions via `preview_eval` + `preview_screenshot`, either (1) wait for the animation to settle before screenshotting, or (2) navigate directly via `window.location.href` to the target URL for isolated verification of that step's rendered state.

### [2026-03-19] Notification dispatcher pattern — channel-agnostic, auditable, idempotent
**Category:** Architecture
**Context:** Needed to send tracking notifications to both sender and recipient, with plans to add SMS and push later. The original webhook handler called `sendEmail()` directly, which would mean duplicating logic for each new channel and each new recipient type.
**Decision/Finding:** Created a notification dispatcher (`_shared/notifications.ts`) that: (1) looks up `notification_contacts` for a shipment, (2) routes each contact to the appropriate channel handler (email now, SMS/push stubs), (3) logs every attempt to `notifications_log` for audit, (4) checks for duplicates before sending (idempotency). The webhook handler now calls `dispatchNotifications()` instead of `sendEmail()` directly.
**Why:** Adding SMS is just adding a handler function — no changes to webhooks, labels, or any calling code. The `notification_contacts` table decouples "who to notify" from "how to notify." The `notifications_log` with a unique index on `(shipment_id, contact_id, event_type)` WHERE `status='sent'` prevents duplicate sends from webhook retries.
**Watch out:** (1) The dispatcher is fire-and-forget — don't await it in the webhook response path. (2) The unique index only prevents duplicates for `status='sent'` — failed attempts can be retried. (3) `notification_contacts` rows are inserted during label purchase; if the DB persist fails (fire-and-forget), the contacts won't exist and no notifications will be sent for that shipment.

### [2026-03-19] Public tracking page — Edge Function, not direct PostgREST
**Category:** Architecture
**Context:** The tracking page at `/track/:trackingNumber` needs to show shipment status publicly (no auth). Options: (1) query PostgREST directly with anon key, (2) dedicated Edge Function.
**Decision/Finding:** Created a dedicated `tracking` Edge Function that returns only safe, non-PII fields (tracking_number, carrier, service, status, timestamps). Uses service role internally but exposes nothing sensitive.
**Why:** PostgREST with anon key would require an RLS policy that exposes shipments to unauthenticated users — risky surface area. The Edge Function acts as a controlled view, returning only what the tracking page needs. If we add more tracking data later (EasyPost tracker details, delivery photo), it's one function to update.
**Watch out:** The tracking function uses service role key — never return addresses, names, emails, or financial data from it. Only expose what appears on the tracking page UI.

### [2026-03-18] Resend REST API used directly — no SDK in Deno Edge Functions
**Category:** Architecture
**Context:** Needed to send transactional emails (OTP, label confirmation, tracking) from Supabase Edge Functions (Deno runtime). The Resend npm SDK has Node.js dependencies that don't work cleanly in Deno.
**Decision/Finding:** Use the Resend REST API directly via `fetch("https://api.resend.com/emails", ...)` with Bearer token auth. Created `_shared/resend.ts` as a thin wrapper (~50 lines). No SDK, no `npm:resend` import.
**Why:** Deno's `fetch` is native and reliable. The Resend REST API is simple (one endpoint, JSON body). Avoids npm compatibility issues and keeps the function bundle small.
**Watch out:** If Resend changes their API, we only need to update `_shared/resend.ts`. The `RESEND_API_KEY` must be set as a Supabase secret — it's not in `.env.local` yet (John needs to add it).

### [2026-03-18] OTP codes hashed with SHA-256 before DB storage
**Category:** Security
**Context:** Email verification OTPs are stored in `email_verifications` table. Storing plaintext codes would allow anyone with DB access to bypass verification.
**Decision/Finding:** OTP codes are hashed with SHA-256 (`crypto.subtle.digest`) before storage. On verify, the submitted code is hashed and compared to the stored hash. Plaintext code only exists in memory during generation and in the email sent to the user.
**Why:** Defense in depth. Even if the DB is compromised (SQL injection, leaked backup, admin error), codes can't be extracted. SHA-256 is fast enough for 6-digit codes and sufficient since OTPs expire in 10 minutes.
**Watch out:** SHA-256 of a 6-digit number is technically brute-forceable (only 900,000 possibilities), but the 5-attempt limit and 10-minute expiry make this impractical. If stronger protection is needed later, add a per-row salt.

### [2026-03-18] Email Edge Function uses action-based routing, not path-based
**Category:** Architecture
**Context:** Supabase Edge Functions map one folder to one URL path (`/functions/v1/email`). We needed both "send OTP" and "confirm OTP" endpoints.
**Decision/Finding:** Single `email` function accepts `{ action: "send", email }` or `{ action: "confirm", email, code }` in the POST body. No path parsing needed.
**Why:** Simpler than creating two separate function directories (`email-send`, `email-confirm`). The function is small enough that both handlers fit in one file. Frontend calls `post("email", { action: "send", ... })` — clean and consistent.
**Watch out:** If the email function grows (e.g., adding "resend", "check-status"), consider splitting into separate functions. For now, two actions is manageable.

### [2026-03-18] Parallel feature branches merged cleanly — auth, flexible link, tests
**Category:** Architecture
**Context:** Three parallel Claude sessions built auth UI (feat/auth-ui), flexible link path (feat/flexible-link), and E2E tests simultaneously. Sender flow session (feat/sender-flow) did not produce distinct work.
**Decision/Finding:** All branches merged to main cleanly via fast-forward (auth-ui) and merge commit (flexible-link). No conflicts because each session touched different files. 110 unit tests + 12 E2E tests all pass post-merge.
**Why:** Parallel sessions work well when features are file-isolated. Auth touched App.tsx/contexts/pages, flexible link touched recipient components/hooks, tests touched tests/.
**Watch out:** Sender flow still needs to be built — SenderFlow.tsx is a placeholder. Future parallel sessions should ensure they don't modify the same files.

### [2026-03-19] Magic link login was broken — Supabase Site URL pointed to old Vercel deploy URL
**Category:** Supabase
**Context:** Clicking "Send magic link" on /login appeared to succeed (no error returned) but no email arrived. Investigating revealed: (1) Supabase Auth Site URL was set to `https://sendmo-john-andersons-projects-89a4aa08.vercel.app/` instead of `https://sendmo.co`, (2) the redirect allowlist only contained the old Vercel URLs, (3) John's account had `confirmed_at: null` / `email_confirmed_at: null` — the account existed but was never confirmed, blocking subsequent OTP sends, (4) the Supabase client had no `detectSessionInUrl: true` configuration so magic link redirects wouldn't be picked up.
**Decision/Finding:** Fixed via `supabase config push`: Site URL → `https://sendmo.co`, redirect allowlist → `sendmo.co/**` + `localhost:5173/**`. Manually confirmed John's email via SQL (`UPDATE auth.users SET email_confirmed_at = NOW()`). Added `detectSessionInUrl`, `persistSession`, `autoRefreshToken` to the Supabase client config.
**Why:** Supabase sends magic link emails using the Site URL as the base for the confirmation link. Wrong URL = link points to a non-functional domain. Unconfirmed accounts can't receive new OTPs.
**Watch out:** (1) When changing production domain, ALWAYS update Supabase Auth Site URL via `supabase config push` or the dashboard. (2) Free tier can't configure session timebox — JWT expiry stays at 1 hour, sessions rely on refresh tokens. (3) Free tier email rate limit is 4/hour — show user-friendly error when rate limited. (4) The `supabase/config.toml` now contains auth settings that get pushed to remote — don't delete them. (5) Custom SMTP is configured via Resend (`smtp.resend.com:465`, user `resend`, pass = Resend API key via `env(SMTP_PASS)`). Emails send from `noreply@sendmo.co`. The SMTP password is passed as an env var during `config push`, never committed to git.

### [2026-03-18] Auth integration — Supabase magic link with auto-profile creation
**Category:** Architecture
**Context:** Needed passwordless auth for dashboard access and future role-based admin gating.
**Decision/Finding:** AuthContext wraps the entire app, uses `supabase.auth.signInWithOtp()` for magic link emails. On first login, auto-creates a `profiles` row via `ensureProfile()`. ProtectedRoute redirects unauthenticated users to /login. Dashboard now fetches real shipment data for the authenticated user.
**Why:** Magic link is the simplest auth UX — no passwords, no OAuth setup. Auto-profile creation means no separate signup step.
**Watch out:** (1) Email redirect URL is `window.location.origin/dashboard` — must match Supabase Auth config. (2) The admin PIN gate is still in place — needs to be replaced with `profile.role === 'admin'` check. (3) Supabase Auth email templates should be customized before public launch.

### [2026-03-18] Vercel env vars must be set separately from .env.local
**Category:** Architecture
**Context:** First production deploy to sendmo.co showed a blank page, then API errors ("Unexpected token '<'"). The Vite build was running but `VITE_SUPABASE_URL` was undefined, so API calls went to relative URLs and got HTML back.
**Decision/Finding:** Vercel ignores `.env.local`. All `VITE_*` environment variables must be set in Vercel via `vercel env add` or the dashboard. After adding/changing vars, a redeploy is required (`vercel --prod`).
**Why:** Vite inlines `import.meta.env.VITE_*` at build time. If the var is missing during the Vercel build, it's baked in as `undefined`.
**Watch out:** When adding a new `VITE_*` var to `.env.local`, always also add it to Vercel. The `vercel.json` `framework: "vite"` setting ensures Vercel runs the build correctly.

### [2026-03-18] vercel.json required for SPA routing + Vite build
**Category:** Architecture
**Context:** Vercel was serving raw source files (0ms builds) and returning 404 on client-side routes like `/admin`.
**Decision/Finding:** Added `vercel.json` with `buildCommand`, `outputDirectory`, `framework: "vite"`, and SPA rewrites (`"source": "/(.*)"` → `"/index.html"`).
**Why:** Without explicit config, Vercel's framework detection wasn't picking up Vite, and client-side routes need catch-all rewrites to serve `index.html`.
**Watch out:** The GitHub token (`ghp_*`) lacks `workflow` scope — cannot push `.github/workflows/` files. If CI is needed, update the token scope on GitHub.

### [2026-03-18] Domain setup — sendmo.co is production, sendmo.com is aspirational
**Category:** Architecture
**Context:** sendmo.co is the owned domain (Cloudflare DNS). sendmo.com is not yet purchased (parked on Afternic).
**Decision/Finding:** sendmo.co is the production domain, pointing to Vercel via A record (76.76.21.21). www.sendmo.co CNAMEs to Vercel. wind.sendmo.co points to the WINDow/coyote-wind project. sendmo.com was removed from Vercel — it will be added back if/when purchased.
**Why:** Clean separation. No dangling domain configs for unowned domains.
**Watch out:** When sendmo.com is purchased, add it to Vercel and set up Cloudflare DNS (or transfer nameservers). Until then, don't reference sendmo.com in any user-facing copy or code.

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

### EasyPost Integration Gotchas

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

### Supabase / Database Gotchas

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

### Testing Gotchas

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

### Label Cancellation / Refund Gotchas

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

### Logging / Observability Gotchas

### [2026-02-25] `log()` is fire-and-forget — don't await it on the critical path
**Category:** Architecture
**Context:** Logging was being awaited, adding latency to every API response.
**Decision/Finding:** The `log()` helper in `_shared/logger.ts` should never be awaited on the critical path. Use `log({...})` without `await`.
**Why:** Log ingestion latency (DB write) should not block the user-facing response.
**Watch out:** This means log failures are silent. Add a try/catch inside `logger.ts` itself to swallow errors gracefully.

---

## Deploy Log

Every merge to `main` triggers a Vercel auto-deploy. This section tracks what shipped and when.

### [2026-04-26] — Links Manager: auth-aware /links/new + /links/:id/edit

**Branch:** `main`
**Deploy:** Vercel auto-deploy + `npx supabase functions deploy links`

**What shipped**
- `/links/new` and `/links/:id/edit` pages for authenticated users — replaces forcing repeat users through the marketing onboarding wizard (with its inappropriate OTP/payment steps).
- Auth'd users hitting `/onboarding/*` now redirect to `/links/new` (preserving `?path=full_label`).
- Edit flow on Dashboard: Pencil icon button on the link card opens `/links/:id/edit`, which prefills from the existing `sendmo_links` row and shows a dismissible "Link updated" banner on save.
- Backend `PATCH /functions/v1/links/:id` handler with status guard (active/draft only), explicit `user_id = auth_user.id` ownership check (service-role bypasses RLS, so this matters), insert-new-address-row + repoint-FK pattern (preserves shipment historical integrity), and audit log to `event_logs`.
- Extracted reusable presenter components: `AddressForm`, `FlexPreferencesForm`, `LinkShareCard`, `NotificationEmailField` — shared between `/links/new`, `/links/:id/edit`, and the legacy `/onboarding/*` wizard steps.

**What changed (files)**
- New: `src/pages/LinksNew.tsx`, `src/pages/LinksEdit.tsx`, `src/components/links/LinksEditor.tsx`, `src/components/links/LinkShareCard.tsx`, `src/components/forms/{AddressForm,FlexPreferencesForm,NotificationEmailField}.tsx`
- Modified: `supabase/functions/links/index.ts` (PATCH handler), `src/lib/api.ts` (`updateFlexLink`), `src/App.tsx` (routes + OnboardingLayout redirect), `src/pages/Dashboard.tsx` (Pencil button + banner), recipient wizard steps (refactored to use shared presenters)
- `tests/unit/App.test.tsx` — wrapped onboarding test in `waitFor` (OnboardingLayout returns null while auth resolves to avoid wizard-flash for authed users)

**Tests**
- 188 unit tests passing (17 files)
- E2E tests still red on Maps autocomplete (pre-existing, see WISHLIST CI debt)

**Breaking changes**
- None

**Notes for future agents**
- Edge Function uses service-role key (bypasses RLS) — every owner check must explicitly filter `user_id = auth_user.id`. Don't rely on RLS for ownership.
- Address mutations don't UPDATE in place — they INSERT a new `addresses` row and repoint `sendmo_links.recipient_address_id`. This preserves the historical address attached to past `shipments` rows. Same pattern should be reused for any future `addresses` mutation through user-facing flows.
- Proposal + decision record: `proposals/2026-04-26_links-manager_reviewed-2026-04-26_decided-2026-04-26.md`

---

### [2026-03-19] — Full sender flow + links pipeline + friendly error copy

**Branch:** `main`
**Commit:** `5346656`
**Deploy:** Vercel auto-deploy

**What shipped**
- Links Edge Function (GET + POST). Creates flex links with recipient preferences, retrieves by short code. Handles expired/used/cancelled statuses.
- Preference-aware rate filtering. Rates Edge Function filters by carrier, speed tier (preferred or faster), and price cap from link preferences.
- Full sender wizard. 4-step flow at `/s/:shortCode`: address → package → rates → done. Fetches link, shows preferences banner, uses SmartAddressInput + Magic Guestimator.
- RecipientStepLinkReady now persists flex links to DB on mount via `createFlexLink()` API call.
- Friendly error copy. "Hmm, that link didn't work", "Rates are playing hide and seek", "No options for this one", "One and done!" etc.
- "prepaid by [name]" shows on rate cards and shipment summary.
- "Your label is ready!" Done step with label placeholder (pending Stripe integration).
- SmartAddressInput name label fix. Now configurable via `nameLabel`/`nameHint` props. Sender side shows "Sender's Name" instead of "Recipient Name".
- SenderPreview page. `/sender-preview` with 7 interactive scenarios for testing all sender states.

**What changed (files)**
- `supabase/functions/links/index.ts` — new Edge Function
- `supabase/functions/rates/index.ts` — added preference filtering (carrier, speed, price cap)
- `src/lib/api.ts` — added `createFlexLink()`, `fetchLink()`, `fetchSenderRates()`, `LinkData` type
- `src/pages/SenderFlow.tsx` — full sender wizard (was stub)
- `src/pages/SenderPreview.tsx` — new preview/mockup page
- `src/components/recipient/RecipientStepLinkReady.tsx` — now persists to DB
- `src/components/ui/SmartAddressInput.tsx` — configurable name label
- `src/App.tsx` — added SenderPreview route

**Tests**
- 188 unit tests passing (17 files)
- 14 E2E tests passing

**Breaking changes**
- None

**Notes for future agents**
- Links Edge Function is NOT yet deployed to Supabase — run `npx supabase functions deploy links` and `npx supabase functions deploy rates`
- Done step has a label placeholder — actual label generation requires Stripe payment integration (see WISHLIST.md)
- SenderPreview.tsx is a dev tool — remove or gate behind admin before launch

---

### [2026-03-19] — UI polish: persistent header, flow badge, path choice redesign, dashboard identity

**Branch:** `feat/ui-polish` (merged to `main`)
**Commit:** `4644a33`
**Deploy:** Vercel auto-deploy

**What shipped**
- Shared AppHeader component. Persistent nav header across all pages (auth-aware, logo links home). Replaces per-page inline navs.
- Flow indicator badge. Pill below header during onboarding shows "Full Prepaid Label" or "Flexible Shipping Link" once a path is chosen
- Dashboard identity. Replaced "Dashboard" heading with avatar circle (first letter of email) + email + tagline. Compact sign-out icon button.
- Path choice redesign. RecipientStepPathChoice now has illustrated cards with gradient hero bands, 3-icon scenes, feature bullet points, and descriptive copy
- Name field label. SmartAddressInput name field now reads "Recipient Name (probably your name!)"
- NotFound page. "Lost in transit" headline with Package icon, Go home + Go back buttons
- SenderFlow placeholder. Added AppHeader to sender checkout placeholder
- Index page. Replaced inline nav with AppHeader, fixed footer email to support@sendmo.co

**What changed (files)**
- `src/components/AppHeader.tsx` — **new**: shared persistent header with `actions` prop override
- `src/components/recipient/RecipientStepPathChoice.tsx` — rewritten with illustrated cards
- `src/components/ui/SmartAddressInput.tsx` — updated name field label
- `src/pages/Dashboard.tsx` — avatar identity section, compact sign-out
- `src/pages/Index.tsx` — uses AppHeader, fixed footer email
- `src/pages/NotFound.tsx` — rewritten with AppHeader + "Lost in transit"
- `src/pages/RecipientOnboarding.tsx` — added AppHeader + flow badge pill
- `src/pages/SenderFlow.tsx` — added AppHeader
- `src/pages/TrackingPage.tsx` — uses AppHeader with breadcrumb action
- `tests/unit/App.test.tsx` — updated 2 assertions to match new copy

**Tests**
- 0 new tests, 2 test assertions updated
- 188 total unit tests passing

**Breaking changes**
- None (frontend-only, no API or DB changes)

**Notes**
- AppHeader `actions` prop completely replaces the right slot — pass `undefined` (or omit) for default auth-aware buttons
- Flow badge reads `data.path` from RecipientFlowContext — no new props needed
- Path choice illustrations use only Tailwind + Lucide icons (no external image assets)
- Page title in browser tab still shows "temp-app" — may want to fix in index.html

---

### [2026-03-19] — User-facing label void, live tracking, dashboard enhancements

**Branch:** direct to `main` (3 commits)
**Commits:** `0358c11`, `cb49ec9`, `de24fe8`
**Deploy:** Vercel auto-deploy + Supabase Edge Functions (`cancel-label`, `tracking`)

**What shipped**
- Dashboard enhancements: sender name column, status with dates ("Shipped on Mar 18"), clickable tracking links to `/track/:number`
- Live tracking from EasyPost: tracking page + function fetch real-time status, events, and ETA from EasyPost tracker API. 30-min TTL cache (terminal statuses never re-fetched). Auto-syncs DB when status changes.
- User-facing label void: "Void Label" button on eligible shipments in dashboard. CancelLabelModal with confirmation, loading, success/error states. Server-side JWT auth + ownership check on cancel-label function. Refund status badges (pending/refunded/rejected).
- Refund service stub: `src/lib/refundService.ts` — interface for future Stripe refund integration
- Resend domain verified: `noreply@sendmo.co` confirmed as sending address, RESEND_API_KEY set as Supabase secret
- DB fix: reassigned all sendmo_links from system user to John's real account

**What changed (files)**
- `src/pages/Dashboard.tsx` — sender name, status dates, tracking links, void button + modal, refund badges
- `src/pages/TrackingPage.tsx` — live EasyPost events timeline, estimated delivery, TTL cache
- `src/components/CancelLabelModal.tsx` — added optional `accessToken` prop for authenticated calls
- `src/lib/refundService.ts` — new stub for Stripe refund integration
- `supabase/functions/tracking/index.ts` — live EasyPost fetch, 30-min TTL, DB sync
- `supabase/functions/cancel-label/index.ts` — JWT auth + ownership via sendmo_links join
- `WISHLIST.md` — added EasyPost webhooks, event caching, payment ledger, Stripe refund, payment history

**Tests**
- No new unit tests this deploy (UI-heavy changes)
- 145 total unit tests still passing

**Breaking changes**
- `cancel-label` now verifies JWT ownership for authenticated callers (admin anon-key path preserved)

**Notes**
- EasyPost webhooks still not registered — tracking relies on TTL-cached polling for now (WISHLIST item)
- Refund service is a stub — needs Stripe integration + transaction ledger before going live
- Label void only shows for live labels with status=label_created and refund_status=none
- All eligibility checks enforced server-side — client-side is UX only

---

### [2026-03-19] — URL-based step routing for recipient onboarding

**Branch:** `feat/url-step-routing`
**Commit:** `4fbc307`
**Deploy:** Vercel auto-deploy

**What shipped**
- Onboarding steps now have real URLs: `/onboarding/address`, `/onboarding/shipping`, `/onboarding/payment`, `/onboarding/label` (full label) and `/onboarding/preferences`, `/onboarding/verify`, `/onboarding/authorize`, `/onboarding/link-ready` (flex)
- Browser back/forward buttons work naturally through the flow
- Step guards: direct URL access blocked if prior steps not completed (redirects to first incomplete step)
- Cross-path slug rejection: flex slugs rejected when full_label path is active (and vice versa)
- Flow state lifted to React Context — persists across URL changes
- Direction-aware animation (forward vs backward slide)

**What changed (files)**
- `src/lib/stepRouting.ts` — new: slug↔step mappings, step ordering, guard logic, progress bar mapping
- `src/contexts/RecipientFlowContext.tsx` — new: flow state context with navigate()-based transitions
- `src/pages/RecipientOnboarding.tsx` — rewritten as layout reading step from URL
- `src/App.tsx` — nested routes with shared OnboardingLayout provider
- `tests/unit/stepRouting.test.ts` — 27 new tests
- `tests/unit/recipientFlowContext.test.tsx` — 11 new tests
- `tests/e2e/url-step-routing.spec.ts` — 10 new tests

**Tests**
- 38 new unit tests (stepRouting + RecipientFlowContext), 188 total passing
- 10 new E2E tests (URL changes, browser back, step guards, cross-path rejection), 31 total E2E passing

**Breaking changes**
- Onboarding URLs changed from `/onboarding` (single page) to `/onboarding/:step` (URL per step). No external links to old step URLs existed, so no user impact.

**Notes**
- Step components required zero changes — context exposes backward-compatible `state: RecipientFlowState`
- Steps 11→12 (payment→label ready) happen within the same `RecipientStepPayment` component, so URL stays at `/payment`
- `useRecipientFlow` hook still exists for its tests but the context wraps similar logic
- Sender flow (`SenderFlow.tsx`) is still a placeholder — URL routing for it will be added when sender flow is built

---

### [2026-03-19] — Shipping notifications for sender + recipient, tracking page

**Branch:** `feat/shipping-notifications`
**Commit:** `22b35a9`
**Deploy:** Vercel auto-deploy

**What shipped**
- Both sender AND recipient get notified on in_transit, out_for_delivery, delivered
- Role-aware email templates ("Your package..." vs "The package you sent...")
- Estimated delivery date and carrier info in tracking emails
- "Track Package" button in emails linking to public tracking page
- Public tracking page at `/track/:trackingNumber` with status timeline
- Notification dispatcher architecture (email now, SMS/push extensible later)
- `notification_contacts` table — who to notify about each shipment
- `notifications_log` table — audit trail with idempotency (no duplicate sends)
- Tracking Edge Function — lightweight read-only endpoint, no auth required
- Labels function stores sender + recipient emails as notification contacts

**What changed (files)**
- `supabase/migrations/011_notification_contacts.sql` — 2 new tables + indexes
- `supabase/functions/_shared/notifications.ts` — notification dispatcher
- `supabase/functions/_shared/email-templates.ts` — role-aware tracking emails with ETA + tracking link
- `supabase/functions/_shared/cors.ts` — added GET method
- `supabase/functions/webhooks/index.ts` — uses dispatcher instead of direct email
- `supabase/functions/labels/index.ts` — stores notification contacts, accepts sender_email
- `supabase/functions/tracking/index.ts` — new public tracking endpoint
- `src/pages/TrackingPage.tsx` — new tracking page
- `src/App.tsx` — added `/track/:trackingNumber` route
- `tests/unit/emailTemplates.test.ts` — updated (13 tests, role + ETA + tracking link)
- `tests/unit/notifications.test.ts` — new (9 tests, dispatch logic + idempotency)

**Tests**
- 14 new/updated tests (9 notification + 5 email template)
- 145 total unit tests passing (up from 131)
- E2E: no new coverage this deploy

**Breaking changes**
- `trackingUpdateEmail()` signature changed — now accepts optional carrier, ETA, trackingUrl, role params (backwards compatible, all optional)

**Notes**
- Migration 011 must be pushed: `npx supabase db push`
- Deploy new Edge Functions: `npx supabase functions deploy tracking webhooks`
- `sender_email` param is optional in labels function — comp labels may not have it
- SMS/push channels are stubbed in the dispatcher — add handlers when ready
- Tracking page fetches from Edge Function, not direct DB (keeps RLS clean)

---

### [2026-03-19] — Fix magic link login + custom SMTP via Resend

**Branch:** `feat/fix-auth-login`
**Commit:** `f7d503b`
**Deploy:** Vercel auto-deploy

**What shipped**
- Magic link login now works — Supabase Site URL corrected from old Vercel deploy URL to `sendmo.co`
- Emails send from `SendMo <noreply@sendmo.co>` via Resend SMTP (was `supabase auth`)
- Landing page nav shows Dashboard + sign out when logged in (was always "Sign In")
- "Sign In" button links to `/login` directly (was `/dashboard` → redirect)
- User-friendly error for rate limiting, spam folder hint on success screen
- Supabase client configured with `detectSessionInUrl`, `persistSession`, `autoRefreshToken`
- John's account confirmed via SQL (was stuck with `email_confirmed_at: null`)

**What changed (files)**
- `src/lib/supabase.ts` — auth config options
- `src/pages/Index.tsx` — conditional nav (signed in vs anonymous)
- `src/pages/Login.tsx` — better error messages, resend link
- `supabase/config.toml` — auth site_url, redirect allowlist, SMTP config
- `tests/unit/auth.test.tsx` — 5 new tests
- `DECISIONS.md` — auth debugging findings
- `WISHLIST.md` — marked magic link bug as fixed

**Tests**
- 5 new auth unit tests, 136 total passing

**Breaking changes**
- None

**Notes**
- Free tier can't change JWT expiry (1hr) — sessions persist via refresh tokens (`autoRefreshToken: true`)
- SMTP password passed as `env(SMTP_PASS)` during `supabase config push` — never in git
- To re-push SMTP config: `SMTP_PASS=re_xxx npx supabase config push --project-ref fkxykvzsqdjzhurntgah`
- Free tier email rate limit: 4/hour (now shows friendly error instead of raw Supabase message)

---

### [2026-03-18] — Email notifications via Resend (OTP, label confirmation, tracking)

**Branch:** `feat/email-notifications`
**Commit:** `6a1b169`
**Deploy:** Vercel auto-deploy + Supabase Edge Functions

**What shipped**
- OTP email verification for Flexible Link path (6-digit code, SHA-256 hashed, 10-min expiry)
- Label confirmation email sent after successful purchase (fire-and-forget)
- Tracking update email on EasyPost webhook status changes (in_transit, out_for_delivery, delivered)
- Rate limiting: 3 sends per email per 10 min, 5 verification attempts per code
- Branded HTML email templates (SendMo blue header, white body, gray footer)
- RecipientStepEmailVerify wired to real API calls (replaces stubbed setTimeout)

**What changed (files)**
- `supabase/functions/email/index.ts` — new Edge Function (send OTP + confirm OTP)
- `supabase/functions/webhooks/index.ts` — new EasyPost webhook handler with tracking emails
- `supabase/functions/_shared/email-templates.ts` — 3 branded HTML templates
- `supabase/functions/_shared/resend.ts` — Resend REST API client for Deno
- `supabase/functions/labels/index.ts` — added label confirmation email (fire-and-forget)
- `supabase/migrations/010_email_verifications.sql` — email_verifications table
- `src/components/recipient/RecipientStepEmailVerify.tsx` — wired to real sendOTP/confirmOTP
- `src/lib/api.ts` — added sendOTP(), confirmOTP()
- `tests/unit/emailTemplates.test.ts` — 8 template tests
- `tests/unit/otpLogic.test.ts` — 13 OTP logic tests

**Tests**
- 21 new unit tests (email templates + OTP logic), 131 total passing

**Breaking changes**
- None

**Notes**
- RESEND_API_KEY set as Supabase secret, sendmo.co domain verified in Resend
- All email sends are fire-and-forget — never block user-facing responses
- No PII logged in event_logs (email addresses excluded per policy)

---

### [2026-03-18] — Auth, Flexible Link path, E2E tests

**Branch:** `feat/flexible-link` (merged), plus auth and test commits
**Commit:** `f65bfc2`
**Deploy:** Vercel auto-deploy

**What shipped**
- Supabase Auth with magic link (passwordless) login
- Protected routes — `/onboarding`, `/dashboard` require auth
- Flexible Link recipient path (Steps 20-23): preferences, email verify, payment auth, link ready
- Comprehensive Playwright E2E test suite
- Updated CLAUDE.md with auth, flexible link, and test status

**What changed (files)**
- `src/pages/RecipientOnboarding.tsx` — added flex link steps 20-23
- `src/components/recipient/RecipientStepFlex*.tsx` — 4 new step components
- `src/hooks/useRecipientFlow.ts` — flex link state + step navigation
- `src/lib/api.ts` — added `sendOTP()`, `confirmOTP()`
- `tests/e2e/` — new Playwright suite
- Auth provider, login page, route guards

**Tests**
- 157 unit tests passing
- New E2E test suite (Playwright)

**Breaking changes**
- Routes now require auth (except landing, FAQ, `/s/:shortCode`)

**Notes**
- Admin PIN still hardcoded (`2026`) — replace with `profile.role === 'admin'` before launch
- Stripe still stubbed — real integration blocked on auth completion

---

### [2026-03-17] — Vercel production deploy + domain setup

**Branch:** direct to `main`
**Commit:** `26a277b`
**Deploy:** Vercel auto-deploy + manual domain config

**What shipped**
- sendmo.co live on Vercel (A record → 76.76.21.21)
- www.sendmo.co CNAME redirect
- wind.sendmo.co pointing to coyote-wind project
- SPA rewrites in `vercel.json` for client-side routing
- EasyPost live key set as Supabase secrets
- Comp label ledger — migration 009 adds `payment_method` column

**What changed (files)**
- `vercel.json` — SPA rewrites, build config
- `supabase/migrations/009_*.sql` — payment_method column
- `CLAUDE.md` — production URL, env var docs, Vercel deployment section

**Tests**
- No new tests this deploy

**Breaking changes**
- None

**Notes**
- Vercel does NOT read `.env.local` — all `VITE_*` vars must be in Vercel dashboard
- After changing env vars, must redeploy with `vercel --prod`

---

### [2026-03-16] — Full Prepaid Label flow + admin mode

**Branch:** direct to `main`
**Commit:** `ba8c354`
**Deploy:** Vercel auto-deploy

**What shipped**
- Recipient onboarding flow (Full Prepaid Label path): Steps 0→1→10→11→12
- Admin page with PIN gate, reporting, label void
- Admin test/live toggle on `/onboarding`
- Magic Guestimator (15 item types + urgency keywords)
- Dashboard with shipment history (mock data)
- Landing page (hero, how it works, value props, use cases, CTA, footer)
- 30+ EasyPost service name mappings
- All backend Edge Functions deployed (addresses, rates, labels, cancel-label, admin-report, autocomplete, place-details, ingest, test-db-insert)
- Database schema: 8 migrations applied on remote Supabase

**What changed (files)**
- `src/pages/` — RecipientOnboarding, Dashboard, Index, Admin, FAQ
- `src/components/recipient/` — all step components, ProgressBar, MagicGuestimator, ShippingMethodCard
- `src/hooks/useRecipientFlow.ts` — state management
- `src/lib/api.ts` — verifyAddress, fetchRates, buyLabel, pricing helpers
- `src/lib/utils.ts` — carrier/service display, speed tier classification
- `supabase/functions/` — 9 Edge Functions
- `supabase/migrations/` — 001-008

**Tests**
- 131 unit tests passing
- LabelTest page for manual backend testing

**Breaking changes**
- First real deploy — no prior production state

**Notes**
- Stripe payment stubbed (shows success without real charge)
- EasyPost test mode by default; live mode via admin toggle only

---

### [2026-03-14] — Initial setup

**Branch:** direct to `main`
**Commit:** `a2b96d4`
**Deploy:** Initial Vercel deploy

**What shipped**
- React + Vite + TypeScript + Tailwind + shadcn/ui scaffold
- EasyPost Edge Functions (addresses, rates)
- LabelTest page for development
- CI pipeline (lint, typecheck, test)
- PRD.md, CLAUDE.md, DECISIONS.md

**What changed (files)**
- Everything (initial commit)

**Tests**
- Basic test framework setup

**Breaking changes**
- N/A (first deploy)

---

*Last updated: 2026-03-30*
