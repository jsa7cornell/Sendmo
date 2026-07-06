---
title: Sender-side visibility for flex shipments (confirmation email + dashboard record)
slug: flex-sender-visibility
project: sendmo
status: reviewed
created: 2026-07-06
last_updated: 2026-07-06 (round-1 addendum appended by second reviewer)
reviewed: 2026-07-06
decided:
author: Claude (Fable 5) — launch-week session, 2026-07-06; surfaced twice during John's first live flex dogfood (no sender email, no sender dashboard entry)
reviewer: Claude (Opus 4.8) — fresh-eyes reviewer, 2026-07-06; verified every claim against notifications.ts, email-templates.ts, labels/index.ts (contacts block 1580-1717), Dashboard.tsx, and the decided 2026-06-27 label-confirmation proposal. Round-1 addendum by a second independent reviewer (Claude, Fable 5, 2026-07-06) — adds B3: the sender creation email was already DECIDED 2026-05-12 (senderLabelReadyEmail + cancel token) and never shipped; this proposal is drift-restoration, and the email must carry ?cancel=<token>
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

## Review

> **reviewer:** Claude (Opus 4.8) — fresh-eyes reviewer, no prior context on this feature; verified every cited routing/dedupe claim against `_shared/notifications.ts`, `_shared/email-templates.ts`, `labels/index.ts` (the real contacts-build block at 1580-1717), `Dashboard.tsx`, `PaidByRecipientBlock.tsx`, and the decided 2026-06-27 label-confirmation proposal in full.
> **reviewed_at:** 2026-07-06
> **verdict:** approve-with-changes

### Summary

The scope call is right: ship the sender confirmation email (A), defer the dashboard (B) — the identity/privacy argument in §2B is sound and matches how the flex buy path works (anonymous sender, no JWT). The feature is genuinely additive and does **not** double-send on any path — I traced full-label, self-send flex, and the `notifications_log` key and all three are clean. **But the proposal describes the code it's about to change incorrectly in two load-bearing places** (§3.2's account of the dispatcher guard, and §3.1's account of the template signature), and both misdescriptions point an implementer at the wrong edit. Neither is fatal to the design — they're "the map doesn't match the territory" problems that need fixing before build so the implementer doesn't relitigate the just-decided 2026-06-27 model. Hence approve-with-changes, not approve.

### Blocking issues

**B1 — §3.2 misstates the dispatcher's current routing. The `sender` contact is NOT "skipped as non-payer" on flex — on flex the payer *is* the recipient contact, and the sender is exactly the role that needs newly enabling.**
- *Location:* §3.2 — "the `LABEL_CREATED_EVENT` routing currently skips non-payer contacts (`contact.role !== payerRole → skip`). Change: on the **flex** path, also dispatch to the `sender` contact."
- *Issue:* The actual guard is [`notifications.ts:116`](../supabase/functions/_shared/notifications.ts): `const payerRole = ctx.is_flex ? "recipient" : "sender";` then line 120 skips any `contact.role !== payerRole`. So on flex, `payerRole = "recipient"` (the link owner), and the creation email today goes to the **recipient** contact, while the **sender** contact is the one skipped. The proposal's phrasing ("skips non-payer contacts … also dispatch to the sender") is directionally right about the *outcome wanted* but wrong about the *mechanism* — it reads as if the sender is currently the payer-role on flex, which is the exact inversion the 2026-06-27 proposal spent its whole review defusing. An implementer who takes §3.2 literally could edit `payerRole` or the full-label branch by mistake. The correct change is narrow: **on flex only, deliver LABEL_CREATED to BOTH the `recipient` (owner, existing) AND the `sender` (new) contact** — e.g. replace the single-role skip with a per-flow allowed-role set (`is_flex ? {recipient, sender} : {sender}`). Full-label MUST stay `{sender}`-only (recipient excluded) to preserve the decided package-centric model.
- *Suggested fix:* Rewrite §3.2 to state the guard as it exists (`payerRole` at line 116, skip at 120) and describe the change as "widen the flex allowed-roles to include `sender`," explicitly noting full-label is untouched. Add a one-line assertion that the sender gets a *different template* than the owner (see B2) so the owner's "created with your prepaid link" copy isn't sent to the sender.

