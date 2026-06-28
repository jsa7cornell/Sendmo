---
title: SendMo public tracking code — decouple `/track` URL from carrier number
slug: sendmo-public-tracking-code
project: sendmo
status: decided
created: 2026-05-11
last_updated: 2026-05-11 19:05
reviewed: 2026-05-11
decided: 2026-05-11
author: Claude session that just shipped delivery-performance badge + verify_jwt fix (PR #31, #32)
reviewer: Fresh-eyes Claude session — verified against tracking/labels/webhooks edge fns, migration 008 + 012, Dashboard, App routing
outcome: approved
---

## 1. Context

Today the public tracking URL is `https://sendmo.co/track/<carrier_tracking_number>`. The slug **is** the third-party identifier — there is no SendMo-minted tracking code. The route handler does an exact-match lookup on `shipments.tracking_number`.

John has flagged this as critical to decouple. Three concrete risks:

1. **Collision risk (the load-bearing concern).** Carrier tracking numbers are unique *within a carrier* but not guaranteed unique across the SendMo `shipments` table:
   - **EasyPost test-mode tracking numbers are deterministic and reused.** A `Tracker` created in test mode for USPS GroundAdvantage may produce the same `tracking_code` every time (EasyPost docs explicitly call out a small set of fixture trackers per service). Two test shipments will share `tracking_number`, and our current lookup uses `.single()` ([tracking/index.ts:50-55](supabase/functions/tracking/index.ts)) — which **returns 0 rows when more than one row matches**. The page 404s even though both shipments exist.
   - **Live-mode cross-carrier overlap is unlikely but unbounded.** USPS 22-digit codes and UPS `1Z...` codes don't visually collide, but the column is `TEXT` with no carrier constraint. Any code path that ever inserts a non-canonical tracking number (placeholder, manual admin entry, future carrier addition) can produce a duplicate.
   - **Void + reissue.** If a label is voided and a new one purchased for the same shipment, the new row gets a new tracking number — the old URL still resolves to the *old* row showing the (now-cancelled) status. URL stability is broken even without a literal collision.

2. **No SendMo identity in the URL.** Every public tracking link advertises the carrier before SendMo. The URL slug is not brandable, not memorable, and not shareable — it's a 22-digit number a user can't repeat back over the phone.

3. **No URL before label purchase.** The current architecture *requires* a carrier tracking number to exist before there's any URL at all. That forecloses future product surfaces: a tracking page for the period between Stripe charge and label purchase, an immediate post-checkout URL the recipient can save, a stable URL across label reissues.

A SendMo-minted public code resolves all three, and the pattern already exists in the codebase: `sendmo.co/s/<short_code>` for flexible links ([Dashboard.tsx:179](src/pages/Dashboard.tsx) uses `sendmo.co/s/${link.short_code}`). We're following the established convention, not inventing one.

## 2. Architecture

**New column:** `shipments.public_code TEXT UNIQUE NOT NULL` — short, opaque, base32 Crockford, generated server-side at insert.

**New canonical URL:** `sendmo.co/t/<public_code>` (e.g. `sendmo.co/t/H7K2P9`).

**Legacy URL preserved:** `sendmo.co/track/<tracking_number>` stays alive as a **301 redirect** to the canonical `/t/<code>` URL. Every tracking-update email sent over the past month is now in someone's inbox; we can't break those links.

**Lookup function** ([tracking/index.ts](supabase/functions/tracking/index.ts)) accepts either:
- `GET /functions/v1/tracking?code=H7K2P9` (new canonical)
- `GET /functions/v1/tracking?number=<carrier>` (legacy alias — returns same payload, also includes a `public_code` field so the redirect handler can build the canonical URL)

**Code format — Crockford base32, 7 characters.** Alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 chars, excludes I/L/O/U to dodge ambiguity with 1/0 and obscenities). 7 chars = 32^7 ≈ 34 billion possible codes; at SendMo's expected scale (<1M shipments lifetime in v1) the birthday-collision probability is ~1 in 70,000 even at 1M rows. Retry-on-collision in the insert RPC handles the rest. 6 chars (~10^9) feels too tight if we ever do scale; 8 looks indistinguishable from 7 to a user but consumes 32× more space. **7 is the sweet spot.**

**Why not match the 10-char `short_code` pattern from `sendmo_links`?** Different surface, different audience. Flexible-link short codes are shared with senders and shown in dashboards; 10 chars is fine there. Tracking codes go in email subject lines, get repeated over phone, get printed alongside the carrier number on receipts. 7 is right for read-aloud, 10 is not.

