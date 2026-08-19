# Handoff: Shipping Label/Link Creation Flow (SendMo)

## Overview
This is the end-to-end flow for creating a shipment on sendmo.co, covering two roles:
1. **Creator flow** — the person starting the shipment (destination → origin → package → shipping → contact verification → payment → done).
2. **Sender flow** — the person who receives a SendMo link when the creator defers one or more fields, and completes whatever's missing before printing the label.

The core idea: a creator can either fill in everything themselves (producing a **prepaid label**, paid in full up front) or defer any of Destination / Origin / Package to whoever actually ships it (producing a **shipping link**, where the creator sets a spending cap and is only charged when the link is used).

## About the Design Files
The files in this bundle (`SendMo Onboarding Flow.dc.html`, `MorphProgressBar.dc.html`) are **design references** — interactive HTML/React prototypes built to show intended layout, copy, and behavior. They are not production code to paste in. The task is to **recreate this design in the Sendmo codebase's existing stack** (React + whatever component/styling system the repo already uses — Tailwind/shadcn per the existing app), following its established patterns, not the raw inline styles used in these prototype files.

## Fidelity
**High-fidelity.** Colors, spacing, typography, and copy are final/near-final. Recreate pixel-close using the app's real design tokens and component library (buttons, inputs, cards should map to the existing shadcn/ui equivalents rather than being rebuilt from scratch).

## How to read the prototype file
`SendMo Onboarding Flow.dc.html` is a single self-running page with two independent, fully-clickable demos stacked vertically:
- `#creator-flow` — the creator's flow, step-driven by `state.step`.
- `#sender-flow` — the sender's flow, with a scenario switcher (segmented control) that simulates the three cases a sender can land in (only package left / origin+package left / nothing filled in), plus step chips to jump directly to any screen.

`MorphProgressBar.dc.html` is a small reusable component (a numbered step tracker) imported by both flows — reference it for the step-indicator behavior.

Open the HTML file directly in a browser to click through every state.

---

## Creator Flow — Screens

### 1. Destination ("Where's it going?")
- Segmented toggle at top of the card: **"I have it"** / **"Sender fills this in"** — equal visual weight, no default selection styling implying one is preferred.
- Caption line under the toggle changes based on state (e.g. "Enter their name, address, and phone." vs "They'll enter the delivery address when they use your link — you set a cap and pay when they ship.")
- If signed in and no address entered yet: a "Deliver to me — use my saved address" chip appears above the fields.
- Fields (dim to 40% opacity + non-interactive when deferred, rather than being replaced/hidden — layout never jumps): Recipient's name, delivery address (autocomplete-style), phone.
- Below the fields: sign-in area. If signed out: full-width "Continue with Google" button + "or use your email" divider + email input. If signed in: "Signed in as {email}" row with small avatar circle.

