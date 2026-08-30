# SendMo Product Requirements Document

> **Version**: 6.1 (Consolidated)
> **Last Updated**: 2026-02-24
> **Sources merged**: SPEC.md (Draft v5), Loveable PRD v1, Loveable PRD v2 (SENDMO-PRD-V2.md), Claude.ai design session (Feb 24, 2026)
> **Status**: Active — use this as the single source of truth
> **Prototype**: https://sendmo.lovable.app
> **Loveable Project**: https://lovable.dev/projects/e3abd1d5-5b30-4349-98c5-b4e7e8d69031

---

## 1. Product Vision

**One-liner**: SendMo: Prepaid shipping made easy. Create a shipping label or a flexible link, share it with anyone who needs to send you something.

### The Problem
Shipping between individuals is unnecessarily complicated:
- Recipients have to share their address with every sender
- Senders have to figure out box sizes, carrier options, and costs
- Both parties go back and forth on shipping estimates
- Neither has visibility once the package is in transit
- Facebook Marketplace killed prepaid shipping labels (Feb 2025) — sellers now buy their own labels

### The Solution
SendMo Label Links. Recipients create a link once, share it with anyone who needs to send them something. Senders click, enter package details, and print a label. The recipient pays.

### Value Proposition
1. **For Recipients**: Control over shipping — set your preferences once, share a link, receive packages
2. **For Senders**: Dead simple — click a link, enter package info, print label, drop off. No payment needed.
3. **Privacy**: Recipients keep their address private until label is printed

### What SendMo leads with, and what it merely supports (decided 2026-08-17, OQ3)

SendMo also produces a **plain outbound label** — you mail something to someone, you pay, you print. That has always worked (`full_label` is role-agnostic; only which address is yours differs). Since 2026-08-18 there is no upfront "who's sending?" question: the outbound case is claimed in-flow via "I'm the sender — it ships from my address" on the origin step.

**It is deliberately not a headline claim.** Plain outbound labels are a commodity where SendMo competes on price and loses — the display price is `EasyPost rate × 1.15 + $1` (§3), against Pirate Ship and Click-N-Ship at no markup. The margin is earned by the coordination problem — address privacy, the other party filling in what they know, the who-pays inversion — and none of that applies to a label you could buy anywhere. So the outbound case is **discoverable in-product, not marketed on the homepage**: the hero stays coordination-led, and the first homepage door reads "Send or receive a package" so it stops *excluding* the case without *leading* with it.

Revisit if SendMo ever has a rates story for that segment. Full reasoning: [`proposals/2026-08-17_onboarding-who-is-sending_reviewed-2026-08-17_decided-2026-08-17.md`](proposals/2026-08-17_onboarding-who-is-sending_reviewed-2026-08-17_decided-2026-08-17.md) OQ3.

### Target Users
**Primary (Recipients)**: Marketplace buyers (Facebook Marketplace, Craigslist, OfferUp), office managers, anyone receiving packages from multiple senders.
**Secondary (Senders)**: Marketplace sellers, friends/family, vendors, remote employees.
**Also served (not led with)**: anyone mailing a package out themselves — see the section above.

---

## 2. Key Concepts

| Term | Definition |
|------|------------|
| **Recipient** | Person receiving the package. Creates and owns SendMo links. Pays for shipping. |
| **Sender** | Person shipping the package. Clicks the link, enters package details, prints label. No account needed. |
| **SendMo Link** | A shareable URL (e.g., sendmo.co/s/k8Hj2mNp4x) that enables shipping to a recipient. |
| **Price Cap** | Maximum the recipient will pay per shipment. Default: $100. |
| **Speed Tier** | Economy / Standard / Express — recipient's preference for delivery speed. |

### Recipient & Seller Paths

The first two paths are **recipient-pays** (the link creator receives the package and pays). The third — the **Seller Link** — flips it: the **seller** creates the link and an anonymous **buyer** pays on-session. It is the first SendMo flow where the payer is not the account holder.

1. **Full Prepaid Label** — When the recipient knows exactly what's being shipped. They enter the origin address, package details, choose a carrier/speed, and get an exact price. Results in a downloadable PDF label.
2. **Flexible Shipping Link** — When shipment details are unknown. The recipient sets distance, size hints, and speed preferences. The sender fills in the rest later. Results in a shareable link.
3. **Seller Link** — The seller specs the package (origin address + size/weight) up front and shares `sendmo.co/s/<code>`. An anonymous buyer opens it, enters their destination, picks a speed, and **pays on-session** (Stripe Payment Element). The seller gets the label to print; the buyer gets a receipt + tracking + a tokenized `/t/<code>?cancel=<token>` link to manage the shipment with no account. `max_shipments`=1 (single-use, closes after the first sale) or NULL (reusable). Funding-agnostic via `funder` (buyer today; "seller covers shipping" is a future seam).

| Type | Status | Description |
|------|--------|-------------|
| **Full Prepaid Label** | MVP | Recipient enters all details, gets exact price + PDF label immediately |
| **Flexible Shipping Link** | MVP | Reusable link. Sender configures package details later. |
| **Seller Link** | Built — test-mode, launch-gated | Seller specs package; anonymous buyer pays on-session. Not merged to `main`; see proposal `proposals/2026-07-17_seller-link-buyer-pays_decided-2026-07-17.md` + plan `zazzy-toasting-parrot`. Live-mode has one remaining launch-blocker (BuyerFlow `buyerLiveMode` — WISHLIST). |
| **Private Shipment Link** | Phase 3 | QR code instead of label, no address exposure. |

**Data model:** all three types share one shape — `User (profiles) → Link (sendmo_links, discriminated by link_type) → Shipment(s) → Transaction(s)` — differing only by attributes, **zero new tables** (migration 040 added `sendmo_links.{funder, origin_address_id, length/width/height_in, max_shipments}` + `shipments.{buyer_email, recipient_user_id}`; `link_type` ∈ {full_label, flexible, seller_link}). Seller sales are discriminated by `shipments.buyer_email IS NOT NULL` (the buy RPC mints a throwaway internal `full_label` link, so `shipments.link_id.link_type` is not reliable — the real link is resolved from the request's `link_short_code`).

---

## 3. Pricing Model

### Standard Rate (Credit Card)
```
Display Price = EasyPost Rate × 1.15
SendMo keeps 15%, shown as single "Shipping" price
```

### Discounted Rate (SendMo Balance — Post-MVP)
```
Display Price = EasyPost Rate × 1.10
SendMo keeps 10%
```

### Display Strategy
- Do NOT show SendMo fee separately
- Show single "Shipping" price that includes margin
- Upsell: "Save 5% on shipping with a SendMo Balance"

### Price Cap
- Recipients set maximum they'll pay (default: $100)
- Cap applies to the display price (includes margin)
- Senders can only select rates where display price ≤ cap

---

## 4. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18 + Vite + TypeScript + Tailwind + shadcn/ui | Extracted from Loveable prototype |
| Hosting | Vercel | Auto-deploy from GitHub, preview deploys per PR |
| Backend | Supabase Edge Functions (Deno/TypeScript) | Server-side API logic |
| Database | Supabase PostgreSQL | Existing project fkxykvzsqdjzhurntgah |
| Auth | Supabase Auth | Magic link passwordless + optional Google OAuth |
| Shipping | EasyPost API | Address verification, rates, labels, tracking |
| Payments | Stripe Payment Intents | Manual capture (auth at link activation, capture at label generation) |
| Email | Resend or SendGrid | Transactional: verification OTP, label notifications, tracking |
| Storage | Supabase Storage | Label PDFs, QR codes |
| AI/ML | Anthropic Claude API | Address parsing, FAQ search, item recognition |
| Monitoring | Sentry (errors) + PostHog (analytics) | |
| CI/CD | GitHub Actions | Lint, typecheck, test, deploy |

---

## 5. Route Structure

```
/                       → Landing page (full marketing page)
/onboarding             → Recipient onboarding flow (4 steps)
/s/:shortCode           → Sender flow (5 steps)
/dashboard              → Authenticated recipient dashboard
/faq                    → FAQ & Help page
/admin                  → Admin reporting (internal)
/label-test             → Backend test harness (internal)
/*                      → 404 Not Found
```

### Sitewide chrome (2026-08-23)

Every user-facing page mounts the same two pieces:

- **`AppHeader`** (`src/components/AppHeader.tsx`) — brand mark on the left, always
  a link to `/`; the admin mode toolbar and the user menu (My Account / Sign Out)
  or the signed-out FAQ + Sign In pair on the right. `/login` is the one exception:
  it shows the brand mark centered above its card instead of a header bar, because
  a "Sign In" button on the sign-in page is noise.
- **`SiteFooter`** (`src/components/SiteFooter.tsx`) — brand mark (also links home)
  plus FAQ / Privacy / Terms / Support.

Excluded on purpose: `/t/:code/print` (print surface), `/admin*`, `/label-test`,
and the `*-preview` routes — internal tools, not product surface.

**`/` is the homepage for everyone, signed in or not.** An earlier behavior (T3-3)
redirected signed-in visitors to `/dashboard`; that is gone. The dashboard is one
click away in the header user menu. **Signing out returns to `/`** — before this,
signing out from `/dashboard` ended on `/login`, because `ProtectedRoute` caught
the now-anonymous user still sitting on a protected route.

---

## 6. Design System

### Brand Identity
- **Name**: SendMo
- **Aesthetic**: Clean, trustworthy, blue accents. Premium but approachable.
- **Typography**: Inter (400, 500, 600, 700)
- **Border radius**: 16px (rounded-2xl) on cards, 12px (rounded-xl) on buttons
- **Page backgrounds**: `bg-gradient-to-b from-background to-muted/50`

### Color System
- **Primary**: HSL 214 89% 52% (SendMo brand blue)
- **Success**: HSL 142 71% 45% (green for verified/delivered)
- **Destructive**: HSL 0 72% 51% (red for errors)
- **Speed tier colors**:
  - Economy: Emerald (bg-emerald-50, border-emerald-300, text-emerald-700)
  - Standard: Blue (bg-blue-50, border-blue-300, text-blue-700)
  - Express: Amber (bg-amber-50, border-amber-300, text-amber-700)

### Component Patterns

**Cards**: `bg-card rounded-2xl border border-border shadow-sm p-5`

**Selection cards (selected)**: Color varies by type (see speed tier colors above). Default: `border-primary bg-primary/5`

**Selection cards (unselected)**: `border-border hover:border-muted-foreground/30`

**Segmented toggles**: `Container: flex gap-1 bg-muted rounded-xl p-1` / Selected: `bg-card text-foreground rounded-lg shadow-sm` / Unselected: `text-muted-foreground`

**Primary buttons**: `rounded-xl shadow-sm` — landing page CTA: `text-lg py-4 px-8 shadow-md`

**Radio dots**: `w-4 h-4 rounded-full border-2` / Selected: `border-primary` with inner `w-2 h-2 rounded-full bg-primary`

**Info notes**: `bg-muted rounded-xl px-4 py-3 text-xs text-muted-foreground`

**Verified badge**: `text-success bg-success/10 rounded-xl px-3 py-2` + CheckCircle2 icon

**Validation error summary**: `rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3` — lists all issues above the Continue button

**Field error**: `border-destructive` + "Required" label at top-right of card

### Validation Pattern

SendMo uses **"try-then-show"** validation: user clicks Continue → `tried` flag set → field-level red borders + "Required" labels appear → validation summary block animates in above the button listing all issues. See Loveable PRD v2 Section 9 for per-step validation details.

### Animation Patterns (Framer Motion)

- **Step transitions**: `AnimatePresence mode="wait"` — `initial={{ opacity: 0, x: 20 }}` / `animate={{ opacity: 1, x: 0 }}` / `exit={{ opacity: 0, x: -20 }}` / `duration: 0.25`
- **Verified addresses**: `initial={{ opacity: 0, y: 4 }}` / `animate={{ opacity: 1, y: 0 }}`
- **Price updates**: `animate={{ scale: [1, 1.02, 1] }}` on cost cards
- **Selection feedback**: `whileTap={{ scale: 0.98 }}` on selectable cards

---


## 7. Recipient Onboarding Flow (/get-started)

### Step Numbering

The flow uses numeric step IDs for branching:
- `0` = Path Choice
- `1` = Destination address (shared by both paths)
- `10-13` = Full Label path (Shipment Details -> Confirm Email -> Payment -> Label)
- `20-23` = Flexible Link path (Shipping Prefs -> Email Verify -> Payment -> Link Activated)

> Step 11 (Contact) was inserted 2026-05-11 per the
> [account-creation-timing proposal](proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md).
> Uses Supabase-native `signInWithOtp` so verifying the email also creates the
> `auth.users` row, allowing shipments.user_id to be stamped from `auth.uid()`.
> Auto-skipped when the user is already authenticated (returning user with a
> live session).
>
> **2026-08-22 — the step now COLLECTS the email as well as confirming it.**
> The input and the Google CTA lived on step 1 until then, which put an account
> question on the screen that asks where a package goes. Step 11 renders in two
> phases: enter an email (or Google), then confirm the 6-digit code. The phase
> is derived from `verification_email` — set when a code is sent — so it
> survives back-navigation. Step 1 no longer reads, writes or validates
> `state.email`; nothing between step 1 and step 11 consumes it.

### Component File Structure

```
src/components/recipient/
  StepQuestionHeader.tsx                    # The question + its one action (steps 1/10/14)
  SkipToSenderLink.tsx                      # That action: "Sender will fill this in →"
  ShipmentDetails.tsx                       # The one summary, payment step only
  SavedAddressPicker.tsx                    # Deduped saved-address list (steps 1/10)
  RecipientStepAddress.tsx                  # Step 1: destination address only (shared)
  RecipientStepOrigin.tsx                   # Step 10: ship-from address
  RecipientStepPackage.tsx                  # Step 14: the parcel
  RecipientStepContact.tsx                  # Both paths: collect + confirm email (Step 11)
  RecipientStepFlexPreferences.tsx          # Link path: shipping prefs (Step 20)
  RecipientStepPayment.tsx                  # Payment + activated state (Steps 12/13/22/23)
```

### No progress UI (2026-08-23)

There is no progress bar, no path chip and no skip banner. All three were
deleted together: they competed to narrate *position*, and none of them
answered the question a creator actually has mid-flow — what have I told you so
far. A step is now a heading, its skip link, a form and the buttons.

What each removed element did, and what carries it now:

| Removed | What it said | Where that lives now |
|---|---|---|
| `MorphProgressBar` | Which of six steps you're on; which were skipped | Nothing states position. The Shipment Details card lists decisions instead |
| Path chip (`Prepaid label` / `Shipping link`) | Which product you're building | The Shipment Details heading, on the payment step |
| Skip banner + `Undo skip` | That a skip made this a link; a way to reverse every skip at once | The URL segment mid-flow; per-question undo via each step's "Enter it myself" |
| `PriceSummaryCard` | Sticky "Shipping to …" on Origin, Package, Shipping | Nothing — it was a tracker by another name |

**Navigating back.** The bar's clickable segments are gone, so mid-flow the
only route to an earlier question is Back, which walks one step at a time.
From the payment step, the Shipment Details card's per-row pencils jump
directly to any question. `undoShippingLinkSwitch` was deleted with the banner
that was its only caller.

### Shipment Details (payment step only)

**Component**: `ShipmentDetails.tsx`

The single summary in the flow, on the last screen before money moves. Replaces
`RecipientStepPayment`'s old "Shipment Summary" list and `FlexPaymentStep`'s
"Delivering to" card.

- **2×2 grid**: `from` and `to` side by side — the direction a shipment travels,
  and the reason it isn't a list — then `parcel` and `via`. One column below 380px.
  On the flexible path a full-width `estimated cost` cell follows (see Price).
- **Every cell has a pencil** that jumps to the step which set it (from → 10,
  to → 1, parcel → 14, via → 20, estimated cost → 20). This is the only direct
  back-navigation left.
- **Handed-off questions** read `Sender fills in` / `Sender chooses` /
  `Sender describes` in italic, and stay editable.
- **Heading names the product**: `Shipment Details` on the label path,
  `Shipping Link Details` on the flexible path. After the chip, bar and banner
  went, this is the only place the two are distinguished.
- **Price**: the label path closes with `Total`. The flexible path gets an
  `estimated cost` cell — the range from `lib/flexEstimate.ts`, with
  `Capped at $N · you're charged the actual rate` under it — and `via` gains the
  days range. This replaced the separate "Estimated shipping cost (per
  shipment)" panel below the card (2026-08-23): the two said the same thing
  twice. The cap is stated once, in that cell, and it bounds the range's high
  end; a cap below the cheapest expected rate is NOT clamped away — it raises a
  warning under the card instead, because no shipment that size is likely to
  go through.

