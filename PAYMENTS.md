# SendMo — Payments Architecture

> **Read this first** when working on anything that touches Stripe, recipient cards, sender charges, refunds, or flex-link lifecycle. This is the operational reference; the canonical decision history lives in `proposals/`.

> **Last meaningful change:** 2026-05-22 — Payments risk-intelligence v1 shipped (Account Budget + Radar-block handling + Radar metadata + per-shipment cap default $100→$50). See §10 below and decided proposal `proposals/2026-05-21_payments-risk-intelligence_reviewed-2026-05-22_decided-2026-05-22.md`.

---

## 1. TL;DR

There are two payment flows. They use **different** Stripe primitives and **different** lifecycles:

| Flow | When | Stripe primitive | Lifecycle |
|---|---|---|---|
| **Full-label** | Recipient knows exact price at link creation; one shipment per link | `PaymentIntent` with `capture_method='automatic'`, charges immediately | Pay → label minted → optional cancel/refund (delayed) |
| **Flex-link** | Recipient creates a reusable URL; N senders ship over time | `SetupIntent` saves card; per-shipment `PaymentIntent` `off_session: true, confirm: true` | Save card → link Active → sender uses → off_session charge → label |

The flex flow is **Pattern D** (decided 2026-05-18). Industry-standard model: save the card via SetupIntent at onboarding, charge it off_session per shipment. No persistent holds. No pre-auth UX.

---

## 2. Glossary

### Concepts

| Term | Meaning |
|---|---|
| **Flex link** | A reusable SendMo URL (`sendmo.co/s/<short_code>`) created by a recipient. Multiple senders use it over time. |
| **Full-label link** | One-shot link: recipient pays at link creation, label minted immediately, URL is a viewer. |
| **Recipient** | The party who creates a link and whose card gets charged. |
| **Sender** | Anonymous user who uses a flex link to ship. No login. |
| **Cap** | `sendmo_links.max_price_cents` — max charge per individual shipment. Server-enforced in `labels` Edge Function. |
| **`is_funded`** | Computed boolean returned by `GET /links?code=`. True when the link can accept shipments. **DB-only query, no Stripe call.** Source-of-truth check happens at the back gate (per-shipment off_session charge). |
| **Active / Inactive** | External binary state for the user-visible badge. **Computed** from `is_funded`, not stored. The DB enum stays for hard states (`draft / active / cancelled / expired`). |
| **Off_session charge** | Server-side PI against a saved PM without the cardholder present. Stripe params: `off_session: true, confirm: true, payment_method=<pm>`. **No `automatic_payment_methods`** (Stripe rejects the combination). |
| **SetupIntent (SI)** | Stripe primitive for saving a card without charging. Internally runs ZDA. |
| **ZDA** | Zero-Dollar Authorization. Visa/MC primitive for "is this card valid?" — Stripe uses this inside SetupIntent. |
| **MIT / CIT** | Stripe terminology. CIT = Customer-Initiated Transaction (user on session). MIT = Merchant-Initiated Transaction (off_session charge after consent at SetupIntent). |
| **CAU** | Card Account Updater. Visa/MC/Amex push new card numbers/expiries to merchants. Stripe relays as `payment_method.automatically_updated`. |
| **3DS / SCA** | EU/UK regulation requiring cardholder auth. Manifests as `requires_action`. v1 treats as decline (US only). |

### Tables (DB)

| Table | Role | Touched by Pattern D? |
|---|---|---|
| `profiles.stripe_customer_id_test/_live` | Recipient's Stripe Customer per mode | Lazily populated; no Pattern D change |
| `payment_methods` | Saved cards/ACH per (user, mode). UNIQUE partial index ensures one default per (user, mode). | The source of truth for "does recipient have a usable card" |
| `stripe_intents` | Mirror of Stripe PI/SI state. UPSERTed by webhook. | **Pattern D added** `payment_method_id`, `cancellation_reason`, `last_payment_error_code` columns |
| `transactions` | **Append-only ledger (Rule 16)**. Every charge/refund/chargeback. | `stripe-webhook` is the **sole writer** |
| `holds` | Pre-Pattern-D flex authorizations. | **Pattern D no longer writes here.** Reserved for Phase 3 escrow. |
| `link_state_events` | Audit trail for flex link lifecycle. | **NEW in Pattern D**. CHECK enum: `created/activated/reactivated/charge_failed/pm_detached/pm_expired/rotated/cancelled_by_user` |
| `sendmo_links` | Link rows. | Pattern D added `last_decline_email_at` (per-day dedup gate) |