### 2. Origin ("Where's it shipping from?")
- Same toggle pattern ("I have it" / "Sender fills this in").
- If signed in and sender not yet claimed: an "I'm the sender — mailing this out myself" chip appears (fills origin with the user's own info).
- Fields: sender's name, address, phone (dimmed when deferred).

### 3. Package ("What's being shipped?")
- Same toggle pattern.
- "Magic Guestimator" card: a textarea ("e.g., a hardcover cookbook") + "I'm Feeling Lucky" button.
- After running the guestimator, a green result panel appears showing **editable** fields (not static text): box L × W × H in inches, and weight in lb + oz, each as small individual number inputs. Defaults: 10×7×4 in, 2 lb 3 oz.

### 4. Shipping ("How should it ship?")
Two very different UIs depending on whether anything was deferred:
- **Full flag** (nothing deferred): a list of rate cards, one per carrier/service (USPS Ground Advantage, UPS Ground, FedEx 2Day), each showing carrier+service, transit days, and exact price. Selecting one shows an "Estimated cost" callout with the price in large text (24px/800 weight).
- **Flex flag** (something deferred): no exact rates shown (the sender will pick later). Instead: a speed selector (Economy/Standard/Express, each with a day range and a price *range*), a carrier preference (Any/USPS/UPS/FedEx), and a spending cap selector ($25/$50/$100/$150). Caption: "Your sender won't see options above this price."

### 5. Contact ("Verify your email or account")
- Heading: **"Verify your email or account"**. Subtext: **"Required so you can securely manage your shipments and so we can help if something goes wrong."**
- "Continue with Google" full-width button, "or use your email" divider, email input, then a 6-digit OTP entry (6 individual boxes). "Verify and continue" button (disabled/greyed until valid).

### 6. Payment
Heading differs by path: **"Enter your payment information"** (full) or **"Add payment information to activate your link"** (flex). Both show a unified summary card that must answer, at a glance:
- **What this is**: a small pill badge, "Prepaid label" (blue) or "Shipping link" (amber/tan).
- **To** / **From** rows: either the actual name, or "Sender fills this in" if deferred.
- **Carrier** row: exact carrier+service (full) or "Sender picks · {speed} speed" / "{Carrier} preferred · {speed} speed" (flex).
- A one-line note stating what's left for the sender to do (dynamically built from which fields were deferred), and the pay-per-use cap folded into the same sentence — e.g. *"They'll add the ship-from address, then print the label. You're only charged when they ship — up to $100, never more."*
- **Total** row: exact price (full) or "Up to $cap" (flex), visually distinct (bold, colored).
- Below the summary: a placeholder card for the actual card-entry field (Stripe Elements for full/one-time charge, Stripe SetupIntent for flex/save-card-on-file), then the CTA button ("Pay $X" / "Save card & activate link").

### 7. Done
- **Full flag**: green success panel ("Label ready" + tracking number placeholder), "Print label" + "Download PDF" buttons, "Tracking updates go to {email}" note.
- **Flex flag**: "Your shipping link" label, a copyable link row (with a "Copy link"/"Copied!" button), and the same narrative sentence from the payment step restating what the sender needs to do and the pay cap.

### Progress bar (all creator screens)
Six equally-sized numbered circles: **Destination, Origin, Package, Shipping, Contact, Payment**. States:
- **upcoming**: white circle, gray border, number shown.
- **current**: light-blue fill, blue border, number shown.
- **done**: solid blue fill, white checkmark.
- **skipped** (only for Destination/Origin/Package when deferred): solid amber/tan fill, white arrow (→) instead of a number.
Connecting lines between circles are blue once both neighboring steps are done/skipped, otherwise light gray. See `MorphProgressBar.dc.html` for exact implementation.

### Skip/defer interaction (applies to Destination, Origin, Package)
- A two-way segmented toggle ("I have it" / "Sender fills this in") sits above the fields — not a radio button or a "skip" link — with neither option pre-selected.
- Choosing "Sender fills this in" does **not** swap the screen for a large colored panel; the field group simply dims (opacity ~0.4, pointer-events off) in place, so nothing else in the layout shifts.
- The very first time a creator defers anything in a session, a one-time dark explainer bubble appears (bg near-black, white text) stating this is now a shipping link, with an inline "Undo" action. On every subsequent defer, only a small "Undo — answer it yourself" text link appears — no repeated banner.

---

## Sender Flow — Screens
Reached via the link a creator shares. What the sender sees depends entirely on what the creator deferred — never more, never less, and it never reveals the creator's exact payment amount (see Privacy rules below).

Demo controls (prototype-only, not part of the real UI): a segmented scenario switcher — "Only package left" / "Origin + package left" / "Nothing filled in" — plus step chips to jump directly to any screen, and a Reset button.

### Intro
- Headline + subhead vary by scenario (e.g. "You're sending a package to Jordan" / "You'll describe what's inside — everything else is set.").
- A "How it works" 3-line mini-card (add anything missing → choose a shipping speed → print the label).
- "Get Started" button.

### Package details
- Reuses the same progress bar component, but with **dynamic labels reflecting exactly what this sender needs to complete**: "Package" (nothing else needed), "Your info" (origin + package), or "Destination & info" (nothing prefilled).
- Header block: "Shipping to {recipient}" and, if the origin is already known, "From {sender name}" directly beneath it (not the destination-only text used previously).
- If destination wasn't provided: destination name/address/phone fields appear.
- If origin wasn't provided: origin name/address/phone fields appear; if it *was* provided, a plain one-line note states who it's from (never shown as an editable field).
- "Describe the product" card: textarea + "I'm Feeling Lucky" → editable box dimensions (L×W×H in) and weight (lb/oz), same pattern as the creator's Package screen.

### Shipping options
- Progress bar, no prices shown — just carrier/service, transit days, and a rough cost tier ($ to $$$$), plus a "Preferred by Jordan" badge on the creator's chosen carrier if one was set.
- One line of copy: **"Jordan will pay for shipping."**

### Review and confirm
- Progress bar.
- Summary card: From / To, then a visually distinct **Service** block (label + bold 14px value on its own line, not squeezed into a space-between row) with an **estimated delivery date** below it (computed from today's date + the selected carrier's transit window, e.g. "Arrives Aug 21–23").
- Email card: single input, helper text **"So we can send delivery updates and help if something goes wrong."** — no Google sign-in option here (removed; email link/OTP is enough for a one-time sender).
- One checkbox: "Share my contact info with Jordan" (the "save my info on this device" checkbox was removed as confusing/unclear).
- "Confirm & generate label" button.

### Done
- Green "Label ready" success card, "Jordan already paid for shipping" note (the only cost language a sender ever sees), "Print label" button, "Tracking sent to {email}" note.

## Privacy rules (must hold in all sender-facing screens)
- Sender never sees a street address for anything already filled in by the creator — only city/state, or a name they typed themselves.
- Sender never sees exact prices for shipping options, only a relative cost tier ($–$$$$).
- Sender never sees how much the creator is being charged — the only money language shown is "Jordan already paid for shipping" / "Jordan will pay for shipping."

---

## Design Tokens

**Typography**: Inter (system sans-serif fallback). Headings ~18–19px/700; body ~12.5–13.5px; captions/help text ~10.5–11.5px, color `hsl(210,7%,46%)` or `hsl(210,7%,55%)`.

**Colors**
- Primary blue (buttons, links, "done"/"current" progress states): `hsl(214,89%,52%)`; hover/darker text variant `hsl(214,89%,42–45%)`; light fill `hsl(214,89%,95–97%)`.
- Ink / heading text: `hsl(210,11%,15%)`.
- Secondary/body text: `hsl(210,7%,46%)`; tertiary/help text: `hsl(210,7%,55%)`.
- Borders: `hsl(210,14%,89%)`; light backgrounds/segmented-control track: `hsl(210,14%,95–96%)`.
- Success (guestimator result, done state): bg `hsl(142,60%,96%)`, border `hsl(142,50%,80%)`, icon fill `hsl(142,71%,45%)`, text `hsl(142,60%,25%)`.
- Amber/tan accent ("skipped" progress state, shipping-link badge): `oklch(72% 0.15 70)` fill, `oklch(97% 0.02 70)` light bg, `oklch(42–45% 0.1–0.12 70)` text.
- Destructive/required-field marker: `hsl(0,72%,51%)`.
- One-time explainer bubble: near-black bg `hsl(210,11%,15%)`, white text, light-blue link `hsl(214,89%,72%)`.

**Radii**: inputs/small controls 10px; buttons/cards 12–14px; large containers 16–20px; pills/avatars/progress circles 999px (full round).

**Shadows**: minimal — a subtle `0 1px 2px rgba(16,24,40,0.06–0.08)` on the active segment of segmented toggles only. Otherwise flat with 1px borders, no drop shadows on cards.

## Components to map to the existing design system
- Segmented two-way toggle ("I have it" / "Sender fills this in")
- Numbered step progress bar with 4 states (upcoming/current/done/skipped) — see `MorphProgressBar.dc.html`
- Rate/option select cards (radio-card pattern) — used for both exact carrier rates and speed tiers
- OTP 6-box input
- Editable dimension/weight mini-inputs (5 small numeric fields in a row)
- Copy-link row with copy/"Copied!" button state
- One-time dismissible explainer bubble vs. persistent small text-link ("Undo")

## Files
- `SendMo Onboarding Flow.dc.html` — full interactive prototype, both flows.
- `MorphProgressBar.dc.html` — reusable step-progress component used by both flows.
