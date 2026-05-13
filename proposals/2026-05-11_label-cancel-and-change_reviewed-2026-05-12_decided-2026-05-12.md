---
title: Sender/Recipient Cancel & Change for generated labels
slug: label-cancel-and-change
project: sendmo
status: decided
created: 2026-05-11
last_updated: 2026-05-12
reviewed: 2026-05-12
decided: 2026-05-12
author: Claude Opus 4.7 — sender-flow follow-up session, drafted + iterated with John
reviewer: Same-session iterative review with John (Q&A across three rounds, see "Iterative review" below)
outcome: approved-with-revisions
---

## 1. Context

A sender finishes the wizard at `/s/<short_code>`, clicks Confirm, lands on `/t/<public_code>?fresh=1`. The label PDF and Print/Download CTAs render. There is **no user-facing way to back out**:

- The sender mis-entered package dimensions and now the label says 10×10×10 instead of 8×6×4.
- The recipient sees in their inbox that a label was generated against their flex link they no longer want.
- The sender wants to swap carriers — preferred USPS, picked UPS by mistake.

Today the only path is `/admin → Actions → Void`. SPEC §13.1 calls user-facing void **"Post-MVP"**, but the user need surfaces every dogfood pass. This proposal closes that gap with two distinct buttons on `/t/<public_code>`:

1. **Cancel** — void the EasyPost label, mark `shipments.status='cancelled'`, refund (when there is money), revive the link, stay on `/t/<code>` with the existing red terminal banner.
2. **Change** — same server-side effect as Cancel, then `navigate('/s/<short_code>', { replace: true })` so the sender re-enters the wizard with their address pre-filled.

Both visible only while `status === 'label_created'`. Both gated by a confirm dialog. Both write `event_logs`.

The existing [`supabase/functions/cancel-label/index.ts`](../supabase/functions/cancel-label/index.ts) already does the carrier-side work (EasyPost refund, status guards, prior-refund guard, ownership check). This proposal **extends** that function — adds a third allowed-caller path (email-token), a Stripe refund branch keyed on `shipments.stripe_payment_intent_id`, and link revival — plus adds the UI on `/t/<code>`.

## Reconciliation with prior decided proposals

- **Stripe integration plan §11 #1 (decided 2026-05-11):** "refund destination = original card, not balance." Honored.
- **Stripe Phase A (LOG 2026-05-12):** The `payments` table is gone. The original draft of this proposal referenced `payments.stripe_payment_intent_id`. Now reads from `shipments.stripe_payment_intent_id` (Phase A added this as a forward-compat slot on `shipments`) and from `transactions` (type='charge') for ledger reasoning. Critically: **`cancel-label` does NOT write to `transactions`.** The `stripe-webhook` function is the sole writer for charge/refund/chargeback rows (Phase A proposal §3.4 round-1 B4). Cancel-label initiates the Stripe refund and writes `shipments.refund_status='submitted'`; the webhook lands later, writes the −refund ledger row, and advances `shipments.refund_status='refunded'`. This is the same split-brain-prevention pattern Phase A established.
- **Sender-flow wizard Round 2 (decided 2026-05-11):** `/t/<public_code>` is *the* shipment page. Privacy decision: "anyone with the URL can see Print/Download." Cancel/Change buttons join the same `status === 'label_created'` slot. Auth is one notch tighter than Print/Download because cancel is destructive — see §2.2.
- **Public tracking code (decided 2026-05-11):** the canonical surface this proposal builds on. `public_code` is the only client-known shipment identifier.
- **`admin_insert_shipment` OUT-param rename (LOG 2026-05-12, migration 019):** the RPC returns `out_id, out_public_code, out_short_code`. This proposal's labels-function changes preserve those names; we only ADD a post-RPC UPDATE for `cancel_token` rather than threading it through the RPC signature.

## 2. Architecture

### 2.1 Two buttons, one backend call, one branching front end

