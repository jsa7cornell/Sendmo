# SendMo — Onboarding UX Refresh: Design Brief for Claude

> **How to use this document:** paste it whole into Claude design. The first section is the prompt; everything after it is the product context, current screens, and hard constraints the design must respect.

---

## The prompt

You are redesigning the **shipment-creation flow** for SendMo, a consumer shipping app. The flow's *mechanics* were just rebuilt and work correctly — this is a **UX and visual design refresh**, not a logic change. The engineering team will implement whatever you design (React + Tailwind + shadcn/ui, mobile-first), so design freely but within the invariants listed at the end.

**The product insight your design must express:** SendMo asks four questions — *Where's it going? Where's it from? What's the package? How should it ship?* — and **every question is skippable**. Skipping isn't failing; it's answering *"the other person will fill this in."* Answer everything → you buy a **prepaid label** right now at an exact price. Skip anything → you get a **shipping link** to send the other person; they fill in what you skipped and print the label, and **you pay when they use it**. The product is the *result* of the answers, never a choice the user makes up front.

**What the founder wants fixed (verbatim intent):**
1. **The "other person chooses" option must be at the top** of each question, not buried under a form. Skipping is a first-class answer — the layout should say so. (Today it renders below the address form, styled as an afterthought.)
2. **The progress indicator must be consistent yet dynamic.** Today it swaps between two different segment sets (5 for the label path, 4 for the link path) mid-flow, which reads as being teleported into a different product. Design ONE progress mechanism that stays stable while visibly *morphing* as answers and skips accumulate — the user should see their four questions, see which are answered vs. handed off, and see the destination of the flow (label vs. link) evolving. This is the hardest and most valuable problem in the brief.
3. **Login, saved addresses, and options need much more thoughtful presentation.** Today: a Google sign-in button and email field sit inside the first question's card; a "deliver it to me — use my saved address" chip appears for signed-in users; an "I'm the sender" claim link sits at the bottom of the origin step. These identity moments are load-bearing (they determine which address slot prefills) but they're scattered and feel bolted on. Design where identity, sign-in, and saved-data affordances live so they help rather than interrupt.
4. **Be more creative overall.** The current flow is competent form-stacking. The label↔link transformation is a genuinely novel product moment — make it feel delightful and legible, not like a warning banner.

**Deliverables:**
- Screen-by-screen flows, mobile-first (375px primary, desktop secondary), covering every state listed in "States you must design" below.
- The progress mechanism: concept, all its states, and the morph moment when a skip changes the flow's destination.
- The skip/answer interaction pattern, reusable across all four questions.
- The identity layer: sign-in, saved address, resume-draft — where each lives and when it appears.
- A copy deck for every screen and state (see the who-pays rule — it is absolute).
- Motion notes for the transformation moment and step transitions.

---

## Product context

**SendMo in one line:** prepaid shipping made easy — create a shipping label, or a link that lets someone else finish the shipment on your dime.

**The three products (only the first two are in scope):**
| Product | Who fills what | Who pays | In scope? |
|---|---|---|---|
| **Prepaid label** (`full_label`) | Creator answers all four questions | Creator, exact price, now | ✅ this flow |
| **Shipping link** (`flexible`) | Creator answers some; the link's user (the "sender") fills the rest | **Creator**, per use, capped | ✅ this flow |
| Seller link (`seller_link`) | Seller sets origin+package; buyer pays | **Buyer** | ❌ separate flow, do not touch, never borrow its look |

**Primary persona:** someone *receiving* a package — a parent whose kid is mailing something home, a buyer awaiting an item, someone being sent a gift. They know where it's going (usually to themselves) but often not the sender's address or the package details. Secondary: someone mailing out themselves (knows origin, knows destination).

**The flow's four questions, in order, each skippable:**
1. **Destination** — skip = "the sender picks where it goes" (link user enters it)
2. **Origin** — skip = "the sender will fill this in"
3. **Package** (dims + weight, with an AI "Guestimator" that estimates from a description) — skip = same
4. **Shipping options** — not skippable; it *branches*: nothing skipped → carrier list + exact price + pay now; anything skipped → speed/carrier preferences + a price cap + save a card