### Choosing a saved address (2026-08-23)

**Components**: `SavedAddressPicker.tsx`, `lib/savedAddresses.ts`

"Use a saved address" used to take the most recent row silently, so a user with
two saved addresses got whichever they typed last with no way to see or change
it. It now expands a list in place under the field it fills (design option A of
three), with a count on the trigger so the choice is visible before it is opened.

**Dedupe is the load-bearing part.** `addresses` is an append-only log, not a
curated book: every link creation INSERTS a row, and edits use insert-new-row +
repoint-FK so shipment history keeps pointing at the address as it was
(`links/index.ts`). Someone who has shipped to the same friend five times owns
five near-identical rows, and listing the table raw shows that friend five
times. `dedupeAddresses` collapses on a normalised `street1 + street2 + zip`
key, newest first:

- **Name is excluded from the key** — "Mum" and "Jane Doe" at one address are
  one place. The newest row supplies the name, which is the one last typed.
- **street2 is included** — a unit number distinguishes real addresses, so
  `Apt 4B` and `Apt 4C` must stay separate.
- Rows with no street are dropped; they come from partly-filled drafts.

**`addresses.label` is still never written.** The column exists and is commented
"e.g. Home, Office", but nothing populates it, so entries are identified by name
and street. Nicknames would need a prompt at save time.

**`sender='self'` is unreachable, deliberately.** `deferToSender` is the only
writer and only ever sets `'other'`, so the flow knows either "someone else is
sending" or nothing. The origin step's confirm-row collapse depended on
`'self'` and was deleted with it (2026-08-23) — the picker fills a known
address for any saved entry, which is what that collapse existed to avoid
retyping. `SenderKind` keeps the `'self'` variant for drafts persisted before
this.

**The picker does not infer who is sending.** The single-address shortcut set
`sender='other'` on the destination step and `sender='self'` on the origin step,
both reasoning "this is YOUR saved address". That held only while there was one
address assumed to be the account holder's; picking from a list that may include
a friend's implies nothing, so the picker fills fields and leaves `sender` alone.
Skipping a question still resolves it, which is where the flow learns the answer.

**The silent prefill is gone with it.** Dropping the most recent row into the
form unannounced is indistinguishable from a picker that guessed.

### The estimate never exceeds the cap (2026-08-23)

`FlexPaymentStep`'s estimate range is clamped to `price_cap_dollars`, because a
shipment above the cap is never charged. Before this, a $25 cap could sit above
a "$9.00 – $38.00" range on the same screen.

A cap *below* the cheapest estimate is NOT clamped away — that state means no
sender is likely to be able to buy a label, so it renders an explicit warning
rather than a tidy "$25 – $25".

### Entry: /onboarding resolves straight to the destination step (who's-sending deleted 2026-08-18, Phase 2)

There is no step 0. `/onboarding` shows the resume-offer interstitial when an unfinished draft exists (Continue / Start fresh — resuming stays an explicit offer, never automatic), otherwise it `Navigate replace`s to `/onboarding/full-label/destination`. All existing deep links resolve unchanged.

**`sender` is derived in-flow, not asked upfront.** It starts `null`; three claims resolve it, first one wins:

| Claim | Where | Resolves to |
|-------|-------|-------------|
| "Deliver to me — use my saved address" chip | destination step | `'other'` (+ fills destination) |
| "I'm the sender — it ships from my address" | origin step | `'self'` (provider prefill effect fills origin) |
| Deferring any question | steps 10/14 | `'other'` — "the sender will fill this in" is itself the claim |

- **Every question is skippable, including the destination (Phase 3, decision B — any combination).** Step 1 offers "The sender picks the destination": the address half is deferred (email is NOT — it gates the account), the link stores no recipient address (migration 042), GET returns `needs_destination`, and the sender flow collects the delivery address (full validation), quotes it via `rates/` (shipment stamped `reference = link.id`), and `labels/` trust-resolves the destination from that reference-bound shipment — never from the client. The skip banner shows from the moment of any skip, on steps 10 and 14.
- **Nothing prefills while `sender` is null.** `prefillSlotFor(null)` returns `null` and both prefill sites gate on it; the destination step fetches the saved address but *holds* it for the chip. Silently guessing a slot puts the wrong party's address on a label (2026-08-16 class).
- Who-pays is unchanged on every branch: the creator pays.
- The seller link-out (gated by `SELLER_LINK_MODE`) lives in the destination step footer; the Dashboard and homepage carry the other seller doors.
- **OAuth auto-advance gotcha:** step 1's post-Google auto-advance is authorized by the `sendmo:oauth_pending` sessionStorage flag set just before the redirect — NOT by "user was null at mount", which every visitor matches now that the entry redirect mounts the step before auth settles (it made forms auto-submit; see LOG 2026-08-18).

### One step map (2026-08-19 — completes the unified-onboarding proposal's Phase 2)

Both URL segments walk the SAME seven-step sequence — `STEPS = [1, 10, 14, 20, 11, 12, 13]` with slugs `destination / origin / package / shipping / verify / payment / label` ([`src/lib/stepRouting.ts`](src/lib/stepRouting.ts)). Step numbers are historical, not ordinal: they survive so persisted drafts stay meaningful (old flex numbers 21/22/23 migrate to 11/12/13 on read). The `full-label ⇄ flexible` URL segment only names the product the flow is heading toward — it rewrites when the first skip lands and rewrites back when the last one is undone.

Step 20 (`shipping`) is one step with two modes: carrier rate cards when everything is known (the rate fetch moved here from the old step 14 — the Package screen shows no prices, and prices no longer live-update while dimensions are edited); speed/carrier preference + cap when anything was skipped. Retired slugs redirect (`preferences → shipping`, `authorize → payment`, `share → label`); `verify` never retires because magic-link emails in flight carry it as `redirectTo`.

The progress bar is six fixed segments (Destination/Origin/Package/Shipping/Contact/Payment) with four states — upcoming, current, done (check), **skipped (dashed + arrow, by shape not hue: amber already means Express, §6)**. A skip morphs one segment in place; nothing is added, removed, or relabeled.

