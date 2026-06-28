---
title: Label-confirmation email — correct copy per flow, separate sender + recipient emails
slug: label-confirmation-email-by-role
project: sendmo
status: decided
created: 2026-06-27
last_updated: 2026-06-27 22:05
reviewed: 2026-06-27
decided: 2026-06-27
author: Claude (Opus 4.8) — session debugging John's live-charge dogfood, 2026-06-27; found the wrong-copy email while investigating a self-created full-label
reviewer: Claude (Opus 4.8) — fresh-eyes reviewer, 2026-06-27; verified against labels/index.ts, notifications.ts, and the email audit
outcome: approve-with-changes
---

> **Why this is a proposal and not a quick fix:** email is high-blast-radius — it goes to real customers' inboxes, it's the most visible thing SendMo produces, and a wrong send can't be un-sent. John asked for the proposal explicitly for that reason.

## 1. Context

**The trigger.** On 2026-06-27 John created a Full Prepaid Label himself (he picked the destination, the package, and paid — no shared link involved). The confirmation email he received said:

> Subject: **"A label was printed using your prepaid link — SendMo"**
> Body: **"A shipping label has been purchased for your SendMo link."**

Both lines are wrong for that flow. There was no link. Nothing was "printed" (this is the *creation* email — it fires at label-buy time, before anyone prints). The copy is shared-link language used for a self-serve label.

**Why it's wrong.** There is exactly one confirmation-email template — `labelConfirmationEmail` ([`_shared/email-templates.ts:63`](../supabase/functions/_shared/email-templates.ts)) — and it has the link-flow copy hardcoded into it ([line 106 subject, line 110 body](../supabase/functions/_shared/email-templates.ts)). It's sent once, to `recipient_email`, for **every** label regardless of flow ([`labels/index.ts:1396-1414`](../supabase/functions/labels/index.ts)). There's no branch on which flow produced the label.

**What John wants (decided in-session 2026-06-27).** For a self-created full label, send **two** emails:
- one to the **sender / payer** (the person who created and paid for the label), and
- one to the **recipient** (the person the package is going to),

each with copy written for that audience. Today only one email goes out (to `recipient_email`), with the wrong words.

**The subtle part that makes this a real design question, not a copy swap.** SendMo has two label-creation flows, and "who is the payer" lands on a *different* stored contact role in each:

