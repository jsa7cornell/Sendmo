---
title: Sender-side visibility for flex shipments (confirmation email + dashboard record)
slug: flex-sender-visibility
project: sendmo
status: in-review
created: 2026-07-06
last_updated: 2026-07-06
reviewed:
decided:
author: Claude (Fable 5) — launch-week session, 2026-07-06; surfaced twice during John's first live flex dogfood (no sender email, no sender dashboard entry)
reviewer:
outcome:
---

> **Why a proposal:** both halves reverse or extend decided designs — the
> payer-only creation email (decided 2026-06-27/28) and the sender-as-anonymous
> model (Pattern D). Two surprises in one dogfood session is signal, but
> deliberate reversal needs a deliberate decision, not a drive-by patch.

## 1. Context

During the first live flex transaction (24W301E, 2026-07-05), John hit two
surprises from the sender's seat:

1. **No email.** The sender (`testerjohnanderson`) printed a real UPS label and
   got no confirmation — no copy of the label, no tracking link. By design: the
   label-creation email goes to the **payer only** (decided 2026-06-28
   "package-centric" model; for flex, payer = the link owner).
2. **No dashboard record.** Logged in as the sender, the shipment doesn't
   appear. Also by design: flex senders are anonymous parties using someone
   else's link; the shipment belongs to the link owner. `Dashboard.tsx` scopes
   to `sendmo_links.user_id = auth.uid()`.

Both behaviors are defensible. But the sender is the person **physically
holding the package**: they need the label again when the printer jams, and
the tracking link when they want to confirm drop-off. Today their only
artifact is the `/t/<code>` URL they landed on — if they close the tab,
they have nothing. Two independent "where is it?" moments in the first real
session says the current model under-serves the sender.

**What doesn't change:** who pays, who owns the shipment, link privacy (Rule 7
— sender never sees the recipient's full address), and the payer's existing
email.

## 2. Architecture (current → proposed)

```
TODAY                                   PROPOSED
─────                                   ────────
label bought (flex)                     label bought (flex)
 ├─ email → payer (link owner) only     ├─ email → payer (unchanged)
 └─ shipment → owner's dashboard        ├─ email → sender: "You shipped this"
                                        │    (label link + /t/ tracking link)
                                        └─ shipment → owner's dashboard
                                             (unchanged)
                                        Sender dashboard: NO change in v1
                                        (see §5 — deferred, weaker case)
```

**Recommended scope split — do the email, defer the dashboard:**

- **A. Sender confirmation email (recommended now).** The sender's email is
  already captured at Step 4 of the sender flow (required since 2026-05-12,
  "in case you want to change your shipment") and already stored as a
  `notification_contacts` row with `role='sender'`. The dispatcher
  (`dispatchNotifications`) already fans out tracking emails to that contact.
  The only gap is the *creation-time* email. Cost: one template variant + one
  dispatcher rule change. The email is the sender's durable handle on the
  label + tracking page.
- **B. Sender dashboard entry (defer).** "Shipments I sent via others' links"
  requires an account-identity link that mostly doesn't exist — senders are
  usually anonymous at print time (no JWT on the flex buy path). Building it
  means either (a) associating by email match at login (privacy questions:
  entering an email at checkout ≠ proving you own it — showing shipments
  keyed to an unverified email leaks shipment data to anyone who typed that
  address), or (b) prompting senders to create accounts mid-flow (friction the
  sender flow was explicitly designed to avoid). The email (A) covers the
  actual need — re-access to label + tracking — without new identity
  machinery. Revisit if real senders ask for history.

## 3. File-by-file plan (scope A only)

1. **`supabase/functions/_shared/email-templates.ts`** — extend
   `labelConfirmationEmail` with an `audience: "payer" | "sender"` param (or a
   sibling `senderLabelEmail`). Sender copy: subject "You shipped a package —
   label + tracking inside"; body = label link (print again), `/t/<code>`
   tracking link, carrier + ETA, "Paid by the link owner — no charge to you"
   line (reuses the `PaidByRecipientBlock` framing). No price shown (the
   sender didn't pay; per the 2026-06-28 decision the payer's copy carries the
   price).
2. **`supabase/functions/_shared/notifications.ts`** — the
   `LABEL_CREATED_EVENT` routing currently skips non-payer contacts
   (`contact.role !== payerRole → skip`). Change: on the **flex** path
   (`ctx.is_flex`), also dispatch to the `sender` contact with the sender
   variant. Full-label path unchanged (payer *is* the sender there — no
   double-send). The existing `notifications_log` (shipment, contact, event)
   guard already dedupes.
3. **`labels/index.ts`** — no routing change needed (contacts already stored).
   Verify the self-send dedupe (owner ships to self via own link) keeps one
   contact on the payer role — in that case the payer email already covers it
   and no sender email fires (correct: same inbox).
4. **Tests** — `tests/unit/notifications.test.ts` + `emailTemplates.test.ts`:
   flex → payer gets payer copy AND sender gets sender copy; full-label →
   payer only (regression); self-send flex → exactly one email; sender copy
   contains label URL + tracking URL and no price.

Estimated size: ~120 LOC + tests. No schema change, no new env vars.

## 4. Test plan

Unit as above (the dispatcher + template contracts are already unit-covered —
extend the same files). Live verification: John re-runs the sender flow with
`testerjohnanderson` → confirm the sender inbox gets "You shipped a package"
with working label + tracking links, and jsa7cornell still gets the payer
email. Check `notifications_log` shows two `label_created` rows (one per
contact role).

## 5. Out of scope

- Sender dashboard/history (deferred — see §2B rationale).
- Any change to full-label emails, payer copy, pricing display, or tracking
  emails (senders already receive those via the `sender` contact role).
- SMS/push channels.

## 6. Verification (post-implementation walkthrough)

1. Flex buy with distinct sender + owner emails → 2 creation emails, correct
   copy each, `notifications_log` has 2 `label_created` rows.
2. Flex self-send (owner = sender inbox) → exactly 1 email (payer copy).
3. Full-label buy → exactly 1 email (payer copy) — unchanged.
4. Sender email's label link opens the PNG; tracking link opens `/t/<code>`.

## 7. Open questions

- **OQ1 — copy stance on the label link.** Include the raw EasyPost label URL
  (convenient, but it's the public unsigned URL — PRE-LAUNCH T3-4 wants it
  signed eventually) or link only to `/t/<code>` where the label button
  already lives? Recommend `/t/<code>` only — one durable surface, and it
  doesn't further propagate the unsigned URL.
- **OQ2 — send timing.** Immediately at label creation (recommended — matches
  payer email) vs. only after first tracking event.
- **OQ3 — does the payer's flex copy need a tweak** to mention "the sender
  also received a copy," or leave it silent? Recommend silent (less copy
  churn).
