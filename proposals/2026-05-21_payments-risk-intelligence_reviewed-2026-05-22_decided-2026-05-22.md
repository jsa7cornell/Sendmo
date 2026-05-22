---
title: Payment risk intelligence — a near-term system for SendMo's two charge contexts
slug: payments-risk-intelligence
project: sendmo
status: decided 2026-05-22 — reviewed, revised, all open questions (O1–O8) resolved; ready for implementation
created: 2026-05-21
revised:
  - 2026-05-21 — folded in John's design direction (run Radar at 2a; velocity hierarchy; per-account PM-add limit; bot detection at signup)
  - 2026-05-22 — Turnstile/signup-CAPTCHA parked to WISHLIST; velocity collapsed to one per-account Account Budget ($200/day + $500/week, admin-raised)
  - 2026-05-22 (post-review) — review returned needs-rework; reworked: Chargeback Protection dropped, B4 reframed (Radar scores the payer, not the sender), §7 split decided/open
  - 2026-05-22 (decided) — O2 ZDA telemetry-gated · O4 per-shipment cap $50 · O5 built-in Radar at launch · O7 notify payer on every block; proposal decided
author: Claude (Job 4 post-verification triage session)
supersedes: the standalone "spend-cap / e-brake" item from proposals/2026-05-19_payments-golive-followups-handoff.md Job 4
---

## 0. TL;DR

The Job 4 backlog carried a "spend-cap / e-brake" item. On inspection a spend cap is the
*bottom* of the stack — a blunt backstop that fires after abuse is already underway. The
right unit of work is a **risk-intelligence system**, scoped to SendMo's two distinct
charge contexts:

1. **PM adding** — the recipient saves a card (SetupIntent). On-session, cardholder
   present. Stripe Radar is **strong** here. This is the stolen-card-entry gate.
2. **Label printing** — splits into two:
   - **2a · Link-driven label (flex):** the printer (anonymous sender) is **not** the
     payer; the payer's saved card is charged **off_session**. Radar scores the *payer*
     on every charge to that card, but **cannot see the anonymous sender** (§3.2). **This
     is the genuinely novel risk surface and the one SendMo must actively defend with its
     own controls.**
   - **2b · Single-use label (full-label):** the printer **is** the payer, paying
     on-session with their own card. A standard e-commerce checkout. Radar is **strong**.

The headline: **2b is an ordinary checkout Radar already handles; 2a is the surface
where someone spends a card that isn't in front of Stripe — Radar scores the *payer* on
every charge, but it cannot see the anonymous sender.** The near-term system is mostly
(a) configure + feed Radar, (b) build SendMo-side intelligence (the Account Budget) at 2a.

**Recommended before launch:** configure Radar + feed it metadata across all three
intent types; handle a Radar block on the flex charge as a distinct outcome (logging +
notification); add the **Account Budget** — one per-account spending limit ($200/day +
$500/week, admin-raised) plus a per-account PM-add breaker (§5.1 B5); and right-size the
default per-shipment cap. **Chargeback Protection was considered and dropped** (2026-05-22
— it requires a Stripe Checkout migration and would never cover the flex MIT path; §4.3).
Signup defenses (CAPTCHA etc.) are **not** in the near-term plan — Turnstile is parked to
WISHLIST; the load-bearing defense is making a farmed account unable to move money, not
blocking signups. Everything heavier (Radar for Fraud Teams, review queue, evidence
automation) is volume-gated and deferred.

---

## 1. Why this proposal exists

`proposals/2026-05-19_payments-golive-followups-handoff.md` Job 4 listed a "spend-cap /
e-brake" follow-up. The Job 4 triage (this session) concluded a cap alone is the wrong
centerpiece: it limits *how much* damage, not *whether* abuse happens, and only on one
of three surfaces. John's direction: think in terms of a risk system, organized around
**where** risk intelligence is applied. This proposal is that system, near-term-scoped.

## 2. Scope — decisions taken as given

Three calls from John frame this proposal; they are inputs, not open questions:

- **Visa/Mastercard network dispute-rate programs are not a concern.** The earlier triage
  framed dispute-rate-driven Stripe account termination as the existential risk. Per
  John's call that lens is **parked**. (One-line FYI for the reviewer: it remains true
  that disputes count toward network monitoring regardless of who absorbs the cost —
  noted only so it isn't re-discovered as a surprise. It does not drive this proposal.)
- **Chargeback Protection — considered, then dropped (2026-05-22).** John initially
  wanted it for nascent-stage peace of mind. The fresh-eyes review found it requires
  routing charges through Stripe Checkout (SendMo uses Elements) and would never cover
  the flex off_session MIT path. John's call: not worth a checkout migration for
  partial coverage — **dropped.** See §4.3.
- **The two charge contexts** (PM adding; label printing, split flex vs single-use) are
  John's framing and structure this proposal's analysis.

### 2.1 Design decisions from John (2026-05-21 / 2026-05-22)

John has given the following design directions across 2026-05-21 and 2026-05-22, folded
into this revision:

