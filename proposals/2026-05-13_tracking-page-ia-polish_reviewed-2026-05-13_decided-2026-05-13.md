---
title: Tracking page IA polish — family-based composition, print logging, admin affordance
slug: tracking-page-ia-polish
project: sendmo
status: decided
created: 2026-05-13
last_updated: 2026-05-13
reviewed: 2026-05-13
decided: 2026-05-13
author: Claude (Opus 4.7) — polish-pass agent continuing from the 2026-05-13 dogfood handoff
reviewer: Claude (Opus 4.7) — fresh-eyes reviewer session, schema + privacy + state-machine pressure-test
outcome: approve-with-changes (T1=a, T2=i decided by John 2026-05-13)
---

## 1. Context

`/t/<public_code>` is the canonical shipment page (decided in [`2026-05-11_sender-flow-wizard`](2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md), Round 2). Every shipment surface — print, download, share, cancel, ship-again, track — funnels here. After today's dogfood John flagged that the page **feels disjointed**: cancelled-state has two near-duplicate bubbles plus a vestigial status card that claims the package "Shipped: May 13" when it never shipped; live labels have no instruction telling users what to do with the PDF; the same fact (status) appears three times (banner + status card + progress bar); the carrier tracking number is shown as a peer to the SendMo `public_code` even when the carrier hasn't scanned the package yet.

Round 1 polish (commit `65192c6`, shipped earlier today) added the `CancelledShipmentBanner` with timestamp + actor + refund chip and fixed the AppHeader. The remaining issues are structural — same skeleton for every state, hiding bits — and need a per-family composition pass, not more block-toggling.

Two additional asks landed during the round-2 mockup pass:

- **Print logging** (over-index on identification): two viewers can both land on `/t/<code>`; only one prints. Today there's no record of *who* printed. Server-side log with actor / user_id / IP / user_agent / session_id resolves the "did you print it or did I" confusion.
- **Admin debug affordance**: admins land on the same surface as link-owners and have to context-switch to `/admin` or SQL to see anything beyond user-visible state. Full inline panel is a separate PR ("Ask 4"); this proposal ships the affordance — a quiet "Admin debug →" footer link visible to admins only.

The user-facing change is a **layout pivot per state family**, not a redesign. Visual tokens (colors, type scale, card chrome) stay; what changes is which blocks compose per family, what each Details card carries, and what the page's primary action is.

A static mockup of all three families exists at [`previews/tracking-page-states.html`](../previews/tracking-page-states.html) and was iterated with John over two rounds (round 1: layouts; round 2: print-count chip + naming + admin scope).

## 2. Architecture

### 2.1 Three state families, each with its own composition

| Family | Statuses | Primary user job | Page composition |
|---|---|---|---|
| **F1 — Ready to Ship** | `label_created` (and not test) | Print → tape → drop off | Hero + `ShipmentLabelSection` + `HowToShipStrip` + `DetailsCard(family=1)` + Cancel row |
| **F2 — In Motion** | `in_transit` · `out_for_delivery` · `delivered` | See where it is, when it'll arrive | Hero + `ProgressBar` (horizontal) + `ActivityFeed` (collapsible) + `DetailsCard(family=2)` |
| **F3 — Cancelled** | `cancelled` · `return_to_sender` | Confirm cancel + see refund | `CancelledShipmentBanner` (built in round 1) + `DetailsCard(family=3)` + `PrintAnotherLabelCTA` (cancelled only) |