Steps **10 = ship-from address** (`origin`) and **14 = parcel** (`package`) remain independently skippable (split 2026-08-18, PR #68).

On the `sender: 'other'` branch, **each** step offers "The sender will fill this in" as a first-class answer:

| Deferred | Result |
|---|---|
| *nothing* | Ordinary prepaid label. Stays `link_type = 'full_label'`. |
| address, package, or both | Becomes `link_type = 'flexible'` **from the first skip** — the URL segment rewrites immediately (2026-08-19), and deferring the address still advances to the package question (deferring one must not silently defer the other; that was the bug). |

Skipping *is* answering: the step is marked complete (`deferredOrigin` / `deferredPackage` on flow state) and the flow advances normally. **Whatever the creator did answer is carried onto the link** (`origin_address` / dims on link create; requires migration 041, applied to prod 2026-08-18) and prefilled for the sender — deferring one question never discards the other's typing.

**The product type is derived, never chosen.** The user answers questions they can actually answer; they are never asked to classify themselves as "full label" vs "flexible link". This replaced (2026-08-18) a muted help-text escape named after the user's problem, which left the link — the product the homepage sells — with no door at all.

"I have their address" is pre-selected deliberately: the label path has produced every shipment to date and must not gain a click to advertise the link path. First-class means named, weighted and visible before the user can fail — not unavoidable.

An undo bar on steps 10/14/20 returns to the earliest reopened question with the typed origin intact (it is never cleared). The undo's completedSteps write is wrapped in `flushSync` — the guard-race class (LOG 2026-05-19) was latent here and surfaced when the segment rewrite made the bounce target differ from the intended one.

This is why there is no "flexible" door at step 0: the fork is a *fact about what the user can answer*, not a preference, and it's surfaced at the moment they discover it.

**Draft persistence (2026-08-18):** flow state lives in **localStorage** (7-day TTL, [`src/lib/recipientFlowStorage.ts`](src/lib/recipientFlowStorage.ts)) so a closed tab no longer loses everything. Resume is *offered* via a banner on `/onboarding`, never automatic; `startFlowAs` resets on every door pick; `clearFlow` clears both localStorage and the legacy sessionStorage location (pre-deploy drafts are read from there as a fallback).

**User-facing names** (strings only — `link_type` values are unchanged): `full_label` → "Prepaid label", `flexible` → "Shipping link", `seller_link` → "Seller link".

### Step 1: Destination (Shared)
**Component**: `RecipientStepAddress.tsx` -- Step ID: `1`

Asks one question: where is the package going. The creator's email and the
Google CTA moved to the Contact step on 2026-08-22.

- Freeform address input with auto-verification (mock: length > 15 chars; production: EasyPost API)
- Green verified badge with CheckCircle2 icon
- **Phone number** -- required (added 2026-05-19). FedEx and UPS reject EasyPost label purchases without a phone on both shipper and recipient addresses (`PHONENUMBER.EMPTY`); USPS doesn't. Collected on every address via `SmartAddressInput`. 10-digit minimum (digits-only count). Server re-validates in the `links` Edge Function — client-side is UX only.
- **Validation**: destination address + phone only. Red borders + "Required" labels + summary block above button
- **Button**: "Continue to shipping preferences"

See "The skip is a link beside the question" below — the pattern is shared with
the Origin and Package steps.

**Under the fields:** "Use my saved address: <street>" when signed in with a
saved address and `sender` is still null; tapping it also resolves
`sender='other'`. Signed out it reads "Log in to use your saved address" and
routes to `/login?next=<this step>`.

### The skip is a link beside the question (2026-08-22, revised 2026-08-23)

All three question steps — Destination (1), Origin (10), Package (14) — share
one pattern, built from two components:

- `StepQuestionHeader` — asks the question once, as the step's `<h2>`, with one
  action **vertically centred on the heading line**. It takes no supporting
  copy: every step had a line under its heading and none earned the delay
  ("Carriers need a phone number for the delivery address" sat directly above a
  field labelled "Phone number (the shipping carriers insist on it)").
- `SkipToSenderLink` — that action: "Sender will fill this in →", or
  "↺ Enter it myself" when the question is already handed over. **Underlined**,
  because it navigates; every other control on these screens submits or edits
  in place.

**Skipping ADVANCES on the click.** No Continue press — it is a complete answer
to the step's only question. `deferToSender` marks the step complete and
navigates to the next one for all three fields; the destination was the last
holdout and joined on 2026-08-22, once its email half moved to Contact.

**Reversing does NOT navigate.** The user is looking at the step they want
back, so it reopens in place.

**Only the FIELDS dim and go `inert`.** The skip link sits outside that subtree,
beside the question — it holds the only control that takes the question back,
and wrapping it made a skipped step unrecoverable (caught by
`skip-to-sender.spec.ts`, which pins the property).

**What this replaced:** a two-button `SkipToggle` radiogroup in a card of its
own above each form. That control asked a second question ("who fills this
in?") before the user could answer the first, and needed a whole card to do it
— three stacked boxes for one question. Its "neither option pre-selected" rule
is gone with it, since there is no second option; the property that rule
protected (the label path gains no clicks) survives because the fields are open
and typeable on arrival. `SkipToggle` and `FirstSkipExplainer` are deleted.

### Package step: the parcel fields start collapsed (2026-08-22)

The Package step (14) leads with "Describe the product" — the Magic Guestimator
textarea — and keeps packaging type, dimensions, weight and item description
behind an "or fill in manually" link. Four cards of dimensions in front of
someone who was going to type "a hardcover cookbook" is the wrong first
impression.

They are revealed, and stay revealed, when ANY of these holds:

1. The user clicked "or fill in manually".
2. Any parcel value is present — the Guestimator just filled them, or the user
   returned to a filled step. An auto-filled estimate must be visible and
   correctable, never hidden behind a link.
3. Validation failed. A summary naming "Length is required" must never point at
   a field the user cannot see.

`MagicGuestimator` serves four surfaces (recipient Package, sender Package,
SellerBuilder, SenderPreview). Its `title` / `subtitle` / `placeholder` /
`icon` / `action` props are all optional and default to the original rendering,
so only the recipient Package step takes this treatment.

---

### FULL LABEL PATH (Steps 10-12)

#### Step 10: Shipment Details
**Component**: `RecipientStepFullShipping.tsx`

The most complex step -- collects all package details to compute an exact shipping price.

**Layout (top to bottom)**:

1. **Sticky destination + cost card** (pinned to top on scroll):
   - "Shipping to [address]" with "Change" link
   - Large price in primary blue (or "Complete details to see cost")
   - Arrival estimate with day name + date
   - Price animates with `scale: [1, 1.02, 1]`

2. **Ship from (sender's address)** -- Text input with address auto-verification

3. **Magic Guestimator** -- AI-powered form pre-filler:
   - Textarea: "Skis in a large box, shipped slow and affordably"
   - "Guestimate it" button with sparkle icon
   - Calls the `guestimate` Edge Function (`fetchGuestimate`) to turn a plain-English
     description into packaging, dimensions, weight, and a speed hint. **Not a
     client-side keyword matcher** — that was the pre-2026 implementation and the
     description here was stale until 2026-08-17.
   - Because it resolves size and weight from a sentence, "I don't know the package
     dimensions" is NOT a reason to need a shipping link. The only real fork is
     whether the user knows the other party's address (see Step 10 escape).

4. **Item description** -- Optional text input

5. **Packaging type** -- 3-option grid: Box/Rigid (default), Envelope/Soft Pack, Tube/Irregular

6. **Package dimensions** -- L x W x H (Height hidden for envelopes)

7. **Package weight** -- Pounds + Ounces

8. **Shipping method** -- Grid of 8 carrier x speed combinations:
   - USPS: Ground Advantage (Economy), Priority Mail (Standard), Priority Express (Express)
   - UPS: Ground (Economy), 3 Day Select (Standard), 2nd Day Air (Express)
   - FedEx: Home Delivery (Economy), 2Day (Express)
   - Color-coded speed tier tags: green=economy, blue=standard, amber=express

9. **Insurance** -- Toggle card: "Add shipping insurance" (+$2.50, covers up to $100)

**Price computation (mock)**:
```
dimWeight = (L x W x H) / 166
billableWeight = max(totalLbs, dimWeight)
base = 5 + billableWeight x 1.8 + (L + W + H) x 0.05
final = base x carrier_multiplier (1.0-1.8) + insurance ($2.50 if selected)
```
**Production**: Replace with EasyPost Rate API.

**Validation**: Ship from address (incl. phone number — required 2026-05-19, see Step 1), all dimensions, weight, shipping method, computed price -- all required. Summary block lists up to 6 issues.

#### Step 11: Confirm Your Email (Full Label)
**Component**: `RecipientStepEmailVerifySupabase.tsx` -- Step ID: `11` (inserted 2026-05-11)

- Headline: "Confirm your email"
- Body: "Just making sure {email} is yours so we can send your SendMo shipping label and updates."
- Two ways to confirm — user picks whichever is faster:
  - **6-digit code input** (paste or type) — calls `supabase.auth.verifyOtp({ type: "email" })`
  - **Tap "Confirm email" button in the inbox** — Supabase processes the token and redirects back to `/onboarding/full-label/verify?confirmed=1`; the step's session-detection effect auto-advances
- Code/link are sent silently at step 1 (email blur) so they're in the inbox by the time the user reaches this screen
- **Auto-skipped** when the user is already authenticated (Google CTA picked at step 1, or returning user with a live session whose email matches the typed email)
- Validation: requires `state.email_verified === true` (mirrors the flex flow's step 21 contract)
- Companion to the flex flow's Supabase OTP at step 21 (`RecipientStepEmailVerifyFlex`)

#### Step 12: Payment (Full Label)
**Component**: `RecipientStepPayment.tsx` -- Step ID: `12` (was `11` pre-2026-05-11)

- **Shipment summary card**: To, From, Service, Est. delivery, Package type + dimensions + weight, Total charge (exact price, large blue text)
- **Payment form** (tabbed: Credit Card / SendMo Balance)
- **No insurance toggle** here (already selected in Step 10)
- **CTA**: "Pay & generate label" -- charges card immediately (not a hold)
- User JWT is now in scope (step 11 created/restored the session), so the labels function stamps `shipments.user_id` from `auth.uid()`

**Full Label Payment Flow**:
1. Recipient completes details -> exact price calculated
2. Stripe charges card immediately (PaymentIntent with immediate capture); `metadata.user_id` stamped server-side from the bearer token
3. Label PDF generated via EasyPost
4. Recipient downloads/shares label

#### Step 13: Label & Link Ready (Full Label)
**Component**: `RecipientStepPayment.tsx` with `isActivated=true` -- Step ID: `13` (was `12` pre-2026-05-11)

- Title: "Your shipping label and link are ready"
- **View/download/print card** -- "View label" + "Download PDF" buttons
- **Share link card** -- Copyable sendmo.co/s/... link
- **Shipment details card** -- To, From, Speed, Distance, Estimated cost, Protection status
- **CTA**: "Go to your account page" -> `/dashboard`

---

### FLEXIBLE LINK PATH (Steps 20-23)

#### Step 20: Shipping Preferences (REDESIGNED 2026-02-24)
**Component**: `RecipientStepShipping.tsx`

**Layout (top to bottom)**:

1. **Destination display** -- Shows verified address with MapPin icon

2. **Distance selector** -- 3 radio-style cards:
   - Nearby ("Same state / neighbor state", <300 mi, Zones 1-3)
   - **Regional** ("Same half of the country", 300-1,000 mi, Zones 4-5) <- DEFAULT
   - Cross-country ("Coast to coast", 1,000+ mi, Zones 6-8)

3. **Package size hint** -- 3 optional tile buttons (toggle on/off, deselectable):
   - Padded envelope (Under 1 lb)
   - Small box (2-5 lbs)
   - Large / heavy box (10-25 lbs)
   - **These are hints, not constraints.** Sender is never limited.

4. **Speed tier selection** -- 3 expandable cards, Standard pre-selected:
   - Economy (emerald accent) -- cost range, delivery window, carrier
   - Standard (blue accent) -- DEFAULT
   - Express (amber accent)
   - All update dynamically based on distance + size selections

5. **"See detailed rate estimates"** link -> bottom-sheet modal with full rate matrix (distance toggleable within modal)

6. **Context notes** -- "Prices are estimates and may vary...", "Your card is not charged..."

7. **Buttons**: "Back" / "Continue" / "Skip, use defaults" (ghost)

**Skip behavior**: Sets defaults: distance=regional, size=unsure, speed=standard, carrier=any, insurance=none

**Data interface**:
```typescript
interface ShippingConfig {
  distance: "nearby" | "regional" | "cross";
  size: "envelope" | "smallbox" | "largebox" | null;
  speed: "economy" | "standard" | "express";
  priceCap: number; // default 100
}
```

#### Step 21: Confirm Your Email (Flexible Link only)
**Component**: `RecipientStepEmailVerifyFlex.tsx` -- Step ID: `21` (migrated to Supabase Auth 2026-05-15)

- Headline: "Confirm your email"
- Body: "Just making sure {email} is yours."
- Two ways to confirm:
  - **6-digit code input** (paste or type) — calls `supabase.auth.verifyOtp({ type: "email" })`
  - **Tap link in email** — Supabase processes token, redirects to `/onboarding/flexible/verify?confirmed=1`; session-detection effect auto-advances
- Code/link sent silently at step 1 (email blur via `maybePrimeOtp`) so they're in the inbox before the user reaches this screen
- **Auto-skipped** when user is already authenticated (Google CTA picked at step 1, or returning user with matching live session)
- Creates a Supabase session — required by step 22 (`createFlexLink` + `createFlexHold` need a JWT)
- Validation: requires `state.email_verified === true`

#### Step 22: Payment & Activation (Flexible Link)
**Component**: `RecipientStepFlexPayment.tsx` → `FlexPaymentStep.tsx` -- Step ID: `22`

> **NOTE (2026-05-20):** the hold / insurance-toggle / SendMo-Balance content below is pre-Pattern-D and stale — the current step saves a card via a Stripe SetupIntent (no hold) and charges the actual shipping cost per shipment, off-session. The section needs a full Pattern-D rewrite (out of scope for the 2026-05-20 UX pass).

- **Destination summary** ("Delivering to" card): name / street / city-state-zip / phone, with an **Edit** link → step 1
- **Estimated cost summary**: per-shipment cost range, low and high shown as captioned columns ("Shorter / smaller package" / "For large, heavy and long shipments"); **Edit** link → step 20 (preferences)
- **Payment form** (tabbed: Credit Card / SendMo Balance)
- **Insurance toggle** (3-option segmented: Off / $100 coverage / $300 coverage)
  - Insurance costs: none=$0, $100=+$3, $300=+$5
  - Dynamically updates cost range and hold amount
- **CTA**: "Add payment & activate label link"
- **Back**: returns to step 20 (preferences); the verify step (21) is skipped on the way back when the email is already confirmed — landing there would auto-advance straight back here, making Back a dead-end

**Hold Calculation**:
```
adjustedHigh = highRange + insuranceCost
holdAmount = adjustedHigh x 1.10 (rounded)
discounted = amount x 0.95 (for Balance tab)
```

**Flexible Link Payment Flow**:
1. Recipient sets preferences -> estimated cost range
2. Stripe creates authorization hold (manual capture) at 110% of high range + insurance
3. Sender uses link later -> enters package -> rates fetched -> label purchased
4. Stripe captures actual amount, excess hold released

#### Step 23: Link Activated (Flexible Link)
- Title: "Your label link is active!"
- **Share link card** -- Copyable link with QR code
- **Shipment details card**: Speed, Distance, Estimated cost, Protection status
- **CTA**: "Go to your account page" -> `/dashboard`

---

### 7.1 Rate Tables (Flexible Link Path)

2026 commercial pricing via EasyPost + 15% SendMo margin.

**Padded envelope (Under 1 lb):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-3 days, $5-6, USPS Ground Advantage | 1-2 days, $8-10, USPS Priority Mail | Next day, $28-30, USPS Priority Express |
| Regional | 3-4 days, $6-7, USPS Ground Advantage | 2-3 days, $9-12, USPS Priority Mail | 1-2 days, $29-32, USPS Priority Express |
| Cross-country | 4-5 days, $7-9, USPS Ground Advantage | 2-3 days, $11-14, USPS Priority Mail | 1-2 days, $30-34, USPS Priority Express |

**Small box (2-5 lbs):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-4 days, $7-10, USPS Ground / UPS Ground | 1-3 days, $10-14, USPS Priority Mail | 1-2 days, $32-42, UPS 2nd Day Air |
| Regional | 3-5 days, $10-15, USPS Ground / UPS Ground | 2-3 days, $14-19, USPS Priority Mail | 1-2 days, $36-48, FedEx 2Day |
| Cross-country | 5-7 days, $14-20, UPS Ground / FedEx Ground | 2-3 days, $18-24, USPS Priority Mail | 1-2 days, $42-56, FedEx 2Day |

**Large / heavy box (10-25 lbs):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-4 days, $14-20, UPS Ground | 1-3 days, $18-26, USPS Priority Mail | 1-2 days, $48-68, UPS 2nd Day Air |
| Regional | 3-5 days, $20-30, UPS Ground / FedEx Ground | 2-3 days, $26-38, USPS Priority Mail | 1-2 days, $58-82, FedEx 2Day |
| Cross-country | 5-7 days, $28-40, UPS Ground / FedEx Ground | 2-3 days, $34-48, USPS Priority Mail | 1-2 days, $72-100, FedEx 2Day |

**Default (no size selected):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-5 days, $5-20 | 1-3 days, $8-26 | 1-2 days, $28-68 |
| Regional | 3-5 days, $6-30 | 2-3 days, $9-38 | 1-2 days, $29-82 |
| Cross-country | 4-7 days, $7-40 | 2-3 days, $11-48 | 1-2 days, $30-100 |

---

## 8. Sender Flow (/s/:shortCode)

Linear wizard, **one question per step, and only the questions the link leaves
open** (2026-08-24). Sender never pays, and never sees the price. There is no
progress bar — it went the way the recipient flow's did, for the same reason.

### Step -1: Link Preview (how `/s/:shortCode` unfurls in iMessage / WhatsApp / Slack)

The preview is the first thing a sender sees — before the page, inside someone else's text thread. Vercel **Edge Middleware** ([`middleware.ts`](middleware.ts), matcher `/s/:shortCode*`) intercepts the request ahead of the CDN cache, fetches the link's public payload, and rewrites `index.html`'s `<head>`. Copy + rewriting live in [`src/lib/ogMeta.ts`](src/lib/ogMeta.ts); the serverless copy at `api/s/[shortCode].ts` is bypassed by the SPA rewrite (see LOG 2026-05-22) and imports the same module so the two can't drift.

| Link data | `og:title` | `og:description` |
|---|---|---|
| name + city/state | `You're sending a package to {First} — {City}, {ST}` | `{Full Name} already paid the postage. Tap to tell us about your package and print the prepaid label — it costs you nothing.` |
| name, no city | `You're sending a package to {First}` | same |
| city/state, no name | `You're sending a package to {City}, {ST}` | `The postage is already paid. …` |
| no data | `You've been sent a prepaid shipping label` | generic fallback |
| `seller_link`, no notes | `Enter your address to get this shipped` | buyer-pays copy (`SELLER_DESC`), prefixed `Shipping typically $X–$Y.` when the band is computed (PR10) |
| `seller_link` + notes | `Get "{item}" shipped to you` (notes sanitized: URLs stripped, 60-char cap) | same |
| `seller_link`, non-active (410 body) | `This item has already sold` | `The seller closed this listing on SendMo.` |

**Invariant — exactly one of each preview tag.** `index.html` ships generic marketing `og:*`/`twitter:*` tags for the root domain, so the middleware **strips them before injecting**: appending alone leaves duplicates and crawlers unfurl the generic SendMo card (the 2026-08-10 bug). [`tests/unit/ogMeta.test.ts`](tests/unit/ogMeta.test.ts) asserts the counts against the real `index.html`, so adding a static tag there without teaching `ogMeta.ts` to strip it turns the suite red.

Card stays `summary_large_image` on the shared brand image (`/og-image.png`) — the personalisation is in the text.

`seller_link` copy revised 2026-08-29 (PR3): the buyer-pays card above, naming the item when `notes` is set — the neutral-fallback placeholder is retired.

### Which questions get asked — `planSenderSteps`

The creator of a flexible link may already have answered the ship-from address
and the parcel; the destination may be theirs (never shown — Rule 7) or
deliberately deferred to the sender. [`senderState.planSenderSteps`](src/components/sender/senderState.ts)
turns the link's GET payload into the list of questions this sender is asked:

| Question | Asked when |
|---|---|
| Destination | `needs_destination` — the creator deferred it |
| Ship from | no `origin_prefill`, **or** a prefill without a usable phone (the carriers reject a phone-less from-address, so a half-answer is still a question) |
| Parcel | no `package_prefill`, or one missing dims/weight |

A question the LINK answers is never asked. A saved address in the sender's own
browser is *not* an answer — it prefills a question that is still theirs.
`origin_prefill` **wins over** the saved address (changed 2026-08-24): it is the
link's answer, and the step that would have let the sender correct it is now
skipped, so deferring to stale localStorage there would ship the package from
whatever address that browser used last.

Before this the flow showed every sender the same "Package Details" mega-step —
destination, ship-from and parcel on one screen — so a sender whose link had
answered two of the three scrolled past pre-filled cards to reach a form with
nothing left to type, under a sticky header reading "Shipping to *this prepaid
link*".

### Step 0: Intro
- No badge, no supporting line (2026-08-24) — "SendMo Label Link" named the artifact to someone who arrived by tapping it.
- Title: "You're sending a package to {recipientName}" — title-cased for display via [`src/lib/name.ts`](src/lib/name.ts) `displayName()`, so a casually typed "john anderson" reads "John Anderson". Display only: the stored address and the printed label keep what the recipient entered. Applies to every sender-facing use of the name (Intro, Rates, Review).
- Insurance banner (conditional): green badge if recipient enabled protection
- How it works: one numbered line per question **this** link asks, then "Choose a shipping method" and "Print the label and ship".
- **CTA**: "Get Started"

### Step 1a: "Where is it going?" (destination-deferred links only)
- Full address + phone, same completeness bar as every address the carriers see.

### Step 1b: "Where's it shipping from?" (when the link didn't answer it)
- Address input with auto-verification; phone required (FedEx/UPS reject the label without one).
- **Creator-carried prefills (2026-08-18, PR #68)** — a flexible link's GET payload may include `origin_prefill` (full ship-from address) and `package_prefill` (dims + weight). Both are **null for seller links** — there the origin is the seller's and the reader is a stranger buyer, so it stays city/state. Trade-off, stated: anyone holding a flexible link's URL can see the street the creator entered (extends the existing flex-payload stance).

### Step 1c: "What are you shipping?" (when the link didn't answer it)
- **The same component the creator answers this with** — [`components/shipment/ParcelQuestion.tsx`](src/components/shipment/ParcelQuestion.tsx), shared by both flows since 2026-08-24 (the sender's own four-card version is gone). Describe-the-product first; the fields (description, packaging, dimensions, pounds + ounces) stay behind "or fill in manually" until the Guestimator fills them, a value is already present, or a validation error names one.
- Each flow adapts its own state to `ParcelDraft` ([`parcelDraft.ts`](src/components/shipment/parcelDraft.ts)) at the boundary: the creator to `RecipientFlowState`, the sender to `SenderParcel`.
- **Validation**: Same try-then-show pattern. Red borders, summary list.
- **CTA**: "Continue" while questions remain, "See shipping options" on the last one

### Step 2: Choose Shipping Method
- Radio-style cards: carrier + service + delivery estimate
- **No pricing shown** (recipient pays)
- "Preferred by {recipientName}" badge on methods matching recipient's speed tier
- **"Most economical option for {recipientName}"** on the cheapest rate (2026-08-24). The sender can't see prices, so the one kindness they can do the payer has to be said in words; the $-tier column shows relative cost but never says which option is cheapest.
- No Guestimator beta note — it described how the dimensions were arrived at, on a screen about choosing a carrier.
- Default selection: first method matching `standard` speed tier
- **Rate Filtering (Production)**: Methods filtered by recipient's speed preference, price cap, and distance. Methods exceeding cap shown disabled.
- **CTA**: "Continue"

### Step 3: Review & Confirm
- **The same Shipment Details card the link's creator saw before paying** — [`components/shipment/ShipmentDetailsCard.tsx`](src/components/shipment/ShipmentDetailsCard.tsx), a presentational 2×2 of FROM / TO / PARCEL / VIA with a pencil on each editable cell. Each side builds its own cells: the creator's from `RecipientFlowState` ([`recipient/ShipmentDetails.tsx`](src/components/recipient/ShipmentDetails.tsx), which adds the estimated-cost cell and the total row), the sender's from the link plus what they entered. **The sender's copy carries no price** — no estimate cell, no total; just "Shipping is prepaid by {recipient} — you're not charged."
- Editing a cell re-opens that one question and walks back out **through the rates step**, because a changed address or parcel re-prices the shipment.
- The TO cell is editable only on a destination-deferred link; on an ordinary flex link the sender may not see or change that address (Rule 7 — city/state only).
- **Email input** for tracking updates (required — the cancel flow's durable auth surface)
- **Checkbox**: "Share contact info with {recipient}" (unchecked). **"Save my information on this device" is gone (2026-08-24)**, with the `sendmo:sender` localStorage store behind it: on a link that supplied the ship-from address it persisted the CREATOR's address as that browser's "my information", most senders use a link once, and browser autofill covers the repeat case.
- **CTA**: "Confirm and generate label" -> AlertDialog confirmation
- **Validation**: Email format validated inline if entered

### Step 4: Label Ready
- **Success banner** -- Green with CheckCircle2: "Label ready!"
- **Label preview** -- Dark header, FROM/TO addresses, service + price, tracking #
- **Print CTA**: "Print" -- routes to the dedicated print page `/t/:code/print` (was: opened the raw label file in a new tab). See below.
- **Download**: saves the label file as `sendmo-<code>.png` (the carrier label is a **PNG**, 4x6 portrait @300dpi — not a PDF; older "(PDF)" copy was wrong)
- **Drop-off instructions** -- Carrier location info, package attachment reminder

#### Label print page (`/t/:code/print`)
Decided 2026-07-17 (proposal `2026-07-17_label-print-page`), deployed 2026-07-18. Component `LabelPrintPage.tsx`. A SendMo-owned print experience replacing the raw-file-in-a-tab flow:
- **Layout presets** (persisted to `localStorage`, default **4×6**): `4×6` (native carrier label, top-left), `half-sheet` (label rotated 90° onto the top half of a Letter page, fold guide at 5.5in), `full-page` (enlarged to fill Letter). Print CSS uses `@page { size: letter portrait; margin: 0 }` + physical inches; screen preview scales responsively (`--s = min(0.44, availWidth/816px)`).
- **Item description** printed as a "Contents" block in the blank sheet area (never over the label): right of the label on 4×6, bottom half on half-sheet, hidden on full-page.
- **Printer-config tips** (print at Actual Size/100%, no headers/footers) + reused `HowToShipStrip`.
- **Always-present raw-label fallback link** (`label_url`) that bypasses all rendering — also the guard if the label format ever changes.
- Print-count logging (`label.printed`) fires here on the Print action.

---

## 9. Dashboard (/dashboard)

### My Label Link
- Link URL with Copy button (primary), preference pills (Destination, Speed, Distance, Price cap, Insurance)
- **Preferences dialog** (gear icon): editable Speed, Distance, Package hint, Price cap, Insurance -- all using same UI components as Step 20
- **Link management**: Copy, Deactivate/Reactivate, Edit preferences
- "+ New Link" button (Post-MVP: multiple links)

### My Wallet
- Payment method display (Visa ...4242, brand, expiry)
- Balance display ($0.00)
- **Management**: Add card (Stripe Elements Setup Intent), Remove card, View balance
- Expandable dialog with "Add Balance" and "Edit Methods"

### Shipments Table
- Columns: ID, From, Location, Status, Carrier, Amount, Created, Shipped, ETA, Tracking
- Status badges (pill-shaped):
  - Label Created: purple
  - In Transit: blue
  - Delivered: green

---

## 10. FAQ & Help (/faq)

- Prominent search bar with real-time filtering
- 10 accordion FAQ items (what is SendMo, who pays, revenue model, privacy, carriers, price caps, dimension adjustments, international, tracking, cancellation)
- Contact support card (email link to support@sendmo.co)
- Production: pgvector semantic search, search analytics, contact form

---

## 11. API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/addresses/verify` | Verify address | No |
| POST | `/api/links` | Create new SendMo link | Yes |
| POST | `/api/links/band-quote` | Pre-create seller price band ("typically $X–$Y" on the builder's review step; same 3 representative destinations as PR10) | Yes |
| GET | `/api/links/:shortCode` | Get link details (sender view) | No |
| PATCH | `/api/links/:id` | Update link preferences | Yes |
| POST | `/api/rates` | Get shipping rates for package | No |
| POST | `/api/labels` | Purchase label and generate PDF | No (link auth) |
| POST | `/api/payments/authorize` | Create Stripe payment intent | Yes |
| POST | `/api/payments/capture` | Capture authorized payment | Internal |
| POST | `/api/cancel-label` | Void an unused label | Admin |
| POST | `/api/email/verify` | Send OTP verification email | No |
| POST | `/api/email/verify/confirm` | Confirm OTP code | No |
| POST | `/api/webhooks/stripe` | Stripe webhook handler | Webhook sig |
| POST | `/api/webhooks/easypost` | Shipping tracking webhook | Webhook sig |

---

## 12. Database Schema

### Core Tables

```sql
-- Users (extends Supabase auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Addresses
CREATE TABLE addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  street1 TEXT NOT NULL, street2 TEXT,
  city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL,
  country TEXT DEFAULT 'US',
  verified BOOLEAN DEFAULT false,
  easypost_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SendMo Links (supports both full label and flexible link)
CREATE TABLE sendmo_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) NOT NULL,
  short_code TEXT UNIQUE NOT NULL,
  destination_address_id UUID REFERENCES addresses(id),
  link_type TEXT NOT NULL CHECK (link_type IN ('full_label', 'flexible_link', 'shipping_and_escrow')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paused', 'deactivated')),
  -- Flexible link preferences
  speed_preference TEXT DEFAULT 'standard',
  distance_preference TEXT DEFAULT 'regional',
  size_hint TEXT,
  price_cap NUMERIC DEFAULT 100,
  carrier_preference TEXT DEFAULT 'any',
  insurance TEXT DEFAULT 'none' CHECK (insurance IN ('none', '100', '300')),
  -- Full label details (if link_type = 'full_label')
  origin_address_id UUID REFERENCES addresses(id),
  package_type TEXT, length NUMERIC, width NUMERIC, height NUMERIC,
  weight_lbs NUMERIC, weight_oz NUMERIC,
  shipping_method TEXT, exact_price NUMERIC, label_pdf_url TEXT,
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Shipments
CREATE TABLE shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID REFERENCES sendmo_links(id) NOT NULL,
  sendmo_id TEXT UNIQUE NOT NULL,
  sender_name TEXT, sender_email TEXT,
  origin_address_id UUID REFERENCES addresses(id),
  carrier TEXT, service TEXT,
  tracking_number TEXT, easypost_shipment_id TEXT, easypost_tracker_id TEXT,
  status TEXT NOT NULL DEFAULT 'label_created'
    CHECK (status IN ('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'return_to_sender', 'cancelled')),
  is_test BOOLEAN NOT NULL DEFAULT false,
  -- Refund/cancellation tracking (migration 002)
  refund_status TEXT NOT NULL DEFAULT 'none'
    CHECK (refund_status IN ('none', 'submitted', 'refunded', 'rejected', 'not_applicable')),
  refund_submitted_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  carrier_refund_id TEXT,
  -- Financials
  shipping_cost NUMERIC, insurance_cost NUMERIC DEFAULT 0, total_charged NUMERIC,
  label_pdf_url TEXT,
  shipped_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, eta TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Payments
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) NOT NULL,
  shipment_id UUID REFERENCES shipments(id),
  link_id UUID REFERENCES sendmo_links(id),
  stripe_payment_intent_id TEXT,
  amount NUMERIC NOT NULL, hold_amount NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'authorized', 'captured', 'refunded', 'failed')),
  payment_method TEXT CHECK (payment_method IN ('card', 'balance')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SendMo Balance (Post-MVP)
CREATE TABLE balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) UNIQUE NOT NULL,
  amount NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Webhook idempotency
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now(),
  payload JSONB
);

-- PHASE 3: ESCROW & MARKETPLACE (Conceptual Modeling)
-- Money transmission requires strict double-entry or append-only ledgering.
-- These tables represent future architectural additions to support "shipping_and_escrow" links.

-- CREATE TABLE escrows (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   shipment_id UUID REFERENCES shipments(id),
--   amount NUMERIC,
--   currency VARCHAR(3) DEFAULT 'USD',
--   status TEXT CHECK (status IN ('pending', 'funded', 'held_in_transit', 'dispute_opened', 'released', 'refunded', 'frozen_fraud')),
--   risk_score NUMERIC,
--   funded_at TIMESTAMPTZ, released_at TIMESTAMPTZ, disputed_at TIMESTAMPTZ
-- );

-- CREATE TABLE disputes (
--   id UUID PRIMARY KEY,
--   escrow_id UUID REFERENCES escrows(id),
--   opened_by UUID REFERENCES profiles(id),
--   reason TEXT,
--   status TEXT CHECK (status IN ('open', 'under_review', 'resolved_buyer', 'resolved_seller')),
--   evidence_urls JSONB,
--   resolution_notes TEXT
-- );

-- CREATE TABLE transactions (
--   -- Immutable ledger for all money transmission (funding, release, fees, dispute holding)
--   id UUID PRIMARY KEY,
--   escrow_id UUID REFERENCES escrows(id),
--   type TEXT CHECK (type IN ('hold', 'release', 'fee_deduction', 'refund')),
--   amount NUMERIC,
--   created_at TIMESTAMPTZ DEFAULT now()
-- );
```

### RLS Policies
- Users read/write own profiles, addresses, links, payments
- Shipments readable by link owner (recipient) AND sender (via short_code)
- Links publicly readable (for sender flow), writable only by owner

---

## 13. Payment System

> **For implementation details, see [`PAYMENTS.md`](PAYMENTS.md).** This SPEC section covers product behavior; PAYMENTS.md covers the architecture, data model, and operational guidance.

### Full Label Flow
1. Recipient completes shipment details -> exact price
2. Stripe charges card immediately (PaymentIntent, immediate capture)
3. EasyPost generates label PDF
4. Recipient downloads/shares

### Flexible Link Flow (Pattern D — Phase F, decided 2026-05-18)
1. Recipient sets preferences -> estimated cost range (informational only)
2. Recipient adds a card via Stripe SetupIntent (the same primitive the
   dashboard's Add Card modal uses). Stripe runs its zero-dollar verification
   with the issuer; on success the PaymentMethod is saved to the recipient's
   Stripe Customer. **No persistent hold is created.**
3. Sender uses link -> enters package -> rates fetched
4. Sender confirms -> labels Edge Function creates a fresh off_session
   PaymentIntent against the recipient's default saved PaymentMethod for the
   actual rate (server-derived, capped at link.max_price_cents). Stripe
   auto-captures synchronously.
5. EasyPost label purchased; transactions.charge ledger row written by the
   stripe-webhook on payment_intent.succeeded.
6. On off_session decline: link flips to externally-Inactive (computed from
   payment_methods state, not a DB enum value); recipient receives a
   payment_declined_reactivate email with a deep link to update their card.
   Once a new PM is attached, the link returns to Active automatically on
   the next render.

See proposal `proposals/2026-05-16_flex-payment-pattern-d-execution_reviewed-2026-05-16_decided-2026-05-18.md`
for the full rationale, decision history, and lifecycle map.

### SendMo Balance (Post-MVP)
- Pre-loaded wallet via card or ACH (Plaid)
- 5% discount on all shipments
- Balance deducted instead of card charged

---

## 13.1 Label Void & Refund Policy

SendMo allows labels to be voided before the package has been picked up and scanned by the carrier. All refund policies are presented under SendMo branding — carrier names are never surfaced to users.

### Eligibility

| Condition | Eligible? |
|-----------|----------|
| Label printed, not yet scanned | ✅ Yes |
| Package in transit | ❌ No |
| Package delivered | ❌ No |
| Previous void already submitted | ❌ No |
| USPS labels | Within 30 days of creation |
| UPS / FedEx labels | Within 90 days of creation |

### Refund Process

1. Admin (or user, post-MVP) initiates void from `/admin` Actions column
2. `CancelLabelModal` shows shipment details + SendMo refund policy (no carrier branding)
3. Click **"Void Label"** → calls `POST /api/cancel-label`
4. Edge function validates eligibility, submits void to carrier
5. `shipments.status` → `cancelled`, `refund_status` → `submitted`
6. Refund credited to SendMo account within **2–4 weeks** after carrier confirmation
7. Credit appears as SendMo account balance (not original payment method in Phase 1)

### Refund Status Values

| Status | Meaning | UI Label |
|--------|---------|----------|
| `none` | No void requested | — |
| `submitted` | Void submitted, awaiting carrier | "Refund Pending" (blue) |
| `refunded` | Carrier confirmed, credit issued | "Refunded" (green) |
| `rejected` | Carrier rejected (label was used) | "Refund Rejected" (red) |
| `not_applicable` | Label type not refundable | "Not Eligible" |

### Admin Void UI (`/admin`)

- **Actions column** in admin table shows **"Void"** button for eligible labels
- Button is **disabled** (with tooltip) for in-transit, delivered, cancelled, or already-voided labels
- **CancelLabelModal**: 4-state dialog (confirm → loading → success/error)
- On success: row updates optimistically to show "Cancelled" status + "Refund Pending" badge

### Future: User-Facing Void (Post-MVP)

- Dashboard Shipments table will show a "Void Label" action for eligible labels
- Same backend (`cancel-label` function) — just a different UI entry point
- Stripe refund to original card will be added in this phase (currently admin-only, credit to balance)

---

## 13.2 Risk Management

SendMo's payments risk-intelligence system defends the flex-link off-session charge surface (where an anonymous sender charges a recipient's saved card) with a per-account **Account Budget** ($200/day + $500/week, admin-raised), a per-account PM-add breaker, and distinct routing for Stripe Radar blocks; the per-shipment cap and Stripe Radar handle the on-session surfaces. Full architecture, operational instructions, observable event types, and the remaining-work list live in [`RISKMANAGEMENT.html`](RISKMANAGEMENT.html) — see also [`PAYMENTS.md`](PAYMENTS.md) §10.

## 13.3 Bidirectional Ledger (migration 032, H1)

The `transactions` ledger is now fully bidirectional — it records both the customer/Stripe side and the EasyPost/carrier side of every shipment's money movement. Two new `type` values (admitted by migration 032):

| Type | Sign | Writer | Trigger |
|---|---|---|---|
| `label_cost` | Negative (−) | `labels` function | Immediately after EasyPost label buy succeeds |
| `easypost_refund` | Positive (+) | `webhooks` (push) + `tracking` (poll) | When EasyPost confirms the carrier void (`refund.successful` event or lazy poll flip to `'refunded'`) |

**Idempotency:** `easypost_refund` rows are keyed on the EasyPost Refund object id (`rfnd_…`), not the shipment id — so a re-void, a webhook retry, and a concurrent tracking poll all resolve to the same row with a safe UNIQUE collision (B4 fix, decided proposal 2026-05-22).

**Zero-amount rows are not always wrong (2026-08-24).** A 0¢ `easypost_refund` row is the CORRECT amount when the carrier declined to refund a cancelled label — SendMo ate that cost. The daily audit therefore skips a 0¢ row when the shipment's `refund_status` is `not_applicable` or `rejected`, in addition to the pre-existing skip for a sibling non-zero (backfill) row. Before this, three such rows were flagged nightly as "under-stated EP credit" and the documented remedy — backfill at `rate_cents` — would have booked $16.00 of refunds that never occurred, irreversibly, in an append-only live ledger. Check `refund_status` before treating a 0¢ row as a defect.

**Amount sourcing:** EasyPost Refund objects carry **no `amount` field** (confirmed empirically 2026-07-06), so the norm-case amount is the shipment's `rate_cents` (declared label cost at buy time — the exact mirror of the `label_cost` row, so the pair cancels in the net-margin identity). Sourcing lives in ONE place: `resolveEasypostRefundAmountCents` inside `_shared/ledger.ts`'s `writeEasypostRefund`, which prefers a payload `amount` only when present, numeric, and > 0. All **three** writers (`webhooks`, `tracking`, `cron-refund-sweep`) pass the raw payload amount + `rate_cents` and cannot re-implement the fallback. Before 2026-07-06, sourcing was inlined per-writer and two of three were broken (webhook fell back to 0¢; tracking's fallback read an unselected column) — the daily reconciliation sweep now audits the ledger directly (Step 4b, window-independent) and flags live 0¢ rows (`recon.zero_amount_easypost_refund_tx`, suppressed once a backfill row exists on the shipment) and duplicate non-zero rows per shipment (`recon.duplicate_easypost_refund_tx`), since ledger rows are append-only.

**Net-margin identity** (foundation for H4 reconciliation dashboard):

```
Paid − Stripe fee − Refund to customer + Adjustment collected − Chargeback − Label cost + Refund from EasyPost − Adjustment charged = Net margin
```

All terms are now ledger rows; no column lookups on `shipments` are needed. Full reconciliation architecture: [`proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md`](proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md).

## 13.4 Carrier-Adjustment Recovery (H2)

Post-pickup carrier rate adjustments (USPS reweighs, UPS dim adjustments, address-correction surcharges) are now detected, recorded, and recovered automatically.

**Detection** — `webhooks/index.ts` `shipment.invoice.created/updated` arm:
- UPSERT `carrier_adjustments` on the partial-UNIQUE `source_event_id` (the ShipmentInvoice id). The `.updated` event corrects the prior amount; UPSERT preserves the latest.
- INSERT `transactions` row `type='carrier_adjustment'`, `amount_cents = -delta_cents` (SendMo's expense).
- Dispatches `_shared/adjustments.ts:resolveRecovery` for the tiered decision.

**Recovery — tiered policy** (`_shared/adjustments.ts`):

| Delta | Action |
|---|---|
| ≤ $1.00 | Absorb |
| $1.01 – $10.00 with no cap breach + saved PM | Auto-recharge = delta + $1 handling fee |
| > $10.00 or cap breach | Flag (Admin Reconciliation tab — H4) |
| Negative delta (carrier credit) | Absorb (credit lands in EP wallet) |
| Comp / no PM | Absorb / Flag |

**Caps:** per-shipment $10 lifetime, per-card $20/24h, per-user $50/7d. Read inside a transaction with `SELECT … FOR UPDATE` on the shipments row (migration 033 `resolve_recovery_lock` RPC) so two near-simultaneous adjustments can't both pass the same cap.

**Adjustment recharges bypass `checkAccountBudget`** — the adjustment-specific caps govern. Documented in PAYMENTS.md §11.4.

**Full-label save-card (D1)** — `payments/index.ts` now does `getOrCreateCustomerForUser` + `setup_future_usage: 'off_session'` so adjustment recharges have a PM to charge against. Brief consent disclosure on the checkout form.

**Risk-Intel Job 3 bundled** — `payments/index.ts` now does a mid-flow EasyPost GET to map `to_address` into Stripe's `shipping` param (Radar destination signal). Closes the deferred risk-intel work.

Full operational reference: [PAYMENTS.md §11](PAYMENTS.md#11-carrier-adjustments-2026-05-23--detection-recovery-ledger).

---

## 13.5 Refund Lifecycle Emails + Cron Sweep (H5)

Three customer-facing emails fire at `refund_status` transitions. Sent via Resend with `notifications_log` dedup (migration 035 partial index `idx_notifications_log_refund_dedup`).

| Email | Trigger | Carrier-aware | Send-site |
|---|---|---|---|
| A — "Refund submitted" | `refund_status → submitted` | Yes (USPS 2–4w / UPS+FedEx 1–2w) | `cancel-label/index.ts` |
| B — "Refund issued" | `refund_status → refunded` (charge.refunded webhook) | No | `stripe-webhook/index.ts` |
| C — "Refund unsuccessful" | `refund_status → rejected` | No | `tracking/index.ts` poll + `cron-refund-sweep` |

**Customer-facing word for rejected state: "Refund unsuccessful"** (Decision D4 — `rejected` enum value is internal; customers never see it).

**Cron sweep** (`cron-refund-sweep/index.ts`): finds `submitted` shipments older than 21 days, polls EasyPost, resolves. Timeout signature: `refund_status='rejected'` + `easypost_refund_status='submitted'` (still-submitted EP status distinguishes a timeout from a hard carrier rejection). Cron registration deferred (same fast-follow as H4). Admin trigger: AdminReconciliation → "Rejected refunds" sub-view.

**Admin queue**: `src/pages/AdminReconciliation.tsx` "Rejected refunds" chip shows all `refund_status='rejected'` shipments as a manual queue. Distinguishes timeout vs. carrier-rejected via the `easypost_refund_status` timeout signature.

Full operational reference: [PAYMENTS.md §12](PAYMENTS.md#12-refund-lifecycle-emails--cron-sweep-h5).

## 13.6 Buy-Time Rate Gate

The labels function enforces a hard correctness invariant immediately before calling EasyPost `/buy`:

> **EasyPost's buy-time rate must leave room for Stripe fees plus a minimum net margin on the price the customer was quoted (`display_price_cents`).**

Concretely, the gate refuses when:

```
buy_time_rate_cents > display_price_cents × (1 − STRIPE_FEE_PCT − MIN_NET_MARGIN_PCT) − STRIPE_FEE_FLAT_CENTS
```

Defaults: `STRIPE_FEE_PCT = 0.029`, `STRIPE_FEE_FLAT_CENTS = 30`, `MIN_NET_MARGIN_PCT = 0.05` (env-overridable via `LABEL_BUY_GATE_MIN_NET_MARGIN_PCT`).

**Flow on a gate trip:**
1. Re-fetch the rate from EasyPost (`/shipments/<id>/rates/<rate_id>` with fallback to `/shipments/<id>`) BEFORE calling `/buy`. Shared helper `lookupRate` in [`_shared/easypost-rates.ts`](supabase/functions/_shared/easypost-rates.ts). No EasyPost label is ever created for a refused buy — no carrier-side artifact, no `shipments` row, no `label_cost` ledger row.
2. Refund the captured PaymentIntent via Stripe `createRefund` with idempotency key `refund_<eps_id>_buy_time_rate_exceeded`.
3. Return HTTP 409 with `error: "rate_changed"` and the new buy-time rate. The client (`RecipientStepPayment` / `SenderFlow`) catches `BuyLabelRateChangedError`, renders `RateChangedDialog`, lets the buyer re-shop at the new price or cancel.
4. **Middle-path refund-failure handling**: if the Stripe refund itself fails, the 409 response carries `refunded: false` + `refund_error`. The dialog renders honest copy: "we tried, our team is on it, reference: <pi_id>". An `auto_refund_failed` event_logs row with `requires_manual_intervention: true` is the admin signal to manually process the refund. No automatic retry queue yet — fast-follow when real-world data demands it.

**When the rate is ABSENT rather than merely expensive** (added 2026-08-24): `lookupRate` returning `null` means the rate is on neither surface, which reliably predicts a 404 `NOT_FOUND` from `/buy` — EasyPost's message for that is the bare *"The requested resource could not be found."* Two rules follow, both learned from the 2026-08-24 incident (LOG):

- **A `null` is never a reason to skip the price cap silently.** Before the fix, `buyTimeRateCents` stayed `null` and the gate simply didn't run — no event, no alert — so the incident left no trace of *why*. It now emits `label.buy_time_rate_unresolvable` (severity `warn`).
- **A 404 from `/buy` triggers one rerate recovery, not an immediate refund.** The labels function calls `POST /shipments/<id>/rerate` (EasyPost's documented remedy for an unpurchasable rate), re-matches the **same carrier+service** via `rerateAndMatch`, re-checks the fresh price against `rerateRetryCapCents` — the identical cap formula above — and retries the buy once. Outcomes are logged as `label.rerate_retry` (`recovered` | `service_unavailable_after_rerate` | `retry_buy_failed`) or `label.rerate_over_cap`.

  **Known limit — recovery needs the rate OBJECT to still exist.** The rerate must re-match a carrier+service, and the only server-trusted source for that is the rate object itself: SendMo never persists the selected rate before purchase, and the client does not send carrier/service. If the rate is gone entirely (EasyPost retains unpurchased rates 28 days, so this means a very old or purged rate) there is nothing to re-match and recovery cannot run — the request falls straight through to the refund path and emits `label.rerate_impossible` (severity `error`). Closing this would require persisting carrier+service at PI-creation time; not done, because the 28-day retention makes the resolvable case the common one.

  **Invariants:** the service is never substituted, even for a cheaper one — the customer chose and paid for that service. The retry cannot produce two labels: it is only reachable when EasyPost *refused* the first buy, and a shipment already carrying a `postage_label` is refused on any further attempt. A failed retry leaves the original 404 as the reported error, so the refund path reports the real cause. Exhausted recovery falls through to the standard refund path with customer-facing copy that names the situation instead of echoing EasyPost's string.

**Soft warning band:** if the buy-time rate drifted >5% from the back-derived quoted rate but still passes the gate, emits a `label.buy_time_rate_drift` event_logs row (severity `warn`) with carrier/service/drift_pct/margin_remaining for telemetry. Doesn't block the buy. Threshold env-tunable via `LABEL_BUY_GATE_SOFT_DRIFT_PCT`.

**Comp labels are exempt** — SendMo absorbs EP cost by design; comparing to `display_price_cents` (which is meaningless for comp flows) would be wrong.

**Complements §13.4** (carrier-adjustment recovery, H2): §13.4 handles POST-pickup drift (USPS reweighs, dim/address surcharges discovered at the carrier scan); §13.6 handles BUY-TIME drift between rate-shop quote and `/buy` commit. They are not redundant — they catch different rate-divergence classes at different lifecycle points.

**Why auto-capture and not auth-then-capture:** SendMo currently uses `capture_method='automatic'` on the PaymentIntent — money moves at customer confirmation, BEFORE `/labels` runs. The gate is consequently a *check-then-refund* design rather than an *auth-then-capture* design. The latter would eliminate the refund path entirely but requires `/payments` + client confirmation flow rework (~2-3h). Deferred until real-world data shows >1 hard refund per week sustained (audit at decision time: 0 live losses across 32 shipments → not warranted for launch).

**Adjustment spend caps — how adjustment charges are identified (repaired 2026-08-24).** The per-card-24h and per-user-7d caps select adjustment charges by joining `stripe_intents` on `stripe_intent_id` and filtering `intent_role = 'carrier_adjustment'`. They must NOT filter `transactions.idempotency_key LIKE 'adjustment\_%'` — that prefix is the **Stripe** idempotency key for the PaymentIntent and never reaches the ledger, whose charge rows are keyed `stripe.evt_<id>:charge`. Migration 033 used the prefix (and a non-existent column) and both caps were consequently unenforced from deploy until migration 043. The per-shipment cap keys off `type='carrier_adjustment' + shipment_id` and was unaffected. The same discriminator governs the unlocked fallback in `_shared/adjustments.ts`.

Reference: [proposals/2026-05-23_buy-time-rate-gate.md](proposals/2026-05-23_buy-time-rate-gate.md). Companion service denylist constant in `rates/index.ts` (`SERVICE_DENYLIST`) suppresses carrier+service pairs with known systematic quote/buy divergence (currently: FedEx Smart Post).

---

## 14. Security Requirements

- **HTTPS** enforced on all routes
- **Stripe Elements** for PCI compliance (never handle raw card numbers)
- **Input validation**: Client-side (Zod) + server-side (Edge Function)
- **Address privacy**: Recipient address only on printed label, never in sender UI text
- **OTP**: 5-digit codes, 10-minute expiry, rate-limited to 3 attempts
- **RLS**: All database access scoped to authenticated user
- **Webhook signatures**: Verify Stripe and EasyPost webhook authenticity
- **Short codes**: Cryptographically random, 10-char alphanumeric (no ambiguous 0/O, 1/I/l), UNIQUE constraint + retry on collision
- **CORS**: Restrict to production domains
- **CSRF**: Supabase Auth tokens in headers (not cookies)

### Rate Limits

| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| `POST /api/email/verify` | 3 req | 10 min | IP + email |
| `POST /api/email/verify/confirm` | 5 attempts | 10 min | IP + email |
| `POST /api/addresses/verify` | 20 req | 1 min | IP |
| `POST /api/rates` | 10 req | 1 min | IP |
| `POST /api/guestimate` | 10 req | 1 min | IP |
| `POST /api/autocomplete` | 60 req | 1 min | IP |
| `POST /api/place-details` | 20 req | 1 min | IP |
| `POST /api/labels` | 5 req | 1 min | IP + link_id |
| `POST /api/links` | 3 req | 1 hour | user_id |
| `POST /api/links/band-quote` | 10 req (user) + 60 req (IP) | 1 min | user_id + IP |
| `GET /api/links/:shortCode` | 30 req | 1 min | IP |

> Implemented 2026-07-04 (PRE-LAUNCH T2-3) via the shared sliding-window limiter
> `supabase/functions/_shared/ratelimit.ts` for: addresses, rates, guestimate,
> autocomplete, place-details (all keyed on IP), plus the pre-existing limits in
> cancel-label / labels-flex / refunds / label-print. Buckets are per-isolate
> (speed bump, not a hard guarantee). Email OTP limits are handled by Supabase
> Auth since the 2026-05-11/15 migration to `signInWithOtp`.
>
> Amended 2026-08-29 (PR2, seller-link launch): the MONEY paths — labels flex
> confirm and seller-checkout — additionally run a shared DB-backed
> fixed-window counter (`rate_limit_hit` RPC, migration 046, via
> `_shared/dbratelimit.ts`; fail-open, logged as
> `ratelimit.db_check_failed_open`), because the per-isolate bucket cannot
> hold where each request spends money or EasyPost quota. seller-checkout:
> 10/min per (IP, short_code) **plus a code-independent 30/min per IP**
> (card testing is PI-create volume from one actor, so N scraped codes must
> not mean N× budget). The labels flex limiter exempts requests whose
> shipment already has a row — those resolve idempotently (PR1) and spend
> nothing. The `GET /links?code=` 30/min/IP limit above is now actually
> implemented (in-memory), dual-keyed: 30/min on `x-sendmo-client-ip` (an
> unauthenticated per-viewer hint forwarded by the Vercel OG middleware —
> without it every page view pools into a few egress IPs) AND 600/min on
> the spoof-resistant transport IP, so header-randomizing enumeration still
> hits a ceiling.

---

## 15. Webhook Processing

### EasyPost Tracking Webhook
Endpoint: `POST /api/webhooks/easypost`
- Verify signature -> extract tracking_code + status -> map to shipment status:
  - `in_transit` -> `in_transit` + send email
  - `out_for_delivery` -> `in_transit` + send email
  - `delivered` -> `delivered` + trigger payment capture (flexible link) + send email
  - `return_to_sender` -> `returned` + initiate refund
- Respond 200 OK (even on processing errors to prevent retries)

### Stripe Webhook
Endpoint: `POST /api/webhooks/stripe`
- `payment_intent.succeeded` -> update payments.status, send receipt
- `payment_intent.payment_failed` -> update status, send failure notification
- `charge.refunded` -> update status, send refund confirmation
- Idempotency via `webhook_events` table

---

## 16. Email Notifications

| Email | Trigger | Recipients |
|-------|---------|-----------|
| OTP Verification (5-digit, 10-min expiry) | Email verification step | Recipient |
| Link Activated | Payment authorized | Recipient |
| Label Created | Sender prints label | Recipient + Sender |
| In Transit | EasyPost webhook | Recipient + Sender |
| Out for Delivery | EasyPost webhook | Recipient |
| Delivered | Final delivery scan | Recipient + Sender |
| Payment Receipt | Payment captured | Recipient |

---

## 17. Authentication

- **Primary**: Magic link (passwordless) via Supabase Auth
- **Account creation**: Automatic during onboarding (after email verify + payment)
- **Returning users**: Email -> magic link -> `/dashboard`
- **Session**: JWT access + refresh tokens, auto-refresh via Supabase client
- **Session durability** (2026-08-18, [decided proposal](proposals/2026-08-18_session-durability-and-auth-architecture_reviewed-2026-08-18_decided-2026-08-18.md)):
  - Refresh calls that return **429 or 500** are retried with backoff and, if persistent, rewritten to a synthetic 503 (`src/lib/authFetch.ts`) — auth-js otherwise treats them as non-retryable and **destroys the stored session** (only network failures + 502/503/504 are retryable in `auth-js@2.97`).
  - Every auth event is breadcrumbed on three channels (`src/lib/authBreadcrumbs.ts`): localStorage ring buffer, `sm_bc` marker cookie, and `event_logs` via `ingest` (`auth.breadcrumb` / `auth.refresh_failed`). This is the Phase 0 diagnosis instrumentation; keep it until the daily-logout cause is confirmed and fixed.
  - Hosted Pro session knobs (dashboard-set, John): time-box **off**, inactivity timeout **off**, refresh-token rotation **on** with a **10s reuse interval**, JWT expiry **1h**. Server sessions are deliberately unbounded until Phase 2 (Token-Mediating Backend) lands; see the proposal for the 30-day-inactivity/90-day-absolute target design.
  - `www.sendmo.co` 308-redirects to the apex (vercel.json) — a second origin means a second, empty `localStorage` and a permanently signed-out UX.
- **Protected routes**: `/dashboard` requires auth, redirects to `/` if unauthenticated. While the browser is **offline**, a missing session holds on a waiting screen instead of bouncing to `/login` (`ProtectedRoute` + `useOnline`).
- **Senders**: No account needed. Optional email for tracking stored in `shipments.sender_email`. "Save my info" stores in `localStorage`.

---

## 18. Mobile & Accessibility

- All flows `container max-w-2xl` -- naturally responsive
- Progress labels hidden on mobile (`hidden sm:inline`)
- Rate modal: `Drawer` on mobile, `Dialog` on desktop
- Touch targets: 44x44px minimum
- `inputMode="numeric"` for dimensions/weight
- `prefers-reduced-motion` respected
- WCAG AA color contrast
- Label printing: 4x6 thermal support

---

## 19. Success Metrics

| Metric | Target |
|--------|--------|
| Time to first link | < 60 seconds |
| Onboarding completion rate | > 60% |
| Sender completion rate (click -> print) | > 70% |
| Payment failure rate | < 5% |
| Revenue (SendMo margin) | 15% standard, 10% with balance |

---

## 20. Phased Execution

### Phase 0: Foundation (Week 1)
- Fresh GitHub repo (sendmo-app), extract Loveable components
- Vercel deploy, sendmo.co domain
- Supabase schema migration (all tables + RLS)
- CLAUDE.md for Claude Code, GitHub Actions CI/CD

### Phase 1: Core Shipping MVP (Weeks 2-4)
- Both recipient paths (Full Label + Flexible Link) with real APIs
- Supabase Auth (magic link)
- AI address parsing + Magic Guestimator Edge Functions
- Stripe: immediate charge (full label) + auth/capture (flexible link)
- EasyPost: address verify, rate shopping, label generation, tracking webhooks
- Email notifications (OTP, label, tracking)
- Dashboard (shipments, links, wallet, preferences)
- FAQ with semantic search

### Phase 2: Payments, Trust & AI (Weeks 5-7)
- Rate adjustment handling, AI shipping advisor
- Google OAuth, saved sender profiles
- Sentry + PostHog integration
- Security hardening, abuse prevention

### Phase 3: Scale, Marketplace & Escrow (Weeks 8+)
- SendMo Balance / prepaid wallet (Plaid ACH)
- **Escrow Service / Trust Platform**: Allow recipients to fund an item (`escrow_amount`) in addition to shipping costs. Held funds released on delivery scan.
- **Money Transmission Compliance**: KYC/AML integration (`identity_verified`), append-only ledger `transactions` tracking, and 1099-K tax reporting (`total_volume_processed`).
- **Dispute Resolution Flow**: UI for buyers to freeze/dispute funds upon delivery, and Admin panel to mediate `disputes` & view `risk_score` / `frozen_fraud` events.
- Multiple links per user
- International shipping
- Private shipment links (QR code)
- Admin dashboard expansion (financial observability)

---

## 21. Development Workflow

### Tool Roles
- **Loveable**: Visual reference prototype only (sendmo.lovable.app) — not used for production code
- **Claude.ai**: Strategy, architecture, PRDs, design decisions
- **Claude Code**: All production code — frontend, Edge Functions, DB migrations, tests
- **GitHub**: Single source of truth
- **Vercel**: Auto-deploys from GitHub

### File Ownership
- Claude Code owns all production code (`/src`, `/supabase`, `/tests`)
- Loveable prototype is reference only — do not extract code from it

---

## 22. AI Item Recognition (Magic Guestimator)

### Overview

Allow users to describe an item (text) or upload a photo, and AI will automatically estimate package dimensions, weight, and suggest the best shipping method. This powers the "Magic Guestimator" feature in both the Full Label path (Step 10) and Sender flow (Step 1).

### User Flows

**Text description**: User types "iPhone 14 Pro in original box" → AI returns dimensions (6.5×3.5×2"), weight (12 oz), suggested packaging (Small Box), fragility flag, carrier recommendation.

**Photo upload** (Phase 2): User uploads photo → AI vision model analyzes → returns size/weight estimates.

**Combined** (Phase 2): Text + photo for higher accuracy.

### API Specification

```
POST /api/ai/analyze-item
```

**Request**:
```typescript
{
  description?: string;
  imageUrl?: string;        // Phase 2
  imageBase64?: string;     // Phase 2
  userHints?: {
    approximateWeight?: number;
    approximateSize?: string;
  }
}
```

**Response**:
```typescript
{
  success: boolean;
  data: {
    itemCategory: string;           // "Electronics > Mobile Phone"
    itemName: string;               // "iPhone 14 Pro"
    confidence: number;             // 0-1
    estimatedDimensions: { length: number; width: number; height: number; unit: "in" };
    estimatedWeightOz: number;
    suggestedPackageSize: "envelope" | "small" | "medium" | "large";
    fragile: boolean;
    fragileReason?: string;
    requiresSignature: boolean;
    insuranceRecommended: boolean;
    recommendedCarriers: Array<{ carrier: string; service: string; reason: string }>;
    warnings?: string[];
  };
}
```

### Implementation Strategy (Hybrid — MVP)

1. **Common items database** — Pre-loaded dimensions for top 100 shipped items (iPhone, MacBook, t-shirt, etc.). Fast lookup, zero cost.
2. **Claude API fallback** — For items not in the database, use Anthropic Claude API for text analysis (Phase 1) and vision analysis (Phase 2).

```typescript
async function analyzeItem(description: string, imageUrl?: string) {
  const commonItem = await checkCommonItems(description);
  if (commonItem && commonItem.confidence > 0.9) return commonItem;
  return await callClaudeAPI(description, imageUrl);
}
```

### Confidence Indicators

| Level | Threshold | UI |
|-------|-----------|-----|
| High | >0.8 | ✅ "We're confident about these estimates" |
| Medium | 0.5-0.8 | ⚠️ "Please verify these estimates" |
| Low | <0.5 | ❌ "Please enter details manually" |

### Cost Analysis

- Common item lookup: $0 (cached)
- Claude API text: ~$0.001 per request
- Claude API vision: ~$0.01 per image (Phase 2)
- At 10K labels/month, 30% using AI: **~$17/month**

### Phased Rollout

- **Phase 1 (MVP)**: Text-only Guestimator with common items DB + Claude API
- **Phase 2**: Photo upload + Claude Vision
- **Phase 3**: Learning from actual shipments (estimate vs. actual feedback loop)
- **Phase 4**: Marketplace-specific models (eBay, Poshmark, FBMP)

---

## 23. Logging & Observability

### Overview

SendMo uses a **structured event log** in Supabase (`event_logs` table) as a debugging knowledge base. It is written by Edge Functions during every significant operation, and queryable via the Supabase SQL editor.

**Today scope:** Debugging agents and developers can query `event_logs` with plain SQL to answer investigation questions without reading raw logs.

**Future scope (Phase 2):** When production volume justifies it, export to ClickHouse for clickstream analytics, funnel analysis, and throughput testing.

### Data Model

| Column | Type | Purpose |
|--------|------|---------|
| `event_type` | TEXT | e.g. `address.verified`, `label.created` |
| `session_id` | TEXT | Client-generated UUID; primary debug join key |
| `actor_id` | UUID | Supabase user_id (null for anonymous senders) |
| `entity_type` | TEXT | `address` \| `rate` \| `label` \| `shipment` |
| `entity_id` | TEXT | EasyPost ID or Supabase UUID |
| `severity` | TEXT | `info` \| `warn` \| `error` |
| `source` | TEXT | `edge_fn` \| `webhook` \| `frontend` |
| `duration_ms` | INT | External API call latency |
| `properties` | JSONB | All structured debug fields |

### Event Sources (Phase 1)

| Edge Function | Events Emitted |
|---|---|
| `addresses` | `address.verified`, `address.soft_warning`, `address.hard_error`, `address.google_fallback` |
| `rates` | `rate.fetched`, `rate.no_results`, `rate.error` |
| `labels` | `label.created`, `label.buy_error`, `label.endshipper_error`, `label.buy_time_rate_unresolvable`, `label.rerate_retry`, `label.rerate_over_cap`, `label.rerate_impossible`, `label.rerate_comp_price_jump` |

### Retention Policy

- **`event_logs`:** 90 days (pg_cron purge job)
- **Transactional tables** (`shipments`, `payments`, etc.): indefinite

### Infrastructure

- **Write path:** Edge Functions → `_shared/logger.ts` (fire-and-forget) → `ingest` Edge Function → `event_logs` table
- **Read path:** Supabase SQL Editor (service role), no RLS
- **Migration:** `supabase/migrations/003_event_logs.sql`
- **Query guide:** See `CLAUDE.md` § Logging & Observability

### Future: ClickHouse Migration (Phase 2+)

Trigger: `event_logs` exceeds ~5M rows or analytical query latency becomes noticeable.

**Recommended path:**
1. Add pg_cron export job (every 5 min): SELECT unexported rows → POST to ClickHouse HTTP API
2. No changes to `ingest` function or Edge Function instrumentation
3. Use ClickHouse for analytics; Supabase remains write target and transactional source of truth

**ClickHouse use cases:**
- Funnel conversion analysis (step drop-off)
- Address failure pattern analysis at scale
- Carrier reliability reporting
- Throughput and load testing baseline metrics

---

## 24. Open Questions

| Question | Status |
|----------|--------|
| Private links MVP timing | Deferred to Phase 3 |
| Carrier adjustment threshold | Pending -- needs Phase 1 data |
| Multiple links per user | Phase 2+ |
| Sender-paid shipping | Post-MVP evaluation |

---

## Appendix A: Decisions Log (2026-02-24)

| Decision | Rationale |
|----------|-----------|
| Two recipient paths (Full Label + Flexible Link) | Full label for known shipments (FBMP purchase); flexible link for ongoing/unknown |
| 3 distance tiers (Nearby/Regional/Cross-country) | Zone 4-5 rates are 40-50% higher than Zone 1-3 |
| 3 package scenarios (Envelope/Small box/Large box) | Maps to physical packaging which drives cost |
| Scenarios are optional hints, not constraints | Recipient doesn't know exact package; sender can ship anything |
| Insurance on Payment step, not Shipping step | Recipient doesn't know item value at shipping step; payment-adjacent decision |
| Insurance as 3-option (Off/$100/$300) | Meaningful choice without complexity |
| Magic Guestimator for AI form pre-fill | Reduces friction for users who know what's being shipped but not packaging specs |
| Full label = immediate charge; flexible link = auth + capture | Full label has exact price; flexible has range requiring hold |
| "Skip -- use default settings" as explicit action | Defaults: Regional, Standard, $100 cap. Prevents users from feeling stuck |
| PRD as bridge document between sessions | Avoids long context; each session starts fresh with PRD upload |

## Appendix B: Archived Reference Documents

These documents are archived in `_archive/` for reference. Content has been consolidated into this PRD and CLAUDE.md:

- `_archive/spec/SPEC.md` -- Original SPEC v5 (event tracking list, wireframes)
- `_archive/spec/external-docs/easypost-*.md` -- EasyPost API references
- `_archive/spec/external-docs/stripe-*.md` -- Stripe API references
- `_archive/spec/decisions/001-data-model.md` -- Data model decisions
- `_archive/frontend/AI_FEATURE_SPEC.md` -- Full AI feature spec (merged into §22)
- `_archive/backend/` -- Deployment guides, data model docs

## Appendix C: Prototype vs Production

| Feature | Prototype (Loveable) | Production |
|---------|---------------------|------------|
| Address verification | Length check (>15 chars) | EasyPost Address API |
| Shipping rates | Hardcoded rate tables + formula | EasyPost Rate API |
| Payment processing | Mock card inputs | Stripe Elements |
| Label generation | Static preview | EasyPost Label API + PDF |
| Email verification | Any 5 digits succeeds | SendGrid OTP with expiry |
| Authentication | None (localStorage) | Supabase Auth (magic link) |
| Tracking | Static mock data | EasyPost Tracker + webhooks |
| Dashboard data | Hardcoded array | PostgreSQL + Supabase |
| Guestimator | Keyword matching | Claude API with item recognition |

---

## 22. Testing Strategy

SendMo uses a 3-tier testing pyramid to ensure code quality and prevent shipping regressions:

1. **Unit & Component Tests** (Vitest + React Testing Library)
   - Tests individual UI components, interactive user flows, and utility functions in isolation.
   - Run on every commit. Fast execution (< 10s).
   - **Agent Directive**: Whenever a new component or utility is created in `src/`, a co-located `.test.tsx` or `.test.ts` MUST be created in the `tests/unit/` directory.

2. **Integration Tests** (Node Scripts)
   - Tests the interaction between the application and external APIs (primarily EasyPost via Supabase Edge Functions).
   - Located in `tests/integration/` (e.g., `easypost-test.mjs`).

3. **End-to-End (E2E) Tests** (Playwright)
   - Tests full user journeys in a real browser environment.
   - Requires the local dev server and mocked connections to be running.
   - Located in `tests/e2e/`.

### Continuous Integration (CI/CD)

- GitHub Actions (`.github/workflows/test.yml`) ensures that the full test suite (linting, type-checking, unit, and E2E) passes on every push and pull request to the `main` branch.
- Vercel is used for deployment, but relies on GitHub Actions as the primary quality gate.

### Execution Commands

- `npm run lint` — Runs ESLint. Crucial for catching React anti-patterns.
- `npm run test:unit` — Runs all Vitest unit and component tests.
- `npm run test:coverage` — Runs Vitest with v8 coverage reporting.
- `npm run test:e2e` — Runs Playwright E2E tests (requires `npm run dev` to be active).
- `npm run test:e2e:browser` — Alias for `test:e2e`, added 2026-05-13 for cross-project convention parity with AgentEnvoy (Playwright == `:browser` everywhere across John's projects). Either name works; new tooling references `:browser`.
- You can use the agent workflow `/run-tests` to execute the full validation pipeline locally.

### Browser-Verification Discipline (PLAYBOOK Rule 19)

Added 2026-05-13. Sibling rule to AgentEnvoy's Rule 29. Empirical basis: an AgentEnvoy bug cluster on 2026-05-13 found that **agent confidence was the failure mode in 4 of 4 catchable bugs** — every agent was sure their fix worked and shipped without browser-verifying.

For any `fix`/`ship` LOG entry touching product surface (`src/components/`, `src/pages/`, `src/hooks/`, `src/contexts/`, `supabase/functions/`), the entry MUST include a structured `Browser-verified:` block. Three valid shapes (exactly one):

- `spec:` + `variants-covered:` — a Playwright spec exercised the relevant variants
- `mcp-session:` + `variants-covered:` — a live Playwright MCP session asserted the relevant variants
- `n/a-category:` (closed enum: `pure-logic | agent-internal | infra | copy-only | migration`) + `n/a-reason:` — categorical exemption

There is **no free-text "I'm confident" path** in the format. Full rule body, the `agent-internal` guidance note ("name the tighter alternative before claiming the exemption"), and reviewer duty live in [`PLAYBOOK.md` §19](./PLAYBOOK.md). Cross-project canonical proposal: [`agentenvoy/proposals/2026-05-13_claude-production-verification-infra_reviewed-2026-05-13_decided-2026-05-13.md`](../agentenvoy/proposals/2026-05-13_claude-production-verification-infra_reviewed-2026-05-13_decided-2026-05-13.md).

**Agent-side tooling:**
- **Playwright MCP** (registered at user scope; works in every SendMo session) — drives a real Chromium against the dev server and returns DOM snapshots into the conversation. Use for in-session verification, ARIA audits, exploratory checks.
- **Slash commands** in `.claude/commands/`:
  - `/runtest` — quick pass/fail on the e2e suite
  - `/verifyfix <commit-or-path>` — daily-use; forces variant-axis naming and tighter-rigor-or-defend discipline before any `n/a-category` claim
  - `/buildtest <bug>` — author a new spec with regression-proof validation (revert fix → spec must fail → restore → must pass)
- **Stop hook** at `scripts/claude-hooks/check-browser-verified.sh` — fires at session close if product-surface files were modified but no `Browser-verified:` structured sub-keys appear in the LOG.md diff. Advisory only (exits 0); blocking gate is reviewer duty per Rule 19.

**Variant-axis discipline.** Verify *the variants of the changed code path*, not just the one named in the bug report. SendMo's common axes:
- Payment paths → `{full-prepaid, flexible-link} × {test-mode, live_comp, live_charge}`
- Shipment lifecycle → `{label_created, in_use, cancelled, completed, expired}`
- Cancel/change auth → `{authed, anonymous-with-cancel-token, anonymous}`

If you can't name the variant axis, the fix is broader than you've modeled — stop and trace.

### Known Anti-Patterns to Avoid

- **Nested Component Definitions**: NEVER define a React component inside another component's render function or body (e.g., defining `AddressFields` inside `LabelTest`). This causes React to remount the child component on every render, leading to massive bugs like input fields losing focus on every keystroke. These bugs are caught by robust Component Interaction tests and the `react/no-unstable-nested-components` ESLint rule.