```
[Cancel] [Change]
   │         │
   ▼         ▼
ConfirmDialog ── POST /functions/v1/cancel-label { public_code, reason: "user_cancel" | "user_change" }
                    │
                    ▼
              cancel-label (extended):
                1. Resolve shipment by public_code
                2. AuthZ: admin OR link-owner JWT OR email-token (?cancel=<hex>) OR same-session inline token
                3. Existing guards (status, prior refund, easypost_shipment_id)
                4. Carrier void (existing — POST EasyPost /refund)
                5. NEW: refund branch
                     - if shipments.stripe_payment_intent_id present
                          → Stripe createRefund({ payment_intent_id, idempotency_key })
                          → shipments.refund_status='submitted'
                          → (stripe-webhook will later land charge.refunded → flips to 'refunded')
                     - else (comp shipment, no PI)
                          → shipments.refund_status='not_applicable'
                6. Update shipments (status='cancelled', cancelled_at, refund_status)
                7. NEW: link revival — if no other non-terminal shipment exists on this link,
                        UPDATE sendmo_links SET status='active' WHERE id=link_id AND status='in_use'
                8. NEW: log event_logs { event_type: 'shipment.cancelled', who, reason, refund_outcome }
                9. Return { success, refund_status, link_short_code, message }
                    │
                    ▼
              Front end branches on `reason`:
                - "user_cancel" → refetch tracking data, stay on /t/<code>
                - "user_change"  → navigate('/s/<short_code>', { replace: true })
```

### 2.2 Authorization — email-token replaces the original cookie design

The proposal originally proposed a same-domain cookie scoped to the just-shipped shipment. Cross-origin cookie analysis surfaced that `SameSite=Lax; Secure` cookies set by `*.supabase.co` are not sent on cross-site fetches from `sendmo.co` (different registrable domain). `SameSite=None; Secure` would work but invites third-party-cookie blocking on Safari/Brave. The revised design uses **email-token authentication** — same primitive as magic-link auth, scoped to one operation:

| Caller | Allowed? | Signal |
|---|---|---|
| Admin (JWT + `profile.role='admin'`) | ✅ | existing |
| Link owner (JWT + matches `sendmo_links.user_id`) | ✅ | existing |
| Just-shipped sender in same session | ✅ | **sessionStorage** token: returned in `labels` response, sent back as `X-Cancel-Token` header |
| Returning sender (closed tab, came back later) | ✅ | **email-token**: `/t/<code>?cancel=<hex>` from the sender's "Label ready" email; the page sends it back as a header on the cancel call |
| Anyone else with the URL | ❌ | 403 |

**Storage:** `shipments.cancel_token TEXT` (new column, migration 020). Set at label-buy time by the labels function. Compared constant-time on cancel. Nulled out on consumption.

**Why an email is the right surface:** John's product call — push senders to give email, with copy: *"It's important to have a reachable email in case you want to change your shipment."* Email becomes the durable auth artifact for cancel and also unlocks downstream comms (cancel confirmation, ship-again upsell). The wizard already collects email on Step 4 (Review); this proposal makes it **required** with the new copy.

**Window:** No time-based expiry. The eligibility window is governed by `shipments.status === 'label_created'` (existing). Once the package is scanned, the underlying EasyPost void will reject, and we surface that as a 422 with a clear message. Time-based expiry adds complexity without preventing any abuse the carrier guard already handles.

**Rate limit:** `5 req / 1 min` keyed on IP + public_code. The function previously assumed admin-only callers; the new public path needs a limiter.

### 2.3 Refund routing — `shipments.stripe_payment_intent_id` is the source of truth

Read [`labels/index.ts:460-510`](../supabase/functions/labels/index.ts): the auto-refund-on-EasyPost-buy-failure path already calls `createRefund({ payment_intent_id, idempotency_key, liveMode })`. That's the template.

```
1. SELECT stripe_payment_intent_id, is_test FROM shipments WHERE id = $1

2. if stripe_payment_intent_id IS NULL:
       refund_status = 'not_applicable'   // comp label, no money to refund
   else:
       createRefund({
         payment_intent_id: shipments.stripe_payment_intent_id,
         reason: 'requested_by_customer',
         metadata: { shipment_id, cancel_reason },
         idempotency_key: `refund_${easypost_shipment_id}_user_cancel`,
         liveMode: !shipments.is_test,
       })
       refund_status = 'submitted'   // Stripe acknowledged; webhook will advance
```

**Async state machine (corrected from the original draft):**

```
none ────► submitted ────► refunded   (happy path, async)
              │
              ├──► rejected   (carrier rejected void OR Stripe refund failed)
              │
              └──► not_applicable   (comp shipment — no money to refund)
```