### Services / Edge Functions

| Function | Role | Pattern D ownership |
|---|---|---|
| `_shared/stripe.ts` | Stripe REST client wrappers | `createOffSessionShipmentPI` is the Pattern D helper. **Sibling** of `createPaymentIntent`, not a wrapper. |
| `payments/` | Full-label PI creation only | flex_hold branch was removed in Pattern D |
| `payment-methods/` | Add Card flow (SetupIntent) | Used by both Dashboard "Add a card" AND flex onboarding step 22 |
| `links/` | Resolve/create/rotate links | `GET ?code=` computes `is_funded`; `POST /:id/rotate` rotates URL; `GET /:id` (auth) for polling |
| `labels/` | Buy EasyPost label after payment | Flex path creates off_session PI inline; rate-limited 5/60s per (IP, short_code) |
| `stripe-webhook/` | Process Stripe events | Sole writer of `transactions` ledger; sends decline-recovery emails inline |
| `tracking/` | Polls EasyPost; triggers refunds | Unchanged |
| `cancel-label/` | Voids labels | Unchanged |

---

## 3. The Pattern D lifecycle (flex)

```
RECIPIENT CREATES FLEX LINK
  → POST /links (initial_status='draft')
  → recipient sees onboarding step 22 (RecipientStepFlexPayment)
  → POST /payment-methods → SetupIntent client_secret
  → Stripe Elements: card entered → confirmSetup
  → Stripe verifies card with issuer (ZDA internal)
  → webhook setup_intent.succeeded → stripe_intents row
  → webhook payment_method.attached → payment_methods row +
      flips this user's draft flex links → 'active' +
      link_state_events.activated row
  → client polls GET /links/:id every 2s up to 30s; advances to step 23

LINK SHARED — NO ACTIVITY UNTIL A SENDER ARRIVES

SENDER USES LINK
  → GET /links?code=<short> returns is_funded (DB-only)
     is_funded = link.status NOT IN (cancelled, expired, completed, used)
                 AND recipient has default PM with un-expired exp
  → if !is_funded: 410 + Inactive message
  → if is_funded: sender proceeds through 4 steps
  → at Confirm: labels/ Edge Function called
     → cap check: display_price_cents ≤ link.max_price_cents
     → mode-mismatch check: link.is_test === !request.live_mode
     → rate limit: 5/60s per (IP, short_code)
     → lookup recipient's default PM (in link's mode)
     → createOffSessionShipmentPI(amount, customer, payment_method)
     → if succeeded:
        → buy EasyPost label
        → webhook payment_intent.succeeded → transactions.charge row
     → if declined / requires_action:
        → cancel PI (best-effort)
        → return 402 to sender with friendly copy
        → webhook payment_intent.payment_failed fires next:
           → write link_state_events.charge_failed
           → send recipient decline email (5s timeout via AbortController,
             event_logs fallback on send failure)
           → dedup gate: one email per (link_id, day)
        → link automatically renders Inactive on next dashboard view
          (no DB UPDATE — Inactive is computed from PM state)

RECIPIENT RECEIVES DECLINE EMAIL
  → "Your payment failed when [sender] was printing a shipping label..."
  → CTA → /dashboard?reactivate=<link_id>
  → Dashboard auto-opens AddCardModal
  → user adds card → SetupIntent → payment_method.attached
  → new PM becomes default → is_funded re-evaluates true →
    link Active automatically (no explicit reactivate call)
```

---

## 4. Failure logging surfaces