1. **Run Radar on the flex label charge (2a)** — Radar scores the *payer* on every
   charge to their PM (built-in, automatic — John's 2026-05-22 confirmation); SendMo's
   job is to **handle a Radar block as a distinct outcome** — a failure notification +
   SendMo-side logging so the team has visibility when it fires. (The 2026-05-21 draft
   proposed fingerprinting the *sender* via a Radar Session; the review showed Radar
   cannot see the sender on an off_session charge — corrected 2026-05-22, see §3.2.)
   See §5.1 B4.
2. **Velocity limits per financial instrument, not just per link** — aggregate dollar
   velocity keyed on the **payment method (card)**, summed across every link that card
   backs. The PM is the real instrument to protect; per-link alone is bypassed by one
   card behind many links. See §5.1 B5 / L2. **(Superseded 2026-05-22 by item 5 —
   collapsed into the per-account Account Budget; the per-card cap is now a
   held-in-reserve escalation, §5.3.)**
3. **A velocity limit on payment-method adds per account** — cap how many cards one
   account can add in a window, to blunt card-testing via repeated SetupIntents. See
   §5.1 B5 / L3.
4. **Bot detection on account creation — decided 2026-05-22: parked.** Limits 2+3 push a
   determined attacker toward scripting many account creations. John raised
   Cloudflare-style human detection. Decision: **Turnstile / signup CAPTCHA goes to
   WISHLIST, not the near-term plan** — John does not want signup friction, and the
   proposal's own logic (§4.4 B) is that the load-bearing defense is making a farmed
   account *unable to move money*, not blocking signups. The remaining signup layers
   (disposable-email block, signup-rate limit) drop to fast-follow (§5.2).

5. **Velocity → one "Account Budget" (2026-05-22).** Collapse the per-link and per-card
   layers into a single per-account spending budget: **$200/day + $500/week**, raised
   only by contacting SendMo (admin tools adjust it; no self-serve raise). The
   per-account PM-add breaker (item 3 / L3) stays. See §5.1 B5.
6. **Terminology direction — "payer" (2026-05-22).** SendMo will move from the
   sender/recipient split toward a single **payer** concept — a recipient can also
   create links and pay. The risk model is unaffected (it keys on accounts and charge
   contexts, not roles), and this is *why* the Account Budget is tied to the **account**:
   that entity survives the reframe. Prepaid balances are a noted future option if
   budgets alone prove insufficient.

Items 1, 3, 5 are **decided inputs**; item 2 is superseded by 5; item 4 is decided
(parked); item 6 is forward context. Chargeback Protection (§2) is dropped. Remaining
open items: O2, O4, O5, O7 — see §7.

Out of scope: reopening Pattern D; international/SCA; the full-label account-creation flow.

## 3. The two risk contexts

### 3.1 Context 1 — PM adding (SetupIntent / card save)

**Code surface:** `payment-methods/` Edge Function (POST → SetupIntent). Reached from
flex onboarding step 22 (`RecipientStepFlexPayment`), Dashboard "Add a card"
(`AddCardModal`), `LinksEditor` inline SetupIntent, and the decline-recovery
reactivation deep link.

**What Stripe sees:** the recipient is **on-session** in Stripe Elements — full device
fingerprint, browser, IP, the card itself. This is Radar's strongest position, identical
to any normal card-on-file save.

**Why it's the highest-leverage layer:** this is the **only** place to stop true fraud
(a stolen card entering the system). Once a stolen card is saved on a flex link, every
downstream control is damage-limitation. A carder creating a flex link with a stolen
card is *also* card-testing here — and Radar's card-testing protection covers
SetupIntents.

**Near-term intelligence:**
- **Radar built-in scoring** on the SetupIntent — already active; needs configuration
  (§4.1).
- **OTP-verified email** is already a gate (flex OTP migration, 2026-05-15) — a real
  KYC-lite signal; no new work, just acknowledge it in the model.
- **ZDA / Pattern D′** belongs *here* as a candidate control, not only as the
  telemetry-gated UX item the WISHLIST frames. Its risk rationale — verify the issuer
  accepts the card at the strongest detection moment — is independent of the
  decline-rate telemetry gate. **Decided 2026-05-22 (O2): kept telemetry-gated** — not
  added now; revisit ~2 weeks post-launch with the decline-rate query (PAYMENTS.md §4).

### 3.2 Context 2a — Link-driven label (flex; off_session; payer ≠ printer)

**Code surface:** `labels/` Edge Function flex branch → `createOffSessionShipmentPI`
(`_shared/stripe.ts`). Triggered by an anonymous, no-login sender at the `/s/<code>`
Confirm step.

**What Stripe sees:** the charge is an **off_session merchant-initiated transaction
(MIT)** against the *payer's* card (the recipient who created the link). Radar runs
automatically on this charge, as on every Stripe charge — but it scores the **payer**:
their card, their customer history, the amount, the PM's Radar data from card-save time,
and whatever metadata SendMo attaches. It **cannot see the anonymous sender.** A
2026-05-21 draft of this proposal claimed SendMo could fingerprint the on-session sender
via a client-side Radar Session and attach it to the charge; the fresh-eyes review
(§ Review, finding B-1) established that a Stripe Radar Session attaches to the
**PaymentMethod** — created once, at the *recipient's* SetupIntent, in the *recipient's*
browser — not to a per-charge sender session. There is no way to put the sender's
fingerprint on a charge against someone else's card without charging the sender directly,
which reopens Pattern D (out of scope, §2). **So: Radar at 2a scores the payer on every
charge — real and worth having (John's 2026-05-22 call) — but the anonymous-sender risk
is structurally invisible to Radar and must be carried by SendMo's own controls.**

**Why 2a is the surface SendMo must actively defend:** the person spending the money is
not the cardholder, has no login, and the product (an EasyPost label) carries real
resale/cash value. Abuse modes:
- **True fraud:** an attacker who obtains the public link URL ships on the payer's card;
  or a carder cashes a stolen card out as postage via their own link.
- **Friendly fraud:** a legitimate payer later disputes charges they did authorize.

Today's only 2a controls: the per-shipment cap (`link.max_price_cents`, currently
**$100 on every link**) and an **in-memory, per-IP** velocity limit (5/60s) in
`labels/index.ts` — weaker than it reads (resets on cold start; not shared across
function instances; per-IP, so IP rotation bypasses it). There is **no cumulative
ceiling**.

**Near-term intelligence at 2a:**
- **Radar on the payer, every charge** (B4, §5.1) — Radar already scores every
  off_session PI automatically; SendMo's build is (1) **feed it metadata** (§4.1) and
  (2) **handle a Radar block as a distinct outcome.** A Radar block is **not** a card
  decline and must not be treated as one: a decline means the payer's card has a problem
  (→ decline-recovery email, link Inactive); a Radar block means Stripe judged the
  charge fraudulent — handled with a friendly sender-facing message, a dedicated
  `label.flex_radar_blocked` `event_logs` row carrying the Radar outcome, a
  `link_state_events` row, and a **notification to SendMo** for visibility ("so we know
  this is happening" — §2.1). It must **not** flip the link Inactive. The **payer is
  also notified on every block** (O7, decided 2026-05-22), with gentle wording.
- **Account Budget** (B5, §5.1) — one per-account spending budget ($200/day +
  $500/week, admin-raised) plus a per-account PM-add breaker. This is the primary bound
  on the sender-side risk Radar cannot see.
- **Right-size the default per-shipment cap** (B6) — every flex link defaults to
  **$100**; real labels run $7–15. Dropping the default to **$50** (O4) halves the
  per-event blast radius at near-zero effort.
- **Feed Radar metadata + `shipping`** (§4.1) — improves Radar's payer-side scoring now,
  and pre-wires Radar for Fraud Teams custom rules later.

### 3.3 Context 2b — Single-use label (full-label; on-session; payer = printer)

**Code surface:** `payments/` Edge Function (full-label PI, `capture_method=automatic`)
→ `RecipientStepPayment` / `StripePaymentForm`.

**What Stripe sees:** an **on-session customer-initiated charge** — the payer is in
Stripe Elements paying with their own card right now. This is an ordinary e-commerce
checkout. Radar is **strong**, identical to Context 1's position.

**Why it's the low-risk surface (relatively):** the only real risk is generic
stolen-card carding, which Radar is designed for. The label still has cash value, but
the charge is on-session so Radar does its job.

**Near-term intelligence:** **mostly just Radar, configured** (§4.1) — the recommended
block rules (CVC fail, postal-code fail, high risk) plus card-testing protection cover
this surface. No bespoke SendMo logic needed near-term. Treat 2b as a solved problem
once Radar is configured.

### 3.4 The asymmetry — one glance

| | Context 1 · PM add | Context 2a · Flex label | Context 2b · Single-use label |
|---|---|---|---|
| Stripe primitive | SetupIntent | off_session PI (MIT) | on-session PI (CIT) |
| Payer present? | Yes (recipient) | **No** | Yes (printer) |
| Payer = actor? | Yes | **No** — anon sender | Yes |
| Radar strength | Strong | **Moderate** — scores the payer on every charge; cannot see the anonymous sender (§3.2) | Strong |
| Primary defense | Radar + ZDA? | **Account Budget + per-shipment cap** (Radar scores the payer, not the sender) | Radar |
| Near-term build | Config only | Radar-block handling + Account Budget | Config only |

**The whole proposal in one sentence:** Contexts 1 and 2b are normal Stripe surfaces —
configure Radar and move on; Context 2a is the one place SendMo carries the risk itself.

## 4. The Stripe products

### 4.1 Radar (built-in) — included; configure before launch

Stripe Radar's ML scoring is included with standard Stripe pricing and is **already
running** on every SendMo charge. Near-term work is **configuration**, not integration:

- In the Stripe Dashboard, review and enable Stripe's **recommended block rules**:
  block if CVC verification fails, block if postal-code verification fails, block if
  Radar risk level is "highest". Verify **card-testing protection** is on (it covers
  SetupIntents too — relevant to Context 1).
- **Feed Radar metadata** on all three intent types so the data is in place for custom
  rules later. Cheap (~½ day) and the highest-leverage code item:

  | Field | SetupIntent (C1) | Flex PI (2a) | Full-label PI (2b) |
  |---|---|---|---|
  | `txn_kind` | `setup` | `mit_flex` | `cit_full_label` |
  | `link_id` / `link_type` | ✓ | ✓ | ✓ |
  | recipient email | ✓ | ✓ | ✓ |
  | sender IP | — | ✓ (Radar can't see the sender on an MIT — pass it as metadata for later Fraud Teams rules) | n/a (Stripe.js captures it) |
  | sender email | — | ✓ (once captured — fast-follow) | n/a |
  | `shipping` (Stripe's dedicated field) | — | origin/destination | origin/destination |

  Built-in Radar won't *rule* on metadata, but this turns Radar for Fraud Teams into a
  zero-code switch-flip later.

**Cost:** included. **Effort:** Dashboard config (~1 hr, John) + metadata code (~½ day).

### 4.2 Radar for Fraud Teams — defer to volume

The paid tier (~$0.07/transaction, verify current pricing) adds custom rules,
allow/block lists, velocity rules on the card fingerprint (better than our per-IP
limit), and a **manual review queue**. Valuable — but at near-zero launch volume,
paying per-transaction for a review queue nobody is staffing is premature.

**Recommendation:** launch on built-in Radar. The §4.1 metadata pre-wiring means this
becomes a Dashboard toggle (no code) the moment volume justifies it.

**Does John's "run Radar at 2a" decision (§2.1) force Fraud Teams now?** No. Built-in
Radar already scores *and automatically blocks* high-risk charges, including off_session
PIs — so Radar runs on the payer at 2a for free. What Fraud Teams adds is **custom
rules** (e.g. rules on SendMo's own metadata, sender-IP velocity) and the **review
queue**. Built-in Radar + the Account Budget (§5.1 B5) delivers John's intent for
launch; Fraud Teams is the volume-gated upgrade. This is open question O5.

### 4.3 Chargeback Protection — considered, dropped (2026-05-22)

Chargeback Protection was in the 2026-05-21 draft as a before-launch "cash hedge." The
fresh-eyes review (§ Review, finding B-2) checked Stripe's current terms: Chargeback
Protection covers only charges **submitted via Stripe Checkout** ("You agree to submit
all of your Charges via the Stripe Checkout"). SendMo integrates via Stripe **Elements**,
not Checkout — so on the public terms *neither* the full-label nor the flex charge
qualifies, and the flex off_session MIT could never be covered regardless. Getting the
coverage would mean migrating the full-label checkout to Stripe Checkout — real scope,
not a toggle.

**John's call (2026-05-22): dropped.** Not worth a checkout migration for partial
coverage. The dispute defense instead is (a) **prevention** — Radar at the PM-add + the
Account Budget — and (b) **representment**: contest disputes with evidence (the
SetupIntent mandate, OTP-verified email, EasyPost delivery proof). The §5.3
chargeback-evidence packet is the relevant follow-up; near-term, document where that
evidence lives.

### 4.4 Bot-farm defense — the plan (O6)

The velocity ladder (per-link → per-PM → per-account PM-adds) closes each bypass until
the last: an attacker scripts **many account creations** to mint fresh accounts and
restart the ladder. The instinct is "stop the bots at signup" — but framed that way the
defender loses. Account creation on the open web is fundamentally cheap, and
CAPTCHA-solving services defeat CAPTCHAs for ~$1–3 per 1,000. **The goal is not zero bot
accounts — it is bot accounts that are free to create but cannot move money.** That
splits the plan in two:

**A — Thin the herd at signup (cheap friction; need not be airtight).** *(Status: this
four-point list is the analysis. A1 is parked to WISHLIST; A3 + A4 are fast-follow — see
"Near-term plan" below. It is not the live before-launch plan.)*

1. **CAPTCHA.** Supabase Auth natively supports a CAPTCHA challenge (Cloudflare
   **Turnstile** or hCaptcha) on its signup/OTP endpoints. SendMo signup *already* runs
   through Supabase Auth OTP (flex OTP migration, 2026-05-15), so this is a config flip
   + a widget, not an integration. Vendor choice is **O6** — the three options are
   Supabase-native CAPTCHA, standalone Turnstile, or Vercel BotID/Firewall;
   recommendation is **Supabase-native Turnstile** (free, usually invisible, reuses the
   existing OTP path, no separate vendor). Stops casual/unsophisticated bots.
2. **Email-OTP — already shipped.** Every SendMo account already requires receiving an
   email and entering a code. The farm's real bottleneck is therefore *working inboxes*,
   not the signup form.
3. **Block disposable / temp-email domains at signup.** Because OTP makes inboxes the
   bottleneck, denying throwaway-email providers is the single highest-leverage cheap
   filter. Maintained domain blocklists exist; this is a small check in the signup path.
4. **Signup velocity + datacenter-IP flagging.** Throttle signups per IP / subnet per
   window; flag signups from known datacenter/VPN ranges (bots run from datacenters,
   real users from residential IPs). The velocity check is small Edge Function logic;
   rich datacenter-IP *intelligence* (a vendor feed) is a deferred upgrade.

**B — Make the account useless even if it is created (this is most of the proposal
already).** A bot account still has to (i) get a stolen card past **Radar at the
SetupIntent** — Context 1, where Radar is *strong* (full on-session device fingerprint)
— and (ii) push each charge past **Radar-at-2a** (B4). Every account also costs the
attacker a working email inbox (OTP) and a stolen card that survives Radar — neither is
free. The **per-account PM-add breaker** (L3) caps how many cards one account can host;
the **Account Budget** caps each account's damage at $500/week.

**Honest gap (decided, accepted near-term).** The Account Budget is *per-account*, so
100 farmed accounts have 100 budgets — it bounds per-account damage but is **not itself
an anti-farm control**. What actually throttles a farm "at first" is (i) Radar at the
PM-add, (ii) the per-account economics, and (iii) L3 — see the §7 farming answer. The
held-in-reserve escalation, if telemetry ever shows a real farm, is a **per-card
fingerprint cap**: aggregate one stolen card's spend across *every* account it touches,
keyed on Stripe's `card.fingerprint` (stable across customers). Not built now — per
John's "don't overdo it" — but documented as the named next move (§5.3).

**C — Burn down farms once detected (fast-follow).** When one bot account trips a Radar
block or a chargeback, correlate its siblings — shared IP, device fingerprint, email
pattern, card fingerprint — and disable the cluster. Lives in the §5.2 admin review
surface; richer at the Radar-for-Fraud-Teams tier.

**Near-term plan (revised 2026-05-22):** rely on **B** — it is the load-bearing fact,
and the proposal already builds it. Layer **A is deprioritized**: **A1 (CAPTCHA /
Turnstile) is parked to WISHLIST** per John's call — he does not want signup friction,
and a CAPTCHA is "thin the herd," not enforcement. A3 (disposable-email block) and A4's
signup-rate limit drop to **fast-follow** (§5.2) — both are invisible to real users, but
neither is load-bearing. One caveat on A3: a disposable-email blocklist must block
*throwaway / temp-mail* domains while still allowing legitimate **privacy-forwarding**
services (Apple Hide My Email, DuckDuckGo, Firefox Relay) — a naive list creates false
positives for privacy-conscious good users. **Defer** the datacenter-IP intelligence
vendor, progressive-trust tiers, and cluster burn-down until there is evidence of real
farm activity.

## 5. Recommended near-term system

### 5.1 Before launch

| # | Item | Context | Effort |
|---|---|---|---|
| B1 | Configure Radar built-in — recommended block rules + verify card-testing protection | 1, 2a, 2b | ~1 hr (John, Dashboard) |
| B2 | Feed Radar metadata + `shipping` on all three intent types (§4.1) | 1, 2a, 2b | ~½ day |
| ~~B3~~ | ~~Stripe Chargeback Protection~~ — **dropped 2026-05-22** (requires a Checkout migration; §4.3) | — | — |
| **B4** | **Radar-block handling on the flex charge** — Radar runs on the payer automatically; build the distinct Radar-block outcome branch (≠ card decline) + `label.flex_radar_blocked` logging + SendMo notification | 2a | ~½–1 day |
| **B5** | **Account Budget** ($200/day + $500/week, per-account, admin-raised) **+ per-account PM-add breaker** — both tunable + logged (detail below) | 2a, 1, 2b | ~2 days |
| B6 | Right-size the default per-shipment cap ($100 → $50) | 2a | near-zero |

**B4 — Radar-block handling on the flex charge.** Radar already scores every off_session
PI automatically (it scores the *payer* — see §3.2), so there is no "turn Radar on" work
and no sender-side Radar Session to build (the 2026-05-21 draft's mechanism — corrected
per review finding B-1). The build is the **distinct Radar-block outcome branch.** When
Radar blocks the off_session charge in `labels/`: it is **not** a card decline and must
not be treated as one — a decline means the payer's card has a problem (→
decline-recovery email, link Inactive); a Radar block means Stripe judged the charge
fraudulent. The branch: a friendly sender-facing message, a dedicated
`label.flex_radar_blocked` `event_logs` row carrying the Radar outcome, a
`link_state_events` row, and a **notification to SendMo** for visibility (near-term: a
simple internal email; longer-term: the §5.2 admin review surface). It must **not** flip
the link Inactive — the payer's card is fine. Per O7 (decided 2026-05-22), the **payer
is also notified on every block**, with gentle wording.

**B5 — the Account Budget + the PM-add breaker.** Decided 2026-05-22 (John): collapse
the per-link and per-card layers into **one per-account spending budget** — simpler, and
the right grain (see below).

**The Account Budget.** Tied to the SendMo **account** (= the payer). Two windows:
**$200 / day and $500 / week.** It counts every charge that settles against the
account's card(s) — flex (2a) and full-label (2b) alike. Raising it is **not
self-serve**: the account holder contacts SendMo and an **admin raises it** via admin
tools. When a charge would breach either window: refuse with friendly copy ("this
account has reached its weekly spending limit — contact us to raise it"), notify the
account holder (email + dashboard), and write a `velocity.limit_hit` log row. The two
windows together give a burst allowance (daily) under a tighter sustained ceiling
(weekly). The budget check **runs before `createOffSessionShipmentPI`** (and before the
full-label PI) — never after — so a refusal can never leave a charged-but-no-label or
label-but-over-budget race.

Why per-account, not per-link or per-card:
- **Simplest model** — one number a user understands, one place an admin adjusts.
- **Future-proof.** SendMo is collapsing "sender/recipient" into a single **payer**
  concept (a recipient can also create links and pay — §2.1 item 6). A budget tied to
  the *account* survives that reframe unchanged; a per-link budget is role-specific and
  would not.
- **Bounds per-account damage** to $500/week regardless of how many links the account
  has.

**On false positives** (John's concern): a good user *will* hit this — a busy flex link,
or a legitimate higher-volume shipper. That is handled by design, not by accident: the
message is "contact us," recovery is a human raising the number via admin tools, and
every hit is logged so SendMo sees who is getting caught and can raise proactively. Two
honest notes: (1) the budget counts a user's own full-label (2b) purchases as well as
flex (2a) — decided 2026-05-22 (O8): the budget is a holistic per-account spend limit,
not only a fraud control. A legitimate high-volume self-shipper therefore reaches
"contact us" sooner; that contact is the intended human-in-the-loop checkpoint, but it
is real friction; (2) admin-raised (not self-serve) means SendMo must be responsive to
those requests or the budget becomes a growth blocker.

**Per-account PM-add breaker** — kept, and kept lean per John's "don't overdo it": cap
how many card-adds (SetupIntents) one account completes per window. A card-tester adds
dozens; a real user 1–3 — the gap is wide, so false-positive risk is low. On a trip:
card-add blocked, "contact support."

**Telemetry.** Both the budget and the PM-add breaker are tunable config (changeable
without a deploy); every trip logs a `velocity.limit_hit` row (which control, account,
window, values). Launch conservative, watch the stream, raise budgets case-by-case —
that is how SendMo "understands when" good users are getting caught.

**Future:** if abuse or growth demands it, the budget can become a **prepaid balance**
(load funds, spend down) instead of a rolling limit — noted as a direction, not v1.

**Data path:** the budget sums `transactions` per **account** — confirm `transactions`
carries `user_id` or a reliable join to it (§8); the PM-add breaker counts `setup`
intents per `user_id`.

**B6 — right-size the default cap.** Default `max_price_cents` **$100 → $50** (O4,
decided 2026-05-22); recipients can raise it deliberately. B6 caps a *single* shipment;
B5 caps *per-account* daily/weekly spend — two different ceilings.

### 5.2 Fast-follow (soon-after launch, still small)

- **Require + capture sender email at Confirm** (2a) — fraud signal, sender
  notification, dispute evidence. ~½ day. (Already raised as Job 5 open question #4 in
  the 2026-05-18 handoff.)
- **Decline-burst soft-lock** (2a) — freeze a link after N declines in M minutes,
  require recipient acknowledgement. ~½ day. Existing WISHLIST fraud item.
- **Light admin review surface** (2a) — heuristic flags in the existing `/admin`:
  links charged > $X in 24h, links hit by many distinct sender IPs, decline bursts,
  `velocity.limit_hit` rows, and **B4 `label.flex_radar_blocked` events**. No new queue
  infrastructure — reuses `/admin`, `event_logs`, `link_state_events`. Until it exists,
  B4's Radar-block notification is a simple internal email; this surface is the durable
  home for it.
- **Signup defenses (residual)** — a disposable/temp-email domain blocklist (must allow
  legitimate privacy-forwarders — see §4.4) and a per-IP signup-rate limit. Both
  invisible to real users; neither load-bearing. Turnstile/CAPTCHA itself is parked to
  WISHLIST per John's 2026-05-22 call.

### 5.3 Deferred — volume-gated

- **Radar for Fraud Teams** — custom rules + review queue; toggle on at real volume.
- **Per-card fingerprint spend cap (anti-farm escalation)** — aggregate one stolen
  card's spend across every account it touches, keyed on Stripe's `card.fingerprint`.
  The escalation if `velocity.limit_hit` / Radar-block telemetry shows a real account
  farm. Deliberately not in v1 (John's "don't overdo it"); documented so it is a known
  next move, not a rediscovery.
- **Chargeback-evidence packet automation** — assemble mandate consent + OTP record +
  EasyPost delivery proof for representment. With Chargeback Protection dropped (§4.3),
  **representment is SendMo's dispute defense** — so this rises in importance. Still fine
  to defer the *automation* until disputes are non-zero; near-term, just document where
  the evidence lives.
- **Nightly PM-validation cron + 30-day expiry email** — from the Job 4 triage;
  card-health, not fraud; unchanged "soon-after" ranking.
- **ZDA / Pattern D′** — kept telemetry-gated (O2); revisit ~2 weeks post-launch with
  the decline-rate query (PAYMENTS.md §4).

## 6. Effort & sequencing

Before-launch code is roughly **3–3.5 days**: B2 (~½ day — Radar metadata), B4 (~½–1 day
— the Radar-block handling branch), B5 (~2 days — the Account Budget columns +
enforcement + limit-hit notification + an admin budget control; no self-serve UI, since
raises go through admin), B6 (~0). Plus one no-code item: B1 (Radar Dashboard config,
~1 hr, John). Suggested order: B1 first; B2 next (unblocks B4); then B4 and B5 in
parallel — independent. **Dependency to clear first:** confirm `transactions` can be
aggregated per account for B5 (§8) — if the join is multi-hop, B5 trends to the high end.
Fast-follow items (§5.2) are independent ~½-day pieces. Chargeback Protection and signup
defenses are not in this scope (§4.3, §4.4).

## 7. Decisions (O1–O8 — all resolved 2026-05-22)

- **O1 — Chargeback Protection. Resolved 2026-05-22: dropped.** Requires a Stripe
  Checkout migration; never covers the flex MIT path. See §4.3.
- **O3 — Velocity model & values. Resolved 2026-05-22:** one per-account Account Budget
  ($200/day + $500/week, admin-raised) + per-account PM-add breaker. Per-link/per-card
  layers dropped from v1 (per-card cap held in reserve, §5.3). Budget values are
  launch-tunable from telemetry.
- **O6 — Bot detection at signup. Resolved 2026-05-22:** Turnstile / signup CAPTCHA
  parked to WISHLIST; disposable-email block + signup-rate limit → fast-follow (§5.2).
- **O8 — Account Budget scope. Resolved 2026-05-22: counts all charges (2a + 2b).**
  John's call: the budget is a holistic per-account spending limit, not only a fraud
  control — it bounds self-spend (full-label) and flex spend alike. The 2b friction
  noted in §5.1 (a high-volume self-shipper reaching "contact us" sooner) is an accepted,
  deliberate tradeoff; the admin-raise path is the intended handling.

- **O2 — ZDA / Pattern D′. Resolved 2026-05-22: kept telemetry-gated.** Not added now;
  revisit ~2 weeks post-launch with the decline-rate query (PAYMENTS.md §4). The risk
  lens did not override the prior telemetry-gated call.
- **O4 — Default per-shipment cap value. Resolved 2026-05-22: $50** (down from $100).
  Recipients can raise it deliberately. See §5.1 B6.
- **O5 — Radar for Fraud Teams. Resolved 2026-05-22:** launch on built-in Radar (it
  auto-blocks high-risk charges); add Fraud Teams when volume justifies a review queue.
- **O7 — Recipient notification on a Radar block. Resolved 2026-05-22: yes** — notify
  the payer on every Radar block, with gentle wording. (SendMo-internal logging +
  notification happens regardless — B4.)

All eight open questions (O1–O8) are resolved. **The proposal is decided 2026-05-22.**

## 8. Review handoff

*(Pre-review handoff — what the author asked the reviewer to stress-test. The review was
completed 2026-05-22; see the § Review and § Author response sections below. Retained for
history; points 1–2 are now resolved by findings B-1 / B-2.)*

For the fresh-eyes reviewer — the load-bearing claims worth stress-testing:

1. **The §3.2 Radar Session technique is now load-bearing — verify it.** This revision
   asserts Radar *can* be effective at 2a because the *sender* is on-session: collect a
   Radar Session client-side (`stripe.createRadarSession()`), attach it to the
   server-created off_session PI via `radar_options.session`. Confirm against current
   Stripe docs that this works for an off_session PI created server-side from a session
   collected in the anonymous sender's browser. If it does not, B4 ("run Radar at 2a")
   needs rethinking and the §3.2 framing reverts to "Radar weak at 2a."
2. **O1 is the highest-stakes product unknown** — whether off_session MITs are
   Chargeback-Protection-eligible determines how much "sleep at night" B3 actually buys.
3. **Is the Account Budget's data path sound?** Confirm `transactions` is reliably
   written for every charge (`stripe-webhook` is the sole writer per Rule 16) and can be
   aggregated **per account** (a `user_id` column, or a reliable join via
   `link_id`/`shipment_id`) so the $200/day + $500/week sums are trustworthy as a gate
   input.
4. **Is the Account Budget (§5.1 B5) the right call?** John chose one per-account budget
   ($200/day + $500/week, admin-raised) over a per-link/per-card hierarchy — simpler and
   future-proof, but a per-account budget does not constrain an account farm (§4.4 B).
   Stress-test: is "Radar-at-PM-add + economics + L3 + bounded per-account damage" a
   sufficient near-term anti-farm posture, with the per-card fingerprint cap held in
   reserve? And does a budget that also counts full-label (2b) charges put too much
   contact-us friction on legitimate high-volume shippers?
5. **Does B4's distinct Radar-block branch interact cleanly** with the existing
   decline-recovery path in `labels/` + `stripe-webhook/`? The two must not be
   conflated — a Radar block must not trigger the recipient decline email or flip the
   link Inactive.

---

*No code was written this session — implementation is a separate session. This proposal
supersedes the standalone Job 4 "spend-cap" item. Decided 2026-05-22; recorded in LOG.md
under that date.*

---

## Review — fresh-eyes pass (2026-05-22)

**reviewer:** Claude (fresh-eyes review session, no part of the design conversation)
**reviewed_at:** 2026-05-22
**verdict:** `needs-rework`

### Summary

This is a strong, well-structured proposal — the three-context decomposition (PM-add /
flex / full-label) is the right frame, the staging instinct (config now, Fraud Teams
later) is sound, and the §4.4 "make the account unable to move money" reasoning is the
correct centre of gravity for an anti-farm posture. The honesty is genuine: §4.4 openly
admits the per-account budget doesn't bound a farm, and §8 flags the right things to
verify. But the two most load-bearing technical claims — the §3.2/B4 Radar Session
technique and O1's Chargeback Protection hope — **do not hold up against current Stripe
documentation in the form the proposal assumes**, and the whole proposal's headline
("run Radar at the flex charge") rests on the first one. That moves the verdict to
`needs-rework`: not because the strategy is wrong, but because B4 needs to be rebuilt
around how Radar Sessions actually attach, and B3/O1 needs to be re-scoped before John
treats Chargeback Protection as bought. Both are fixable; neither is fatal to the plan.

### Blocking findings

**B-1 — The §3.2 / B4 Radar Session mechanism is described wrong: for the off_session
case Stripe attaches the session to the *PaymentMethod*, not to the off_session
PaymentIntent.**

*What's wrong.* §3.2, §2.1 item 1, the §3.4 table, B4, and O5 all assert the technique
is: collect a Radar Session in the sender's browser → thread the id to `labels/` →
attach it to the off_session PI via `radar_options.session`. Stripe's own Radar Session
documentation shows the off_session pattern differently: the Radar Session is attached
to the **PaymentMethod** (`radar_options[session]` on the *PaymentMethod* create call),
and "Radar associates the client data with the Payment Method and all future payments
made with it." The PaymentMethod-attach path is the one Stripe documents for the
"charge later / off_session" scenario precisely because an off_session PI has no live
browser session of its own.

*Why it matters.* This is not a nit — it inverts the timing of the whole technique.
SendMo's PaymentMethod is created **once, at the recipient's SetupIntent** (Context 1),
in the *recipient's* browser, weeks before any sender arrives. The §3.2 thesis — "the
sender is a live human on-session, so we can fingerprint the *actual actor*" — is the
entire reason the proposal claims Radar is "strong with a sender-side Radar Session" at
2a. If the session can only ride on the PaymentMethod, then the only Radar Session ever
attached is the *recipient's* device fingerprint from card-save time, and Radar at the
flex charge scores the recipient's old session, **not the sender** — which is exactly
the "Radar weak at 2a" conclusion the v1 draft reached and this revision claims to have
overturned. The proposal says (§8 finding 1) "if it does not [work], B4 needs
rethinking and the §3.2 framing reverts to 'Radar weak at 2a.'" That contingency has
now triggered.

*Recommended fix.* Before John decides, resolve one factual question with Stripe
directly (support ticket or a Stripe solutions contact, not docs inference): **can a
Radar Session collected client-side be passed to `radar_options[session]` on a
*PaymentIntent* `create` call (with `confirm=true, off_session=true`) and have Radar
score that session?** The Stripe.js `createRadarSession` reference does say the id "can
be passed to Stripe when creating charges" — "charges" *may* include PI create — so this
is genuinely ambiguous and worth a definitive answer rather than a guess. Two outcomes:
 - **If PI-attach works:** B4 stands, but §3.2 should say "attach to the PI" explicitly
   and stop also implying the PM path; the proposal currently blurs the two.
 - **If only PM-attach works:** B4 must be re-architected. The realistic options are
   (a) accept that Radar-at-2a scores stale recipient data and downgrade the §3.4 table
   back to "Radar weak at 2a" — which makes the Account Budget and per-shipment cap the
   *actual* primary 2a defense, not a co-equal; or (b) add a per-sender Stripe primitive
   that *can* carry a fresh Radar Session — but every option there (charging the sender
   directly, a sender-side SetupIntent) reopens Pattern D, which §2 puts out of scope.
   Either way the proposal's headline sentence and §3.4 table need rewriting. This is
   the single highest-value thing to nail down before John spends 1.5–2 days on B4.

**B-2 — Chargeback Protection almost certainly does NOT cover SendMo's charges as built
— and the gap is wider than O1 frames it. O1 worries only about 2a; the real risk is
that 2b is uncovered too.**

*What's wrong.* §2, §4.3, B3, and O1 treat Chargeback Protection as "enable before
launch," with the only open question being whether *off_session 2a* charges qualify.
Stripe's Chargeback Protection legal terms state the covered set is "valid credit card
Charges that your customers submit **via Stripe Checkout**" and "You agree to submit all
of your Charges via the Stripe Checkout." Secondary sources are consistent: protection
applies only to Stripe Checkout transactions, and recurring / manually-approved
transactions are excluded.

*Why it matters.* SendMo does not use Stripe Checkout — it uses Stripe **Elements**
(`StripePaymentForm`, `RecipientStepPayment`, custom card fields per PAYMENTS.md). If
the Checkout requirement is enforced as the terms read, then **neither 2a nor 2b
qualifies** — not just the off_session flex charge O1 flags, but the ordinary
full-label checkout the proposal calls "should qualify cleanly" (§4.3). That would mean
B3 buys John essentially nothing, and the §2 "cash hedge … so I can sleep at night"
framing is resting on a product SendMo cannot currently use. This is a decided input
("Chargeback Protection is wanted") that the proposal recommends acting on — and the
review's job is to flag when a decided input has a factual problem John should see:
**this is one.** John may still want it, but he should know that getting it likely
requires migrating full-label checkout to Stripe Checkout (a real scope item, not a
toggle), or that Stripe may offer Elements-integration eligibility on newer terms that
the public legal page doesn't reflect.

*Recommended fix.* Re-scope O1 from "are 2a MITs eligible?" to the prior question:
**"Is SendMo eligible for Chargeback Protection at all, given it integrates via Elements
and not Stripe Checkout?"** Ask Stripe directly; do not infer from docs. Until that is
answered, B3 should be marked **blocked**, not "minutes — pending O1," and §4.3's "an
on-session full-label charge (2b) should qualify cleanly" should be softened — it is an
assumption, not a fact, and the verification flips it. If the answer is "Checkout
required," John gets a clean decision: migrate checkout, or drop Chargeback Protection
and rely on representment (the §5.3 evidence-packet item, which becomes more important).

**B-3 — The before-launch scope is mis-sequenced against SendMo's actual go-live
state: B4 and B5 are 3.5–4 days of new payment-path code being inserted *ahead of* a
flex money-path that has zero live volume and was itself only verified end-to-end two
days ago.**

*What's wrong.* Per the task brief and the DB check, there is **zero live-mode
flex-charge volume** — live mode isn't even configured. LOG 2026-05-20 (Job 1) shows the
Pattern D money-path was verified end-to-end *in test mode* for the first time on
2026-05-20; the 2026-05-19 go-live handoff lists live-key/webhook config as the only
remaining go-live work. The proposal labels B4 + B5 "before launch" and §6 budgets
4–5 days for them. That inserts a new Radar-block branch and a new Account-Budget
enforcement gate into `labels/` and `stripe-webhook/` — the exact two functions whose
decline-recovery interaction §8 finding 5 already flags as delicate — *before the
existing flex path has carried a single real charge.*

*Why it matters.* This is a staging judgment, and the proposal's own logic argues
against itself here. §4.4 is built on the premise that the load-bearing defense is
"make a farmed account unable to move money," and §5.3 holds the per-card cap "in
reserve … if telemetry ever shows a real farm." But there *is no telemetry* — no live
charges, no abuse, no farm. Building B5's Account Budget before launch means launching
conservative limits ($200/day, $500/week) tuned against zero data, on a brand-new code
path, with admin-raise as the only escape hatch — and §5.1 itself concedes "admin-raised
… means SendMo must be responsive or the budget becomes a growth blocker." For a product
with zero users, the first real risk is not a card farm; it is a legitimate early user
hitting a guessed limit and churning. Meanwhile B4's value is capped by B-1 above until
the Radar Session question resolves.

*Recommended fix.* Re-stage. **Genuinely before-launch:** B1 (Radar config — John,
1 hr), B2 (metadata feed — ½ day, pure upside, pre-wires everything), B6 (per-shipment
cap right-size — near-zero, the single highest blast-radius-per-effort item). That trio
is cheap, low-risk, and touches no enforcement logic. **Fast-follow, gated on live mode
being on and the B-1 question answered:** B4 (rebuilt per B-1) and B5. The Account
Budget is genuinely valuable — but as a fast-follow once there is a money-path in
production to instrument, not as a guessed gate bolted on pre-launch. This also lets the
B-1 and B-2 Stripe questions resolve before code is committed to either. If John wants
*a* spend backstop before launch for peace of mind, a single crude per-account weekly
ceiling set deliberately high (well above any plausible legitimate early user) is a
half-day item and a better pre-launch shape than the full tunable two-window system.

### Non-blocking findings / nits

**N-1 — The Account-Budget-counts-2b-charges friction is under-weighted relative to how
real it is.** §5.1 honestly lists it ("a legitimate high-volume shipper reaches
'contact us' sooner … real friction"), but then moves on. Consider: a small business
owner using SendMo for their own outbound shipping — exactly the kind of early
power-user a nascent product wants — buying 30 full-label shipments in a week at
$15 each is $450, brushing the $500 weekly ceiling with their *own legitimate
self-serve purchases*, for which there is no fraud rationale at all. The fraud surface
is 2a (someone else's card, anon sender); 2b is the user spending their own money
on-session, Radar-screened. Folding 2b into the same budget means the anti-fraud
control taxes the lowest-risk, highest-value behavior. Recommendation: either exclude
2b (on-session, payer=printer) from the Account Budget entirely and let it count only
2a flex spend, or set the weekly ceiling materially higher. The proposal's "that
contact *is* the intended human checkpoint" defense is reasonable for 2a; it is weak
for a user buying their own postage.

**N-2 — §4.4 still reads as if CAPTCHA/Turnstile is partly in scope; it is decided
out.** §4.4 sub-section A is a full four-point plan with A1 (CAPTCHA) written in present
tense, and only the "Near-term plan (revised 2026-05-22)" paragraph at the end says A1
is parked. §2.1 item 4 and O6 also both say "parked." The body of §4.4-A should be
trimmed or clearly marked superseded so a future reader doesn't mistake the four-point
plan for the live plan. Minor, but the proposal was revised across a conversation and
this is visible seam.

**N-3 — Stale internal cross-reference: §3.1 and B5's data-path note.** §3.1 references
"flex onboarding step 22" and B5 says the PM-add breaker "counts `setup` intents per
`user_id`" while the Account Budget "sums `transactions` per account — confirm
`transactions` carries `user_id`." PAYMENTS.md §2 shows `transactions` is the
append-only ledger written solely by `stripe-webhook`, but does not confirm a `user_id`
column — the join may have to go `transactions → stripe_intents → … → sendmo_links →
user_id`, which is several hops and worth confirming *before* B5 is estimated at 2 days,
not during. §8 finding 3 raises this, but the 2-day B5 estimate in §5.1/§6 doesn't
visibly account for the risk that the join is non-trivial. Treat the 2-day figure as
"if the data path is clean" and flag the dependency.

**N-4 — O3 and O6 are marked "Resolved" inside §7, which is headed "Open questions."**
Cosmetic, but a reader skimming §7 for what's still open has to read each entry to
discover two are closed. Consider moving resolved items to a "Decided" subsection or
striking them, leaving §7 as genuinely-open-only (O1, O2, O4, O5, O7).

**N-5 — B4's effort estimate (1.5–2 days) predates B-1.** If the Radar Session must
attach to the PaymentMethod and the technique has to be re-architected, B4 is not
1.5–2 days — it is either near-zero (accept stale-recipient-session scoring, just pass
metadata) or substantially more (a new sender-side primitive). The estimate can't be
trusted until B-1 resolves.

**N-6 — The proposal never states what happens to an in-flight EasyPost label buy if
the Account Budget refuses the charge.** B5 says "refuse with friendly copy" when a
charge would breach the window. In `labels/` the off_session PI is created immediately
before the EasyPost buy (PAYMENTS.md §3). A budget refusal at that point is clean *if*
it happens before the PI is created — but the proposal should state explicitly that the
budget check runs *before* `createOffSessionShipmentPI`, not after, so there is no
charged-but-no-label or label-but-budget-exceeded race. Same care the proposal rightly
gives the Radar-block branch (§8 finding 5) should be spelled out for the budget gate.

### Factual-verification results

| Claim (proposal §) | Verdict | Notes / source |
|---|---|---|
| `createRadarSession()` + `radar_options[session]` lets you attach a browser-collected Radar Session to an **off_session PI created server-side** (§3.2, B4) | **Contradicted as written / couldn't fully confirm** | Stripe's documented off_session pattern attaches the session to the **PaymentMethod** ("Radar associates the client data with the Payment Method and all future payments made with it"), not to the off_session PI. Whether a session can *also* be attached to a PI `create` call is genuinely ambiguous in the docs and needs a direct Stripe answer. The PM-attach path defeats the §3.2 "score the actual sender" thesis because SendMo's PM is created at the recipient's SetupIntent, not the sender's session. [createRadarSession](https://docs.stripe.com/js/payment_intents/create_radar_session), [Radar Session guide](https://docs.stripe.com/radar/radar-session) |
| Off_session MIT is eligible for Stripe **Chargeback Protection** (O1) | **Contradicted (and broader than O1 assumes)** | Chargeback Protection terms: covers "Charges … submitted via Stripe Checkout"; "You agree to submit all of your Charges via the Stripe Checkout." SendMo uses Elements, not Checkout — so on the public terms *neither* 2a nor 2b qualifies, not just the MIT. Confirm SendMo's eligibility with Stripe directly. [Chargeback Protection Terms](https://stripe.com/legal/chargeback-protection) |
| Radar for Fraud Teams ≈ $0.07/txn (§4.2) | **Verified** | $0.07/screened txn standard; $0.02/txn for accounts on standard payment pricing. [Stripe Radar pricing](https://stripe.com/radar/pricing) |
| Chargeback Protection ≈ 0.4%/txn (§4.3) | **Verified** | Multiple sources confirm 0.4% per transaction surcharge. [Stripe Radar pricing](https://stripe.com/radar/pricing) |
| Built-in Radar (no Fraud Teams) auto-blocks high-risk charges (§4.2, O5) | **Verified** | Built-in Radar auto-blocks via risk controls / three preset risk settings (Maximize protection / Balance / Maximize revenue). [Risk settings](https://docs.stripe.com/radar/risk-settings) |
| Custom Radar **rules** require Fraud Teams (§4.2) | **Verified** | Custom rules and granular block-threshold editing are Radar-for-Fraud-Teams-only; built-in Radar gives presets, not custom rules. [Fraud prevention rules](https://docs.stripe.com/radar/rules) |
| Stripe `card` fingerprint is stable across different Customers for the same physical card *within one Stripe account* (§5.3 anti-farm escalation) | **Verified** | Fingerprint is unique per card number within a Stripe account and is the documented primitive for "look up other users with the same fingerprint" — stable across Customers in the same account. Caveats: changes if the card number changes (CAU reissue); wallet-tokenized cards (Apple/Google Pay) don't share the fingerprint of the same card used directly; differs *across* Stripe accounts. [Detect duplicate cards](https://support.stripe.com/questions/how-can-i-detect-duplicate-cards-or-bank-accounts) |
| Supabase Auth has native CAPTCHA on signup/OTP (Turnstile/hCaptcha) (§4.4-A1) | **Verified** | Supabase Auth supports Cloudflare Turnstile and hCaptcha on sign-up, sign-in, and password-reset, configured via Dashboard. [Supabase Auth CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha) |
| Cloudflare Turnstile is genuinely free/unlimited (§4.4-A1) | **Verified (with a cap)** | Free with unlimited challenges up to ~1M widget solves/month; free plan limited to 20 widgets/account. Effectively free for SendMo's scale. [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) |

### What the proposal got right

- The three-context decomposition (PM-add / flex / full-label) and the asymmetry table
  in §3.4 are the correct mental model and make the whole risk surface legible.
- §4.4's core thesis — "the goal is not zero bot accounts, it is bot accounts that
  cannot move money" — is the right strategic call and is rare clarity for a nascent
  product; parking signup CAPTCHA follows correctly from it.
- The honesty in §4.4 ("Honest gap … the Account Budget is not itself an anti-farm
  control") and §8 (flagging the Radar Session technique as the thing to verify) is
  exactly what makes a proposal reviewable — the two blocking findings above are
  *because* the author flagged where to look, not in spite of it.
- B6 (right-size the $100 default cap to ~$25–30) is the best effort-to-blast-radius
  item in the proposal and should ship regardless of everything else.
- Tying the budget to the **account** rather than link/role is the right durability
  call given the §2.1 item-6 "payer" reframe.

*Reviewer note: this review edits only the frontmatter-equivalent verdict line above
and appends this section. No proposal body text (§0–§8) was modified, per protocol.*

---

## Author response (2026-05-22)

The review returned `needs-rework` with 3 blocking findings. John reviewed the findings
and made the calls below; the proposal body (§0–§8) has been revised accordingly. The
Review section above is left intact as the audit trail.

**B-1 (Radar Session technique wrong) — accepted.** The review is right: a Stripe Radar
Session attaches to the PaymentMethod (created at the recipient's SetupIntent), not to a
per-charge sender session — so Radar at the flex charge scores the *payer*, never the
anonymous sender. John's call, verbatim: "Radar only works for the payer; it should run
on the payer every time there's a new charge to their PM." That is automatic — built-in
Radar scores every charge. B4 is reframed from "build a sender-side Radar Session" to
"build the distinct Radar-block handling branch"; §0, §2.1, §3.2, §3.4, §4.1, §4.2
corrected. Effort drops from ~1.5–2 days to ~½–1 day. The sender-side risk Radar cannot
see is now explicitly carried by the Account Budget + per-shipment cap.

**B-2 (Chargeback Protection requires Stripe Checkout) — accepted; product dropped.**
John's call: **no Chargeback Protection.** Not worth migrating the full-label checkout
from Elements to Stripe Checkout for partial coverage that never extends to the flex MIT
path. §4.3 rewritten as "considered, dropped"; B3 struck from §5.1; O1 marked resolved.
Dispute defense is now prevention (Radar + Account Budget) + representment (the §5.3
evidence packet, which accordingly rises in importance).

**B-3 (before-launch scope mis-sequenced) — partially accepted.** B4 is now small
(~½–1 day) and stays before launch. **B5 (Account Budget) stays before launch — John's
explicit call:** real payer cards on public URLs with no cumulative ceiling is the
original launch-safety gap, and a conservative guessed cap beats no cap. The reviewer's
concern about guessing thresholds with zero telemetry is mitigated by the budget being
tunable config + admin-raisable + fully logged from day one. Before-launch code is now
~3–3.5 days (down from 4–5).

**Nits:** N-1 → surfaced as new open question **O8** for John (count 2b charges, or
flex-only?) rather than silently decided. N-2 → §4.4-A marked as analysis, not the live
plan. N-4 → §7 split into Resolved / Still-open. N-6 → §5.1 B5 now states the budget
check runs *before* PI creation. N-3 / N-5 folded into §6 + §8 (the `transactions`
per-account aggregation is a flagged dependency; the old B4 estimate is replaced).

**Status:** all 3 blocking findings addressed. The changes since review are scope
*reductions* — a product dropped, a mechanism simplified — so a second full review pass
is not warranted. Remaining for John: O2, O4, O5, O7, O8 (§7). Ready for John's final
decision.