Test-mode banner persists across all families as a separate amber strip at the top (today's behavior — preserved). Admin affordance footer renders at the bottom of every family when `isAdmin`.

### 2.2 Why family-based composition, not toggle-block

Today the page renders a fixed skeleton (banner-stack → status-card → progress-bar → events-feed → label-section → ship-again) and hides bits per state. That's why cancelled feels disjointed: the status card is mostly empty, the progress bar is hidden but the layout it would occupy is hard to forget, and the page never makes a clear statement about *what this state is for*. Pivoting composition per family lets each state say "this is the one job" without empty containers.

The trade-off: more conditional code paths than today. Mitigated by extracting per-family components — each one is small, self-contained, and unit-testable in isolation.

### 2.3 Print logging (Phase 2)

**Endpoint:** `POST /functions/v1/label-print`
**Body:** `{ public_code: string }`
**Auth:** identical 3-path scheme to `cancel-label` (JWT → admin/link_owner; X-Cancel-Token → session_token/email_token; else `anonymous`). No auth required to succeed — anonymous viewers must be able to log.

**Effect:** writes one row to `event_logs`:

```
event_type:  'label.printed'
entity_type: 'shipment'
entity_id:   <shipment.id>
session_id:  x-session-id header (client-generated)
actor_id:    <user.id> when JWT present, else NULL
severity:    'info'
source:      'edge_fn'
properties:
  actor:       'admin' | 'link_owner' | 'session_token' | 'email_token' | 'anonymous'
  user_id:     <uuid> | null
  ip:          x-forwarded-for first hop | 'unknown'
  user_agent:  user-agent header (truncated to 200 chars)
  public_code: <string>
```

**Rate limit:** 10 prints/minute per `(ip + public_code)`, matching the cancel-label pattern. Prevents a forwarded URL from being weaponized to spam the log.

**Tracking GET response addition:**

- `print_count: number` — `COUNT(*) FROM event_logs WHERE event_type='label.printed' AND entity_id=<shipment.id>`
- `last_printed_at: string | null` — most recent `created_at`

The tracking function will issue this count query inline (same shape as the round-1 `cancelled_by_actor` lookup added in commit `65192c6`). Cost: one extra COUNT per tracking fetch; cheap because of `idx_event_logs_entity`.

### 2.4 Client print flow

On Print click:
1. Fire-and-forget POST to `/label-print` with `{ public_code }`. Same headers as cancel: `Authorization: Bearer <jwt>` if signed in, `X-Cancel-Token: <hex>` if `sessionStorage` has one, `X-Session-Id: <client-uuid>`.
2. Optimistically increment local `printCount` so the chip flips from "Printed N times" → "Printed N+1 times" before the network call returns.
3. Browser opens the PDF (target="_blank" — unchanged).

The chip reads `print_count` from the tracking response on first paint; the optimistic bump preserves perceived responsiveness on click.

### 2.5 Address summary in tracking response

`shipments` already has `from_*` / `to_*` columns. Tracking response will return:
- `from_city`, `from_state` (string)
- `to_city`, `to_state` (string)
- `item_description` (string | null)

City + state only — never street1, per **PLAYBOOK Rule 7** ("NEVER expose recipient address in sender UI"). Item description is shown to all viewers including anonymous third-party per John's explicit call (round-2 mockup): transparency wins; flagged as a future-revisit if abuse pattern emerges.

### 2.6 Admin affordance

A single muted footer link at the bottom of the page, only rendered when `useAuth().isAdmin === true`:

```
[Admin debug →]    /admin?shipment=<id>
```

The full inline admin panel (identifiers, ledger table, event log, "Refetch from EasyPost" button) is **out of scope for this proposal** and gated on a separate proposal that designs a role-gated `/tracking-admin` endpoint. Surfacing the affordance now is non-binding scaffolding — when Ask 4 lands, this footer link is swapped for the inline panel without touching surrounding code.

### 2.7 Carrier-adjustment stub line

Every "Paid" row across all three families always renders a second line `+ $0.00 carrier adjustment` (or the populated amount when it exists). The field comes from `shipments.carrier_adjustment_cents` — TODO column not present today; defer the column until Phase G (carrier-adjustment recovery loop, per [`2026-04-26_stripe-integration-plan`](2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) §11 #5). For this proposal, **hard-code `+ $0.00` on the client** so the visual hierarchy is in place when the column lands.

## 3. Reconciliation with prior decided proposals

- **[`2026-05-11_sender-flow-wizard`](2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md) Round 2** — established `/t/<public_code>` as THE shipment page. This proposal preserves that role and reinforces it (one URL per shipment, bookmarkable). The Round-2 privacy decision (Option a — anonymous-with-URL sees Print/Download but not Cancel) is preserved unchanged.
- **[`2026-05-11_label-cancel-and-change`](2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md)** — full cancel architecture. This proposal does not modify the cancel contract; it only restructures how the cancelled-state page renders. The 3-path auth (JWT / X-Cancel-Token / body cancel_token) and async refund state machine are unchanged. The print-log endpoint reuses the same auth derivation by design — keeps "auth shape" consistent across user-facing edge functions.
- **[`2026-05-11_sendmo-public-tracking-code`](2026-05-11_sendmo-public-tracking-code_reviewed-2026-05-11_decided-2026-05-11.md)** — SendMo `public_code` is the canonical identifier. This proposal renames the page's "Code" label to **"SendMo ID"** to make this hierarchy explicit; carrier tracking number is demoted to "Tracking #" and only appears in Family 2 (where it's actionable — the carrier has scanned it).
- **[`2026-04-26_stripe-integration-plan`](2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md) §11 #5** — carrier-adjustment recovery loop is Phase G. This proposal renders the `$0.00` slot in the UI today; the column and population belong to Phase G.

No prior decided proposal addresses tracking-page IA at this granularity. Family-based composition is new ground.

## 4. File-by-file plan

### 4.1 New edge function: `supabase/functions/label-print/index.ts`

```typescript
// Auth: 3-path scheme matching cancel-label (JWT → admin/link_owner;
// X-Cancel-Token → session_token/email_token; else 'anonymous').
// Rate limit: 10 req/min per (ip + public_code).
// Effect: writes one event_logs row + returns updated count.
serve(async (req) => {
  // 1. CORS + method guard
  // 2. Parse body { public_code }
  // 3. Service-role supabase client
  // 4. Rate limit (in-memory bucket, same shape as cancel-label)
  // 5. Lookup shipment by public_code (no auth needed — endpoint is public)
  // 6. Auth derivation:
  //    a. JWT? -> getUser; if user.id === link.user_id -> 'link_owner';
  //       if profile.role === 'admin' -> 'admin'
  //    b. X-Cancel-Token matches shipment.cancel_token (timingSafeEqual) ->
  //       'session_token' (header) or 'email_token' (body fallback)
  //    c. else 'anonymous'
  // 7. Insert event_logs row (service role, no RLS concern)
  // 8. Return { actor, print_count: <SELECT COUNT(*) ...> }
});
```

LOC estimate: ~150–180 (mirroring cancel-label's auth + rate-limit + log pattern).

### 4.2 Edge function changes: `supabase/functions/tracking/index.ts`

Add to the SELECT field list:
```
item_description, from_city, from_state, to_city, to_state
```

After the existing `cancelled_by_actor` lookup, add a parallel `print_count` lookup:
```typescript
const { count: printCount } = await supabase
  .from("event_logs")
  .select("id", { count: "exact", head: true })
  .eq("event_type", "label.printed")
  .eq("entity_type", "shipment")
  .eq("entity_id", shipment.id);

// last_printed_at — separate one-row query, only when count > 0
let lastPrintedAt: string | null = null;
if ((printCount ?? 0) > 0) {
  const { data: latest } = await supabase
    .from("event_logs")
    .select("created_at")
    .eq("event_type", "label.printed")
    .eq("entity_type", "shipment")
    .eq("entity_id", shipment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  lastPrintedAt = latest?.created_at ?? null;
}
```

Add to response payload:
```
print_count: printCount ?? 0,
last_printed_at: lastPrintedAt,
item_description: shipment.item_description ?? null,
from_city: shipment.from_city ?? null,
from_state: shipment.from_state ?? null,
to_city: shipment.to_city ?? null,
to_state: shipment.to_state ?? null,
```

### 4.3 New frontend client function: `src/lib/api.ts`

```typescript
export async function logLabelPrint(
  publicCode: string,
  opts: { accessToken?: string; cancelToken?: string }
): Promise<{ print_count: number; actor: string }> {
  // Same shape as cancelShipment(...). Fire-and-forget caller pattern.
}
```

### 4.4 Refactor: `src/pages/TrackingPage.tsx`

Today's monolithic 511-line file becomes a thin router:

```tsx
return (
  <div className="min-h-screen bg-background">
    <AppHeader />
    <main className="max-w-2xl mx-auto px-4 py-8">
      {loading && <TrackingPageSkeleton />}
      {error && <TrackingNotFound error={error} />}
      {data && (
        <>
          {data.is_test && <TestModeBanner />}
          {showCelebration && <CelebrationBanner onDismiss={...} />}
          {data.status === "label_created" && (
            <Family1ReadyToShip data={data} canCancel={canCancel} ... />
          )}
          {["in_transit", "out_for_delivery", "delivered"].includes(data.status) && (
            <Family2InMotion data={data} />
          )}
          {["cancelled", "return_to_sender"].includes(data.status) && (
            <Family3Cancelled data={data} />
          )}
          {isAdmin && <AdminAffordanceFooter shipmentId={data.shipment_id} />}
          <CancelLabelDialog open={...} ... />
        </>
      )}
    </main>
  </div>
);
```

Auth derivation (`canCancel`), refetch state, and dialog state stay in the page; rendering moves into family components.

### 4.5 New components in `src/components/tracking/`

| File | Responsibility | LOC est |
|---|---|---|
| `Family1ReadyToShip.tsx` | Hero card + ShipmentLabelSection + HowToShipStrip + DetailsCard(F1) + Cancel row | ~120 |
| `Family2InMotion.tsx` | Status hero + ProgressBarHorizontal + ActivityFeed + DetailsCard(F2) | ~140 |
| `Family3Cancelled.tsx` | CancelledShipmentBanner (existing) + DetailsCard(F3) + PrintAnotherLabelCTA | ~70 |
| `DetailsCard.tsx` | Per-family field config rendering Details dl-list | ~80 |
| `HowToShipStrip.tsx` | 3-step print/tape/drop-off instruction card | ~50 |
| `ActivityFeed.tsx` | Tracking events list with "Show N more" collapse | ~80 |
| `ProgressBarHorizontal.tsx` | 4-dot horizontal progress (replaces today's vertical) | ~60 |
| `PrintAnotherLabelCTA.tsx` | "Print another label →" linking to `/s/<short_code>` | ~30 |
| `AdminAffordanceFooter.tsx` | Muted link "Admin debug →" → `/admin?shipment=<id>` | ~20 |
| `TestModeBanner.tsx` | Extract today's inline TestMode JSX from TrackingPage | ~30 |
| `CelebrationBanner.tsx` | Extract today's `?fresh=1` banner | ~30 |
| `TrackingPageSkeleton.tsx` | Loading state | ~10 |
| `TrackingNotFound.tsx` | Error state | ~25 |

### 4.6 `ShipmentLabelSection.tsx` changes

Add:
- `printCount: number` prop
- `lastPrintedAt: string | null` prop
- `onPrintClick: () => void` callback (so the parent can fire the log POST + optimistically bump count)
- Print-count chip (top-right of Print button) — green emerald chip "✓ Printed N times" when count > 0
- Reprint reassurance line below the action grid: *"Safe to reprint — your card was charged once. The label locks when USPS scans it."*

Existing `labelUrl: string | null` orphan-recovery branch preserved.

### 4.7 TrackingData interface

```typescript
interface TrackingData {
  // ...existing fields...
  print_count: number;
  last_printed_at: string | null;
  item_description: string | null;
  from_city: string | null;
  from_state: string | null;
  to_city: string | null;
  to_state: string | null;
  shipment_id: string;  // ALREADY present? if not, add — needed for AdminAffordanceFooter
}
```

(Need to verify whether tracking already returns `shipment.id`; if not, add it — gated on isAdmin in the response so non-admins don't get the UUID.)

## 5. Test plan

### 5.1 Unit tests

| File | Coverage |
|---|---|
| `tests/unit/Family1ReadyToShip.test.tsx` | Renders Print/Download/Share; renders HowToShipStrip; renders DetailsCard with SendMo ID + Item + From/To + Paid + carrier-adjustment stub; canCancel=false hides cancel row |
| `tests/unit/Family2InMotion.test.tsx` | Renders ProgressBar with correct step; renders ActivityFeed; renders carrier link only when not test; delivered-state shows delivery-performance badge |
| `tests/unit/Family3Cancelled.test.tsx` | Renders CancelledShipmentBanner; DetailsCard has "Label created" (not "Shipped"); shows PrintAnotherLabelCTA only for cancelled with `link_short_code` |
| `tests/unit/ShipmentLabelSection.test.tsx` (existing, extend) | Print-count chip renders when count > 0; doesn't render when count === 0; reassurance line always renders; onPrintClick called with no args |
| `tests/unit/DetailsCard.test.tsx` | Family configs render the right fields; carrier-adjustment stub always present; item description shown |
| `tests/unit/AdminAffordanceFooter.test.tsx` | Renders only when isAdmin; href is `/admin?shipment=<id>` |
| `tests/unit/logLabelPrint.test.ts` | Client fn POSTs with correct headers; handles 200/4xx/5xx; returns parsed `print_count` |

### 5.2 Edge function tests

No automated test harness for edge functions in this repo today. Manual verification per Section 6.

### 5.3 Baseline

Current: 257 unit tests passing. Target after this proposal: ~275 (add ~18 new tests; preserve all existing).

## 6. Verification (end-to-end walkthrough)

After implementation + deploy:

1. **F1 — Ready to Ship**: Sign in as link-owner; navigate to `/t/<live label_created code>`. Verify: hero says "Ready to ship", Print/Download/Share visible, HowToShipStrip shows 3 steps, DetailsCard has SendMo ID / Item / From/To / Paid+adjustment stub. Click Print — chip flips to "Printed 1 time". Refresh — chip persists. Open in a private window — chip still says "Printed 1 time" (proves server-side count).
2. **F1 — test mode**: Navigate to `/t/<test code>`. Verify: amber TestModeBanner above hero; Print chip doesn't show because clicking Print in test doesn't actually print anything useful (still allowed to log — verify count increments).
3. **F2 — in_transit / delivered**: `/t/RA2W2NG` (live) or `/t/Z7BCPTY` (test delivered). Verify horizontal progress, ActivityFeed, DetailsCard with Tracking #, no label preview. Delivered: delivery-performance badge.
4. **F3 — cancelled**: `/t/NEC7J3E`. Verify CancelledShipmentBanner (built round 1) + DetailsCard without "Shipped" line + PrintAnotherLabelCTA at bottom.
5. **Admin affordance**: Sign in as admin (jsa7cornell@gmail.com); reload any `/t/<code>`. Verify "Admin debug →" footer link present; sign out and reload — link disappears.
6. **Print logging — multi-viewer**: Open `/t/<code>` on phone (anonymous third-party) and click Print. Open same URL in browser signed in as admin. Verify `event_logs` has two rows, one with `actor='anonymous' + ip=<phone>` and one with `actor='admin' + user_id=<jsa7's uuid>`. This validates the "who printed it" disambiguation use case.
7. **Edge function deploy**: GitHub Action auto-deploys both `tracking` and `label-print` on push (workflow shipped earlier today). Verify via `gh run list --workflow="Deploy Supabase Edge Functions"`.

## 7. Open questions for the reviewer

1. **Anonymous print logging — feature or footgun?** Phase 2 logs prints from any URL-holder including anonymous third-party. Intent: resolve "who printed it" two-viewer confusion. Risk: a bad actor with the share URL can spam print events to dirty the log. Mitigated by rate limit (10/min/IP). Is that enough, or do we need anonymous-prints to be gated behind a CAPTCHA / heuristic / not-logged-at-all? Author lean: ship as proposed; the log is advisory, not enforcement, and 10/min ceiling caps damage.

2. **Item description privacy.** John explicitly chose "always show" over "hide-for-anonymous". This means anyone with the share URL sees the item description (e.g. "A pair of running shoes") that the sender entered. Imagine a sender forwarding `/t/<code>` to a friend ("here's the tracking") — the friend now knows the contents. Is the transparency-wins call still right after the reviewer thinks about it cold? Author lean: ship as proposed; flag as future-revisit if abuse pattern emerges.

3. **Family-based composition vs. progressive enhancement.** Today's single-skeleton-with-toggles is simpler in code; family-per-component is cleaner in IA but adds ~600 LOC of components. Is the IA-clarity win worth the LOC? Or would a "config-driven Details + per-state hero" half-step land most of the IA benefit at a fraction of the surface? Author lean: full family-based; the page is high-traffic and the IA is the *product*, not a thin layer over it.

4. **`shipment_id` exposure on tracking response.** Today the response returns `tracking_number`, `public_code`, and joined `short_code` — but not the raw shipment UUID. The AdminAffordanceFooter needs it to deep-link `/admin?shipment=<id>`. Options: (a) always return `shipment_id` (UUID isn't sensitive but no need to leak); (b) only return when caller is admin (server-side branch); (c) skip the deep-link and have AdminAffordanceFooter link to `/admin` and let the admin search. Author lean: (b) — server-side branch — keeps the public response slim.

5. **Print-count + cancelled state.** If a label is printed 3 times then cancelled, do we still show "Printed 3 times" on the cancelled banner? Useful debug context for support ("they printed, then cancelled") but arguably noise in the user-facing surface. Author lean: hide on cancelled; the data stays in `event_logs` for admin/support to query.

6. **Carrier-adjustment hard-code at $0.00.** We render `+ $0.00 carrier adjustment` always, today, with no backing column. Is showing a perpetually-zero line item user-comprehensible, or does it just look broken until Phase G populates it? Author lean: ship the stub; future Phase G writes flip non-zero values in without touching the layout.

## 8. Review

**reviewer:** Claude (Opus 4.7) — fresh-eyes reviewer session, schema + privacy + state-machine pressure-test
**reviewed_at:** 2026-05-13
**verdict:** approve-with-changes

### Summary

The IA pivot is the right call — family-based composition is what the page wants to be, and the round-1 polish already proved the structural problem. The proposal got the privacy boundary and the white-label-cancel reconciliation correct, cites prior proposals accurately, and the print-log endpoint reuses the cancel-label auth shape cleanly. **However, the proposal is wrong on its own central premise that "no migration is needed"** — three of the four "already there" fields it plans to surface (`item_description`, `from_city/state`, `to_city/state`) are not columns on `shipments` at all; the data lives in the joined `addresses` table, and `item_description` does not exist anywhere in the schema. A second blocker: surfacing `item_description` to anonymous third-party viewers also requires reconciling with the Round-2 privacy decision, which was scoped to label-grade PII *not* the package contents. Several other concerns are non-blocking. Once §2.5 and §4.2 are reworked against the real schema and the privacy decision is escalated cleanly, this is a strong ship.

### Blocking issues

**B1. `shipments.item_description` does not exist; this needs a migration or a different source-of-truth.**
- **Location:** §2.5 "Address summary in tracking response", §4.2 (SELECT field list), §4.7 (TrackingData interface), §2.7 implicitly assumes the same about `carrier_adjustment_cents`.
- **Issue:** I grepped the entire `supabase/migrations/` tree and the codebase for `item_description` — zero hits. The shipments table (migration 001) has `weight_oz / length_in / width_in / height_in` but **no** description / notes / item field. The nearest existing field is `sendmo_links.size_hint` + `sendmo_links.notes`, which is link-level (recipient-set), not shipment-level (sender-set). The proposal's §4.2 line `item_description: shipment.item_description ?? null` will silently return `null` for every shipment in production. The proposal's verification step 1 will appear to pass (no crash, just blank field) — this fails open into a feature that ships dead.
- **Suggested fix:** One of three, pick deliberately:
  - (a) **Add a migration**: `ALTER TABLE shipments ADD COLUMN item_description TEXT NULL;` plus the labels function path that populates it from the sender wizard's "What's in the package?" step (if that field exists today — check `SenderStepReview` props). State explicitly in §4 that this is a new column and stage it as a separate migration. This is the most honest path.
  - (b) **Source from the link**: surface `sendmo_links.notes` (recipient-set free text) as the "item description" — but this conflates two different semantics (recipient hint vs. sender declaration). Worth flagging if you take this path.
  - (c) **Drop item_description from this round** and scope to address summary only. Punt to a follow-up proposal that designs the field properly.

**B2. `from_city/from_state/to_city/to_state` are not columns on `shipments`; they live on `addresses`.**
- **Location:** §2.5, §4.2 SELECT field list, §4.7.
- **Issue:** Migration 001 shipments table has `sender_address_id` and `recipient_address_id` foreign keys to `addresses`. The address columns (`city, state, street1, …`) live on `addresses`, not denormalized onto `shipments`. The SELECT `from_city, from_state, to_city, to_state` in §4.2 will fail with a Postgres "column does not exist" error on first invocation. The proposal's "no migration needed" claim doesn't hold.
- **Suggested fix:** Use PostgREST embedded resources, same pattern already in use elsewhere (Dashboard.tsx joins `sender_address:addresses!sender_address_id(name)` per the 2026-05-13 LOG entry). Replace the SELECT in §4.2 with something like:
  ```typescript
  const selectFields = "id, tracking_number, public_code, ..., sender_address:addresses!sender_address_id(city,state), recipient_address:addresses!recipient_address_id(city,state), sendmo_links!inner(short_code, user_id, notes)";
  ```
  Then in the response payload: `from_city: shipment.sender_address?.city ?? null` etc. Note this matters for `is_test=true` fixture data too — most rows will have addresses, but the orphan-recovery rows from 2026-05-13 used the canonical RPC which DOES populate addresses, so coverage should be fine.

**B3. `item_description` exposure to anonymous URL-holders is a separate privacy decision from the Round-2 label-grade PII call — escalate, don't conflate.**
- **Location:** §2.5 (paragraph 2) and Open Question #2.
- **Issue:** The Round-2 privacy decision (verified by reading `2026-05-11_sender-flow-wizard` §11 §14 "John, 2026-05-11: approved Round 2 with Option (a) on the privacy tradeoff") was specifically about *Print/Download (the PDF, which contains recipient street/zip) being URL-gated*. Option (a) said: accept that the 7-char public_code now gates label-grade PII. That decision did NOT scope `item_description`, because `item_description` did not exist at the time. The proposal's §2.5 implies John has already decided item description is fine to surface anonymously ("John's explicit call (round-2 mockup)") — but the round-2 decision did not address it. This conflates two questions and risks shipping a privacy default John didn't actually approve, on a field that's *more* sensitive than the PDF in some scenarios (a sender shipping a medication, sex toy, controlled substance, etc., entered the description himself). The PDF leaks recipient address; an item-description leak goes the other way — it tells the *recipient's* social graph what the sender is sending.
- **Suggested fix:** Either (a) gate `item_description` behind `viewer_is_recipient || cancel_token_present` (i.e., same auth as Cancel — only the two parties to the shipment see contents), or (b) explicitly add a `## Privacy decision — item_description` block to the proposal stating: "Round-2 Option (a) covered label-grade PII (address). Item description is a new field with a separate threat model. The author's call is full-transparency; this is being surfaced as a Round-2-extension privacy decision for John to confirm before merge." Don't ship as written without an explicit John sign-off.

**B4. Open Question #4 ("`shipment_id` exposure") is a Rule 14 / server-side-state question — the author's lean (b) is correct but the proposal must commit before ship.**
- **Location:** Open Question #4; §4.5 AdminAffordanceFooter; §4.7 `TrackingData.shipment_id`.
- **Issue:** Option (a) "always return shipment_id" is a one-way door — once the UUID is on the public response, removing it later breaks any consumer that learned to depend on it. The author's lean (b) is the right one per Rule 14 (critical decisions derived server-side; the admin-deep-link target is an admin-only concern). But the proposal frames this as "open" and falls through to "needs to verify whether tracking already returns shipment.id" — it doesn't, I confirmed. **Commit to (b) in the proposal body before shipping**, with the implementation: branch the response in the tracking function based on `isAdmin` derivation (which already happens for `viewer_is_recipient` — reuse the same JWT lookup path). Don't ship with the question open.

### Non-blocking concerns

**N1. Print logging for `is_test=true` shipments pollutes `event_logs` with no upside.**
- **Location:** §2.3 endpoint behavior; verification step 2 explicitly tests that print-logging works in test mode.
- **Issue:** event_logs has 90-day pg_cron retention, but volume matters at scale. Test shipments are dogfood-only and have a fast auto-advance to "delivered" anyway (per 2026-05-13 LOG entry). Logging a print against a synthetic tracking number serves no real "who printed it" purpose because no real package is in play. The author's verification step 2 says "still allowed to log — verify count increments" — that's testing the endpoint, not validating the product behavior.
- **Suggested fix:** In `label-print/index.ts` step 5 (shipment lookup), if `shipment.is_test === true`, return `{ actor: 'anonymous', print_count: 0 }` without writing a row. Or: log it but flag `properties.is_test=true` so a follow-up purge can scope to those. Either is fine — but think about it explicitly. Author's call.

**N2. Three sequential supabase queries on cancelled-state tracking GET.**
- **Location:** §4.2 — after the existing `cancelled_by_actor` lookup (round-1 added) plus the new `print_count` plus new `last_printed_at`, a cancelled-state tracking fetch now issues: (1) shipment SELECT, (2) `event_logs` cancelled-actor lookup, (3) `event_logs` print-count COUNT, (4) `event_logs` last-printed lookup — four sequential round-trips. For label_created it's three.
- **Issue:** A hot share link could see this load. The author named `print_count` as "cheap because of `idx_event_logs_entity`" — that's true per migration 003 — but four sequential awaits over a region-hop to Postgres adds tail latency. Not a blocker because today's tracking fetches are already 2-3 sequential and nobody's complaining, but it's worth flagging.
- **Suggested fix:** Wrap the three event_logs queries in `Promise.all()` after the shipment SELECT. One round-trip for the parallel batch instead of three. Trivial code change, real latency win.

**N3. Optimistic increment can drift from server state on failure (Rule 14 echo).**
- **Location:** §2.4 client print flow step 2.
- **Issue:** The client bumps `printCount` locally on Print click and only the next refresh corrects it. If the POST fails (network error, rate-limit 429, server error), the chip lies forever until refresh. Worse: on a chip that says "Printed 3 times" after a failed POST, the user trusts the server-state implication and assumes the print was recorded.
- **Suggested fix:** On non-200 response, roll back the optimistic increment. Either show a small "couldn't log this print" toast or silently revert. The current proposal doesn't specify the error path.

**N4. `PrintAnotherLabelCTA` linking to `/s/<short_code>` may bypass the `sendmo_just_voided_for_change` UX message.**
- **Location:** §4.5 `PrintAnotherLabelCTA.tsx` (Family 3).
- **Issue:** The cancel-flow proposal Phase A specifies that after Cancel-and-change, `sessionStorage.sendmo_just_voided_for_change` is set, then `navigate('/s/<short>')` fires, and SenderFlow.tsx:38 reads the flag to show "Previous label voided. Let's try again." (verified at TrackingPage.tsx:239 and SenderFlow.tsx:38-39). But `PrintAnotherLabelCTA` on the cancelled-state page is a different entry point (user lands cold on `/t/<cancelled-code>`, clicks "Print another label →") — the flag won't be set, so the SenderFlow banner won't show. That's *probably correct* (they're not "trying again" from a voided label, they're starting fresh) — but the proposal doesn't say.
- **Suggested fix:** State explicitly in §4.5 whether `PrintAnotherLabelCTA` should set the flag or not. If "no" (my read), good — but document it so the next agent doesn't add the flag thinking it's missing.

**N5. The "carrier-adjustment hard-code at $0.00 stub" is shaped wrong relative to Phase G.**
- **Location:** §2.7.
- **Issue:** Phase G doesn't add a `shipments.carrier_adjustment_cents` column — it adds a `carrier_adjustments` *table* with per-event rows (verified in `2026-04-26_stripe-integration-plan` §3.7 and §schema, line 249). A shipment can accumulate multiple adjustments (reweigh + address correction). When Phase G lands, the UI displayed value will be `SUM(carrier_adjustments.amount_cents WHERE shipment_id=...)`, not a single column read. The proposal's "field comes from `shipments.carrier_adjustment_cents`" assumption is wrong shape.
- **Suggested fix:** Either (a) drop the stub from this round (PLAYBOOK §refunds white-label rule still applies — "+ $0.00 carrier adjustment" arguably surfaces a thing the user shouldn't have to think about until it's non-zero), or (b) restate the stub with the correct future shape: when Phase G lands, the line populates from a joined SUM, not a column. Author's Open Question #6 already flags this as worth revisiting — recommend dropping the stub for now.

**N6. Test coverage gap for the new public endpoint.**
- **Location:** §5.2 — "No automated test harness for edge functions in this repo today. Manual verification per Section 6."
- **Issue:** `label-print` is a new public endpoint that writes to `event_logs`. Today, none of the existing edge functions have automated coverage either — true. But this is a public, anonymous-allowed endpoint with a rate limiter, that takes a user-supplied `public_code`, and writes a row keyed off it. The cancel-label function had a three-path auth scheme that took three rounds of in-session Q&A to get right (per LOG entry 2026-05-12). Manual verification of "click print twice and see count = 2" doesn't cover: rate-limit boundary, malformed `public_code`, expired `X-Cancel-Token`, JWT-but-non-admin/non-owner, the timing-safe-equal correctness.
- **Suggested fix:** This isn't a blocker because the codebase pattern is "edge functions have no harness." But: add at least one Vitest unit test for the *auth-derivation helper* if you extract it (mirror `cancelAuth` pattern). That's the part most likely to be wrong and is testable without a Deno harness. State explicitly in §5 if you're choosing not to.

**N7. LOC estimates are likely 1.5–2× low.**
- **Location:** §4.5 "LOC est" column.
- **Issue:** Family2 at 140 LOC for "Status hero + ProgressBarHorizontal + ActivityFeed + DetailsCard(F2)" — the existing TrackingPage.tsx is 511 LOC and the in-motion path is maybe 200 of those. Extracting + restructuring + adding the per-family DetailsCard config + tests will overshoot. Not a blocker, just budget realism: ~600 LOC of new components is likely ~900-1000 once tests and prop drilling are accounted for.
- **Suggested fix:** None required — just calibrate expectations. If you're tracking a TTL on this work, double it.

### Nits

- §2.1 "**F1 — Ready to Ship**" includes the parenthetical "(and not test)" for the family-1 condition. But §6 verification step 2 explicitly tests F1 *in* test mode. The family table and the verification are inconsistent — F1 should include `is_test=true` shipments (with the TestModeBanner above), not exclude them. Drop the "(and not test)" from §2.1.
- §2.3 says "rate limit: 10 prints/minute per (ip + public_code), matching the cancel-label pattern" — but `cancel-label` is 5 req / 60s per the LOG entry, not 10. Pick one (10 may be the right number for print, but say so explicitly rather than asserting parity with cancel-label).
- §4.2 the `last_printed_at` extra query "only when count > 0" — fine, but consider returning it from a single window query: `SELECT created_at FROM event_logs WHERE ... ORDER BY created_at DESC LIMIT 1` and let the count come from `data.length === 0 ? 0 : data.length` if you also batch a `LIMIT N`. Probably not worth it; flagging because two queries for one chip is the kind of thing future-you will look at and wince.
- §4.7 The TypeScript field list mixes camelCase (in the new fields) with the existing response shape (snake_case for `tracking_number` etc., per the actual `tracking/index.ts:187` response). The proposal preserves the existing snake_case convention — good. Just confirming the §4.7 sketch matches what's already there: it does. No action needed.
- §6 step 5 says "Sign in as admin (jsa7cornell@gmail.com)" — the LOG entry from 2026-05-11 shows the admin gate is `profiles.role='admin'` server-side, not a hardcoded email. The verification should say "sign in as a user whose `profiles.role='admin'`" — not name the email, which sets a brittle expectation.

### Predicted pitfalls

1. **Shipping will fail at first deploy because the tracking SELECT errors on nonexistent columns.** Per B1+B2, `shipments.item_description / from_city / from_state / to_city / to_state` don't exist. The first request to `/tracking?code=…` post-deploy will 500 with a Postgres "column does not exist" error, taking the entire tracking page offline for every viewer (signed-in, sender, anonymous third party). Ties to the 2026-05-13 orphan-shipment incident: the labels function deployed before migration 018 applied, and `event_logs.label.db_persist_error` for half a day before John noticed. *Same recurrence pattern: code references schema that isn't deployed*. Recommend a server-side defensive `try/catch` on the new fields during rollout AND verify the SELECT against the actual schema *before* writing the proposal.

2. **The optimistic print-count increment will drift in test mode and look broken to John during his own dogfood.** Per N1+N3: if the test-mode print logging is later disabled server-side, the client's optimistic bump will show "Printed 1 time" momentarily, then snap back to 0 on refresh. John's likely first reaction is "the chip is broken" not "test-mode shipments don't log prints." Ties to the LOG-entry pattern from 2026-05-13 test-mode-hygiene work: visible UI affordances on test mode that don't match server behavior create confusion ("View on USPS site" went to a 404 because the test number was synthetic). Print logging is the next instance of the same recurrence.

3. **The "who printed it" cross-viewer use case won't actually disambiguate the way the proposal frames.** The intended UX (per §1) is: sender prints, recipient opens `/t/<code>` on her phone, sees "Printed 1 time" and knows the sender printed it. But the recipient on her phone has no JWT (she'd need to be signed in as the link owner — many recipients won't be, especially flex-link senders forwarding to a friend) and no `X-Cancel-Token` (she's not the sender). So her own page-open doesn't tell her *who* printed it — just that someone did. If she now hits Print herself (perhaps to share with her partner who's actually shipping), the chip says "Printed 2 times" — and she can't tell whether (a) the sender printed and she printed, or (b) the sender printed twice. The audit trail in `event_logs` distinguishes actors, but the user-facing chip flattens that to a count. Ties to the 2026-05-11 sender-flow §11 Round-2 review finding about device-based "Ship Again" heuristics being a false-positive risk on shared devices — *same shape of problem*: the proposal models a clean two-party flow when the real world is messier. Recommend either (a) lower the chip's promise — "Printed 1 time" without implying agency, or (b) actually surface the actor when it's clear (e.g. for the link-owner viewer: "You printed this 1 time" vs "The sender printed this 1 time" — derivable from event_logs).

4. **(Bonus) The Family-3 PrintAnotherLabelCTA always linking to `/s/<short_code>` won't work for `return_to_sender` shipments.** §2.1 puts `return_to_sender` in Family 3 alongside `cancelled`. But "Print another label" implies the user is taking action on a cancellable mistake. A return-to-sender package is *physically being returned* — printing a new label doesn't fix it. The CTA should be conditional on `status === 'cancelled'` only, not the whole Family-3 set. (The proposal's table at §2.1 actually says this — "`PrintAnotherLabelCTA` (cancelled only)" — but §4.5 component list does not condition it. Inconsistency between sections.)

### What the proposal got right

- **Family-based composition is the correct architecture** for this surface — the dogfood signal John gave is structural, not cosmetic, and the proposal reads that correctly. Round-1 polish proved the structural ceiling of the toggle-skeleton approach.
- **`/t/<public_code>` as canonical management surface is preserved unchanged** — proposal §3 reconciles cleanly with `2026-05-11_sender-flow-wizard` Round 2 and `2026-05-11_sendmo-public-tracking-code`. Renaming "Code" to "SendMo ID" and demoting carrier "Tracking #" to Family-2-only is exactly the white-label reinforcement PLAYBOOK §"Label Cancellation / Void" calls for.
- **The 3-path auth-shape reuse for `label-print`** (JWT / X-Cancel-Token / anonymous) matches `cancel-label` deliberately, which preserves "auth shape" consistency across user-facing edge functions per the §3 reconciliation block. This is the kind of consistency that pays off six months later when someone adds a fourth endpoint.
- **The split-component scaffolding (12 new components, each ~30-140 LOC)** is right-sized for the IA pivot and aligns with the existing `src/components/recipient/` and `src/components/sender/` extraction patterns. The pattern is already proven in this codebase.
- **Round-1 work is preserved, not redone.** The `CancelledShipmentBanner` from the round-1 polish slots into Family 3 unchanged. That's the right reuse instinct — many proposals would have re-designed it for "consistency with the new families" and lost the work.
- **Admin affordance is intentionally scoped to a stub.** Surfacing the `[Admin debug →]` link now without designing the full panel is good phased thinking — it preserves the seam for the inline-panel proposal without dragging that proposal's scope into this one.
- **Open Questions #1 (anonymous print logging — feature or footgun?) and #6 (carrier-adjustment stub at $0.00 — comprehensible or broken-looking?) are the right questions to surface for John.** Both are genuine tradeoffs worth his attention, framed cleanly with the author's lean stated.

## 9. Author response

The reviewer found two genuine schema blockers I should have caught (B1, B2 — grepped after the fact, confirmed) plus a separate privacy blocker (B3) that I conflated with the Round-2 decision. Several non-blocking points sharpen the implementation. One item (item_description scope) is a tradeoff worth surfacing to John rather than deciding unilaterally. Everything else accepted.

### Blocking

**B1 — `item_description` doesn't exist on shipments.** ❓ Needs John.
- Confirmed: grep across `supabase/migrations/`, `supabase/functions/labels/index.ts`, and the labels-buy request body — `item_description` is not a persisted field anywhere. The sender wizard *does* capture `parcel.description` at [`SenderStepReview.tsx:90`](../src/components/sender/SenderStepReview.tsx) but it's discarded before reaching the labels function. So the data path needs work, not just a column add.
- The reviewer's three options:
  - **(a) migration + plumb the field** through labels function + sender-flow buy call — most honest, but expands this PR's scope (extra migration + edits to labels function + SenderFlow's buy call). Estimated +~80 LOC and one new migration.
  - **(b) source from `sendmo_links.notes`** — semantic mismatch, reject. Recipient hints ≠ sender declarations.
  - **(c) drop item_description from this round** and follow up — keeps this PR tight, but conflicts with John's explicit round-2 ask ("item description is a helpful field we should use in all 3 families").
- John asked for item_description; the cleanest fix removes it. **Surfacing as Tradeoff T1 in §10.**

**B2 — `from_city/state, to_city/state` live on `addresses`, not `shipments`.** ✅ Accept.
- Reviewer is correct. I missed the join. Will update §4.2 to embed via PostgREST: `sender_address:addresses!sender_address_id(city,state), recipient_address:addresses!recipient_address_id(city,state)` and read `shipment.sender_address?.city ?? null` etc. in the response. Same pattern already used in Dashboard.tsx per 2026-05-13 LOG.

**B3 — `item_description` exposure is a separate privacy decision from Round-2 Option (a).** ✅ Accept the framing; resolution depends on T1.
- Reviewer is right that Round-2 Option (a) covered the *label PDF* (recipient street + ZIP visible on the printed label). It did not cover sender-declared package contents — a different threat model that runs in the opposite direction (PDF leaks recipient PII; description leaks sender intent, e.g. shipping a controlled substance or sex toy).
- **If T1 resolves to (a) or (b): item_description is in scope; we need an explicit privacy decision.** Author lean: gate `item_description` behind `viewer_is_recipient || is_link_owner || cancel_token_present` — only the two parties to the shipment see contents. Anonymous third-party sees the rest of Details but item_description is hidden. **Surfacing as Tradeoff T2 in §10, conditional on T1.**
- **If T1 resolves to (c) — drop item_description:** T2 is moot.

**B4 — commit to (b) on `shipment_id` exposure.** ✅ Accept.
- Locking the proposal to server-side branch by `isAdmin`. The tracking function already does a JWT-derived `viewer_is_recipient` lookup; the same path resolves admin via `profiles.role` and conditionally includes `shipment_id` in the response. Updating §4.2 + §4.7 to reflect this commitment.

### Non-blocking — all accepted

- **N1 — skip print logging when `is_test=true`.** ✅ Accept. In `label-print/index.ts`, return early `{ actor: 'anonymous', print_count: 0 }` without writing when `shipment.is_test === true`. Avoids event_logs pollution and matches the 2026-05-13 test-mode-hygiene work.
- **N2 — wrap parallel queries in `Promise.all`.** ✅ Accept. Refactor §4.2's three event_logs queries (cancelled-actor + print-count + last-printed) into a single `Promise.all` after the shipment SELECT. Real latency win, trivial code.
- **N3 — roll back optimistic increment on POST failure.** ✅ Accept. On non-2xx response from `/label-print`, decrement the optimistic bump and (silently) revert; no toast — print failures shouldn't distract the user from the page they came for. Document in §2.4.
- **N4 — `PrintAnotherLabelCTA` does NOT set `sendmo_just_voided_for_change`.** ✅ Accept. Stating explicitly in §4.5: the flag is set by Cancel-and-change from `/t/` mid-cancel-flow (preserved). Cold-landing on a cancelled page and clicking "Print another label →" is a *fresh start*, not a *continuation* — the SenderFlow's "Previous label voided" banner should not show.
- **N5 — drop the carrier-adjustment $0.00 stub.** ✅ Accept reviewer's option (a). Reviewer is right that Phase G's shape is a `carrier_adjustments` *table*, not a column — my stub assumed wrong. Dropping the "+ $0.00" line entirely from this round. When Phase G lands, it adds the populated line in its own PR.
- **N6 — extract + unit-test the auth-derivation helper.** ✅ Accept. Will extract `deriveActor()` from `label-print/index.ts` into `_shared/actor.ts` (along with refactoring `cancel-label` to use it — small but real Rule-6 win: shared auth shape gets a single home), and add a unit test for the helper. State in §5 if I end up not doing this — currently planning to.
- **N7 — LOC under-estimate.** ✅ Accept (informational, no action).

### Nits — all accepted

- §2.1: drop "(and not test)" from F1 — test-mode shipments still belong in F1 (with TestModeBanner above). Fixed.
- §2.3: rate limit clarification — `cancel-label` is 5/60s, not 10. Restating as "rate limit: 10 prints/min per (ip + public_code) — chosen separately from cancel's 5/min because prints are a more frequent legitimate action."
- §4.2: skip the redundant `last_printed_at` query; reviewer's right that it can come from a `LIMIT 1 ORDER BY DESC` and count from a separate `count: 'exact'`. Or simpler: use one query that returns recent rows and derive both client-side. Will pick simplest at implementation.
- §6 step 5: replace "Sign in as admin (jsa7cornell@gmail.com)" with "Sign in as any user with `profiles.role='admin'`". The role is what's checked; the email is incidental.

### Predicted pitfalls

- **PP1 (schema-doesn't-exist)** — fully addressed by B1 + B2 fixes. The 2026-05-13 orphan-shipment incident is the right reference; same recurrence pattern.
- **PP2 (test-mode chip drift)** — fully addressed by N1.
- **PP3 (chip doesn't actually disambiguate "who")** — ✅ Accept the critique but not the proposed fix. Author lean: keep the chip simple ("Printed N times") as Phase 1. The over-indexing John asked for lives in `event_logs.properties` (actor + user_id + ip + user_agent + session_id) — which an admin can read when there's a real dispute. Surfacing per-actor in the chip would invent UI for a use case we don't have data on yet. **Phase 2.1 future enhancement:** for authorized viewers (admin / link_owner / sender-with-token), enrich the chip into a small "Last printed: 2h ago" with a tooltip that lists the actors. Filed as out-of-scope here; documenting the intent so the next agent doesn't reinvent.
- **PP4 (PrintAnotherLabelCTA on return_to_sender)** — ✅ Accept. Conditioning on `status === 'cancelled'` specifically, not the whole Family-3 set. Will fix the inconsistency between §2.1 (which already says "cancelled only") and §4.5 (which doesn't). For `return_to_sender` shipments Family 3 renders without the CTA.

## 10. Tradeoffs for John

Two unresolved decisions — both tied to **item_description**. T2 is conditional on T1.

### T1 — Item description scope in this PR

**Question:** include item_description in this PR (requires a migration + plumb through labels fn + sender flow), or drop and follow up?

| Option | What ships now | LOC + risk | Trade |
|---|---|---|---|
| **(a) Migrate now** | Add `shipments.item_description TEXT NULL` in migration 021; update labels function to accept + persist; update SenderFlow's buy call to pass `parcel.description`; tracking response returns it; UI shows it in all three families' Details. | +~80 LOC + 1 migration + edits in 3 files outside this PR's stated scope. Schema migrations have a deploy ordering risk (per the 2026-05-13 orphan-shipment incident pattern). | You get what you asked for in round-2 in this PR. Coupled risk: a migration outside this PR's footprint. |
| **(c) Drop now, follow up** | Item description omitted from Details in all families. Everything else from the proposal still ships. Next proposal designs item_description as a coherent feature: schema + sender-flow plumbing + privacy default + display surfaces. | This PR stays tight; nothing new to land. Cost: visible regression vs. the round-2 mockup you approved. | You wait one more PR for the field, in exchange for a cleaner ship now. |

**Author lean:** (c). The IA polish is the high-value win; item description is a small detail surface that benefits from its own design pass with the privacy question explicitly answered. Adding a migration on the day of a polish PR is exactly the deploy-ordering shape the 2026-05-13 incident reminded us to avoid.

**Cost of (c) you should weigh:** "the page doesn't say what's in the box" is a real UX gap, especially on the cancelled state where the user might not remember which shipment they're looking at across multiple cancellations.

### T2 — Item description privacy default (only if T1 = a)

**Question:** if item_description ships, who sees it?

| Option | Who sees it | Trade |
|---|---|---|
| **(i) All viewers including anonymous third-party** | Anyone with the share URL — sender's friend, recipient's roommate, anyone the link was forwarded to. | Matches your round-2 mockup choice ("show item description"). Risk: sender entered "PrEP medication" or "engagement ring" and the recipient's roommate now knows. The Round-2 Option (a) privacy decision did NOT cover this — it was scoped to the PDF, not contents. |
| **(ii) Gate to admin / link_owner / sender-with-cancel_token** | The two parties to the shipment (and admin). Anonymous third-party sees everything else but item_description is hidden. | More conservative; matches the "the two parties know what's in the box, no one else needs to" intuition. Slight asymmetry: Print/Download (PDF, recipient PII) is anonymous-allowed per Round-2; item_description (sender intent) is more gated than Print. |

**Author lean:** (ii). The asymmetry is deliberate — different threat models, different defaults. PDF availability is functionally useful (anyone helping with the package needs to see it); item description is informational and the failure mode is one-way reputational.

**If T1 = (c), T2 is moot.**

### Status & next step

If you bless T1 + T2 here, I'll lock the proposal, update the body sections inline with the accepted findings, rename to `_decided-2026-05-13`, and start implementation. If you want to discuss, reply with notes and I'll iterate.

## 11. Decision

**Decided 2026-05-13 by John.**

- **T1 = (a)** — migrate `item_description` now. Migration 021 adds `shipments.item_description TEXT NULL`. Labels function accepts + persists `parcel.description`. Sender-flow buy call passes the field. Tracking response returns it. UI surfaces it in all three families' Details.
- **T2 = (i)** — all viewers including anonymous third-party see `item_description`. The Round-2 Option (a) privacy threat-model is explicitly extended to cover sender-declared package contents; transparency wins. Flagged for future-revisit if abuse pattern emerges.

### Final locked scope (consolidates blockers + accepted findings)

The body sections 1–7 are the original proposal of record. The deltas below are what implementation should follow — they override the body where they conflict:

**Schema (B1 + B2 fixes):**
- New migration `021_shipments_item_description.sql`: `ALTER TABLE shipments ADD COLUMN item_description TEXT NULL;`
- Labels function (`supabase/functions/labels/index.ts`): accept optional `description` in request body; persist as `item_description` on the `shipments` row. Backwards-compatible — `NULL` for any caller that doesn't send it.
- Sender flow buy call (`src/lib/api.ts` `buyLabel` or wherever the labels POST is built): include `parcel.description` when present.
- Tracking function: embed addresses via PostgREST — `sender_address:addresses!sender_address_id(city,state), recipient_address:addresses!recipient_address_id(city,state)`. Surface as `from_city / from_state / to_city / to_state` in the response. Also surface `item_description`.

**Print logging (N1 + N3 + N6 fixes):**
- New edge function `label-print` with the 3-path auth shape from cancel-label.
- Shared helper `_shared/actor.ts` extracts auth derivation; both `cancel-label` and `label-print` import it. Unit-tested.
- `is_test=true` shipments: return early without writing to `event_logs`. Avoids pollution + matches 2026-05-13 test-mode-hygiene work.
- Client-side: optimistic increment on Print click; rollback (silent) on POST failure.
- Rate limit: 10/min per (ip + public_code) — chosen separately from cancel's 5/min because prints are a more frequent legitimate action.

**Tracking response (B4 + N2 fixes):**
- `shipment_id` returned only when caller is admin (`profiles.role='admin'` via JWT). Reuses the existing `viewer_is_recipient` JWT-lookup path; no extra round-trip.
- The three `event_logs` queries (cancelled-actor + print-count + last-printed) run via `Promise.all` after the shipment SELECT.

**UI / family composition (N4 + N5 + PP3 + PP4 fixes, plus nits):**
- F1 includes `is_test=true` shipments (TestModeBanner above). Drop "(and not test)" qualifier from §2.1.
- **Drop the `+ $0.00 carrier adjustment` stub line** entirely from this round. Phase G adds the populated line in its own PR with the correct shape (table SUM, not column read).
- `PrintAnotherLabelCTA` is conditional on `status === 'cancelled'`, not on Family 3. `return_to_sender` shipments render Family 3 without the CTA.
- `PrintAnotherLabelCTA` does NOT set `sendmo_just_voided_for_change`. The flag is reserved for the mid-cancel-flow "let's try again" handoff; cold-landing on a cancelled page and clicking "Print another label →" is a fresh start.
- Print-count chip stays a simple "Printed N times" count. The "who printed it" disambiguation lives in `event_logs.properties` (actor + user_id + ip + user_agent + session_id) for admin/support investigation. Phase 2.1 future enhancement: enrich the chip for authorized viewers with last-actor labels. Out of scope here; documented for the next agent.

**Documentation:**
- Verification §6 step 5: replace "Sign in as admin (jsa7cornell@gmail.com)" with "Sign in as any user with `profiles.role='admin'`".

### Test target
- Baseline: 257 passing.
- Add: actor-helper unit tests, family-component unit tests, `logLabelPrint` client unit test, DetailsCard config tests, `AdminAffordanceFooter` visibility tests.
- Target: ~275 passing.

### Status
- Proposal: **decided**. Filename renamed to `_reviewed-2026-05-13_decided-2026-05-13.md` immediately after this commit.
- Implementation starts in the polish session.