**Non-question steps that must fit somewhere:** email + verification (OTP or Google sign-in — NOT skippable; it's how the creator gets an account and card), payment (Stripe card form), and the finale (label to print, or link to share).

---

## The current flow, screen by screen (what you're replacing)

### Creator flow (`/onboarding`)
1. **Destination step** — heading "Where's it going?"; name + address autocomplete (verifies → green badge) + phone; email field + "Continue with Google" in the same card; for signed-in users a "Deliver it to me — use my saved address" chip; skip option *below the form* ("The sender picks the destination"); resume-draft banner appears above everything when an unfinished flow exists.
2. **Origin step** — question card "Where's it shipping from?" with two radio-style answers: "I have their address" (pre-selected) / "The sender will fill this in"; address form below; a text link at the bottom: "I'm the sender — I'm mailing this out myself" (claims the saved address for the origin slot).
3. **Package step** — AI Guestimator input ("e.g., a hardcover cookbook"), packaging type (box/envelope/tube), dims, weight, then a live carrier-rate list (USPS/UPS/FedEx with prices) to pick from; skip option at the bottom.
4. **If nothing skipped:** email verify (OTP screen, skipped for Google users) → payment (Stripe, exact amount) → label ready (print + tracking).
5. **If anything skipped:** preferences (speed, carrier, **price cap** slider $ up to 500) → email verify → save card (Stripe SetupIntent, no charge now) → share screen (link + copy button).
6. **The banner:** the moment anything is skipped, a muted banner appears on subsequent steps: "This will be a shipping link, not a label. The sender fills in what you skipped and prints the label — you pay when they use it." with an "Undo skip" action.
7. **Progress bar:** 5 circles on the label path (Destination / Origin / Package & Shipping / Payment / Label), a *different* 4-circle set on the link path (Destination / Preferences / Save Card / Share Link). Completed circles are clickable to jump back.

### Sender flow (`/s/<code>` — the person who received a link; redesign is SECONDARY scope)
Intro ("You're sending a package to Sarah — postage is covered") → one long page: destination form (only if the creator skipped it), origin form, Guestimator + package form → rate list → review → label. Any field the creator already answered arrives prefilled.

**Known UX debts beyond the founder's four points:** the resume banner and the skip banner compete for the same visual slot; the origin step asks its question twice (radio card + the "I'm the sender" link are really one three-way question); the package step mixes four concerns (guestimate, packaging, measurements, carrier choice) in one scroll; the price-cap concept lands with no explanation of why it exists; the share screen undersells the link (it's the product's most viral surface).

---

## States you must design

- Each question: empty / partially filled / answered / **skipped** (with visible undo) / re-opened after undo
- Signed-out vs. signed-in (saved address available) vs. mid-flow Google OAuth return
- Resume: returning visitor with an unfinished draft (offer, never auto-apply)
- The morph moment: the instant a skip flips the outcome from label→link (and undo flipping it back)
- Link path: preferences + cap, card save, share screen
- Label path: rate list (including "no rates / address problem" error), payment, label ready
- Validation errors (address unverified, missing phone — carriers require one, bad email)
- Sender flow: all-prefilled, partially-prefilled, and nothing-prefilled ("you choose where it goes") variants

---

## Hard constraints (violating any of these makes the design unshippable)

1. **Who-pays is sacred copy.** On every branch of this flow, **the creator pays**. The link must never be described in a way that could read as "the other person pays" — a sibling product (seller link) exists where the buyer pays, and confusing the two is the #1 forbidden failure. State "you pay" plainly at the decision moment and at card-save.
2. **Privacy (Rule 7):** the sender must never be shown the recipient's street address or ZIP in UI text — city/state only. (Exception: fields the sender themselves typed.) Design summaries accordingly.
3. **Email is not skippable** and must be verified (OTP or Google) before payment/card steps. Don't design it away; do design it a better home.
4. **Every address needs a phone** (FedEx/UPS refuse labels without one) and must be picked from autocomplete verification. Surface these as helpful, not as gotchas.
5. **The card forms are Stripe Elements** — their internals are Stripe-rendered; you style the container, not the fields.
6. **Refresh, back button, closed-tab resume all work today and must keep working** — design the resume offer, don't assume a fresh start.
7. **Implementable in React + Tailwind + shadcn/ui** without a new component framework; motion via Framer Motion (already in the stack).
8. **Mobile-first.** Most senders open links from a text message.
9. The defaults question is open: today "I have their address" is pre-selected so the label path (all revenue to date) doesn't lose a click, while the founder wants the skip option *on top*. Prominence and default are separable — resolve this tension deliberately and say how.

---

## What NOT to redesign

The seller flow (`/sell`), the dashboard, the tracking page, and the admin surface. The homepage hero is out of scope except for the single button that enters this flow.