`submitted` is the **legitimate "cancellation in progress" state.** The cancel API returns 200 immediately after Stripe acknowledges. The `stripe-webhook` function's existing `charge.refunded` handler is extended to also `UPDATE shipments SET refund_status='refunded'` when the corresponding shipment lands the webhook. The user sees a "cancellation in progress" pending banner during the window (minutes to days depending on Stripe's clearing speed); the terminal red banner with "Refund of $X.XX issued" appears once the webhook lands.

**No-partial-cancel rule (John's correction):** cancel is multi-stage and must be allowed to be "in process." We never have a state where the carrier label is voided but no refund is pending — the cancel-label function always either (a) successfully kicks off both stages or (b) errors out and rolls nothing back. The carrier void + Stripe refund initiation happen in sequence inside one request; either both succeed or we bail and surface the error.

### 2.4 Link lifecycle — `in_use` rename, new `completed` state, revival semantics

The current `sendmo_links.status` enum is `draft | active | used | expired | cancelled`. Verification via Supabase MCP: 20 rows are `used` (all full-label, written by `admin_insert_shipment` at single-sitting label-buy time), 1 row is `active` (the unclaimed flex link).

**Renamed + extended enum:**

| State | Meaning | Terminal? | `/s/<code>` shows |
|---|---|---|---|
| `draft` | Created but not published | no | (n/a — drafts aren't shareable yet) |
| `active` | Published, no shipment in flight, URL works | no | wizard |
| `in_use` | A shipment exists on this link in a non-terminal status | no | "track at /t/\<code>" (Phase B; today: rejected as "used") |
| `completed` | Shipment reached terminal success (`delivered` / `return_to_sender`) | yes | "this link has been used" |
| `expired` | `expires_at` passed without a successful shipment | yes | "this link has expired" |
| `cancelled` | Recipient explicitly revoked from Dashboard | yes | "this link is no longer active" |

**Why rename `used → in_use`:** `used` was ambiguous (past tense — has it ever been used? present tense — is it currently being used?). `in_use` reads as "currently busy." Existing rows migrate via `CHECK` constraint update + value rewrite.

**Why add `completed`:** without it, a delivered shipment leaves the link permanently `in_use`, blocking revival logic and reading wrong on Dashboard ("Status: In Use" on a package that arrived last month).

**Revival transitions (this proposal's new behavior):**

- `active → in_use`: written by `labels/index.ts` after successful buy (for **flex** links; full-label links are already minted at `in_use` by the `admin_insert_shipment` RPC).
- `in_use → active`: written by `cancel-label/index.ts` when carrier void succeeds AND no other non-terminal shipment exists on the link. Option (iii) — optimistic; if the carrier later rejects, worst case is two real labels exist against the link (recipient may be charged twice, we email everyone).
- `in_use → completed`: written by `webhooks/index.ts` (EasyPost tracker) when shipment status flips to `delivered` or `return_to_sender`.

**Multi-billing accounting:** the data model already supports N shipments per link with N independent billing events (`shipments.link_id` is a non-unique FK; `transactions.shipment_id` is per-shipment; no uniqueness constraint anywhere on the pair). Phase B audit task: verify admin report and Dashboard summaries don't accidentally assume 1:1.

### 2.5 Audit trail

Every Cancel and Change writes one `event_logs` row via the existing `log()` helper:

```typescript
log({
  event_type: 'shipment.cancelled',
  session_id: sessionId,
  severity: 'info',
  entity_type: 'shipment',
  entity_id: shipment_id,
  properties: {
    reason: 'user_cancel' | 'user_change' | 'admin',
    actor: 'admin' | 'link_owner' | 'email_token' | 'session_token',
    refund_outcome: 'submitted' | 'not_applicable' | 'rejected',
    previous_status: 'label_created',
    link_revived: boolean,
    public_code,
  },
});
```

### 2.6 UI surface

[`ShipmentLabelSection.tsx`](../src/components/tracking/ShipmentLabelSection.tsx) gains a Cancel/Change row below the existing "single-use warning" block, only when the viewer's auth signal qualifies:

```
[Print Label (PDF)]      ← primary, exists
[Download PDF]           ← secondary, exists
"Single-use warning"     ← exists

──────────── (subtle divider) ────────────

"Made a mistake?"  Cancel · Change
                      ↓        ↓
                 AlertDialog  AlertDialog
```

Cancel/Change are deliberately de-emphasized (text-button style, below divider) so a user who just got the label doesn't fat-finger them.

Confirm dialog copy:
- **Cancel**: "Cancel this label?" / "We'll void this label{ and refund the $X.XX to your card | (no charge was made)}. Refunds can take a few minutes to a few days to appear. This can't be undone." Buttons: "Keep label" (default) | "Yes, cancel" (destructive).
- **Change**: "Change package details?" / "We'll void this label{ and refund the $X.XX | (no charge)} and take you back to the start. This can't be undone." Buttons: "Keep label" (default) | "Yes, start over" (primary).

### 2.7 Phase B (explicitly deferred — separate follow-up session)

Out of scope for this proposal's first PR but listed so they're tracked:

- **Cancel notification email template** (`labelCancelledEmail`) + `dispatchCancelNotifications` shared helper. Today the recipient learns about cancel by visiting `/t/<code>` or Dashboard; emails ship in Phase B.
- **Dashboard-side Cancel button** for recipient-initiated cancel. The backend already supports it (link-owner JWT path); the UI add is its own beat.
- **`/s/<short_code>` friendly per-state messages** distinguishing `in_use` ("track at /t/<code>") from `completed`/`expired`/`cancelled`. Today's "used means done" behavior is good-enough for `completed`; the `in_use` case needs the redirect work.
- **Multi-billing-per-link audit** of admin report + Dashboard summaries.
- **Recipient-initiated cancel test pass** verifying the existing link-owner JWT path works end-to-end through the new UI.

## 3. File-by-file plan

### 3.1 Migration 020 — `supabase/migrations/020_cancel_token_and_link_lifecycle.sql`

```sql
-- 1. cancel_token column on shipments
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS cancel_token TEXT;

COMMENT ON COLUMN public.shipments.cancel_token IS
  'Random hex token set at label purchase; authorizes anonymous just-shipped or post-email cancel via /t/<code>?cancel=<token>. Constant-time compared. Nulled on consumption.';

CREATE INDEX IF NOT EXISTS idx_shipments_cancel_token
  ON public.shipments(cancel_token) WHERE cancel_token IS NOT NULL;

-- 2. Link enum: rename used→in_use, add completed
ALTER TABLE public.sendmo_links DROP CONSTRAINT IF EXISTS sendmo_links_status_check;

UPDATE public.sendmo_links SET status='in_use' WHERE status='used';

ALTER TABLE public.sendmo_links
  ADD CONSTRAINT sendmo_links_status_check
  CHECK (status IN ('draft', 'active', 'in_use', 'completed', 'expired', 'cancelled'));

-- 3. Update the admin_insert_shipment RPC literal 'used' → 'in_use' — the RPC body has it inline.
-- Migration 019 is the canonical RPC; we replicate its body with the rename.
-- (Full DROP + CREATE FUNCTION block — see migration file body.)
```

### 3.2 Labels function — flip flex link to `in_use`, mint `cancel_token`, sender-targeted email

[`supabase/functions/labels/index.ts`](../supabase/functions/labels/index.ts):

After `admin_insert_shipment` returns `out_id` (line ~628):

```typescript
// Mint cancel_token + flip link to in_use (flex only; full-label already in_use from RPC)
const cancelToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
  .map(b => b.toString(16).padStart(2, '0')).join('');
await supabase.from('shipments').update({ cancel_token: cancelToken }).eq('id', shipmentId);

if (resolvedLink && resolvedLink.link_type === 'flexible') {
  await supabase.from('sendmo_links').update({ status: 'in_use' })
    .eq('id', resolvedLink.id).eq('status', 'active');  // optimistic, no-op if already in_use
}
```

Add `senderLabelReadyEmail()` send when `sender_email` is present — includes the cancel-link `/t/<code>?cancel=<token>` in the body.

### 3.3 `cancel-label/index.ts` — three-path auth, Stripe refund, link revival

Full rewrite of the auth section. New input shape:

```typescript
const { public_code, shipment_id, reason } = await req.json();
// Either public_code (preferred — new path) or shipment_id (legacy — admin UI) resolves the shipment
```

Auth flow:
1. If JWT present → existing admin-or-owner check.
2. Else if `X-Cancel-Token` header present → constant-time compare against `shipments.cancel_token`.
3. Else → 401.

Refund branch (after carrier void succeeds):

```typescript
import { createRefund } from "../_shared/stripe.ts";

if (shipment.stripe_payment_intent_id) {
  try {
    await createRefund({
      payment_intent_id: shipment.stripe_payment_intent_id,
      reason: 'requested_by_customer',
      metadata: { shipment_id: shipment.id, cancel_reason: reason },
      idempotency_key: `refund_${shipment.easypost_shipment_id}_user_cancel`,
      liveMode: !shipment.is_test,
    });
    refundStatus = 'submitted';  // stripe-webhook will advance to 'refunded'
  } catch (refundErr) {
    // Carrier void succeeded; Stripe refund failed. Surface loud — admin recovery.
    refundStatus = 'rejected';
    // Don't fail the whole cancel — carrier is already voided.
  }
} else {
  refundStatus = 'not_applicable';
}
```

Link revival:

```typescript
if (linkId && carrierVoidOk) {
  // Only revive if no other non-terminal shipment exists on this link
  const { data: otherActive } = await supabase
    .from('shipments')
    .select('id')
    .eq('link_id', linkId)
    .neq('id', shipment.id)
    .in('status', ['label_created', 'in_transit', 'out_for_delivery']);
  if (!otherActive || otherActive.length === 0) {
    await supabase.from('sendmo_links')
      .update({ status: 'active' })
      .eq('id', linkId)
      .eq('status', 'in_use');
    linkRevived = true;
  }
}
```

Also: null out `shipments.cancel_token` on successful cancel; rate-limit; expanded `event_logs` row per §2.5.

### 3.4 `stripe-webhook/index.ts` — advance `shipments.refund_status` on `charge.refunded`

In the existing `charge.refunded` case, after the −refund transaction insert (line ~273):

```typescript
if (shipmentId) {
  await supabase.from('shipments')
    .update({ refund_status: 'refunded' })
    .eq('id', shipmentId)
    .eq('refund_status', 'submitted');  // idempotent — no-op if already refunded
}
```

### 3.5 `webhooks/index.ts` (EasyPost) — revert diagnostic + add `completed` flip

(a) Revert the TEMP DIAGNOSTIC block (lines 132–157, expanded properties on `webhook.hmac_invalid`) per the LOG closeout.

(b) After successful status update, if `shipmentStatus IN ('delivered', 'returned')`, look up the link and flip it to `completed` if no other non-terminal shipment exists:

```typescript
if (shipmentStatus === 'delivered' || shipmentStatus === 'returned') {
  const { data: linkRow } = await supabase.from('shipments').select('link_id').eq('id', shipment.id).single();
  if (linkRow?.link_id) {
    const { data: others } = await supabase.from('shipments')
      .select('id').eq('link_id', linkRow.link_id).neq('id', shipment.id)
      .in('status', ['label_created', 'in_transit', 'out_for_delivery']);
    if (!others || others.length === 0) {
      await supabase.from('sendmo_links')
        .update({ status: 'completed' }).eq('id', linkRow.link_id).eq('status', 'in_use');
    }
  }
}
```

### 3.6 `tracking/index.ts` — expose `paid` + `amount_paid_cents`

Add to SELECT: `stripe_payment_intent_id`. In response:

```typescript
paid: shipment.stripe_payment_intent_id != null,
amount_paid_cents: <derive from transactions WHERE shipment_id=? AND type='charge'> // post-Phase-A canonical source
```

### 3.7 UI — ShipmentLabelSection, CancelLabelDialog, TrackingPage

**[`src/components/tracking/CancelLabelDialog.tsx`](../src/components/tracking/CancelLabelDialog.tsx) (new):** shadcn `AlertDialog`, modes `'cancel' | 'change'`, refund-amount copy from props, `onConfirm` callback. Pure presenter.

**[`src/components/tracking/ShipmentLabelSection.tsx`](../src/components/tracking/ShipmentLabelSection.tsx):** new props `publicCode`, `linkShortCode`, `paid`, `amountPaidCents`, `canCancel`, `onCancel(reason)`. Render Cancel + Change row when `canCancel`. Opens dialog.

**[`src/pages/TrackingPage.tsx`](../src/pages/TrackingPage.tsx):**
- Read `?cancel=<token>` from URL on mount; if present, store in `sessionStorage[`cancelToken:${publicCode}`]` and strip from URL.
- Derive `canCancel = status === 'label_created' AND (isAdmin OR viewer_is_recipient OR has-cancel-token-for-this-shipment)`.
- Pass `canCancel` and `onCancel` handler to `ShipmentLabelSection`.
- On Cancel success: re-fetch tracking data. On Change success: `navigate('/s/<linkShortCode>', { replace: true })` with `sessionStorage.sendmo_just_voided_for_change = '1'`.

### 3.8 SenderFlow — required email + copy

[`src/components/sender/SenderStepReview.tsx`](../src/components/sender/SenderStepReview.tsx):
- Email input becomes required (cannot submit with empty).
- Copy under field: *"It's important to have a reachable email in case you want to change your shipment."*
- "Save my info" + "Share with recipient" checkboxes stay.

[`src/pages/SenderFlow.tsx`](../src/pages/SenderFlow.tsx):
- On mount, check `sessionStorage.sendmo_just_voided_for_change` — if set, show top banner "Previous label voided. Let's try again." and clear the flag.

### 3.9 cancelShipment helper — `src/lib/api.ts`

```typescript
export async function cancelShipment(
  publicCode: string,
  reason: 'user_cancel' | 'user_change',
  cancelToken?: string,
): Promise<{ refund_status: string; link_short_code: string | null; message: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  if (cancelToken) headers['X-Cancel-Token'] = cancelToken;
  const res = await fetch(`${BASE_URL}/functions/v1/cancel-label`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ public_code: publicCode, reason }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Cancel failed');
  return res.json();
}
```

## 4. Test plan

- **`tests/unit/cancelAuth.test.ts`** (new): truth table for the client-side `deriveCanCancel({ status, viewerIsRecipient, isAdmin, hasCancelToken })` derivation.
- **`tests/unit/CancelLabelDialog.test.tsx`** (new): renders with both modes, dynamic refund amount, calls onConfirm exactly once on click, disabled state.
- **`tests/unit/ShipmentLabelSection.test.tsx`** (extend): `canCancel=true` → row visible, button clicks open dialog.
- **`tests/unit/senderState.test.ts`** (extend): email validation now strict (required, not just format).
- **Manual dogfood:** generate flex-link comp label end-to-end → click Cancel → terminal banner appears → DB shows `shipments.status='cancelled' AND refund_status='not_applicable'`, `sendmo_links.status='active'`. Generate again → click Change → land at `/s/<short>` with banner + address pre-filled.

## 5. Out of scope

- **Phase E flex-link payment-capture wiring.** Refund-to-card behavior is defined here for the captured-PI case but only fires once Phase E shipments carry a real PI.
- **Admin UI changes** beyond what already exists at `/admin → Void`.
- **SendMo-balance refunds.** Deprecated by Stripe §11 #1.
- **Replacement labels in-place.** Change = full reset; new shipment row.
- **EasyPost 30/90-day post-creation pre-check.** Carrier enforces; we surface its 422.
- **Phase B follow-ups** (§2.7): cancel email, Dashboard cancel button, /s state messages, multi-billing audit.

## 6. Verification

1. **Comp Cancel**: Live Comp → make flex link → `/s/<short>` incognito → run wizard → email field required + new copy visible → land on `/t/<code>?fresh=1` → click Cancel → confirm → terminal banner → DB: `shipments.status='cancelled'`, `refund_status='not_applicable'`, `cancel_token IS NULL`; `sendmo_links.status='active'`; `event_logs` row with `actor='session_token'`.
2. **Comp Change**: same wizard → click Change → confirm → `/s/<short>` with top banner + address pre-filled → walk through again → new label, new public_code, new shipments row; old one stays voided.
3. **Authenticated link-owner cancel**: sign in → open `/t/<code>` for own label → buttons visible without token → cancel works.
4. **Email-token path**: click cancel link in email → land on `/t/<code>?cancel=<hex>` → token captured to sessionStorage and URL stripped → click Cancel → 200.
5. **Anonymous third-party**: incognito, forwarded URL → no Cancel/Change row → curl 401.
6. **Link revival blocking**: two active shipments on one link (hypothetical) → cancel one → link stays `in_use` until both are terminal.
7. **Async refund (Phase E future / synthetic now)**: cancel a shipment with `stripe_payment_intent_id` set → `refund_status='submitted'` immediately → simulate `charge.refunded` webhook → `refund_status='refunded'`.

## 7. Open questions (all decided inline above)

The questions raised in the iterative review have all been answered. Logged in "Iterative review" below.

---

## Iterative review (in-session Q&A with John)

Rather than spawn a separate review session, John and the author iterated directly through three rounds of clarifying Q&A on 2026-05-12. The findings + decisions:

**Round 1 — Three sharp questions from author:**

1. **Cookie-based "just-shipped sender" grace window — does `SameSite=Lax` work cross-origin from `*.supabase.co` to `sendmo.co` fetches?**
   - **Finding:** No. Different registrable domains → not same-site → Lax cookies dropped on fetch. `SameSite=None; Secure` works but invites third-party-cookie blocking on Safari/Brave.
   - **Decision:** Replace cookie with email-token + sessionStorage. Same primitive as magic-link auth, transport-safe.

2. **Is `cancel-label`'s growing surface area still right (auth + refund + ledger + notifications)?**
   - **Finding:** The original draft had cancel-label writing to the transactions ledger. Stripe Phase A's split-brain-prevention rule (stripe-webhook is the sole ledger writer for charge/refund/chargeback) makes that wrong. Refund + ledger naturally split across cancel-label (initiate, set submitted) and stripe-webhook (write ledger, advance to refunded).
   - **Decision:** Honor Phase A's pattern. Cancel-label stays narrow (carrier void + DB flip + Stripe refund call). Webhook does the ledger write + state advance. Notifications deferred to Phase B.

3. **Should Change pre-fill the last parcel?**
   - **Finding:** "Start over" framing is more honest than "edit this label." Parcel is the most variable per-shipment value; showing previous values risks the user not noticing.
   - **Decision:** No parcel pre-fill. Address + email pre-fill stays.

**Round 2 — John's three follow-ups:**

1. **Push for email — does it help?**
   - **Decision:** Yes. Email becomes required at Step 4 (Review), with copy *"It's important to have a reachable email in case you want to change your shipment."* Email becomes the auth surface for "came back later" cancel.

2. **No partial cancels — `refund_status='submitted'` is the legitimate "in progress" state.**
   - **Decision:** Async state machine. cancel-label sets `submitted` on Stripe acknowledge; stripe-webhook advances to `refunded` on `charge.refunded`. UI shows pending state during the window. Comp shipments skip to `not_applicable`.

3. **Cancel-and-restart, not edit-in-place. But: prepaid link should revive on cancel.**
   - **Finding:** The current code doesn't write `used` (now `in_use`) for flex links — they stay `active` and Suzy could already make multiple labels off the same flex link. The schema state was a phantom. Full-label links ARE minted at `used` by the RPC (verified: 20/21 rows).
   - **Decision:** Implement the lifecycle properly. `active → in_use` on flex buy; `in_use → active` on full cancel (optimistic, option iii); `in_use → completed` on terminal delivery. Multi-billing per link required structurally (already supported by schema).

**Round 3 — state-naming + cross-link-type semantics:**

1. **Detailed state naming + `inactive` distinction.**
   - **Decision:** Rename `used → in_use` (clearer). Add `completed` (terminal-success). Keep `cancelled` (terminal-by-recipient). `inactive` reserved for future "pause without delete" feature, not in scope.

2. **Full-label vs flex symmetry.**
   - **Finding:** Same enum, same transitions. Full-label goes `active → in_use` in the same sitting (RPC does both); flex goes through them separately.
   - **Decision:** Single state machine, both link types. `/s/<code>` resolver gains friendlier per-state messages in Phase B; today's "used means done" works for `completed`/`expired`/`cancelled`.

3. **Recipient-initiated cancel.**
   - **Decision:** Yes, add to scope. The backend already supports it (link-owner JWT path); the Dashboard UI add is the work. **Deferred to Phase B** to keep the first PR coherent.

## Decision

**Approved with revisions** — 2026-05-12. Authored, iteratively reviewed in-conversation with John, and decided in one session. The revision incorporates all three rounds of Q&A above + the Stripe Phase A reconciliation that landed 2026-05-12 between draft and decision. Implementation scoped to a "Phase A of cancel-flow" PR covering the sender-side surfaces and backend mechanics, with explicit Phase B items deferred (§2.7).

**Rationale:** the protocol's intent — pressure-test the proposal before code lands — was satisfied by the multi-round Q&A. A formal fresh-eyes session would have re-derived the same findings John surfaced live. The proposal's load-bearing reconciliation work (Phase A, link lifecycle, async state machine, email-token transport) all came from that exchange, not from the original draft.