For diagnosing whether strict Pattern D is costing real declines (vs adding Pattern D' = ZDA verification):

| Event | Where | Key fields |
|---|---|---|
| SetupIntent succeeded | `stripe_intents` (webhook) | `intent_kind='setup', status='succeeded', payment_method_id` |
| SetupIntent declined | `stripe_intents` (webhook) | `status='failed', last_payment_error_code` |
| Off_session PI succeeded | `stripe_intents` + `transactions.charge` | as today |
| Off_session PI declined | `stripe_intents` + `link_state_events.charge_failed` | `last_payment_error_code` + reason |
| PM auto-updated (CAU) | `payment_methods` row updated; brand change → `link_state_events.pm_expired` | new exp/last4 |
| Decline email sent | `sendmo_links.last_decline_email_at` UPDATE | timestamp (dedup gate) |
| Decline email send failed | `event_logs` row `decline_email.send_failed` | for manual replay |

**Useful query for decline-rate analytics** (run weekly):

```sql
SELECT
  date_trunc('day', created_at) AS day,
  last_payment_error_code,
  COUNT(*)
FROM stripe_intents
WHERE intent_kind = 'payment'
  AND status = 'failed'
  AND mode = 'live'
  AND created_at > now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;
```

If `card_declined` or `insufficient_funds` dominates and total volume is meaningful, **consider adding Pattern D'** (ZDA verification at SetupIntent confirm) per the wishlist.

---

## 5. Why Pattern D (vs alternatives we considered)

Each rejected with reason:

| Considered | Rejected because |
|---|---|
| Phase E hold-and-capture (one PI = one capture, 7-day max) | Breaks reusable-link semantics after shipment 1 or after 7 days, whichever first |
| Auth rotation (capture old, create new hold per shipment) | Doubles Stripe ops; novel pattern; credit-line stacking is customer-hostile |
| Visible $cap auth + separate off_session charges | Cardholder sees both a hold AND a charge for same event → confusing |
| Per-visit front-gate Stripe call | Adds latency to every sender visit; card-testing surface on anonymous URL; per-page-view billing |
| Pattern D' (ZDA verification at save) | Recommended by research; deferred by John (2026-05-16) to "ship strict D first, see if telemetry justifies adding ZDA" |

Full alternatives table + research evidence: `proposals/2026-05-16_payment-auth-pattern-research.md` §3 + §9.

---

## 6. Where to find decision history

| Question | Where |
|---|---|
| Why Pattern D? What did we compare? | `proposals/2026-05-16_payment-auth-pattern-research.md` (Opus deep-research scan) |
| Why these specific files/columns/handlers? | `proposals/2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md` |
| What about Phase E's hold-and-capture code? | Removed in commit `69ac58b`. See LOG entry 2026-05-18. |
| What about full-label? | Master plan `proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md` §3-4 |
| How does refund work? | `proposals/2026-05-13` cancel-and-change proposal + cancel-label/tracking Edge Functions |
| Phase 3 escrow (future) | Master plan §3.8 — `holds` table reserved for this |

Superseded proposals (preserved for institutional memory):
- `proposals/2026-05-15_payment-authorization-strategy.md` (initial strategy)
- `proposals/2026-05-16_flex-payment-execution-pr1-pr2_reviewed-2026-05-16_decided-2026-05-16.md` (PR1/PR2 split, replaced by Pattern D single PR)

---

## 7. Open items / known gaps

> **Go-live status (2026-05-19):** the flex money-path (off_session charge, decline-recovery email, reactivation) has **not been verified end-to-end** since Pattern D shipped, and the FedEx phone fix has not been confirmed against a real purchase. Live-mode Stripe/EasyPost keys + webhook subscriptions are not yet configured. Full punch-list + go-live infra checklist: [`proposals/2026-05-19_payments-golive-followups-handoff.md`](proposals/2026-05-19_payments-golive-followups-handoff.md).

10 follow-ups in WISHLIST under "Added 2026-05-18 — Pattern D follow-ups". Highest-value items:

1. **ZDA verification at SetupIntent save (Pattern D')** — flip on if telemetry shows decline-rate issues
2. **Sender self-paid fallback flow** — when a link is Inactive, sender can pay themselves
3. **Multi-PM retry on decline** — if default declines, try the next saved PM
4. **Nightly background PM validation cron** — catches expired/replaced cards before sender failure
5. ~~**LinksEditor `/links/new` integration** — dashboard "+ New Link" still creates links without inline card collection~~ **DONE 2026-05-18** — `/links/new` is now a 2-step wizard (Details → Payment), Step 2 mounts the shared `<FlexPaymentStep>`. Returning users with a usable PM skip Step 2 via the server's new `initial_status: 'auto'` resolution.
6. **`sendmo_links.status` enum cleanup migration** — drop dead values (`'in_use'`, `'used'`, `'completed'`)
7. **Fraud-mitigation escalation** — if `link_state_events.charge_failed` bursts show real fraud signal, add Stripe Radar / per-customer caps / soft-lock

See WISHLIST.md for the full list with descriptions.

---

## 8. Webhook event subscriptions required

Stripe Dashboard → Developers → Event destinations. Both `Sendmo-test-2026` and `Sendmo-live-2026` (at `2026-04-22.dahlia` API version) must subscribe:

- `payment_intent.succeeded`
- `payment_intent.payment_failed` *(Pattern D: drives decline email)*
- `payment_intent.amount_capturable_updated` (defensive — Phase E remnants)
- `payment_intent.canceled` (defensive — Phase E remnants)
- `charge.refunded`
- `charge.dispute.created`
- `setup_intent.succeeded`
- `payment_method.attached`
- `payment_method.detached`
- `payment_method.updated` *(Pattern D: CAU + manual updates)*
- `payment_method.automatically_updated` *(Pattern D: CAU specifically, brand-change detection)*

If any of these aren't subscribed in production, Pattern D's lifecycle handlers fire silently into the void. Verify periodically; the Stripe wizard has been known to silently drop events from the "saved subscriptions" list.

---

## 9. Things to NEVER do (without reading the corresponding proposal)

- **Don't bring back the `flex_hold` PI-creation branch in `payments/index.ts`.** It's intentionally removed; `payments/index.ts` is full-label only now. Flex collects cards via `payment-methods` (SetupIntent) and charges via `labels` (off_session).
- **Don't write to the `holds` table from any flex code path.** Reserved for Phase 3 escrow per master proposal §3.8.
- **Don't flip `sendmo_links.status` to `'in_use'` after a flex shipment.** Pattern D keeps flex links `'active'` indefinitely.
- **Don't add `automatic_payment_methods` to off_session PIs.** Stripe rejects the combination with `payment_method` + `confirm: true`.
- **Don't write to `transactions` outside of `stripe-webhook/`.** Append-only ledger; webhook is sole writer (Rule 16). The labels function used to write `comp_grant` rows; that's the lone exception, fully gated by admin auth.
- **Don't bypass the cap check in `labels/`.** `display_price_cents` is server-derived from EasyPost rate and compared to `link.max_price_cents`. Never trust the client value.
- **Don't bypass `checkAccountBudget()` in `labels/` or `payments/`.** The Account Budget (proposal 2026-05-21, §10 below) is the per-account cumulative spend ceiling. It runs *before* `createOffSessionShipmentPI` / `createPaymentIntent` so a refusal never leaves a charged-but-no-label race. The RPC `set_account_budget` (admin-only) is the only sanctioned way to raise it — column-level `REVOKE UPDATE` prevents self-raise.
- **Don't treat a Stripe Radar block as a card decline in `stripe-webhook/`.** A `payment_intent.payment_failed` whose latest charge has `outcome.type === 'blocked'` is Radar (not the issuer). The payer's card is fine; do NOT send the decline-recovery email, do NOT flip the link Inactive, do NOT write a `charge_failed` `link_state_events` row. Use the `radar_blocked` branch instead. See §10.

---

## 10. Risk intelligence (2026-05-22) — Account Budget + Radar handling

Shipped 2026-05-22, commit `397530c`. Decided proposal: `proposals/2026-05-21_payments-risk-intelligence_reviewed-2026-05-22_decided-2026-05-22.md`. Read the proposal for full design rationale; this section is the operational summary.

### 10.1 The three controls

1. **Account Budget** (per-account $/day + $/week cumulative spend).
2. **Per-account PM-add breaker** (5 SetupIntents/user/day).
3. **Radar-block branch** (Stripe Radar block ≠ card decline; distinct downstream state).

Plus B2 — Radar metadata fed on every PaymentIntent / SetupIntent (`txn_kind`, `link_type`, `sender_ip`, `sender_email`, `recipient_email`; `shipping` on the flex off_session PI).

### 10.2 Account Budget

| Item | Value |
|---|---|
| Storage | `profiles.daily_budget_cents` / `weekly_budget_cents` (NOT NULL, defaults 20000 / 50000) |
| Defaults | $200/day, $500/week (per account, per mode summed separately) |
| Enforcer | `supabase/functions/_shared/budget.ts` `checkAccountBudget()` — sums `transactions` charge rows over rolling 24h/7d |
| Call sites | `labels/index.ts` (flex 2a, against `link.user_id`); `payments/index.ts` (full-label 2b, only when authenticated payer) |
| Ordering | Runs **before** `createOffSessionShipmentPI` / `createPaymentIntent` — never after — so a refusal can't leave a charged-but-no-label race |
| Failure mode | Fails *open* on DB error (per-shipment cap + Radar still apply) |
| On breach | 402 to caller with "contact us" copy; `velocity.limit_hit` event log; `budgetReachedEmail` to the account holder |
| Raising | Admin-only via `set_account_budget(target_user_id, daily_cents, weekly_cents)` RPC (SECURITY DEFINER + role check); column-level `REVOKE UPDATE` prevents self-raise |

**No self-serve raise** — admin contact path only, by design.

### 10.3 PM-add breaker

`supabase/functions/payment-methods/index.ts` — before `createSetupIntent`, counts `stripe_intents` rows with `intent_kind='setup'` for `(user_id, mode)` in the trailing 24h. Limit constant `PM_ADD_LIMIT_PER_DAY = 5`. Counts *attempts* (creations), not completions — slightly tighter than counting only succeeded SetupIntents. On breach: 429 + `velocity.limit_hit` (`layer:'pm_add'`).

### 10.4 Radar-block handling

Stripe Radar blocks surface as a `payment_intent.payment_failed` with the failed charge's `outcome.type === 'blocked'`. **This is NOT a card decline** — the payer's card is fine; the *sender* (anonymous at 2a) looked fraudulent.

`stripe-webhook/index.ts` distinguishes by fetching the failed PI's latest charge via `retrieveCharge(latest_charge)` and inspecting `outcome.type`. Two branches:

| Outcome | Branch |
|---|---|
| `'blocked'` (Radar) | Write `radar_blocked` `link_state_events` row; notify payer via `radarBlockedPayerEmail` (O7 — gentle, every block); log `stripe.radar_blocked` (severity `warn`). **DO NOT** send decline email; **DO NOT** flip link Inactive; **DO NOT** write `charge_failed`. |
| anything else (issuer decline, etc.) | Existing decline-recovery path: `charge_failed` event + decline-recovery email (with per-link/day dedup). |

`labels/index.ts` uses a synchronous hint — when `createOffSessionShipmentPI` throws with `decline_code === 'fraudulent'`, the sender sees the distinct fraud-protection message and `label.flex_radar_blocked` is logged.

**Fallback:** if the charge can't be fetched, the webhook conservatively treats the failure as a decline (wrongly-sent decline email beats wrongly-skipped one).

**Test card:** Stripe `4100 0000 0000 0019` triggers a Radar block in test mode.

### 10.5 New `event_logs` event types (free TEXT, no enum migration)

| Event | Emitted from | When |
|---|---|---|
| `velocity.limit_hit` | `labels/`, `payments/`, `payment-methods/` | Budget or PM-add breach. `properties.layer` ∈ `{account_budget, pm_add}`. |
| `velocity.budget_email_failed` | `labels/`, `payments/` | Budget-hit email send failed (logged for replay) |
| `label.flex_radar_blocked` | `labels/` | Synchronous Radar-block hint at the off_session call |
| `stripe.radar_blocked` | `stripe-webhook/` | Authoritative Radar block at the webhook (severity `warn`) |
| `stripe.radar_check_failed` | `stripe-webhook/` | `retrieveCharge` failed; conservative fall-through |
| `stripe.radar_block_email_failed` | `stripe-webhook/` | Payer notification email failed |
| `stripe.radar_blocked_no_link` | `stripe-webhook/` | Defensive: `link_id` from metadata didn't resolve |

### 10.6 New `link_state_events.event` value

- `radar_blocked` — added via migration 031, distinguishes from `charge_failed`. `reason='radar_block'`; `metadata.last_payment_error_code` carries the Stripe code (typically `'card_declined'`, which would read identically if used as `reason`).

### 10.7 What was deferred / fast-follow

- **Admin UI for `set_account_budget`** — the RPC works (Supabase Studio / `supabase.rpc('set_account_budget', …)`). A minimal Admin.tsx control is the lead fast-follow.
- **`shipping` on the full-label PI** — `payments/` only gets `easypost_shipment_id`; would need a mid-flow EasyPost lookup. Radar at 2b is already strong on-session; low-value.
- **Integration tests for `checkAccountBudget`** + **e2e for B5/B4.**
- **B1 — Stripe Dashboard config** (John, ~1 hr — recommended block rules + card-testing protection).