**B2 — §3.1 proposes an `audience: "payer" | "sender"` param, but the template's decided axis is `variant: "full_label" | "flex"` (required, no default, decided 2026-06-27). Adding a parallel `audience` axis re-litigates a 9-day-old decision and trips Rule 6.**
- *Location:* §3.1 — "extend `labelConfirmationEmail` with an `audience: "payer" | "sender"` param."
- *Issue:* [`email-templates.ts:77`](../supabase/functions/_shared/email-templates.ts) already takes `variant: "full_label" | "flex"`, made required-with-no-default *specifically* so a future caller can't silently inherit wrong copy (the 2026-06-27 decision, §3.1 note + Decision block). Introducing a second orthogonal `audience` axis on the same function is a parallel construct next to the one that just shipped — precisely the "one-off / parallel system" Global Rule 6 says to avoid, and it would force every existing caller (`notifications.ts:62`, plus the labels fallback at [1663](../supabase/functions/labels/index.ts)) to now pass *both* axes. The sender email is a genuinely new third copy variant; the clean extension is a third `variant` value (e.g. `"flex_sender"`) or a sibling `senderLabelEmail()` function — the proposal's own parenthetical "(or a sibling `senderLabelEmail`)" is actually the better half of its own sentence. Pick one and drop `audience`.
- *Suggested fix:* Extend `variant` to `"full_label" | "flex" | "flex_sender"` (dispatcher passes `flex_sender` when routing to the `sender` contact on flex), OR add a sibling `senderLabelEmail()`. Either way, do not add an `audience` param. Update §3.1's signature sketch and the §4 test names to match the real `variant` axis.

### Non-blocking concerns

**N1 — §3 point 3's self-send description is imprecise, though the behavior it wants is already correct.** §3 point 3 says "Verify the self-send dedupe (owner ships to self via own link) keeps one contact on the payer role." The actual dedupe ([labels/index.ts:1604-1607](../supabase/functions/labels/index.ts)) keys on `senderAddr.toLowerCase() === recipientAddr.toLowerCase()` and, when equal, stores a single contact on `payerRole` (which is `recipient` for flex). Consequence for THIS feature: in the sameInbox case there is **no `sender` contact row at all**, so the new sender dispatch fires zero extra emails and the inbox gets exactly one email — the desired outcome, achieved for free. Worth restating precisely in §3 so the implementer doesn't add a redundant dedupe at send time (the contact-build dedupe already handles it). Also note the dedupe compares the *sender's* email to the *owner's* email — the common "owner tests their own link" case (owner types their own address as sender) collapses correctly; a sender who happens to share the owner's email is rare but also handled.