**Generation:** done in `admin_insert_shipment` RPC (mirrors the existing `sendmo_links.short_code` generation pattern in migration 008). Retry loop with 5 attempts before raising.

**Backfill:** existing rows (currently ~10s of shipments) get codes generated in the migration itself. Backfill is the same generation function, applied row-by-row. Safe to ship in the migration since the production table is tiny.

## 3. File-by-file plan

### Database

**`supabase/migrations/014_shipments_public_code.sql`** (new)

```sql
-- Adds shipments.public_code (7-char Crockford base32, unique, non-null going forward).
-- Backfills existing rows. Updates admin_insert_shipment RPC to mint codes.

-- 3a. Add column, nullable for now (so backfill can run)
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS public_code TEXT;

-- 3b. Crockford base32 generator (excludes I L O U)
CREATE OR REPLACE FUNCTION public._gen_crockford_base32(p_length INTEGER)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_alphabet TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    v_out TEXT := '';
    v_i INTEGER;
BEGIN
    FOR v_i IN 1..p_length LOOP
        v_out := v_out || substr(v_alphabet, (floor(random() * 32) + 1)::INTEGER, 1);
    END LOOP;
    RETURN v_out;
END;
$$;

-- 3c. Backfill existing rows with retry on collision
DO $$
DECLARE
    r RECORD;
    v_code TEXT;
    v_attempt INTEGER;
BEGIN
    FOR r IN SELECT id FROM public.shipments WHERE public_code IS NULL LOOP
        v_attempt := 0;
        LOOP
            v_code := public._gen_crockford_base32(7);
            BEGIN
                UPDATE public.shipments SET public_code = v_code WHERE id = r.id;
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                v_attempt := v_attempt + 1;
                IF v_attempt >= 5 THEN
                    RAISE EXCEPTION 'Could not generate unique public_code for shipment %', r.id;
                END IF;
            END;
        END LOOP;
    END LOOP;
END $$;

-- 3d. NOT NULL + UNIQUE after backfill
ALTER TABLE public.shipments
  ALTER COLUMN public_code SET NOT NULL,
  ADD CONSTRAINT shipments_public_code_unique UNIQUE (public_code);

CREATE INDEX IF NOT EXISTS idx_shipments_public_code ON public.shipments (public_code);

-- 3e. Update admin_insert_shipment to mint codes
-- (Full body matches migration 012 but adds the public_code generation loop
-- before the shipment INSERT, and writes public_code in the INSERT.)
```

The full `CREATE OR REPLACE FUNCTION admin_insert_shipment` body will replicate migration 012's signature exactly (so callers don't break), with the public_code generation loop added internally — caller doesn't need to provide it.

### Edge Functions

**`supabase/functions/tracking/index.ts`** — modified.

- Accept either `?code=` or `?number=` query param. If both, prefer `code`.
- Lookup `.eq("public_code", code)` or `.eq("tracking_number", number)` accordingly.
- Response payload gains `public_code` field always.
- Legacy lookup still returns 200 (no breaking change for any external integration).

```ts
const code = url.searchParams.get("code");
const number = url.searchParams.get("number");
if (!code && !number) return badRequest("code or number required");

const query = supabase.from("shipments").select("...new field list including public_code...");
const lookup = code
  ? query.eq("public_code", code)
  : query.eq("tracking_number", number);
const { data: shipment, error } = await lookup.limit(1).single();
```

**`supabase/functions/labels/index.ts`** — no change required. `admin_insert_shipment` mints the code internally.

**`supabase/functions/_shared/notifications.ts` + `email-templates.ts`** — modified.

- `NotificationContext` gains `public_code: string`.
- `trackingUpdateEmail()` builds the Track Package button URL from `public_code`, not `tracking_number`. URL becomes `https://sendmo.co/t/<public_code>`.
- Both call sites (`webhooks/index.ts:151`, `tracking/index.ts:120`) pass `shipment.public_code` when dispatching.

**`supabase/functions/labels/index.ts` label-confirmation email** — also rebuilt to point at `/t/<code>`. The function already does a fire-and-forget `sendEmail()` call with `labelConfirmationEmail()` ([labels/index.ts:489-498](supabase/functions/labels/index.ts)). Pass the new public_code through; template gains a "Track Package" button.