| Flow | Who created/paid | Who receives the package | `notification_contacts` rows today |
|---|---|---|---|
| **Full Prepaid Label** (John's case) | the signed-in user (sender = payer) | the destination person | `role: sender` = payer's email; `role: recipient` = destination email — both from the request body ([`labels/index.ts:1442-1447`](../supabase/functions/labels/index.ts)) |
| **Flex link** (someone ships *to* a link owner) | the **link owner** (they prepay so others can ship to them) | the **link owner** (same person) | `role: recipient` = link owner's email, resolved server-side from `profiles.email` ([`labels/index.ts:218`](../supabase/functions/labels/index.ts)); `role: sender` = the person who *used* the link |

So in full-label the payer is the `sender` role, but in flex the payer is the `recipient` role. **Any fix that naively maps "payer email" → `role: sender` will send the flex link owner the wrong email.** This is the trap the proposal has to defuse.

## 2. Architecture

**The existing pattern to extend (not reinvent).** The tracking-update emails already **fan out over `notification_contacts`** — they send to every contact row for a shipment, sender and recipient roles alike (per the [email audit](../previews/email-audit.html), the tracking-update email's recipient is "all entries in `notification_contacts`"). The confirmation email is the lone holdout that sends directly to one address. The fix makes the confirmation email use the same fan-out, with copy chosen per role. No new construct — this is the contacts-fan-out pattern that already ships.

**Two copy variants, chosen by role — but role is resolved per flow.** Rather than branch on "flow", we resolve a single **audience** value per contact and pick copy from that. Audience is the honest thing the copy depends on:

- `payer` audience → "Your SendMo label is ready / your prepaid label has been created."
- `recipient` audience → "A prepaid label is on its way to you."

The flow determines the role→audience mapping (this is the asymmetry from §1):

```
                         full-label flow            flex flow
  role: sender     →     payer  (John)              the link user (the one who shipped)
  role: recipient  →     recipient (destination)    payer = the link owner
```

**Flow shape after the change:**

```
label bought + shipment row persisted
        │
        ├─ build notification_contacts (UNCHANGED — already happens at 1442-1447)
        │
        └─ for each contact row:
               audience = mapRoleToAudience(role, flow)     ← new, the only new logic
               template = labelConfirmationEmail({ ...details, audience })
               sendEmail(to: contact.address, template)      ← fan-out replaces single send
```

**Worked examples:**

- *Full-label, John ships to Jane.* Contacts: `sender`=john@…, `recipient`=jane@…. John (sender role, full-label → payer audience) gets "Your label is ready." Jane (recipient role → recipient audience) gets "A label is on its way to you." ✅ John's ask.
- *Flex, Bob uses Alice's link to ship to Alice.* Contacts: `recipient`=alice@… (owner), `sender`=bob@… (link user). Alice (recipient role, flex → payer audience) gets "Your label is ready" — correct, she's the payer/owner. Bob (sender role, flex → recipient-of-nothing… see OQ2) — **this is the open question**; today flex stores Bob's email but the current single email never goes to him.

## 3. File-by-file plan

### 3.1 `supabase/functions/_shared/email-templates.ts` — add an `audience` param + two copy variants

Change `labelConfirmationEmail` to accept an `audience` and branch only the **subject + headline + intro sentence** (the details table, tracking button, and footer stay identical — they're audience-neutral):

```ts
export function labelConfirmationEmail(params: {
  publicCode: string;
  carrierTracking: string;
  carrier: string;
  eta: string;
  trackingUrl: string;
  senderName?: string | null;
  itemDescription?: string | null;
  displayPriceCents?: number | null;
  audience: "payer" | "recipient";   // NEW — required, no default (force callers to decide)
}): { subject: string; html: string } {
  // ... existing trimming/summaryRow logic unchanged ...

  const copy = params.audience === "payer"
    ? {
        subject: "Your SendMo label is ready",
        headline: "Your label is ready!",
        intro: "Your prepaid shipping label has been created. Here are the details:",
      }
    : {
        subject: "A prepaid label is on its way to you — SendMo",
        headline: "A label is on its way!",
        intro: "Someone created a prepaid shipping label for a package headed your way. Here are the details:",
      };
  // subject/headline/intro substituted into the existing layout(...) html
}
```

Exact wording is **OQ1** — `previews/label-confirmation-variant-{a,b,c,d}.html` already exist as design explorations; we should pull final copy from whichever John blessed (or bless one now). The signatures and structure above are what's being proposed; the strings are placeholders pending OQ1.

**Note:** making `audience` required (no default) is deliberate — it forces every call site to state the audience, so a future caller can't silently inherit the wrong copy. The one existing caller is updated in 3.2.

### 3.2 `supabase/functions/labels/index.ts` — fan out the send over contacts

Replace the single send block ([1396-1414](../supabase/functions/labels/index.ts)) so it iterates the `contacts` array already built at 1441-1447. Add one small pure helper:

```ts
// full-label: payer is the sender; flex: payer is the link owner (recipient role).
function audienceForContact(role: string, isFlex: boolean): "payer" | "recipient" {
  if (isFlex) return role === "recipient" ? "payer" : "recipient";
  return role === "sender" ? "payer" : "recipient";
}
```

`isFlex` is already known at this point in the function — it's the branch gated on `link_short_code` / `link.link_type === "flexible"` ([line 184](../supabase/functions/labels/index.ts)); we thread a boolean down. The send becomes a loop over `contacts`, each call passing `audience: audienceForContact(c.role, isFlex)` and `to: c.address`. Sends stay **fire-and-forget with per-send error logging** (unchanged semantics — a failed email is non-fatal, the label already shipped), but each logs its own `email.label_confirmation_sent` / `_error` with the role+audience in properties for auditability.

**Idempotency note (risk, see §7 OQ3):** the buy is idempotent on `easypost_shipment_id`, but the email send is not guarded — a client retry after a successful buy could re-send. This is a *pre-existing* risk (true of the single email today); the change doesn't worsen per-label send count, but going from 1→2 emails doubles the blast radius of a double-send. OQ3 asks whether to add a send-once guard now.

### 3.3 Flex path — minimal change

Flex keeps sending to the link owner (`recipient` role → `payer` audience → "Your label is ready"), which **fixes the wrong "printed/your link" wording for flex too**. Whether flex *also* emails the link-user (`sender` role) is deferred — see OQ2 / Out of scope.

## 4. Test plan

Unit tests (matches the existing email-test layer — `tests/unit/`):
- `labelConfirmationEmail({ audience: "payer" })` → subject/headline/intro are the payer strings; details table renders unchanged.
- `labelConfirmationEmail({ audience: "recipient" })` → recipient strings.
- `audienceForContact`: `("sender", false)→"payer"`, `("recipient", false)→"recipient"`, `("recipient", true)→"payer"`, `("sender", true)→"recipient"`. This 4-case table is the whole point — it locks the asymmetry.
- Regression: confirm the details table / tracking URL / price row are byte-identical across both audiences (only the three header strings differ).

## 5. Out of scope

- **Flex link-user (`sender` role) email.** Whether the person who *used* a flex link gets a confirmation is a product question (OQ2), deferred. This proposal only guarantees flex keeps emailing the owner with corrected copy.
- **Print-event email.** The "label printed" subject implies a printed-notification email exists; it does not. Not creating one here — separate from creation confirmation. (The audit's print-related items are their own gaps.)
- **Tracking-update / refund / cancel emails.** Untouched.
- **A send-once idempotency guard**, *unless* OQ3 says do it now.
- **`notification_contacts` schema.** No change — it already stores what's needed.

## 6. Verification (run after implementation, per PLAYBOOK Rule 19)

1. **Test-mode full-label, two distinct recipients.** Create a full label in Test mode with `sender_email` = address A, recipient `recipient_email` = address B. Confirm A receives "Your label is ready" and B receives "A label is on its way." (Test mode won't charge; confirm sends fire — or, if test mode suppresses sends, verify via rendered template output + `email.label_confirmation_sent` event_logs with the right audience in properties.)
2. **Flex label.** Use a flex link; confirm the link owner gets "Your label is ready" (payer audience) and the wording no longer says "printed using your prepaid link."
3. **Template render check.** Open the rendered HTML for both audiences side by side; verify only headline/intro/subject differ and the details block is identical.
4. Browser-verify block in LOG with `mcp-session:` + `variants-covered:` (payer / recipient / flex-owner).

## 7. Open questions

- **OQ1 — final copy.** Which of `previews/label-confirmation-variant-{a,b,c,d}.html` is canonical, or should we lock fresh copy for the payer + recipient subjects/headlines/intros? The proposal fixes structure; the strings need John's eye since this is what customers read.
- **OQ2 — flex link-user email.** In the flex flow, should the person who *used* the link (the `sender` role contact) also get a confirmation, and if so, with what framing ("Your label to {owner} is confirmed")? Or does flex stay single-email-to-owner? This is the cross-flow asymmetry's loose end.
- **OQ3 — send-once guard.** Going 1→2 emails doubles double-send exposure on client retry. Add an idempotency guard now (e.g. skip send if an `email.label_confirmation_sent` event already exists for this shipment+address), or accept the pre-existing risk as-is since buys are rare and retries rarer?
- **OQ4 — full-label when sender == recipient.** John's dogfood had himself as both. If `sender_email == recipient_email`, do we send two emails (payer + recipient) to the same inbox, or dedupe to just the payer copy? Dedupe seems right; confirming.

## Reconciliation with prior decided proposals

- **[2026-05-13_tracking-page-ia-polish](2026-05-13_tracking-page-ia-polish_reviewed-2026-05-13_decided-2026-05-13.md)** — introduced the `notification_contacts` storage at label-buy time and the sender/recipient role model this proposal fans out over. No conflict; this extends that model to the confirmation email. The "printed" wording in today's subject likely predates even this — it's legacy copy, not a decision from this proposal.
- **[2026-05-11_sender-flow-wizard](2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md)** — established server-side `recipient_email` resolution for flex (`profiles.email`, the line-218 behavior). This proposal depends on that being the link owner; the role→audience map is built around it. No divergence.
- **[Email audit](../previews/email-audit.html)** (commit `37b6afe`, 2026-05-27) — catalogs the confirmation email as E2 and notes its single-recipient behavior. This proposal doesn't contradict the audit; it addresses the wrong-copy-per-flow problem the audit's E2 entry describes in passing. Note the audit's G-gaps (G1–G9) are *missing* emails; this is a *wrong-copy on an existing* email, so it's not a numbered gap — it's a correctness fix on E2.

No schema change, no external-contract (MCP) impact — SendMo has no MCP surface.

## Review

> **reviewer:** Claude (Opus 4.8) — fresh-eyes reviewer, no prior context on this fix; verified every cited line against `labels/index.ts`, `_shared/notifications.ts`, `_shared/email-templates.ts`, and `previews/email-audit.html`
> **reviewed_at:** 2026-06-27 21:10
> **verdict:** needs-info

### Summary

The problem is real and correctly diagnosed: `labelConfirmationEmail` ([`email-templates.ts:106,110`](../supabase/functions/_shared/email-templates.ts)) hardcodes shared-link copy ("printed using your prepaid link" / "purchased for your SendMo link") and the send ([`labels/index.ts:1396-1437`](../supabase/functions/labels/index.ts)) goes to a single `recipient_email` with no flow branch — so John's self-created full label got recipient-of-a-link copy. The role→audience asymmetry table is accurate against the code. **But the proposal's central architectural claim — "extend the existing contacts-fan-out pattern, no new construct" — is not what the plan actually does.** It hand-rolls a *new* fan-out loop plus *new* idempotency reasoning in `labels/index.ts`, while the real fan-out construct (`dispatchNotifications` in `_shared/notifications.ts`) already does role-keyed fan-out, per-contact copy selection, AND the exact send-once guard OQ3 treats as an open question. That gap needs resolving before this is ready to build, hence needs-info rather than approve-with-changes.

### Blocking issues

**B1 — The "existing pattern" being cited (`dispatchNotifications`) is not the one being used; the plan reinvents it, which trips Rule 6.**
- *Location:* §2 "The existing pattern to extend (not reinvent)"; §3.2 (the hand-rolled `for each contact` loop + `audienceForContact` helper).
- *Issue:* §2 says the tracking-update emails "fan out over `notification_contacts`" and the fix "uses the same fan-out." The actual fan-out machine is [`_shared/notifications.ts:63` `dispatchNotifications`](../supabase/functions/_shared/notifications.ts) — it queries `notification_contacts` by shipment, routes per `channel`, picks copy per `contact.role` (`trackingUpdateEmail(..., contact.role)` at line 39-47), and logs every attempt to `notifications_log`. §3.2 does **not** call it; it writes a brand-new loop inline in `labels/index.ts` with bespoke `email.label_confirmation_sent` event logs. That is a parallel fan-out construct sitting next to the real one — precisely the "one-off helper / parallel system" Global Rule 6 says to avoid. The proposal asserts "no new construct" while introducing one.
- *Suggested fix:* Either (a) route the confirmation send through `dispatchNotifications` — add a `"label_created"` event type, branch the `email` handler to call `labelConfirmationEmail` for it, and widen `NotificationContext` to carry `senderName`/`itemDescription`/`displayPriceCents` (it currently only has tracking fields, [notifications.ts:15-21](../supabase/functions/_shared/notifications.ts)); the role→copy decision already lives in the handler, so `audienceForContact` becomes the handler's job. Or (b) if reusing it is genuinely too heavy (e.g. the context-widening is ugly), say so explicitly and justify the parallel loop — but the current proposal doesn't even acknowledge `dispatchNotifications` exists, so the "extend not reinvent" framing is unearned.

**B2 — The send fires before `notification_contacts` is built, so "iterate the contacts array already built at 1441-1447" is out of order.**
- *Location:* §3.2 — "Replace the single send block (1396-1414) so it iterates the `contacts` array already built at 1441-1447."
- *Issue:* In the actual code the email send block is **1396-1437**, and the `contacts` array is assembled **afterward** at **1439-1483**. At the moment the send runs, `contacts` does not exist yet. You can't iterate it where the send currently sits. This forces a reorder (build contacts first, then send) or building the audience list from the raw `recipient_email`/`sender_email` vars instead of the `contacts` rows. Reordering is fine but has a wrinkle: the contacts insert can fail (it logs `notification_contacts_error` and continues) — decide whether a failed/partial insert should suppress or still allow the emails. If you go with `dispatchNotifications` (B1), this resolves naturally because it reads the rows back from the DB after insert — but then the insert MUST be awaited and succeed before dispatch, which it currently is (`await ... .insert`), so dispatch after line 1483 is the clean seam.
- *Suggested fix:* State the new ordering explicitly: persist row → insert `notification_contacts` (await) → fan out. Decide the partial-insert behavior and write it into the plan.

**B3 — `isFlex` does not exist as a variable; the flow discriminator in the code is `resolvedLink !== null`. Threading a fresh `isFlex` boolean risks getting it wrong for the comp-on-flex case.**
- *Location:* §3.2 — "`isFlex` is already known at this point … the branch gated on `link_short_code` / `link.link_type === "flexible"` (line 184); we thread a boolean down."
- *Issue:* There is no `isFlex` in `labels/index.ts`. The established flow tag is `resolvedLink ? "flex" : "full_label"` ([lines 944, 1049](../supabase/functions/labels/index.ts)). Line 184 is an early-return guard, not a stored boolean. More subtly: `comp` labels can run *on a flex link* (the comp gate at line 358 requires `resolvedLink`), so a label can be both comp and flex. If you mint a new `isFlex`, define it as `resolvedLink !== null` to match the rest of the function — don't re-derive from `link_short_code` (which is request-body input, present even when the link lookup later failed paths diverge).
- *Suggested fix:* Use `const isFlex = resolvedLink !== null;` (or pass `resolvedLink` and check inline), matching lines 944/1049. Add the comp-on-flex case to the §4 audience test table.

### Non-blocking concerns

**N1 — The proposal cites the email audit as supporting evidence, but the audit contradicts the code on this exact point.** §1/§2 lean on the audit to establish that the confirmation email is "the lone holdout that sends directly to one address." The audit's E2 entry actually says the opposite — [email-audit.html:534](../previews/email-audit.html): *"Recipient: All entries in `notification_contacts` for the shipment (role: sender or recipient)."* That is wrong about the live code (the code sends to a single `recipient_email`, 1396-1437). So the proposal's premise (single-send today) is correct *from the code*, but the audit it cites as a source documents the buggy email as already-fanned-out. Worth a one-line note that the audit's E2 recipient claim is itself inaccurate and should be corrected when this ships — otherwise the audit will keep asserting a behavior that won't match even post-fix nuance.

**N2 — Null-email cases for comp/admin labels aren't in the asymmetry table (the author asked for scrutiny here, area 2).** `sender_email` and `recipient_email` are *both* request-body fields ([index.ts:76-77](../supabase/functions/labels/index.ts)); only flex resolves `recipient_email` server-side. An admin comp label created on someone's behalf can legitimately arrive with `sender_email` absent (or `recipient_email` absent). The current single-send is already guarded by `if (publicCode && recipient_email …)` (1396) so it no-ops cleanly when `recipient_email` is missing. The proposed fan-out must preserve a per-address truthiness guard — the §2 table implies both rows always exist, but `notification_contacts` only inserts a row when the corresponding email is a non-empty string (1442-1446). This is actually *handled* if you iterate the real contact rows (missing email → no row → no send), which is another argument for B1's option (a). Flag it so the implementer doesn't reintroduce a null send. Note John's own dogfood logged `notification_contacts` count=1 ([audit line 911](../previews/email-audit.html)) — meaning his `sender_email` was NOT stored, so even after this fix he'd get only the recipient/payer copy, not two emails. Verify the full-label client actually sends `sender_email`, or the "two emails" outcome won't materialize.

**N3 — Flex `recipient_email` can be null (`prof?.email ?? null`, [line 218](../supabase/functions/labels/index.ts)).** If a link owner's profile has no email, the flex confirmation has no payer-audience address and silently sends nothing. Pre-existing, but the "flex keeps emailing the owner with corrected copy" guarantee in §3.3/§5 is conditional on the owner having an email. Worth one sentence acknowledging the null case.

**N4 — OQ3 is effectively already answered by the platform you should be reusing.** `dispatchNotifications` does a per-(shipment, contact, event) send-once check against `notifications_log` ([notifications.ts:103-115](../supabase/functions/_shared/notifications.ts)). If you route through it (B1), the 1→2 double-send risk is closed for free and OQ3 collapses. If you keep the hand-rolled loop, you're re-litigating a solved problem. This is the strongest single reason to reuse rather than reinvent.

### Nits

- §3.2 line ref "1396-1414" for the send block is short by 23 lines — the `.then/.catch` logging runs to 1437. Use 1396-1437.
- §1 table says contacts built at "1442-1447"; the enclosing block is 1439-1483 and the pushes are 1442-1446. Minor.
- "Reconciliation" claims `2026-05-13_tracking-page-ia-polish` "introduced the `notification_contacts` storage … and the sender/recipient role model." I grepped that proposal — `notification_contacts` does not appear in it. The construct appears in `2026-05-21_refund-system-implementation`. The role model may predate the cited proposal; the attribution looks wrong and should be corrected so the institutional-memory trail is accurate.

### Predicted pitfalls (what's most likely to go wrong if shipped as written)

1. **Implementer writes the inline loop at line 1396 against a `contacts` array that doesn't exist yet (B2), hits a `ReferenceError`/TDZ in the edge function, and the *entire label-buy response path* throws after the charge already succeeded** — i.e. money moved, no confirmation, possibly a 500 to the client that triggers a retry. This is the worst failure class for this function (charge succeeded, response failed). The send is currently fire-and-forget *after* persist precisely to avoid this; a careless reorder reintroduces it. Mitigation: keep sends fire-and-forget and strictly after the awaited contacts insert.

2. **Two emails to one inbox on the sender==recipient dogfood case (OQ4) — but only sometimes, depending on whether the client sent `sender_email`.** Because `sender_email` is client-supplied and John's dogfood stored count=1 (no sender row), the "send two" behavior is silently dependent on a client field the proposal never verifies is populated. Result: inconsistent behavior across full-label clients — some users get two, some get one, with no server guarantee. Mitigation: confirm the full-label buy client always sends `sender_email`; decide dedupe (OQ4) and implement it where the contact rows are built, not at send time.

3. **Double-send on client retry actually doubles (the OQ3 risk made worse), because the hand-rolled loop has no `notifications_log` guard while the rest of the system does.** The buy is idempotent on `easypost_shipment_id`, but a client that retries the buy after a network blip re-enters the persist+send path; the existing single email already has this exposure, and going to 2 emails with a bespoke loop that doesn't consult `notifications_log` means a retry sends 4. The platform's own dispatcher would have caught this. Mitigation: route through `dispatchNotifications` (B1) and inherit its idempotency.

4. **The audit drifts further from reality (N1).** Ship the per-role copy but leave the audit's E2 "all entries in notification_contacts" claim in place, and the next agent reading the audit will believe the confirmation email already fans out — and may "fix" something that isn't broken or skip a real gap. Mitigation: correct E2's recipient line in the same change.

### What the proposal got right

- **The diagnosis is correct and well-evidenced.** The wrong-copy lines (106/110), the single-recipient send, and the absence of a flow branch all check out against the code. This is a real, customer-facing correctness bug, and email-as-high-blast-radius justifies the proposal treatment.
- **The role→audience asymmetry is the genuinely hard part, and the table is accurate.** Full-label: payer = `sender` role; flex: payer = `recipient` role (server-resolved owner email at line 218). The 4-case `audienceForContact` truth table in §4 is the right thing to lock down, and naming "any naive payer→sender map breaks flex" is exactly the trap a less careful fix would fall into.
- **Making `audience` a required param with no default** is good defensive design — it forces every future caller to choose, preventing silent inheritance of wrong copy.
- **Surfacing OQ1-OQ4 honestly** (especially OQ3 idempotency and OQ4 self-send dedupe) is the right instinct; the author flagged the real risk areas even if OQ3's answer already exists in the codebase.
- **Correctly scoped out** the print-event email, tracking/refund emails, and schema changes — tight blast radius.

## Author response

**reviewed_at:** 2026-06-27 21:40 · **author verdict on the review:** accept in full. No ties to escalate — every finding holds up against the code. The review found a genuine blind spot (I never read `_shared/notifications.ts`) that flips the architecture from "hand-roll a loop" to "reuse the dispatcher," and a real prerequisite (the payer email isn't captured today) that the original plan assumed away. The proposal as written should NOT be built. Revised design below; recommending a round-2 review because the new approach modifies a shared construct the tracking + webhook emails depend on.

### Per-point

- **B1 — reinvents `dispatchNotifications` → ✅ accept.** Confirmed: `dispatchNotifications` ([notifications.ts:63](../supabase/functions/_shared/notifications.ts)) already does role-keyed fan-out over `notification_contacts`, per-role copy selection, and a send-once guard against `notifications_log` (103-115). My §2/§3.2 hand-rolled a parallel loop and never acknowledged it existed — straight Rule 6 violation. **Revised approach (option a):** route the confirmation through `dispatchNotifications`. Concretely: add a `"label_created"` event type; in the dispatcher's `email` handler, branch on event type to call `labelConfirmationEmail` (today it hardcodes `trackingUpdateEmail`, [notifications.ts:39](../supabase/functions/_shared/notifications.ts)); widen `NotificationContext` ([15-21](../supabase/functions/_shared/notifications.ts)) to carry `senderName`/`itemDescription`/`displayPriceCents`/`carrier`/`eta`/`publicCode`/`trackingUrl`. The role→audience decision moves *into* the handler (it already receives `contact.role` and now knows the flow via context), so `audienceForContact` becomes the handler's internal logic, not a `labels/index.ts` helper.

- **B2 — send fires before contacts built → ✅ accept.** Confirmed: send block is 1396-1437, contacts insert is 1439-1483. Reusing the dispatcher resolves this cleanly: the contacts `.insert` is already awaited (1449), so the dispatch seam is **after line 1483** — `dispatchNotifications` reads the rows back from the DB, so it's correct by construction and needs no in-memory array. Sends stay fire-and-forget (the dispatcher is already called fire-and-forget at [tracking:169](../supabase/functions/tracking/index.ts)/[webhooks:848](../supabase/functions/webhooks/index.ts)). The current direct send at 1396-1437 is **removed**.

- **B3 — `isFlex` doesn't exist → ✅ accept.** Will use the established `resolvedLink !== null` (matching [944/1049](../supabase/functions/labels/index.ts)), passed into `NotificationContext`, not a freshly-minted boolean off the request body. Comp-on-flex case added to the test table (a comp label on a flex link is still flex for audience purposes — payer = owner = recipient role).

- **N1 — audit E2 contradicts the code → ✅ accept.** The audit's E2 "all entries in notification_contacts" claim is wrong about today's single-send code; will correct that line in `previews/email-audit.html` in the same change so the audit stops asserting a behavior the code doesn't have.

- **N2 — null-email / payer-email-not-captured → ✅ accept; this is the most important finding and it expands scope.** Two parts:
  1. *Truthiness guard:* reusing the dispatcher (B1/option a) handles missing emails for free — `notification_contacts` only inserts a row when the email is a non-empty string (1442-1446), so a missing address = no row = no send. No null sends. Good.
  2. *The real gap:* for an **authenticated full-label payer, `sender_email` is typically empty** — the client sends `sender_email: state.senderEmail || undefined` ([RecipientStepPayment.tsx:95](../src/components/recipient/RecipientStepPayment.tsx)), and the payer's email lives in the auth session, not that field. That's why John's dogfood stored count=1 and would still get only one email post-fix. **Fix (mirrors how flex resolves the owner server-side):** in the full-label path, resolve the authenticated user's email server-side (the function already calls `getUser` at [349/383](../supabase/functions/labels/index.ts)) and insert it as the `sender`-role contact when `sender_email` from the body is absent. This is a new, small addition to the contacts-build block — and it's a **prerequisite** for "two emails" to actually happen. Without it the feature is inert for the dominant case.

- **N3 — flex owner email can be null → ✅ accept.** Will state in §3.3/§5 that the flex payer-audience send is conditional on the owner having a `profiles.email`; null = no send (pre-existing, now explicit).

- **N4 — OQ3 already solved by the platform → ✅ accept. OQ3 is closed:** routing through `dispatchNotifications` inherits its `notifications_log` send-once guard, so the 1→2 double-send-on-retry risk is handled for free. OQ3 is withdrawn.

- **Nits → ✅ all accepted:**
  - Send-block line ref corrected to 1396-1437; contacts block to 1439-1483 (pushes 1442-1446).
  - **Attribution fix:** `notification_contacts` was introduced by `2026-05-21_refund-system-implementation`, **not** `2026-05-13_tracking-page-ia-polish` (verified — it doesn't appear in the latter). The Reconciliation section's attribution is wrong and will be corrected; the role model traces to the refund-system + notifications work.

- **OQ4 — sender==recipient dedupe → resolved:** dedupe at contact-build time, not send time. If the resolved payer email equals `recipient_email`, insert only the `sender`/payer contact (payer copy wins) so one inbox gets one email. Implemented where the contacts rows are built (1439-1483), upstream of the dispatcher.

- **OQ2 — flex link-user email → still open, still deferred.** Out of scope here; flagged for John. Default stays single-email-to-owner for flex.

### Net change to scope

Bigger than the original framing, smaller blast radius in the right way:
1. **`_shared/notifications.ts`** — add `label_created` event, branch handler to `labelConfirmationEmail`, widen `NotificationContext`. (Touches a shared construct the tracking/webhook emails use → the reason for round-2 review.)
2. **`_shared/email-templates.ts`** — `audience` param + two copy variants (unchanged from original §3.1).
3. **`labels/index.ts`** — DELETE the direct send (1396-1437); resolve payer email server-side + dedupe in the contacts-build block; call `dispatchNotifications(..., "label_created", ctx)` after line 1483.
4. **`previews/email-audit.html`** — correct E2's recipient line.
5. Tests: dispatcher `label_created` path + role→audience table (incl. comp-on-flex) + payer-email-server-resolution + sender==recipient dedupe.

OQ3 withdrawn (solved by reuse). OQ1 (copy) and OQ2 (flex link-user) remain for John. New OQ5: confirm server-side payer-email resolution is acceptable vs. a client change to send `sender_email` — author recommends server-side (robust, mirrors flex, no client dependency).

**Status → revised. Recommend round-2 review of the dispatcher changes before build.**

## Decision

**Decided 2026-06-27 (John, in-session). Outcome: approve-with-changes** — approved with the revised "package-centric" model worked out after the review, not the original two-creation-emails design.

**Final behavior (the approved who-gets-what table):**

| Party | Label creation | In-transit (drop-off) | Out for delivery | Delivered |
|---|---|---|---|---|
| **Payer** | ✅ "Your label is ready" (new copy + payer email resolved server-side) | ✅ sender tracking | ✅ | ✅ |
| **Recipient** | ❌ none (remove today's wrong link-copy email) | ✅ "Your package is on the way" | ✅ | ✅ |
| **Flex link-user** | ❌ none | ✅ sender tracking | ✅ | ✅ |

**Decisions:**
- **OQ1:** Payer creation copy = "Your label is ready / Your prepaid shipping label has been created." Recipient gets **no creation email** — their first touchpoint is the existing `in_transit` package email at drop-off ("Your package is on its way"). The package-centric tracking emails (in_transit → out_for_delivery → delivered) already exist and already fan out correctly; **no copy change needed to them.**
- **OQ2 (flex link-user):** No creation email; receives the existing package tracking emails like any other party. Resolved — flex link-user is **not** a new creation-email audience.
- **OQ5 → A:** payer email resolved **server-side** from the authenticated user (mirrors flex's server-side owner resolution), stored as the `sender`-role contact. This is the prerequisite that makes the payer email fire at all.
- **OQ3:** withdrawn — reusing `dispatchNotifications` inherits its `notifications_log` send-once guard.
- **OQ4 (self-send dedupe):** at contact-build time, if the resolved payer email equals `recipient_email`, store a single `sender`-role contact (payer wins) so one inbox doesn't get duplicate tracking copies.
- **Payer also receives tracking updates** ("the package you sent was delivered") — confirmed acceptable (table approved); this falls out naturally from storing the payer as a `sender` contact and routing through the dispatcher.
- **Round-2 review: waived by John** given the reduced, mostly-subtractive scope.

**Net implementation (smaller than the original proposal):**
1. `_shared/email-templates.ts` — `labelConfirmationEmail` gains `audience` (only `payer` is used in practice now); fix subject/headline/intro ("created", not "printed"; no "your link").
2. `_shared/notifications.ts` — add `label_created` event; handler calls `labelConfirmationEmail` for it; widen `NotificationContext` with the label fields. Only the `sender`-role contact receives `label_created` (recipients are excluded from the creation event).
3. `labels/index.ts` — DELETE the direct send (1396-1437); resolve payer email server-side + store as `sender` contact (with the OQ4 dedupe); call `dispatchNotifications(..., "label_created", ctx)` after the awaited contacts insert (post-1483).
4. `previews/email-audit.html` — correct E2's recipient line (N1) + the `notification_contacts` attribution nit.
5. Tests: dispatcher `label_created` path (sender-only), payer-email server-resolution, OQ4 dedupe, template copy for `payer`.

Status → decided. Implementation on a branch; no push to main without John's ok (payments-adjacent + email).