**N2 — Privacy (Rule 7): emailing the sender is not a new leak, but the label-link choice in OQ1 is where a leak could sneak in.** The sender already physically holds/prints the label (which carries the recipient's full address — unavoidable, it's a shipping label), so a confirmation email to the sender doesn't expose anything they don't already have. The one real risk is OQ1's "raw EasyPost label URL" option: that URL is public + unsigned (PRE-LAUNCH T3-4), so putting it in an email propagates an unauthenticated handle to the label. The proposal's own OQ1 recommendation (`/t/<code>` only, don't propagate the raw URL) is the right call — I'd promote it from "recommend" to "decided" in the plan. Separately, confirm the `/t/<code>` page rendered for a sender doesn't surface the recipient's *full street address* (it shows city/state + name via `PaidByRecipientBlock` and the tracking header — verify the sender view stays city/state-only, matching Rule 7, since the email is now actively driving senders to that page).

**N3 — "already stored as a `notification_contacts` row with `role='sender'`" is true only when the sender entered an email.** §2A states the sender contact "is already stored." Verified: [SenderFlow.tsx:167](../src/pages/SenderFlow.tsx) passes `sender_email`, and labels/index.ts pushes the `sender` row when it's a non-empty string ([1591-1613](../supabase/functions/labels/index.ts)). Sender email is required at Step 4, so in practice the row exists — but a comp/admin flex label or any path that omits `sender_email` yields no sender row and no sender email. That's the correct fail-safe (no address → no send), but §2A slightly over-claims ("already stored" reads as unconditional). One clause noting "when the sender provided an email (required in the sender wizard)" closes it.

**N4 — The dispatcher's `NotificationContext` currently has no field to distinguish which template a `sender`-role contact should get.** Today the `email` handler ([notifications.ts:52-63](../supabase/functions/_shared/notifications.ts)) picks the template purely from `eventType` and `ctx.is_flex`. Once the sender contact is also a LABEL_CREATED recipient on flex, the handler needs to emit the *sender* copy for the sender row and the *owner* copy for the recipient row — i.e. the template choice now depends on `contact.role`, not just event+flow. The handler already receives `contact`, so this is a small branch, but §3 doesn't mention it. Call it out: "on LABEL_CREATED + is_flex, `contact.role === 'sender'` → sender copy; `=== 'recipient'` → owner copy."

### Nits

- §3.1 "reuses the `PaidByRecipientBlock` framing" — that's a React component ([src/components/tracking/PaidByRecipientBlock.tsx](../src/components/tracking/PaidByRecipientBlock.tsx)), not shared with the Deno email templates. You can reuse the *wording* ("No charge to you — the prepaid label is on the recipient") but not the component. Minor, but say "reuse the copy" not "reuse the block."
- §3 point 2 "sender variant" and §4 "sender copy" should name the concrete `variant` value chosen in B2 once decided, so the test names are unambiguous.
- Estimated size "~120 LOC + tests" is plausible but the template + one dispatcher branch + one context field is likely closer to ~60 LOC; not worth precision, just noting it reads high.

### Predicted pitfalls (what's most likely to go wrong if shipped as written)

1. **Implementer edits `payerRole` or the full-label branch (from B1's inverted description) and starts sending recipients a creation email again — silently reverting the 2026-06-27 package-centric decision.** The whole point of that decided proposal was "recipient gets NO creation email; first touchpoint is the in_transit tracking email." A careless widening of the LABEL_CREATED role set that isn't gated on `is_flex` re-enables recipient creation emails on full-label. Mitigation: the change must be `is_flex ? add sender : no-op`, with a regression test asserting full-label → exactly one email to the sender/payer only (this test already exists from 2026-06-27 — extend it, don't replace it).

2. **The sender receives the *owner's* copy ("A label was created with your prepaid link").** If the dispatcher routes the sender contact through LABEL_CREATED but the template choice stays keyed on `is_flex` alone (N4), the sender gets copy addressed to the link owner ("your prepaid link") — confusing and slightly leaky (implies the sender owns the link). Mitigation: template choice keys on `contact.role`, verified by a unit test that the `sender`-role render contains sender wording and no "your prepaid link" phrase.

3. **Double-dispatch on a labels-function retry — the pre-existing OQ3 gap the 2026-06-27 proposal explicitly left open — now doubles again.** `notifications_log` dedupes per `(shipment, contact_id, event, status='sent')`, but there's no unique constraint on `notification_contacts`, so a labels retry that re-inserts fresh contact rows creates new contact_ids and re-sends. Going 1→2 creation emails on flex doubles the blast radius of that retry path (2→4). This is inherited, not introduced, but the proposal should note it explicitly rather than lean on "the existing `notifications_log` guard already dedupes" (§3.2) — that guard only holds *within* one set of contact rows, not across a retry that re-inserts them. Mitigation: acknowledge as inherited risk; the real fix (a unique constraint) stays deferred but should be named.

4. **Sender email fires on comp/admin flex labels where it's unwanted, or fails to fire because no sender row exists — inconsistent behavior the proposal doesn't bound.** Because the sender contact's existence depends on a client-supplied `sender_email`, the "sender gets an email" guarantee is conditional. For an admin-comp flex label created on someone's behalf, `sender_email` may be absent (no email) — correct silence — but the proposal never states the comp-on-flex behavior. Mitigation: add comp-on-flex to the §4 test matrix (no sender_email → no sender send; sender_email present → sender send), mirroring how the 2026-06-27 proposal added the comp-on-flex audience case.

### What the proposal got right

- **The scope split (do A, defer B) is the correct call and the §2B reasoning is genuinely sharp.** "Entering an email at checkout ≠ proving you own it — showing shipments keyed to an unverified email leaks shipment data to anyone who typed that address" is exactly the privacy trap a naive email-match dashboard would fall into. Deferring the dashboard on identity-verification grounds, not on effort grounds, is the right frame.
- **The core premise is verified true.** The sender IS stored as a `role='sender'` contact on flex (when email provided), the dispatcher DOES already fan out tracking emails to that contact, and the only gap really is the creation-time email. §2A's diagnosis holds against the code.
- **The Dashboard §2B claim checks out.** [Dashboard.tsx:221-222](../src/pages/Dashboard.tsx) scopes shipments via `sendmo_links!inner(user_id)` + `.eq("sendmo_links.user_id", user.id)`, so a flex sender who isn't the link owner genuinely cannot see the shipment. No misrepresentation.
- **No double-send on any path** — full-label (payer=sender, recipient excluded), self-send flex (sameInbox dedupe → one contact), and the `notifications_log` key (sender is a distinct contact_id, no collision) all hold. The author's instinct on the three risk areas was right; the mechanisms just need to be described accurately.
- **OQ1's instinct (link to `/t/<code>`, don't propagate the raw unsigned label URL)** is the privacy-correct choice and aligns with PRE-LAUNCH T3-4.
- **Correctly frames itself as reversing/extending a decided proposal** and names the 2026-06-27 decision up front — no drift-as-new-finding, exactly the institutional-memory discipline the protocol asks for.

---

### Round-1 addendum — second reviewer (2026-07-06)

> **reviewer:** Claude (Fable 5) — independent fresh-eyes pass, run concurrently with the review above; verified against `notifications.ts`, `labels/index.ts:1580-1717`, `email-templates.ts:63-167`, `cancel-label/index.ts`, `SenderFlow.tsx`, `SenderStepReview.tsx`, `senderState.ts`, `TrackingPage.tsx`, `tracking/index.ts`, `Dashboard.tsx:221-222`, and the decided proposals of 2026-05-11/12 (cancel-and-change), 2026-05-11 (sender-flow-wizard), 2026-05-16 (Pattern D), 2026-06-27 (label-confirmation-by-role).
> **reviewed_at:** 2026-07-06
> **verdict:** approve-with-changes (concurs with the review above; adds one blocking issue it missed)

I independently reached the same core conclusions as the review above — the scope split is right, the double-send analysis is clean (full-label untouched, self-send dedupe at [labels/index.ts:1604-1607](../supabase/functions/labels/index.ts) yields exactly one email, the `notifications_log` guard at [notifications.ts:137-149](../supabase/functions/_shared/notifications.ts) keys per `contact_id` so the second contact isn't blocked), and B1/B2 above are real (I hit the same `variant`-vs-`audience` mismatch). I won't restate those. This addendum exists because my prior-proposal scan surfaced one finding the review above missed, and it's blocker-class.

#### Blocking issue (additional)

**B3 — The sender creation email was already DECIDED on 2026-05-12 and never shipped. This proposal is *drift-restoration*, not a fresh reversal — and the decided design requires the email to carry the cancel token, which changes OQ1's answer.**
- *Location:* §1 (framing), §2A, OQ1; missing `## Reconciliation with prior decided proposals` section.
- *Issue:* [2026-05-11_label-cancel-and-change (decided 2026-05-12)](2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md) §3.2 states: *"Add `senderLabelReadyEmail()` send when `sender_email` is present — includes the cancel-link `/t/<code>?cancel=<token>` in the body."* Its §2.2 auth table makes that email the load-bearing transport for the returning-sender cancel path ("Returning sender (closed tab, came back later) → email-token: `/t/<code>?cancel=<hex>` **from the sender's 'Label ready' email**"), and its verification walkthrough item 4 tests clicking that link. **That email was never built** — `senderLabelReadyEmail` appears nowhere in the codebase, and no email today carries `?cancel=`. The infrastructure around it all shipped and is live-but-orphaned: the token is minted at [labels/index.ts:1508-1527](../supabase/functions/labels/index.ts), the email-token auth arm is live at [cancel-label/index.ts:159-160](../supabase/functions/cancel-label/index.ts), and both [TrackingPage.tsx:79,197](../src/pages/TrackingPage.tsx) and [SenderFlow.tsx:189](../src/pages/SenderFlow.tsx) carry comments referencing *"?cancel=<hex> from the sender's 'Label ready' email"* — an email that does not exist. A sender who closes the tab today cannot cancel or change their shipment, despite the required-email copy (*"in case you want to change your shipment"*, [SenderStepReview.tsx:39-44](../src/components/sender/SenderStepReview.tsx)) promising exactly that — the very promise was the 2026-05-12 rationale for making the email required. John's dogfood surprise is this drift biting, on schedule.
  Three consequences:
  1. **Framing:** per the protocol ("drift from a decided proposal is its own category"), §1 should present scope A as *restoring the 2026-05-12 §3.2 spec* — merged with the 2026-06-27 dispatcher architecture — and add a `## Reconciliation with prior decided proposals` section citing both. The proposal currently quotes the 2026-05-12 copy and its "required since 2026-05-12" fact without noticing that the same decided proposal specified this exact email.
  2. **Design:** the sender email's tracking link should be **`/t/<code>?cancel=<token>`**, not the bare `/t/<code>`. That resolves OQ1 decisively — neither of OQ1's two options is the decided design. Without the token, the email gives the sender a view they could already reach but still no way to cancel/change, and the email-token arm in `cancel-label` stays dead code. The token is available at send time (minted before the contacts block); thread it into `NotificationContext` for the **sender variant only** — the owner cancels via their JWT (link-owner arm) and doesn't need the token, so don't widen token distribution to the owner's copy.
  3. **Conflict to surface for John:** the 2026-06-27 decision table ("flex link-user: ❌ none at creation") itself contradicted the still-standing 2026-05-12 decision without naming it — two decided proposals conflict. The Decision section here should explicitly record which cell supersedes which, so the next agent doesn't re-drift in either direction.
- *Suggested fix:* reframe §1/§2A as drift-restoration citing 2026-05-12 §2.2/§3.2; answer OQ1 with the tokenized `/t/` link (sender variant only); add the reconciliation section; ask John to ratify "2026-06-27's flex-link-user cell is superseded" in the Decision block.

#### Non-blocking (additional)

- **§2B's option space is missing the cheapest identity option, (c): stamp sender identity from the JWT when a session exists.** The flex buy deliberately omits the JWT ([SenderFlow.tsx:174](../src/pages/SenderFlow.tsx): `undefined, // accessToken — sender flow uses link_short_code auth, not JWT`), so "no JWT on the flex buy path" is an implementation choice, not a fact of nature. For the subset of senders who happen to be signed in, attaching the token and stamping `shipments.sender_user_id` would give a *verified* identity link with zero mid-flow friction and none of option (a)'s unverified-email leak. Separately, `saveSender`/`loadSavedSender` ([senderState.ts:47-64](../src/components/sender/senderState.ts)) already half-builds device-level sender identity (localStorage address+email pre-fill). Neither changes the deferral verdict — B stays correctly deferred — but the revisit should start from options (a)/(b)/(c) plus the existing localStorage seam, not the false binary.
- **Degraded-path asymmetry:** when the `notification_contacts` insert fails, the fallback direct send ([labels/index.ts:1646-1682](../supabase/functions/labels/index.ts)) emails the **payer only** — the sender email silently drops on that path. Probably acceptable (it's a rare degraded mode), but the proposal should say so rather than leave it implicit.

#### Predicted pitfalls (additional — beyond the four above)

1. **The email ships without the cancel token, and John's exact dogfood scenario recurs one layer deeper:** a sender prints a label, closes the tab, gets the new confirmation email, clicks through to `/t/<code>` — and still can't change or cancel the shipment, because the sessionStorage token died with the tab and no email ever carried `?cancel=<hex>`. The 2026-05-12 email-token arm stays dead code, and the required-email field keeps making a promise the product doesn't keep. (This is the B3 failure mode; it's also the most likely one, since the bare-`/t/` link is OQ1's current recommendation.)
2. **If the token IS added but threaded carelessly into the shared `NotificationContext.tracking_url`, the owner's copy gets the tokenized link too** — silently widening cancel-token distribution to a second inbox and creating a second live credential per shipment. The token must ride only the sender-variant render (the owner already has JWT-arm cancel).
3. **OQ2's "send after first tracking event" option, if picked, double-emails the sender at first scan:** the sender contact already receives the `in_transit` tracking email via the existing fan-out (that's §5's own observation). A creation email deferred to first-tracking-event arrives in the same minute as the in_transit email with near-identical content. OQ2 should be decided as "immediate" — the deferred option is strictly worse, not a neutral alternative.
4. **Comp-on-flex sends the sender copy with a false payment line:** `is_flex = resolvedLink !== null` includes admin Live-Comp labels bought through a flex link, where nobody paid — "Paid by the link owner — no charge to you" is half-false (SendMo comped it). Low stakes, but Rule 19's variant-axis discipline ({test, live-comp, live-charge} × flex) means §6 should name the comp-on-flex variant explicitly or it will be skipped in verification.

#### What the proposal got right (concurrence + one addition)

I concur with the full list above. One addition: **the proposal's instinct that "the email is the sender's durable handle" is more right than it knows** — it's not just convenience, it's the decided auth surface for cancel/change from 2026-05-12. Restoring it closes a real product-promise gap, not just a nice-to-have.