### Frontend

**`src/App.tsx`** — add route `<Route path="/t/:code" element={<TrackingPage />} />`. Keep `<Route path="/track/:trackingNumber" element={<LegacyTrackingRedirect />} />`.

**`src/pages/LegacyTrackingRedirect.tsx`** (new) — minimal component that:
1. Pulls `:trackingNumber` from URL.
2. Calls tracking function with `?number=<n>`.
3. Reads `public_code` from response.
4. `navigate(`/t/${public_code}`, { replace: true })` — single-render redirect.
5. Falls back to rendering the existing TrackingPage on the legacy URL if the lookup fails (graceful degradation — old emails still work even on rows with no public_code, though there shouldn't be any after backfill).

**`src/pages/TrackingPage.tsx`** — modified.

- Param hook changes from `useParams<{ trackingNumber }>()` to `useParams<{ code }>()`.
- Fetch URL uses `?code=`.
- Display **both** the SendMo public code (prominent — the "your tracking number" surface) and the carrier tracking number (smaller, labeled as "USPS tracking" with the existing carrier deep link).

**`src/pages/Dashboard.tsx`** — modified.

- Shipments table tracking-cell link target changes from `/track/${s.tracking_number}` to `/t/${s.public_code}`.
- Mobile card same change.
- `DashboardShipment` type gains `public_code: string`.
- Select adds `public_code` to the column list.

## 4. Test plan

### Migration
- Apply migration 014 against a fresh DB clone; verify every existing row has a non-null unique `public_code`.
- Run `admin_insert_shipment` directly with the same params labels.ts passes; verify the returned shipment has a `public_code`.

### Tracking function
- `curl ...?code=H7K2P9` returns shipment payload including `public_code`.
- `curl ...?number=<carrier>` returns same payload (legacy alias).
- `curl ...?code=BADCODE` returns 404 with `error: "Tracking code not found"`.

### Frontend
- Visit `/t/H7K2P9` → tracking page renders.
- Visit `/track/<old carrier number>` → 301-equivalent client redirect to `/t/<code>`, address bar updates.
- Visit `/track/UNKNOWN` → existing "Tracking number not found" error page (unchanged).

### Email
- Trigger a new label purchase end-to-end; verify the label-confirmation email's "Track Package" button URL is `https://sendmo.co/t/<code>`.
- Trigger a tracking-update notification (force-poll on an in-flight shipment); verify the email URL is `/t/<code>`.

### Collision smoke test
- Use EasyPost test-mode to create two shipments that produce the same `tracking_number`. Verify both rows have *different* `public_code`s and both `/t/...` URLs resolve correctly. (This is the load-bearing test — the whole proposal exists to fix this case.)

## 5. Out of scope

- **Custom user-chosen codes** (vanity URLs). Not now.
- **Code recycling on label void.** If a label is voided, the row's `public_code` stays bound to that row forever. Voiding doesn't generate a new code.
- **QR codes / sharing UI.** The tracking page could grow a "Share this link" affordance, but that's a follow-on, not part of this proposal.
- **Removing the legacy `/track/<carrier>` route.** Keeping it indefinitely as a redirect costs almost nothing and protects every email already in someone's inbox.
- **Public-facing rate limiting on the lookup endpoint.** Current lookup is unauthenticated and uncapped; that's a separate concern that applies equally to old + new URLs.
- **Migrating `sendmo_links.short_code` to the same generator.** Out of scope; that surface already works.

## 6. Verification (end-to-end after implementation)

1. Apply migration 014 to a staging clone; confirm `select count(*) from shipments where public_code is null` returns 0.
2. Deploy the modified `tracking`, `labels`, `webhooks` Edge Functions.
3. Deploy frontend.
4. Create a new label in live mode via the normal Full Label flow.
5. Confirm the label-confirmation email's tracking button points at `/t/<code>`.
6. Visit `/t/<code>` — tracking page renders, both the SendMo code (prominent) and the carrier number (with "View on USPS site ↗" deep link) are visible.
7. Visit the legacy `/track/<carrier_number>` URL — page redirects to `/t/<code>`, content matches.
8. Force a status update (test webhook or live poll) and verify the tracking-update email URL is `/t/<code>`.
9. Smoke-test collision: create two EasyPost test shipments that share a tracking_number; verify both have distinct codes and both URLs resolve.

## 7. Open questions for the reviewer

1. **Code length.** I chose 7 chars Crockford base32 (~34 billion codes) reasoning that it balances read-aloud-ability against collision headroom. Is there a reason to go shorter (6, ~10^9 — still ample) or longer (8, ~10^12 — feels like overkill)? Aesthetic argument welcome.

2. **Should the legacy `/track/<number>` route 301-redirect or quietly serve the same content under both URLs?** Redirecting is the right long-term answer (one canonical URL, better for analytics + brand) but adds a brief flash for users clicking old email links. Acceptable tradeoff?

3. **Where else should the SendMo public code surface in the product?** I have it on the tracking page itself and as the URL slug. Should it also appear on the Dashboard shipments table (currently shows the carrier number truncated)? On the label-confirmation email body itself, not just the button URL? Sender's reading the code aloud over the phone is the use case I'm sizing for.

4. **Collision-test rigor.** EasyPost test-mode fixtures are deterministic, but I haven't actually verified the specific case where two shipments share a `tracking_number`. Should we add a dedicated unit/integration test that constructs this case explicitly, or is the existing test-mode behavior enough to trust?

## Reconciliation with prior decided proposals

Scanned `~/AI-Brain/sendmo/proposals/`:
- **`2026-04-26_links-manager_decided`** — scoped to `/links/new` + `/links/:id/edit` and component refactors. No overlap with shipment tracking URLs.
- **`2026-04-26_stripe-integration-plan`** — Stripe + ledger + reconciliation. No overlap.

No prior proposal addresses the tracking URL or shipment public-code surface. This is greenfield.

## Review

> **reviewer:** Fresh-eyes Claude session (no prior context on this proposal; verified against tracking/labels/webhooks edge functions, migration 008 + 012, Dashboard.tsx, App.tsx)
> **reviewed_at:** 2026-05-11 18:40
> **verdict:** approve-with-changes

### Summary

The product direction is right and the proposal is solid on the high-leverage parts (URL shape, code surface as a brand affordance, legacy redirect). The architectural choice to mirror the existing `sendmo_links.short_code` pattern is the right call — it's the established convention. However, three concrete things need to land before this is ready to ship: (a) the `.single()` failure-mode description is technically wrong in a way that changes which test you'd write, (b) the label-confirmation email today fires *outside* and *in parallel with* the `admin_insert_shipment` RPC and never sees the returned shipment row, so "pass the new public_code through" is not a one-liner — it requires re-sequencing the email send or having the RPC return the code, and (c) the webhook handler (which the proposal doesn't mention) does its own `eq("tracking_number", …)` lookup and inherits the exact collision problem the proposal is trying to fix.

### Blocking issues

**1. The label-confirmation email send is not synchronized with the RPC that mints the public_code.**
- **Location:** `supabase/functions/labels/index.ts:297-485` (fire-and-forget `.rpc('admin_insert_shipment')`) vs. `:487-523` (top-level `labelConfirmationEmail()` send).
- **Issue:** The proposal says "Pass the new public_code through; template gains a Track Package button." But the email send at line 488 runs at the top level after the RPC call is dispatched fire-and-forget — it does not await the RPC, has no reference to the returned shipment row, and the RPC currently returns only a UUID (`v_shipment_id`), not the generated short code. With the proposal as written, the email would have to either (i) re-query `shipments.public_code` after the RPC completes — adding a round-trip and now coupling email send to DB persist success, or (ii) have the RPC return both id + public_code (changing the signature again, and re-touching every caller), or (iii) generate the public_code in the Edge Function before calling the RPC and pass it in (different architecture from what the proposal describes).
- **Suggested fix:** Pick one explicitly and write it into Section 3. The cleanest option is to change `admin_insert_shipment` to `RETURNS record (id UUID, public_code TEXT)` (or a composite type), and route the email send into the `.then()` callback at line 329-481 where the RPC result is already in scope. That also fixes a latent issue: today the email goes out even when DB persist fails — a confirmation email with a tracking number that doesn't exist in our DB.

**2. The collision claim mis-describes `.single()` behavior — the actual failure mode is worse than a 404.**
- **Location:** Proposal §1 first bullet; `supabase/functions/tracking/index.ts:50-55`.
- **Issue:** The proposal says "our current lookup uses `.single()` ... which returns 0 rows when more than one row matches. The page 404s." That's not what `.limit(1).single()` does. `.limit(1)` caps the result set to 1 row server-side, so `.single()` succeeds and returns *one* of the matching rows — Postgres-arbitrary which one (no ORDER BY). On EasyPost test-mode collision, the page will render the *wrong* shipment to the wrong user (or in test/live mix-up: a live shipment's status to someone with the test row in mind). This is a privacy/correctness issue, not a 404. The proposal's collision fix is still right; just describing it as "404s on duplicates" understates the severity. Worth restating in §1 so John knows what's actually at stake.
- **Suggested fix:** Reword §1 bullet 1 to "returns an arbitrary one of the matching rows" and lift the severity framing accordingly. Also: drop `.limit(1)` from the new `?code=` lookup since `public_code` is UNIQUE — `.single()` alone is correct there and gives you a real PGRST116 error if anything is wrong.

**3. The webhook handler inherits the collision bug — proposal doesn't address it.**
- **Location:** `supabase/functions/webhooks/index.ts:83-84` (`select(...).eq("tracking_number", trackingCode)`) and `:152-155` (builds `tracking_url` from carrier number).
- **Issue:** EasyPost's `tracker.updated` webhook only carries the carrier tracking number, so the webhook will always lookup by `tracking_number`. After collision, the webhook updates the wrong shipment's status and dispatches notifications to the wrong contacts. The proposal mentions changing `webhooks/index.ts:151` to pass `shipment.public_code` in the notification context, but doesn't acknowledge that the *lookup itself* is the collision vector. With public_code as our identity, webhook behavior on collision needs an explicit decision: (a) if more than one row matches `tracking_number`, log + bail (safest for now, given test-mode collisions are the only realistic case), or (b) update *all* matching rows (probably wrong for cross-mode collisions). The current single-row "first match wins" is the worst of both.
- **Suggested fix:** Add a §3 bullet for `webhooks/index.ts`: when the lookup matches >1 row, log `webhook.tracking_collision` and skip the update. Use `.select(...).eq("tracking_number", …)` without `.single()`, inspect length, and branch. Document the same constraint should apply to the `tracking_number=` legacy lookup in `tracking/index.ts` once public_code is the canonical id.

### Non-blocking concerns

**4. `random()` is not cryptographically random; the existing `short_code` generator uses `gen_random_bytes`.**
- **Location:** Proposed `_gen_crockford_base32` uses `floor(random() * 32)`; migration 008's short_code generator uses `extensions.gen_random_bytes(8)` + base64 + char-substitution.
- **Issue:** Postgres `random()` is a seeded PRNG; two backends with the same seed could collide deterministically, and it's predictable enough that someone could brute-force the public_code namespace if they wanted to enumerate shipments. Crockford base32 at 7 chars (34B) is fine entropy *if* the source is good. Lower stakes since the tracking page only reveals status + carrier (no PII), but the proposal explicitly claims to mirror the migration 008 pattern — actually mirroring it costs nothing.
- **Suggested fix:** Use `extensions.gen_random_bytes` + base32 encoding, or `pgcrypto`-backed randomness. The pattern is already proven in this codebase.

**5. `idx_shipments_public_code` is redundant with the UNIQUE constraint.**
- **Location:** Migration §3d.
- **Issue:** Postgres automatically creates a unique B-tree index for `ADD CONSTRAINT ... UNIQUE`. Adding a second index on the same column wastes space and slows writes.
- **Suggested fix:** Delete the `CREATE INDEX IF NOT EXISTS idx_shipments_public_code` line.

**6. The proposal's `out of scope` list doesn't mention the `webhooks` function changes that §3 implies.**
- §3 mentions "Both call sites (`webhooks/index.ts:151`, `tracking/index.ts:120`) pass `shipment.public_code` when dispatching" — fine. But the webhook file isn't listed in the file-by-file plan as a modified file. Tighten §3 by adding a `webhooks/index.ts` section so the implementer doesn't miss it and so the deploy checklist in §6 picks it up (it should redeploy `webhooks` too).

**7. Email body content vs. button URL — author's open question #3.**
- The current `trackingUpdateEmail()` template already shows the tracking number prominently in a card (`email-templates.ts:174-178`). If the goal is "SendMo identity in front of carrier identity," the email body should swap to displaying the public_code with the carrier number as a secondary line — not just changing the button URL. Otherwise the email's most prominent UI element still says "22-digit carrier number." Same call needed for `labelConfirmationEmail()` at `email-templates.ts:75-94`.
- **Recommendation:** Yes, surface the public_code in the body, with the carrier number as a smaller secondary line + the existing "View on USPS site" deep link. This is the higher-leverage user-facing change; the URL slug is secondary.

**8. 7 vs. 6 vs. 8 chars — agreed with 7, but the argument has a small hole.**
- Crockford base32 at 7 chars = 32^7 ≈ 34B, fine. But the proposal cites "<1M shipments lifetime in v1" — that's a self-imposed cap, not a real one. At 100M shipments (a number SendMo could plausibly reach if it works), birthday collision probability rises but is still manageable with retry. Conclusion is the same (7 is right), but the reasoning would be more durable if framed as "even at 100M rows, retry-on-collision handles us" rather than "v1 is small."

### Nits

- §2: "32 chars, excludes I/L/O/U to dodge ambiguity with 1/0 and obscenities" — Crockford excludes I/L/O/U specifically, and U is excluded to avoid accidental obscenities; this is correct, but worth noting the alphabet you wrote `0123456789ABCDEFGHJKMNPQRSTVWXYZ` does correctly drop I/L/O/U. Sanity check: 10 digits + 22 letters = 32. ✓
- §3 example code: `query.eq("public_code", code)` after `.select("...new field list including public_code...")` — write out the actual select string so the reviewer (and future implementer) can verify no field is dropped from the response shape that the frontend already consumes.
- §6 step 1: `select count(*) from shipments where public_code is null` — good check; also verify uniqueness with `select public_code, count(*) from shipments group by 1 having count(*) > 1;` returns zero rows.
- LOG cross-link: when this ships, the LOG entry should back-link this proposal filename per the convention in `/Users/ja/AI-Brain/PROPOSAL-REVIEW-PROTOCOL.md`.

### Predicted pitfalls

1. **The label-confirmation email goes out before DB persist completes, sending a `/t/<code>` URL that 404s for a few seconds (or forever if persist fails).** Today the email send and the RPC are siblings, both fire-and-forget. If you naïvely add public_code to the email by querying right after the RPC, the email send beats the eventual-consistency window on Supabase write-then-read. Concretely: user gets the email, taps the button, lands on a 404. Fix is to chain the email send into the RPC `.then()` callback or to mint public_code client-side / in the function before the RPC. This is the same class of bug as the 2026-04-26 LOG entry ("Any Edge Function `.then()` chain on a Supabase write is fire-and-forget in Deno — Deno may terminate the request before the promise resolves"). Heightened risk because this proposal adds a *dependency* between the two fire-and-forget chains.

2. **A second redeploy of `tracking` or `webhooks` without `--no-verify-jwt` will break the new URLs the same way it broke the old ones twice this week.** The 2026-05-11 and 2026-05-10 LOG entries are both literally about this. The new `/t/<code>` URL will be just as anon-callable as `/track/<num>` — the deploy footgun is identical and the symptom (404 on tracking page) will be identical and will look like a public_code bug instead of an auth bug. Worth adding an explicit "deploy with `--no-verify-jwt`" line to §6 verification step 2.

3. **Backfill runs in the same migration as the NOT NULL + UNIQUE constraint; if backfill fails partway, the migration leaves the table in a half-state and 014 can't re-run cleanly.** The `IF NOT EXISTS` on the column add saves you, but the DO block's `RAISE EXCEPTION` after 5 retries would abort the migration mid-transaction, leaving `public_code` nullable on some rows. On retry, the loop runs again but only for `WHERE public_code IS NULL` — fine in theory. The real risk is the `ADD CONSTRAINT ... UNIQUE` line: if any row got duplicated via concurrent inserts (unlikely at this scale but not impossible), constraint creation fails and the migration is stuck. Cleaner pattern: do the backfill in a separate migration from the NOT NULL/UNIQUE flip, or wrap the constraint addition with a clear comment about how to recover.

4. **Test-mode + live-mode shipments can share carrier tracking numbers in a way the new system handles correctly *only if* the legacy `?number=` lookup is removed or carrier-disambiguated.** EasyPost test-mode fixture numbers (e.g. `EZ2000000002` for delivered) are deterministic and shared across all SendMo users in test mode. With public_code as the canonical id, two different shipments get different public_codes — good. But `/track/<number>` still works as a redirect, and the legacy lookup does `.eq("tracking_number", …)` which will match more than one row. The proposed `LegacyTrackingRedirect` calls `?number=<n>` and reads `public_code` from the response — but *which* row's public_code? Whichever Postgres returned first. The user clicking the old email link from test shipment A might get redirected to test shipment B's tracking page. Author flagged this as open question #4; my read is **yes, you must add an explicit test that creates two shipments with the same `tracking_number` and verifies both `/track/<n>` legacy URLs redirect to the *correct* `/t/<code>`** — which means the legacy lookup needs to disambiguate (by `is_test` flag? by `recipient_email`? probably by `created_at desc limit 1` with the understanding that old test-mode emails sometimes redirect "wrong" but it doesn't matter because both shipments are test fixtures). Decide and document.

5. **The proposal silently changes `DashboardShipment` type and the select column list but doesn't audit other consumers of those fields.** `Dashboard.tsx:139` is the only call shown, but `src/lib/api.ts` and any other component reading shipments may also select column lists or assume the shape. A grep for `tracking_number` in `src/` would surface anyone who'd be confused by a new field appearing or anyone who expects the URL to be `/track/<number>` (e.g., shared links surface, email composers). Quick check before implementation begins.

### What the proposal got right

- **Mirrors the established `/s/<short_code>` pattern instead of inventing a new one.** Exactly the call. Rule 6 in John's global instructions is "prefer simple, extensible code over new constructs" and this proposal honors that by extending a pattern already in the codebase.
- **Legacy `/track/<number>` redirect rather than break** — every email already in someone's inbox keeps working. Right tradeoff; one or two extra redirect hops are nothing compared to broken links.
- **Crockford base32 at 7 chars is the right format and length** for read-aloud-over-phone — the alphabet hygiene (no I/L/O/U) is the difference between a code people can dictate and one they can't.
- **Backfill in the migration itself is correct at current scale** (~10s of rows). A separate backfill job would be over-engineering.
- **Open questions section is honest and well-targeted** — the author flagged exactly the points a fresh reviewer would push on (length, redirect vs. dual-serve, where the code surfaces, collision test rigor). That's the marker of a proposal written to be reviewed honestly rather than defensively airtight.
- **Reconciliation section** — scanned prior proposals and stated no overlap. Right thing to do.
- **Test plan includes an explicit collision smoke test** as "the load-bearing test" — correctly framing what the proposal exists to prove.

## Author response

All three blockers and all non-blocking concerns accepted. None require John adjudication. Revised plan inline; the body of the proposal (§1–§7) will be updated to match before implementation begins.

**Blocker 1 — Email/RPC sync mismatch.** ✅ **Accept.** Going with option (ii) from the review: change `admin_insert_shipment` to `RETURNS TABLE(id UUID, public_code TEXT)` (or `RETURNS RECORD` with both out params), and route the label-confirmation email send into the existing `.rpc(...).then()` callback at [labels/index.ts:326+](supabase/functions/labels/index.ts). Side benefits: (a) generation stays in one place (the RPC with its retry loop), (b) fixes the latent bug where the email currently fires even when DB persist fails, (c) no eventual-consistency window between RPC commit and read-back. The email's "Track Package" URL becomes `https://sendmo.co/t/${data.public_code}`.

**Blocker 2 — `.single()` mis-description.** ✅ **Accept.** Reviewer is right; the bug is worse than I framed it. Will reword §1 bullet 1 from "404s on duplicates" to "returns an arbitrary one of the matching rows — wrong shipment to wrong viewer." This strengthens the case for the proposal, not weakens it. Also accepting the suggestion to drop `.limit(1)` from the new `?code=` lookup — `public_code` is UNIQUE so `.single()` alone is correct and will return a proper PGRST116 error if anything is off.

**Blocker 3 — Webhook handler inherits the collision bug.** ✅ **Accept.** Adding [webhooks/index.ts](supabase/functions/webhooks/index.ts) to §3 file-by-file plan as a modified file. The lookup at lines 83-84 will change from `.eq("tracking_number", code).single()` to `.eq("tracking_number", code)` without `.single()`, then inspect `data.length`:
- `length === 0` → log `webhook.tracking_not_found`, return 200 (don't retry from EasyPost)
- `length === 1` → proceed with the single shipment
- `length > 1` → log `webhook.tracking_collision` with all matched row IDs, return 200 without updating anything (safe default; surface to admin via the event log)

Section 6 verification gets a new step: redeploy `webhooks` with `--no-verify-jwt` and confirm the collision-bail path with a synthetic test event.

**Non-blocking 4 — `random()` vs `gen_random_bytes`.** ✅ **Accept.** Will rewrite `_gen_crockford_base32` to use `extensions.gen_random_bytes(8)` and map each byte modulo 32 into the alphabet. Mirrors migration 008's pattern exactly, gets us cryptographic-quality randomness with no real cost.

**Non-blocking 5 — Redundant index.** ✅ **Accept.** Dropping the `CREATE INDEX IF NOT EXISTS idx_shipments_public_code` line. UNIQUE constraint creates the B-tree.

**Non-blocking 6 — `webhooks/index.ts` missing from §3.** ✅ **Accept.** Covered by Blocker 3 fix; §3 now explicitly lists webhooks as modified, and §6's deploy step lists all three functions (`tracking`, `labels`, `webhooks`).

**Non-blocking 7 — Email body should show public_code prominently, not just button URL.** ✅ **Accept.** Both `trackingUpdateEmail()` (current tracking-number card at [email-templates.ts:174-178](supabase/functions/_shared/email-templates.ts)) and `labelConfirmationEmail()` (current tracking-number row at lines 75-94) get reworked so the SendMo public_code is the prominent "Tracking" field and the carrier number is a smaller secondary line beneath it, with the existing "View on USPS site ↗" deep link.

**Non-blocking 8 — 7-char argument reframing.** ✅ **Accept.** Will reword §2 to "even at 100M rows, retry-on-collision handles us comfortably" instead of citing v1's volume cap. More durable framing.

**Nits — all accepted.** Writing out the explicit select column list in §3, adding the dupe-check query to §6 verification, and committing to LOG cross-linking when the ship-PR lands.

**Predicted pitfall 3 (backfill + constraint in same migration).** ✅ **Accept the split.** Cleaner to ship as two migration files:
- `014_shipments_public_code.sql` — adds the column nullable + `_gen_crockford_base32` function + backfill loop.
- `015_shipments_public_code_constraints.sql` — flips to NOT NULL + adds UNIQUE constraint, runs only after 014's backfill is verified.

Two files, two `db push` invocations or one combined, but recoverable from a partial failure either way. Worth the extra file.

**Predicted pitfall 4 (test-mode collision in the legacy redirect path).** ✅ **Accept** with the following resolution: legacy `?number=<n>` lookup will order `created_at DESC` and take the first match. The rationale:
- Going forward, all new emails point at `/t/<code>` — the legacy URL only exists in *already-sent* emails.
- A user clicking an old email link almost certainly cares about the *most recent* shipment with that tracking number (the older one is stale).
- For the rare test-mode case where two live test fixtures share a number, "most recent wins" is a defensible default that doesn't 500 and doesn't render the wrong row silently.
- This will be documented in §3 with a code comment naming the test-mode collision as the case being handled and the "most recent wins" rule as deliberate.

**Predicted pitfall 5 (other consumers of `tracking_number` / shipment shape).** ✅ **Accept.** Pre-implementation `grep -r "tracking_number" src/` will be in the implementer's first commit — any consumer that needs the new public_code field or assumes `/track/<number>` URLs gets surfaced before code lands.

**Predicted pitfall 2 (verify_jwt regression on next deploy).** ✅ **Accept.** §6 step 2 will explicitly read: "Deploy modified functions with `supabase functions deploy tracking labels webhooks --no-verify-jwt`. Confirm each returns HTTP 405 (not 401) when called with no auth header — 405 means the function ran and just rejected the verb, 401 means the gateway is blocking." Adds a concrete verification command that catches the regression at deploy time, not at user-report time.

---

**Net effect on the proposal body:** §1 reframed (collision claim sharpened), §2 reframed (7-char durability argument), §3 expanded (webhooks added, email templates expanded, RPC signature change documented, gen_random_bytes), migration split into two files, §6 hardened (verify_jwt check, dupe-uniqueness check, deploy-order check). No architectural pivots; all the reviewer's findings tighten the existing plan rather than redirect it.

Bumping `status: revised`. Ready for John's decision.

## Decision

**Approved 2026-05-11.** John signed off on the revised plan (Option A — accept all reviewer findings, no round-2). Implementation proceeds directly.

The proposal body §1–§7 reflects the *original* plan; the **Author response** section above is the canonical revised spec the implementer follows. Any future reader: read the Author response first, then the body as background.

Bumping `status: decided`, `outcome: approved`. File renamed to add `_decided-2026-05-11` suffix per protocol.
