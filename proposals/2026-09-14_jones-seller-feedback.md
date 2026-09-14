---
title: Jones's seller feedback — four asks, three already built, two live bugs
slug: jones-seller-feedback
project: sendmo
status: in-review
blocked_on: null
created: 2026-09-14
last_updated: 2026-09-14  # drafted from Jones's 2026-09-11 feedback
reviewed: null
decided: null
pr: null
author: Claude Opus 5 — drafted from John's request to act on Jones Anderson's post-sale feedback (received 2026-09-11 over WhatsApp). Grounded against production (read-only queries against fkxykvzsqdjzhurntgah, plus a pixel decode of Jones's actual label PNG) and a worktree at origin/main (HEAD df30c08, 0 behind). Two multi-agent passes — a four-item investigation with per-item adversarial verification, and a focused label-sizing pass with three adversarial lenses (compliance, code, product). The adversarial passes killed two of the author's own framings; both corrections are recorded in §1.
reviewer: null
outcome: null
---

> **What this is in one line:** A real seller used SendMo for a real eBay sale and asked for four things. Three of them already exist and the seller lane simply never offered them to him; the fourth is a wish we cannot honour literally. Along the way we found two live bugs, one of which silently distorts every UPS label.

---

## 0. Read this part first

Two findings here are independent of everything else in this proposal and stand on their own merits:

1. **Every UPS label prints distorted.** The print page forces a 4×7 UPS label into a 4in × 6in box with no `object-fit`, so CSS default `fill` compresses it 14.3% vertically. UPS labels carry a MaxiCode — a fixed-geometry 2D symbol with no tolerance for non-uniform distortion. Roughly half of all live SendMo labels are UPS (4 of 7). **Nobody has reported a scan failure, and I have not print-and-scan tested it** — but the geometry is measured, not inferred.

2. **Picking "UPS" or "FedEx" as a carrier constraint filters out every rate.** `_shared/rate-filters.ts:58` compares EasyPost's raw carrier string to the lowercase UI chip id. EasyPost returns `UPSDAP` and `FedExDefault`; the chips are `ups` and `fedex`. Only `usps` matches, by coincidence. This is **latent** — prod has exactly two carrier-constrained links, one `usps`/active (works) and one `ups`/draft (never resolved, because `rates/` only reads active links). Cheap insurance, not an emergency.

Neither is seller-specific. Both affect flex and full-label today.

---

## 1. Context

### What Jones said

Jones Anderson sold an item on a marketplace, shipped it with SendMo, and sent John four lines on 2026-09-11, prefaced *"I would like:"*

1. "it sent me a copy of my shipment to my email"
2. "it made lable easy to re size"
3. "i could make it so i paid for shipping as seller"
4. "i could set only usps or ups"

John clarified #2 in session: *"set different sizes of it so it fits on smal/medium/large sized packages."*

### What Jones actually did — ground truth from production

One read-only query settles most of the ambiguity. Shipment `K1ZQ9FR`:

| Fact | Value |
|---|---|
| Created | 2026-09-10 19:45:53 UTC |
| Mode | **live** (`is_test = false`) |
| Carrier / service | `UPSDAP` / `UPSGroundsaverLessThan1lb` |
| Lane | `link_type = seller_link` → **Checkout Link, buyer pays** |
| Parcel | **12 × 13 × 1 in, 7 oz** |
| Item | "DEFCON badge" |
| Emails | 2 × `label_created`, both `status = sent`, no errors |
| Jones's contact role | `recipient` (on a seller link the seller is the `recipient` contact) |

### Two corrections the adversarial passes forced on this author

Both were framings I had already written down, and both were wrong. Recording them because they change what we should build:

**Correction 1 — "the label was too big for his package" is false for this shipment.** His parcel was a 12×13 flat. A 4×6 label on that face leaves ~4 inches of clear margin on every side. There was no geometric fit problem on the sale he actually made.

**Correction 2 — trimming the UPS label does not make the printed label smaller.** The print page already forces every label into a 4in × 6in box. Fixing the distortion makes the same 4×6 footprint *undistorted*. The delta in physical size is exactly zero. Any copy that tells a seller "we made your label smaller" would be false.

### The finding that actually explains #2

**Jones never opened the print page.** Production has exactly **4** `label.printed` events, ever; the most recent is 2026-07-18, well before his 2026-09-10 sale. So he never saw the three-preset size picker.

What he almost certainly used is **Download**, right next to Print on the tracking page. `handleDownloadClick` (`src/pages/TrackingPage.tsx:310-327`) calls `fetch(labelUrl)` against a no-CORS S3 URL. That throws. The `catch` falls through to `window.open(labelUrl)` — which dumps a raw 800×1400 PNG into a browser tab. From there the only sizing control is the browser's print dialog.

*"It made lable easy to re size"* is a plain description of that experience.

### The through-line

**Three of the four asks already exist. The seller lane never offered them to him.**

- The size picker ships, live and unflagged — behind a button labelled only `Print`.
- The seller-pays lane ships, live and unflagged — behind a button labelled *"Back to shipping options"*.
- The carrier constraint ships and is enforced server-side — but the seller builder hardcodes `"any"` and the control was deliberately removed on 2026-08-29.

Jones is not asking for features. He is asking to be the actor in his own shipment. On a Checkout Link the buyer picks the carrier, pays, holds the cancel token, and gets the celebration screen. The seller packs the box, drives to UPS, and answers to eBay if it goes wrong.

### Where each gap sits

```
SELLER JOURNEY (Checkout Link — the lane Jones used)

  /sell  ──────────────────────────────────────────────────────┐
   │  step 1: origin + quantity                                │
   │  step 2: parcel                                           │  GAP C: no who-pays choice.
   │  step 3: review                                           │  Only exit to the seller-pays
   │  step 4: ready → share link                               │  lane is a back-arrow reading
   │                                                           │  "Back to shipping options"
   │  preferred_carrier hardcoded "any"  ← GAP D               │  (SellerBuilder.tsx:310)
   └───────────────────────────────────────────────────────────┘
        │
        │  buyer opens link, picks carrier, pays
        ▼
   labels/ buys the label ───► 2 emails sent ───► seller's inbox
        │                          │
        │                          └── GAP A: 5 rows. "From" shows the seller
        │                              his OWN name. No buyer, no destination,
        │                              no service level, no parcel.
        │                              Tracking # present but 11px grey.
        ▼
   seller lands on /t/<code>  (pre-dropoff, family=1)
        │
        ├── Tracking # HIDDEN here (DetailsCard.tsx:75 gates on family===2)
        │
        ├── [Print] ──► /t/<code>/print ──► 3 presets  ← he never got here
        │                                    (4 print events ever, none his)
        │
        └── [Download] ──► fetch() fails (no CORS) ──► window.open
                          ──► raw 800×1400 PNG in a tab   ← GAP B
```

---

## 2. Architecture

Five workstreams. Each is independently shippable; none blocks another. They are ordered by value-to-effort, not by dependency.

| # | Workstream | Kind | Effort | Needs John? |
|---|---|---|---|---|
| **W1** | Carrier matcher fix | Bug | XS | No |
| **W2** | Seller-pays signpost on `/sell` | Copy + routing | XS→S | Yes, for the full version |
| **W3** | Label email becomes a real shipment record | Feature | S | No |
| **W4** | UPS label distortion fix | Bug | S | No |
| **W5** | Carrier constraint control on `/sell` | Feature | M | **Yes — reverses a 2026-08-29 call** |

The unifying idea: **stop hiding capabilities the seller already paid for.** Four of the five are about exposure and correctness, not new capability. Only W5 adds a control, and even that restores one that existed until three weeks ago.

### Why these five and not a "seller dashboard" rebuild

Every workstream here extends something that already exists:

- W1 mirrors `normalizeCarrier` (`src/components/sender/senderState.ts:124-131`), which already handles `UPSDAP` and `FedExDefault` correctly via `.includes()`.
- W2 changes one string and one route.
- W3 extends `summaryRow` (`email-templates.ts:136`) and `labelCreatedCtx` — the context object already built at the call site.
- W4 extends the existing `Preset` / `PRESETS` / `sheet-${preset}` scheme (`LabelPrintPage.tsx:21-28`, `:166-203`).
- W5 extends the existing `preferred_carrier` column and the one shared rate predicate.

No new table, no new edge function, no new dependency, no new abstraction.

---

## 3. File-by-file plan

### W1 — Carrier matcher fix (XS, bug)

**The bug.** `supabase/functions/_shared/rate-filters.ts:51,58-59`:

```ts
const carrierLower = rate.carrier.toLowerCase();
...
if (prefs.preferredCarrier && prefs.preferredCarrier !== "any") {
    if (carrierLower !== prefs.preferredCarrier.toLowerCase()) return "carrier_filtered";
}
```

EasyPost returns `USPS`, `UPSDAP`, `FedExDefault` (confirmed against prod `shipments.carrier`). The UI chips are `usps`, `ups`, `fedex` (`src/components/forms/FlexPreferencesForm.tsx:58-63`). So:

- `"usps" === "usps"` → works, by coincidence
- `"upsdap" !== "ups"` → **every UPS rate filtered out**
- `"fedexdefault" !== "fedex"` → **every FedEx rate filtered out**

**Files**

- `supabase/functions/_shared/rate-filters.ts` — add a server-side `normalizeCarrier`, mirroring `src/components/sender/senderState.ts:124-131` verbatim (uppercase, then `.includes()` on `USPS` / `FEDEX`|`FED_EX` / `UPS` / `DHL`). Compare normalized-to-normalized. Order matters and the existing helper already has it right — `USPS` is tested before `UPS`, and `"USPS"` does not contain the substring `"UPS"` anyway.
- `tests/unit/rateFilters.test.ts` — **new file.** No test anywhere currently imports `rate-filters`; the one adjacent test uses a synthetic `"UPS"` string EasyPost never returns, which is why CI is green on a broken matcher.

**Blast radius.** `rateDisplayFilterReason` is the single shared predicate — `rates/index.ts:431`, `_shared/price-band.ts` (and `seller-band-sweep` transitively). One fix covers every caller.

**Note on scope.** This fixes the *display* filter. `labels/` still does not re-check the bought rate's carrier at buy time (`WISHLIST.md:187`, seller-link F5) — so the constraint remains a display filter, not a guarantee. Out of scope here; cross-linked, not fixed.

### W2 — Seller-pays signpost (XS → S)

**What is true.** A seller can already pay for shipping today. `/onboarding` walks destination → origin → package → real rates → pay → print. Not flag-gated. That is exactly "I paid for shipping as seller."

**What is wrong.** `/sell` offers no who-pays choice — `SellerBuilder`'s complete user-choice state is step, origin, parcel, single-use — and its only exit to the lane that does is a back-arrow reading **"Back to shipping options"** (`src/pages/SellerBuilder.tsx:310`).

There is a second, subtler problem. The listing snippet SendMo hands the seller to paste into his eBay listing reads:

> *"📦 Shipping is easy — open my SendMo link, enter your address, pick your speed, and pay for shipping."* (`src/components/links/LinkShareCard.tsx:70`, duplicated at `:187`)

Telling a marketplace buyer to pay for shipping is close to the opposite of what a competitive listing says. That framing — not the `funder` column — may be most of what Jones reacted to.

**Cheap version (XS, ship now).** Change the `SellerBuilder.tsx:310` string to name the destination, e.g. *"I'd rather pay for shipping myself"*. One string, zero risk.

**Full version (S, needs John).** A two-card who-pays choice at the top of `/sell` step 1, using the existing `WhoPaysChip` vocabulary. "My buyer pays" continues as today; "I'll pay" routes to `/onboarding`.

**Two implementation notes if we take the full version.** Route to `/onboarding`, *not* a deep step URL — only `OnboardingEntry` calls `clearFlow()`, so a deep link can repopulate from a stale draft (the 2026-08-16 stale-autofill class). And the signed-out path never reaches the choice: `SellerBuilder` renders a coming-soon wall then a sign-in wall first.

**Explicitly not proposed: `funder='seller'`.** The seam exists and is dormant (migration 040 column + CHECK; `links/index.ts:842` hardcodes `"buyer"`; `seller-checkout/index.ts:237-241` refuses anything else). Do not build it yet. Migration 042 already shipped "the creator defers the destination and still pays" — so a seller-funded, buyer-filled link **already exists as a flexible link**. The only real difference is who prints at the end. That makes this a role swap, not a new lane, and it deserves its own proposal.

### W3 — The label email becomes a real shipment record (S)

**What the seller gets today.** `labelConfirmationEmail(variant:"seller_link")` — subject *"You made a sale — print your label"* — renders: SendMo code, carrier + tracking number, **From (a bare name)**, Item, Amount, Carrier, ETA (`supabase/functions/_shared/email-templates.ts:77-193`).

**Defect 1 — the "From" row is wrong for sellers.** `labelCreatedCtx` sets `sender_name: from_address?.name ?? null` (`supabase/functions/labels/index.ts:3033`). On a seller link `from_address` is the **seller's own** ship-from. So the email tells Jones *From: Jones*, and never names the buyer or the destination. A seller with three concurrent sales cannot file it against an order.

**Defect 2 — the email is the only place his carrier tracking number is selectable text.** This is the sharpest finding in the whole review, because pasting that number into eBay is what marks the order shipped and releases payout. Verified surface by surface:

| Surface | Carrier tracking # | Evidence |
|---|---|---|
| `/t/<code>` pre-dropoff (Jones's exact state) | **hidden** | `DetailsCard.tsx:75` gates on `family === 2`; `TrackingPage.tsx:792` renders `family={1}` for pre-dropoff |
| `/t/<code>/print` | **absent** | zero hits for `tracking_number` in `LabelPrintPage.tsx` |
| Dashboard desktop | hover tooltip only | `Dashboard.tsx:1002` `title={...}` — not selectable, invisible on touch |
| Dashboard mobile | **absent** | `Dashboard.tsx:1065-1073` renders no `title` |
| Copy button anywhere | **none exists** | `DetailsCard.tsx:76` is a bare `<span>` |
| **The email** | **present** | `email-templates.ts:163` — but at `font-size:11px; color:GRAY_400`, the faintest text in the message, under a 22px bold SendMo code no marketplace accepts |

The `family === 2` gate is defensible on its own terms — the comment says F1 hides it because the carrier page would 404 before first scan. The bug is that we then hide it *everywhere else too*.

**Files**

- `supabase/functions/_shared/email-templates.ts` — lift `summaryRow` (currently local, `:136`) to module scope; add route (From → To as **city/state**), service level, and parcel (weight · dims) rows to `labelConfirmationEmail` and `senderLabelReadyEmail`; on the seller variant replace the self-referential From with the buyer name + destination; promote the carrier tracking number to primary weight.
- `supabase/functions/labels/index.ts` — extend `labelCreatedCtx` (`~:3027-3045`) with the fields. All are already in scope at the call site.
- `src/components/tracking/DetailsCard.tsx` — surface the tracking number pre-dropoff with a copy button, worded so it is clearly "not scanned yet."
- `tests/unit/emailTemplates.test.ts` — extend.

**Privacy position — city/state, not street.** `supabase/functions/tracking/index.ts:782-789` deliberately emits only `from_city`/`from_state`/`to_city`/`to_state` to **every** viewer role including the payer. Street addresses are never denormalized out. Email is a weaker, forwardable channel than an authenticated page, so it gets the same grade, not a looser one. The full street address stays where it belongs — on the label itself. Including the **buyer's name** in the seller's email is parity, not new exposure: `Dashboard.tsx:900` already shows the seller `buyer <email>`.

**Do not reuse the admin renderer.** A complete shipment-record renderer already exists and already fires on every label — to John. `buildLabelCreatedNoticeRows` (`supabase/functions/_shared/label-notice.ts:115-175`) renders full From/To addresses, parcel, carrier, service, ETA and codes. **It also carries EasyPost cost, estimated Stripe fee, net margin, sender IP, and the PaymentIntent id.** Sending that to a customer would be a serious incident. Share the *data* (`labelCreatedCtx` already is that), never the renderer.

**Two traps.**
1. `labels/index.ts:3069-3106` calls `labelConfirmationEmail` **directly** on the contacts-insert-failure path, bypassing the dispatcher. Update both call sites or the degraded path keeps sending the old email silently.
2. `senderLabelReadyEmail` hand-rolls its rows rather than using `summaryRow`, which is why the helper has to be lifted first.

**Not proposed: attaching the label PDF.** `_shared/resend.ts:38-43` posts exactly `{from, to, subject, html}` — no `attachments` key anywhere in `supabase/functions/`. Resend supports attachments, so this is a real option, but it is a separate decision with size and deliverability consequences. See §7 Q3. Note `WISHLIST.md:77` — the original seller-link entry promised *"label PDF delivered to seller (email + their dashboard)"* and it was never built.

**Also not proposed: a post-purchase "we emailed you" line on the tracking page.** It does not reach the seller. On a seller link the **buyer** is the one redirected to `?fresh=1`, and the celebration flag is only read inside the payer branch. Setting the seller's expectation means the email subject doing the work, not a page he never visits.

### W4 — UPS label distortion fix (S, bug)

**Measured, not inferred.** I pulled Jones's actual label from `shipments.label_url` and decoded the pixels:

```
image        : 800 x 1400
implied dpi  : 200            (width / 4.00in)
full height  : 7.00 in
last ink row : 1199  → ink ends at exactly 6.00 in
blank tail   : 200 rows = exactly 1.00 in
```

USPS labels are 1200×1800 @300dpi = 4.00 × 6.00in, ink edge to edge.

`LabelPrintPage.tsx:167` sets `width: 4in; height: 6in` on the `<img>` with **no `object-fit` anywhere in `src/`** (grepped — zero hits), so CSS default `fill` applies: x-scale 1.000, y-scale 0.857. **14.3% non-uniform vertical compression on every UPS label.** All three presets inherit it — `:176` rotates the already-squashed box, `:186` forces aspect 1.5.

**The decided proposal got this wrong, and it matters.** `proposals/2026-07-17_label-print-page.md:36` asserts *"1200×1800 px = exactly 4″ × 6″ portrait at 300 dpi … This holds across carriers (USPS GroundAdvantage and **UPSDAP Ground** samples all `.png`)."* The `.png` half is true; the dimensions half was false when written — the UPSDAP Ground sample it cites was bought 2026-07-05, twelve days earlier, and is 800×1400. `LOG.md:2555` shows how: browser verification was done on a USPS label and generalised. The same false claim is copied into the code comment at `LabelPrintPage.tsx:17-19`.

Per the protocol, this is **drift from a decided proposal**, not a new discovery. Framing: *restoring the 2026-07-17 spec's intent ("the carrier label untouched") for carriers whose labels are not 4:6.*

**Fix.** On `<img onLoad>` read `naturalWidth`/`naturalHeight` — this works cross-origin with no CORS (CORS gates canvas pixel reads and `fetch()`, not intrinsic dimensions or printing; the 2026-07-17 proposal establishes this at `:37`). Every carrier label in the book is 4.00in wide, so `labelH = 4 * (naturalHeight / naturalWidth)`. Render the image at its true height inside a `overflow: hidden` window, anchored top-left, so the blank tail is hidden rather than the image squashed. Downstream presets then all operate on a uniform, undistorted 4×6.

**Three things the adversarial pass caught that the implementation must handle:**

1. **The trim must be content-derived, not a hardcoded inch.** Only Jones's Groundsaver label has pure white below row 1200. The three UPS **Ground** labels in prod each carry two rows of solid black at rows 1200-1201 — an 800px-wide border rule — with white starting only at 1202. A blind 1-inch trim clips that border.
2. **The `half` preset's crop axis is not obvious.** `transform: rotate(90deg)` currently sits on the `<img>` itself (`:176`). An unrotated `overflow:hidden` window would clip the **side** of a rotated label, not the tail. The rotation must move to the wrapper, or the window must rotate with it.
3. **`full` needs a fourth `.item-desc` rule** or the Contents block prints over a full-bleed label.

**Files:** `src/pages/LabelPrintPage.tsx` (the `PRESETS` array, the three `sheet-*` img rules, a new `onLoad` handler and CSS custom properties), plus the stale comment at `:17-19`. Correct `proposals/2026-07-17_label-print-page.md:36` with a dated drift note.

**Separate, pre-existing, and NOT fixed here:** the **Full page** preset is a live compliance breach. At 6.667/4 = 166.7% every legal source X-dimension exceeds USPS DMM 204's **0.021in maximum** (it is a two-sided bound, not a floor), and UPS's fixed-size MaxiCode prints at ~1.85in against a ~1.11in nominal. We should not ship copy steering sellers toward it. Flagging for a decision (§7 Q4), not silently fixing.

### W5 — Carrier constraint on `/sell` (M, needs John)

**What is true.** The constraint works end to end. `rates/index.ts:245` reads `link.preferred_carrier` and the shared predicate filters on it. A working three-chip picker exists in `FlexPreferencesForm.tsx:301-318`.

**What is wrong.** `SellerBuilder.tsx:229` hardcodes `preferred_carrier: "any"`, under the comment *"No constraint UI (removed 2026-08-29): the buyer picks freely."* That removal is PR #131, commit `735f070` — **12 days before Jones shipped.**

Production confirms the consequence: **0 of 7 seller links carry a carrier constraint; 2 of 27 flexible links do.**

**The schema limit.** `preferred_carrier` is a single `TEXT` column and the filter is exact equality. Restoring the old single-select chips gives Jones USPS *or* UPS, never both — which is not what he asked for. A comma-separated list in the existing column solves it with **no migration**, because `rateDisplayFilterReason` is the one place that interprets the value.

**Proposed control.** Three checkboxes on `/sell`, framed as the seller's real constraint rather than a preference: *"Which carriers can you drop off at?"* All three checked by default, which writes `null` and behaves exactly as today.

**Why the framing matters.** The product already agrees that carrier = drop-off burden — `dropOffCopy` (`src/components/sender/senderState.ts:183-212`) carries bespoke per-carrier drop-off instructions and store-locator links for USPS and UPS. It just tells the seller after the buyer has already chosen.

**This reverses a deliberate call John made.** It needs his sign-off, not a reviewer's. See §7 Q1.

---

## 4. Test plan

| Workstream | Tests |
|---|---|
| W1 | **New** `tests/unit/rateFilters.test.ts`: assert `UPSDAP` matches `ups`, `FedExDefault` matches `fedex`, `USPS` matches `usps`, and a genuine mismatch still returns `carrier_filtered`. Use the **real** EasyPost strings, not synthetic ones — that substitution is why this bug shipped. |
| W2 | Unit: the who-pays choice routes to `/onboarding` (not a deep URL). Manual: signed-out path still hits the sign-in wall correctly. |
| W3 | Extend `tests/unit/emailTemplates.test.ts`: seller variant never renders the seller's own name in a From-like row; city/state only, no street; tracking number present and prominent. Extend the notifications test for the **degraded direct-send path** (`labels/index.ts:3069-3106`) — that is the trap. |
| W4 | Geometry unit tests need `naturalWidth`/`naturalHeight` stubbed — jsdom never loads images, so `onLoad` never fires. There is no precedent in the repo for this, so budget for it: `Object.defineProperty` on the img plus a manual `load` dispatch. **Playwright is the better layer here** — see §6. |
| W5 | Unit: comma-separated `preferred_carrier` filters to the union. Integration: a two-carrier link returns rates from both. |

**The honest gap:** no unit test can prove a barcode scans. W4's real verification is physical (§6).

---

## 5. Out of scope

- `funder='seller'` — the dormant column stays dormant. Separate proposal (see W2).
- Buy-time carrier re-check in `labels/` (`WISHLIST.md:187`, seller-link F5). Cross-linked, not fixed.
- Attaching the label PDF to the email — decision first (§7 Q3).
- Fixing the Full-page preset's over-scale — flagged (§7 Q4), not fixed.
- Any repeat-sale / duplicate-link flow. Real gap (origin starts empty, single-use closes the link, no duplicate action exists) but it is its own proposal.
- Requesting a different `label_size` from EasyPost at buy time. `label_size` is a **shipment-create** option, not a buy parameter, so it would have to be chosen before the buyer has paid. Post-purchase conversion via `GET /shipments/:id/label` exists and our labels are all PNG (the only convertible format), but neither is needed once W4 lands.

---

## 6. Verification

Per PLAYBOOK Rule 19, browser-verify before the LOG entry.

1. **W1** — create a flexible link constrained to `ups`, activate it, open it as a buyer. Rates appear. Repeat for `fedex`. Before the fix both return zero options.
2. **W3** — buy a test-mode seller-link label. Confirm the seller's email names the **buyer** and destination city/state, shows service level and parcel, and carries the tracking number prominently. Force the contacts-insert failure path and confirm the degraded email is also correct.
3. **W4 — the one that needs a physical printer.** Print a real UPS label and a real USPS label at each of the three presets. Measure the printed label with a ruler: the UPS label must measure 4.00 × 6.00in with no vertical compression. **Then scan every barcode with a phone scanner app**, including the MaxiCode. This is the only proof that matters and it cannot be automated. Blocks the W4 LOG entry.
4. **W5** — create a seller link restricted to USPS + UPS, open as a buyer, confirm both carriers appear and FedEx does not.

---

## 7. Open questions

**Q1 — Does the carrier control come back to `/sell`? (John's call, not the reviewer's.)**
Restoring it reverses PR #131, a deliberate simplification made 2026-08-29. My recommendation is **yes, restore it**, for three reasons: the drop-off burden is the seller's alone; prod shows 0/7 seller links carry a constraint because nobody *can*; and the first real seller asked for it within 12 days. The counter-argument is real — you removed it to keep `/sell` short, and three checkboxes is a step backward on that axis. Middle option: put it behind the same collapsed "Show optional settings" disclosure the flex form already uses, so the default path stays short.

**Q2 — Ask Jones two questions before building W4?**
"Did you print from the tracking page or from a downloaded file?" and "do you own a thermal label printer?" His answers fork W4 cleanly: if he used Download, the fix is the download path and a signpost, not presets. One message, and it de-risks the most expensive workstream. **Recommend asking before W4 starts.** W1/W2/W3 do not depend on the answer.

**Q3 — Should the label PDF be attached to the email?**
`WISHLIST.md:77` promised it and it was never built. Resend supports attachments; `sendEmail` does not. It would make the email a genuinely self-contained record and would matter most for a seller on a phone who wants to print later on a computer. Costs: email size, deliverability, and a new code path on the money flow. My recommendation is **not in this batch** — ship W3's enrichment first and see whether Jones still wants the file.

**Q4 — What do we do about the Full-page preset over-scaling barcodes?**
It is pre-existing and not introduced by anything here, but W4 touches the same code and it would be dishonest to ship a fix that blesses it. Options: (a) leave it and say nothing, (b) cap the enlargement at a compliant scale, (c) remove the preset. My recommendation is **(b)** — keep the option for legibility, cap it where DMM 204's 0.021in ceiling puts it.

**Q5 — For the reviewer specifically.** The three-way split in W4 (fix distortion / signpost the print page / fix the Download path) is where I am least confident. I have argued Jones hit the Download path, on the evidence that no print event exists for his shipment. That is strong but circumstantial — the event only fires from the SendMo print page, so its absence proves he did not use that page, not what he did instead. If you read the evidence differently, say so; it changes which of the three we build first.

---

## Reconciliation with prior decided proposals

- **`2026-07-17_label-print-page.md` (decided).** W4 is drift from it, not a new finding. Its §36 dimensional claim is false for UPS; its intent ("the carrier label untouched") is what W4 restores. The file needs a dated drift note.
- **`2026-07-17_seller-link-buyer-pays.md` (decided).** W2 explicitly does **not** reopen the buyer-pays decision. It signposts the existing seller-pays lane; it does not make seller-funded checkout links.
- **`2026-08-28_seller-link-launch_…_decided-2026-08-29.md` (decided, built).** W5 reverses one narrow piece of the builder simplification that landed in that arc (PR #131). Named explicitly so the reversal is a decision, not an accident.
- **`WISHLIST.md:187` (seller-link F5)** — buy-time carrier gate. W1 fixes the display filter only; F5 remains open and is cross-linked in both directions.
- **`WISHLIST.md:77`** — the unbuilt "label PDF to seller by email" promise. Surfaced in §7 Q3.
