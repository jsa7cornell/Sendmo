---
title: Jones's seller feedback — four asks, three already built, two live bugs
slug: jones-seller-feedback
project: sendmo
status: reviewed
blocked_on: null
created: 2026-09-14
last_updated: 2026-09-14  # fresh-eyes review posted (five lenses, each cross-checked, consolidated into one Review section per protocol); awaiting author response
reviewed: 2026-09-14
decided: null
pr: null
author: Claude Opus 5 — drafted from John's request to act on Jones Anderson's post-sale feedback (received 2026-09-11 over WhatsApp). Grounded against production (read-only queries against fkxykvzsqdjzhurntgah, plus a pixel decode of Jones's actual label PNG) and a worktree at origin/main (HEAD df30c08, 0 behind). Two multi-agent passes — a four-item investigation with per-item adversarial verification, and a focused label-sizing pass with three adversarial lenses (compliance, code, product). The adversarial passes killed two of the author's own framings; both corrections are recorded in §1.
reviewer: Fresh Claude (Opus 5) session — loaded cold, five parallel lenses (factual verification, prior art, product/market, implementation risk, inference chain). Each lens's findings were then independently cross-checked by a sixth pass before inclusion; findings that failed cross-check were dropped. Reviewers re-decoded all seven live label PNGs, re-curled the S3 CORS headers, re-ran every prod query read-only, and read the decided 2026-07-17 and 2026-08-28 proposals in full.
outcome: approve-with-changes
---

> **What this is in one line:** A real seller used SendMo for a real eBay sale and asked for four things. Three of them already exist and the seller lane simply never offered them to him; the fourth is a wish we cannot honour literally. Along the way we found two live bugs, one of which silently distorts every UPS label.

---

## 0. Read this part first

Two findings here are independent of everything else in this proposal and stand on their own merits:

1. **Every UPS label printed *from the print page* comes out distorted.** It forces a 4×7 UPS label into a 4in × 6in box with no `object-fit`, so CSS default `fill` compresses it 14.3% vertically. UPS labels carry a MaxiCode — a fixed-geometry 2D symbol with no tolerance for non-uniform distortion. Roughly half of all live SendMo labels are UPS (4 of 7). **Nobody has reported a scan failure, I have not print-and-scan tested it, and — confirmed 2026-09-14 — Jones did not hit it** (he printed from Download, which bypasses that CSS entirely). The geometry is measured, not inferred; the user impact is currently theoretical. Fix it on its own merits, not as a response to this feedback.

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

### The finding that actually explains #2 — confirmed by John, 2026-09-14

**Jones never opened the print page, and he printed from Download on a plain home printer.**

The code evidence: production has exactly **4** `label.printed` events, ever; the most recent is 2026-07-18, well before his 2026-09-10 sale. So he never saw the three-preset size picker.

**John confirmed the rest directly: Jones does not own a thermal printer, and was printing from the downloaded file.** That closes the one gap the code could not close — the absence of a print event proves he did not use the print page, not what he did instead.

So his actual path was **Download**, the button sitting right next to Print. `handleDownloadClick` (`src/pages/TrackingPage.tsx:310-327`) calls `fetch(labelUrl)` against a no-CORS S3 URL. That throws. The `catch` falls through to `window.open(labelUrl)` — which dumps a raw 800×1400 PNG into a browser tab. From there his only sizing control was the browser's print dialog, which by default scales a lone image to fit the sheet. An 800×1400 image fitted to Letter portrait prints at roughly **6.3 × 11in** — not 4×6, and far *larger* than the package needs.

*"It made lable easy to re size"* is a plain description of that experience, and John's clarification — *"so it fits on smal/medium/large sized packages"* — is what you ask for after a label prints the size of the page.

> **The implication that re-scopes W4: Jones never experienced the distortion bug.** The 14.3% squash lives in the print page's CSS. He never loaded that page, so the PNG he printed was geometrically correct — just enormous. The distortion is still real and still worth fixing (§0.1), but it is **not** the cause of his complaint, and fixing it would not have changed his day. W4 is therefore split: the thing that fixes Jones is the Download path, and the distortion fix rides along as an independent bug.

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
                          ──► browser scales it to fill Letter  (CONFIRMED path)
```

---

## 2. Architecture

Five workstreams. Each is independently shippable; none blocks another. They are ordered by value-to-effort, not by dependency.

| # | Workstream | Kind | Effort | Needs John? |
|---|---|---|---|---|
| **W1** | Carrier matcher fix | Bug | XS | No |
| **W2** | Seller-pays signpost on `/sell` | Copy + routing | XS→S | Yes, for the full version |
| **W3** | Label email becomes a real shipment record | Feature | S | No |
| **W4a** | Download lands on the print page + signpost | Bug + copy | S | Pick an option (§7 Q2) |
| **W4b** | UPS label distortion fix | Bug | S | No |
| **W5** | Carrier constraint control on `/sell` | Feature | M | **Yes — reverses a 2026-08-29 call** |

The unifying idea: **stop hiding capabilities the seller already paid for.** Four of the five are about exposure and correctness, not new capability. Only W5 adds a control, and even that restores one that existed until three weeks ago.

### Why these five and not a "seller dashboard" rebuild

Every workstream here extends something that already exists:

- W1 mirrors `normalizeCarrier` (`src/components/sender/senderState.ts:124-131`), which already handles `UPSDAP` and `FedExDefault` correctly via `.includes()`.
- W2 changes one string and one route.
- W3 extends `summaryRow` (`email-templates.ts:136`) and `labelCreatedCtx` — the context object already built at the call site.
- W4a re-points an existing button at an existing page. W4b extends the existing `Preset` / `PRESETS` / `sheet-${preset}` scheme (`LabelPrintPage.tsx:21-28`, `:166-203`).
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

### W4 — The printing path (S) — split into W4a and W4b

John's 2026-09-14 confirmation (Jones printed from Download, no thermal printer) splits this cleanly. **W4a is what fixes Jones. W4b is an independent bug he never hit.** They touch different files and should be separate PRs.

#### W4a — Make Download land somewhere printable (S) — *this is the one that answers Jones*

**The failure.** `src/pages/TrackingPage.tsx:310-327`:

```ts
const res = await fetch(labelUrl);        // no-CORS S3 URL → throws
...
} catch {
  window.open(labelUrl, "_blank", ...);   // raw 800×1400 PNG in a tab
}
```

The `fetch` **always** throws for these labels. Verified 2026-09-14 against Jones's live label URL: a request carrying `Origin: https://sendmo.co` returns `200 OK` with **no** `Access-Control-Allow-Origin` header at all, so the browser blocks the read. This is the same fact the decided 2026-07-17 proposal established at `:37` as the reason the print page uses an `<img>` rather than `fetch`. So the `catch` is not an edge case; **it is the only path Download ever takes.** The `a.download` branch above it is dead code for every real label.

The seller then prints a bare image from the browser, which scales it to fit the sheet. That is the whole of Jones's complaint.

**Fix — pick one (see §7 Q2, now reframed).** My recommendation is (a):

- **(a) Point Download at the print page.** Replace the Download button's handler with navigation to `/t/<code>/print`, or relabel the pair so one button reads something like "Print or save label" and both land on the print page. The print page already solves sizing with three presets and already logs `label.printed`. This is a handful of lines and it puts every seller on the surface that was built for this.
- **(b) Keep a true download but make it work.** Proxy the label through an edge function so `fetch` succeeds and `a.download` fires, giving a real saved file. More code, a new endpoint, and it still hands the seller a bare PNG to print badly.
- **(c) Do both** — (a) for the button, (b) later if sellers ask for an actual file.

**Files:** `src/pages/TrackingPage.tsx` (the button pair at `:454-497` and `handleDownloadClick` at `:310-327`). Possibly `src/components/tracking/HowToShipStrip.tsx` for a line of guidance.

**Also in W4a — the signpost.** The route to the size picker is a button reading only `Print` (`TrackingPage.tsx:483`). The words "size", "resize", "layout" and "paper" appear nowhere on the tracking page. And the print page's own tips card says *"Paper size **Letter**, portrait. Any printer works — no label printer needed"* — fine for Jones, who has no thermal printer, but it reads as "there is nothing to choose here." Lead the preset names with the physical outcome instead of the format name. Zero print-behavior change, no printer required to verify.

#### W4b — UPS label distortion fix (S, independent bug)

**Not the cause of Jones's complaint** — he never loaded this page. Fix it because it is wrong, not because he asked.

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
| W4a | Playwright: from a pre-dropoff tracking page, the Download/print affordance lands on `/t/<code>/print` (not a raw S3 tab) and a `label.printed` event is logged. Unit: the dead `a.download` branch is gone or genuinely reachable. |
| W4b | Geometry unit tests need `naturalWidth`/`naturalHeight` stubbed — jsdom never loads images, so `onLoad` never fires. There is no precedent in the repo for this, so budget for it: `Object.defineProperty` on the img plus a manual `load` dispatch. **Playwright is the better layer here** — see §6. |
| W5 | Unit: comma-separated `preferred_carrier` filters to the union. Integration: a two-carrier link returns rates from both. |

**The honest gap:** no unit test can prove a barcode scans. W4's real verification is physical (§6).

---

## 5. Out of scope

- `funder='seller'` — the dormant column stays dormant. Separate proposal (see W2).
- Buy-time carrier re-check in `labels/` (`WISHLIST.md:187`, seller-link F5). Cross-linked, not fixed.
- Attaching the label PDF to the email — decision first (§7 Q3).
- Fixing the Full-page preset's over-scale — flagged (§7 Q4), not fixed.
- A 4×6 thermal-roll preset (`@page { size: 4in 6in }`). Dropped 2026-09-14: Jones has no thermal printer, so it helps nobody we know of yet. Revisit when a seller with one asks.
- Any repeat-sale / duplicate-link flow. Real gap (origin starts empty, single-use closes the link, no duplicate action exists) but it is its own proposal.
- Requesting a different `label_size` from EasyPost at buy time. `label_size` is a **shipment-create** option, not a buy parameter, so it would have to be chosen before the buyer has paid. Post-purchase conversion via `GET /shipments/:id/label` exists and our labels are all PNG (the only convertible format), but neither is needed once W4 lands.

---

## 6. Verification

Per PLAYBOOK Rule 19, browser-verify before the LOG entry.

1. **W1** — create a flexible link constrained to `ups`, activate it, open it as a buyer. Rates appear. Repeat for `fedex`. Before the fix both return zero options.
2. **W3** — buy a test-mode seller-link label. Confirm the seller's email names the **buyer** and destination city/state, shows service level and parcel, and carries the tracking number prominently. Force the contacts-insert failure path and confirm the degraded email is also correct.
3. **W4a — reproduce Jones's exact path first.** On a real pre-dropoff tracking page, click Download as it exists today and confirm it opens a raw PNG in a tab (this is the bug). Then print that tab to Letter and measure what comes out — that is the artifact Jones was holding. After the fix, the same click lands on `/t/<code>/print` with the presets visible. No special printer needed.
4. **W4b — the one that needs a physical printer.** Print a real UPS label and a real USPS label at each of the three presets. Measure the printed label with a ruler: the UPS label must measure 4.00 × 6.00in with no vertical compression. **Then scan every barcode with a phone scanner app**, including the MaxiCode. This is the only proof that matters and it cannot be automated. Blocks the W4 LOG entry.
5. **W5** — create a seller link restricted to USPS + UPS, open as a buyer, confirm both carriers appear and FedEx does not.

---

## 7. Open questions

**Q1 — Does the carrier control come back to `/sell`? (John's call, not the reviewer's.)**
Restoring it reverses PR #131, a deliberate simplification made 2026-08-29. My recommendation is **yes, restore it**, for three reasons: the drop-off burden is the seller's alone; prod shows 0/7 seller links carry a constraint because nobody *can*; and the first real seller asked for it within 12 days. The counter-argument is real — you removed it to keep `/sell` short, and three checkboxes is a step backward on that axis. Middle option: put it behind the same collapsed "Show optional settings" disclosure the flex form already uses, so the default path stays short.

**Q2 — RESOLVED 2026-09-14, and it changed the plan.** John confirmed: Jones has no thermal printer and printed from the downloaded file. That kills the 4×6-roll preset idea outright, demotes the distortion fix from "the answer" to "an unrelated bug", and promotes the Download path to the thing that actually fixes him. What remains is a smaller choice — which of W4a's three options (a/b/c) to take. **Recommend (a)**: point Download at the print page. It is the fewest lines, it reuses a page built for exactly this, and it starts logging `label.printed` so we stop being blind to how sellers print.

**Q3 — Should the label PDF be attached to the email?**
`WISHLIST.md:77` promised it and it was never built. Resend supports attachments; `sendEmail` does not. It would make the email a genuinely self-contained record and would matter most for a seller on a phone who wants to print later on a computer. Costs: email size, deliverability, and a new code path on the money flow. My recommendation is **not in this batch** — ship W3's enrichment first and see whether Jones still wants the file.

**Q4 — What do we do about the Full-page preset over-scaling barcodes?**
It is pre-existing and not introduced by anything here, but W4 touches the same code and it would be dishonest to ship a fix that blesses it. Options: (a) leave it and say nothing, (b) cap the enlargement at a compliant scale, (c) remove the preset. My recommendation is **(b)** — keep the option for legibility, cap it where DMM 204's 0.021in ceiling puts it.

**Q5 — For the reviewer specifically.** My original open question here was whether Jones hit the Download path; John has since confirmed he did, so that is settled. What I now most want challenged is the **W4a option choice**. Option (a) removes a "Download" affordance some sellers may genuinely want (a saved file to print later, or from another device) and replaces it with navigation. If you think losing a real download is worse than the bad print it currently produces, argue for (c). I have since verified the `fetch`-always-throws claim myself, so it is no longer open: `curl -I` against Jones's live label URL, **with an `Origin: https://sendmo.co` header**, returns `HTTP/1.1 200` and **zero** `Access-Control-Allow-Origin` headers. A browser `fetch` from our origin is therefore blocked every time, the `catch` always fires, and `a.download` is dead code for every real label. Challenge it if you read that differently.

---

## Reconciliation with prior decided proposals

- **`2026-07-17_label-print-page.md` (decided).** W4 is drift from it, not a new finding. Its §36 dimensional claim is false for UPS; its intent ("the carrier label untouched") is what W4 restores. The file needs a dated drift note.
- **`2026-07-17_seller-link-buyer-pays.md` (decided).** W2 explicitly does **not** reopen the buyer-pays decision. It signposts the existing seller-pays lane; it does not make seller-funded checkout links.
- **`2026-08-28_seller-link-launch_…_decided-2026-08-29.md` (decided, built).** W5 reverses one narrow piece of the builder simplification that landed in that arc (PR #131). Named explicitly so the reversal is a decision, not an accident.
- **`WISHLIST.md:187` (seller-link F5)** — buy-time carrier gate. W1 fixes the display filter only; F5 remains open and is cross-linked in both directions.
- **`WISHLIST.md:77`** — the unbuilt "label PDF to seller by email" promise. Surfaced in §7 Q3.

---

## Review

Reviewer: Fresh Claude (Opus 5) session — loaded cold; five parallel lenses (factual verification, prior art, product/market, implementation risk, inference chain), each lens findings independently cross-checked before inclusion.
Reviewed: 2026-09-14
Verdict: approve-with-changes

### Summary

This proposal turns four lines of feedback from the first real seller into five scoped workstreams, and the verification behind it is the best I have seen in this repo — I re-decoded the label PNGs, re-curled S3, and re-ran every prod query, and the numbers reproduce to the pixel. The work itself should proceed. What must change is the paper trail and the questions put to John: two of the six questions in §7 ask him to decide things he already decided (the Download proxy on 2026-07-17, the carrier control on 2026-08-28), a third reverses a decided call without naming it, and §2's claim that the workstreams are independent is wrong three separate ways. The single most important fix: **re-anchor W4a and W5 on the decisions already in `proposals/`, so John is asked "is this still what you want?" instead of "will you reverse yourself?"** That change alone takes two items off his desk and makes the rest cheaper to read.

### Blocking

**1. W4a presents a decided, logged bug as a new finding, and its two options are the two positions John already took.**
`proposals/2026-07-17_label-print-page.md:42` states the failure verbatim — the Download handler fetches `label_url`, S3 sends no CORS headers, the fetch throws and silently falls back to `window.open`. `:18` records John's resolutions: **OQ5** — "v1 frontend-only, no download-proxy — raw-label link + browser save covers file access; proxied one-click download deferred to fast-follow" (that is W4a option b, deferred), and **OQ6** — "fold Bug A + Bug B fixes into this PR". `:110` gives the cheapest fix, which is W4a option (a). `LOG.md:2569` records the outcome: "left as raw-open for now". `git log -1 33bbdd4` plus `git show 33bbdd4 -- src/pages/TrackingPage.tsx` shows PR #54 changed only `.pdf` → `.png`; `TrackingPage.tsx:310-327` is the original handler today, dead `a.download` branch and all. The proposal cites this file at `:36` for W4b's dimensional drift and gives W4b the correct "drift, not a new finding" framing — W4a does not get it.
**Change:** rewrite W4a's opening as "OQ6 decided Bug A gets fixed in #54; only the copy half shipped, and OQ5's proxy fast-follow is now due." Name OQ5/OQ6/Bug A in Reconciliation. Collapse §7 Q2 and Q5 into one question, and say plainly what is new: field evidence of what raw-open costs a real seller. Note that "point Download at the print page" is a genuinely new third option — the print page did not exist when `:110` was written.

**2. W5 is drift-restoration, not a reversal, and the proposal asks the expensive version of the question.**
The decided `proposals/2026-08-28_seller-link-launch_reviewed-2026-08-28_decided-2026-08-29.md:245` reads: "the cap control leaves the seller builder entirely (**carrier and speed stay**)." PR #131 (`735f070`, 2026-08-29) removed carrier and speed anyway, and `LOG.md:157` records it as **"Shipping-limit control removed 'for now'"** — the commit's own words. The proposal's §2 table, W5 body, and §7 Q1 all call restoring it "reverses a deliberate call John made," which invites him to defend a position rather than confirm a parked one.
**Change:** frame W5 as restoring the `:245` spec that a same-day polish PR parked, quote the "for now," and make Q1 "was 'for now' meant to be permanent?" Also say whether **speed** comes back — the removal took both, and W5 restores only carrier. One caveat worth stating honestly: `LOG.md:151-160` is titled "John's link-type copy," so the removal may have been John-directed in session. The record does not say. That is another reason to ask the cheap question.

**3. W5's file plan points at a display prop, so the picker as specced would write nothing.**
W5 cites `SellerBuilder.tsx:229`. That line sits inside the `<LinkShareCard value={{…}}>` object at `:225-232`, rendered on the step-4 ready screen after the link already exists, under the comment "No constraint UI (removed 2026-08-29)". The create path is `handleCreate` at `:122`, whose `CreateSellerLinkParams` literal (`:128-149`) contains no `preferred_carrier` at all. The server writes NULL, and prod agrees: all 7 seller links have `preferred_carrier` NULL, not `"any"`.
**Change:** point W5 at `handleCreate` for the write and `:225-232` for the display, and say both need editing. Upside worth stating: `src/lib/api.ts:554` and `supabase/functions/links/index.ts:852` already accept and store the field, so W5 is a client-only change and is probably below M.

**4. §2's "each is independently shippable; none blocks another" is wrong three ways.**
(a) W5 depends on W1. `_shared/price-band.ts:84-88` passes `preferredCarrier` into the same broken predicate and `:89` returns null when nothing survives; `seller-band-sweep/index.ts:82` feeds it `link.preferred_carrier`. A UPS-constrained link shipped before W1 returns zero rates and a null price band. (The blast radius is smaller than it looks — `BuyerFlow.tsx:401-403` already tells the buyer it is the seller's filter, and `rates/index.ts:456` logs `rate.no_results` at warn — but the ordering claim is still false.) (b) W1 and W3 both edit `supabase/functions/_shared/`. `.github/workflows/deploy-edge-functions.yml:74-77` redeploys everything when `_shared` changes, and `ls -1 supabase/functions/ | grep -v '^_' | wc -l` = **28**; W1 is labelled XS. `WISHLIST.md:186` already flags this convention for a different `_shared` fix ("best batched"). (c) Two open PRs sit on the same files: `gh pr list` shows **#136** `claude/seller-review-band` (DIRTY) touching `SellerBuilder.tsx`, `links/index.ts`, `api.ts`, `seller-builder.spec.ts`, `SPEC.md` — W2 and W5's entire file set — and **#112** `feat/sender-intro-shipment-card` (DIRTY) touching `TrackingPage.tsx`, W4a's file. Both are DIRTY, so per `PLAYBOOK.md:355` no Actions ran on either; absence of a run is not a pass.
**Change:** replace the sentence with a real sequencing paragraph: W1 first, W5 after; batch the two `_shared` edits into one deploy; resolve or land #136 before W2/W5 touch `SellerBuilder.tsx`.

**5. W4b names a requirement its own mechanism cannot meet, and the obvious workaround takes the preview page down for everyone.**
Trap #1 is right: the trim must be content-derived. But the stated fix reads only `naturalWidth`/`naturalHeight`, which gives aspect ratio, not ink extent — and the proposal itself establishes that CORS blocks the pixel read. I re-curled all seven live labels with `-H "Origin: https://sendmo.co"`: every one returns 200 with zero `Access-Control-*` headers. So `getImageData` throws on a tainted canvas, and adding `crossOrigin="anonymous"` makes the image fail to load entirely → `onError` at `LabelPrintPage.tsx:302,305` → `imgFailed` → every user sees "We couldn't render a preview here."
**Change:** pick the resolution before implementation. The cheapest is geometry-only and needs no JS: a 4in × 6in `overflow:hidden` wrapper with `img { width: 4in; height: auto; }`. State the cost honestly — that clips at row 1200 and trims 0.010in off a 0.015in cosmetic border rule on UPS Ground. It is not a scan risk. Whatever you pick, say in W4b that `crossOrigin` is not an option and why.

**6. Reconciliation names one drifted proposal; four more govern the files these workstreams edit, and one of them W3 reverses.**
The reversal: `proposals/2026-05-13_tracking-page-ia-polish…:117` decided that "carrier tracking number is demoted to 'Tracking #' and only appears in Family 2 (where it's actionable — the carrier has scanned it)," cross-linked to the white-label `public_code` decision. `DetailsCard.tsx:75` and `TrackingPage.tsx:792` implement exactly that. W3's bullet "surface the tracking number pre-dropoff" reverses it, and the proposal engages only with the 404 rationale in the code comment, not the white-label one. The three others: `2026-06-27_label-confirmation-email-by-role…` (created the per-flow copy branch W3 edits; its OQ3/OQ4 are why the degraded direct send at `labels/index.ts:3062-3068` is exempt from the `notifications_log` guard — cite it so the next agent does not "fix" the exemption); `2026-07-06_flex-sender-visibility` and `2026-05-12_label-cancel-and-change §3.2`, both named in `_shared/notifications.ts:151-153` as the deciders of `label_created` routing; and `042_flexible_link_may_defer_destination.sql:4-6`, which names the 2026-08-18 unified-onboarding "decision B" that W2 builds on.
**Change:** add all four to Reconciliation, and put the tracking-number question to John as a reversal of a decided call, not as a gap.

### Non-blocking

**1. The print-event evidence proves less than §1 claims — and the stronger version is free.**
`logLabelPrint` has exactly two call sites: `LabelPrintPage.tsx:128` (inside `handlePrint`, right before `window.print()` at `:135`) and `:356` (the raw-label link). Neither fires on page load, and there is no print-page view event. So zero events proves Jones never completed a print action, not that he never loaded the page; §1's "proves he did not use the print page" overstates it. The better claim needs no assumption about any user: I pulled all four `label.printed` rows from prod — 2026-05-24, 2026-06-28, and two on **2026-07-18 05:39/05:40Z**. The print page merged at `2026-07-17T23:29:43-07:00` = **06:29:43Z**, 49 minutes *after* the last event, and `LOG.md:2550` records the #54 build was rate-limited on top of that. The two older rows carry `"actor":"admin"` with John's own `user_id`. **The deployed print page has logged zero prints, ever.** Adopt that; drop the Jones-specific inference.

**2. The "did the email land?" question is answerable today, without texting John or Jones.** `notifications_log` has no delivered/opened/bounced columns, so `status='sent'` cannot tell W3's premise from "he never saw it." But both `label_created` rows for K1ZQ9FR have `provider_id` populated — those are Resend message ids, and Resend carries per-message delivery and open state. Check Resend first; the text to John is the fallback.

**3. W4a's relabel option silently neuters two e2e guards.** `tests/e2e/tracking-lifecycle-states.spec.ts:138` is `getByRole("link", { name: /^print$/i })` and `:248-250` is the anchored `/^print$/i` pair asserting `.not.toBeVisible()` on the cancelled state. Both are anchored, so any relabel ("Print or save label") makes them match nothing and pass vacuously — including a PR9 guard that exists to prove a buyer never sees the seller's home-address label. `:105-111` goes red only if the word "Download" disappears. Add a test-plan line naming both specs.

**4. W5's "`rateDisplayFilterReason` is the one place that interprets the value" is false, and one consequence is visible on day one.** `LinkShareCard.tsx:96-99` does a bare `.toUpperCase()` and `:166-167` renders it, so a comma value shows the seller `· USPS,UPS` on their own ready screen. `links/index.ts` normalizes `"any"` → NULL in three separate places (`:852`, `:886`, `:1089`) with no value whitelist anywhere, so a comma list stores verbatim. Ignore the `SenderPreview` and `LinksEdit` paths — the first is a mock page (`App.tsx:110`, hardcoded `MOCK_LINK`), and the second is closed for seller links at two layers (`LinksEdit.tsx:64-70` returns early, `links/index.ts:1197` rejects non-flexible PATCH). Add a `parseCarriers` helper and name the display site. While you are there: `WISHLIST.md:187` (seller-link F5) prescribes `rate.carrier !== resolvedLink.preferred_carrier`, the same raw-string compare W1 fixes — W1 should export the normalizer and F5 should be told to use it.

**5. W3's edit to `senderLabelReadyEmail` reaches the anonymous buyer, not the seller.** `_shared/notifications.ts:73-88` routes `label_created` + `is_flex` + `role === "sender"` to that function, and `:34-40` documents that on a seller link the `sender` contact **is the buyer**. So the seller's ship-from city/state and parcel dims land in a stranger's inbox. That is almost certainly fine — `BuyerFlow.tsx:283-302` already shows the buyer "Ships from {city, ST}" and the package line — so this is a paragraph W3 should write, not a risk to mitigate. The mechanical half matters more: Defect 1's fix is written against `labelConfirmationEmail`'s `variant` enum (`email-templates.ts:92`), but `senderLabelReadyEmail` is a different function keyed on a `sellerLink` boolean. An implementer will look for a seller variant there and not find one.

**6. `SPEC.md:806` carries both false claims and is in neither file list.** It reads: "**Download**: saves the label file as `sendmo-<code>.png` (the carrier label is a **PNG**, 4x6 portrait @300dpi…)". Download does not save a file (W4a's bug) and 4x6@300dpi is the claim W4b corrects. `CLAUDE.md` routes every agent to SPEC second. Add `SPEC.md` to both file lists.

**7. Two more reasons point at the proxy, which strengthens W4a option (c).** `WISHLIST.md:23` already asks for a signed/expiring label URL instead of a public EasyPost one — same edge function as OQ5's proxy. And the URLs expire: `curl -I` on Jones's label returns `x-amz-expiration: expiry-date="Wed, 10 Mar 2027", rule-id="expire-postage_label"`, roughly six months after purchase. That bears on §7 Q3 (an attachment gains permanence the link loses) and on the proxy itself (it will 404 on expired objects). Two separately-filed reasons converging on one edge function is a better argument for (c) than "sellers want a file."

**8. Three geometry corrections.** The UPS Ground border is **three** rows, not two: on all three prod Ground labels rows 1199, 1200 and 1201 are each 800/800 dark and white starts at 1202, so ink ends at 6.01in and the blank tail is 198 rows (Jones's own label ends at 1199, exactly 6.00in, 200-row tail). And the carrier book holds **three** pixel geometries, not two: FedEx SMART_POST labels are 800×1200. The right generalization for W4b is "every label is 4in wide, DPI varies, and only UPS carries a blank tail" — not "UPS vs USPS at 300dpi."

**9. W4b trap #3 is already handled.** `LabelPrintPage.tsx:203` is `.sheet-full .item-desc { display: none; }`, one of three per-preset rules at `:201-203`, with the comment at `:188-190` saying why. "Full needs a fourth `.item-desc` rule" sends an implementer hunting a bug that does not exist.

**10. Sellers see raw EasyPost carrier strings, and the proposal never says so.** `carrierDisplayName` (which maps `UPSDAP` → `UPS`, `src/lib/utils.ts`) exists only in `src/` — `grep -rn "carrierDisplayName" supabase/functions/` returns **0**. `_shared/email-templates.ts:164` interpolates `${carrier}` raw, which is why Jones's email said `UPSDAP #1Z…`. And `HowToShipStrip.tsx:17-18` builds "Most UPSDAP locations accept drop-offs until late afternoon" from `data.carrier` passed through unnormalized at `TrackingPage.tsx:786`. Two specific sites, small fix: normalize into the strip, and port `CARRIER_NAMES` into `_shared/`. This is seller-facing polish on the exact surfaces W3 already edits.

**11. W2's "I'll pay" route lands in the wrong lane.** `App.tsx:41-44` — `OnboardingEntry` runs `clearFlow()` then navigates to `/onboarding/full-label/destination`, whose first question is the buyer's address, which a seller writing a listing does not have. The implementation note is right that only `OnboardingEntry` clears state; the answer is a path parameter on it, not the full-prepaid lane. Also cross-link `2026-07-17_seller-link-buyer-pays…:35,:211`, which decided that the established-marketplace seller needs the deferred seller-pays tool with order import — that is Jones's ask, and `/onboarding` is not it.

**12. Put the /sell page length to John as one question, not two.** `LOG.md` has three consecutive 2026-08-29 entries trimming step 1 (hero gone, How-it-works card gone, title and intro only on step 1, Buyer-pays chip removed), and `LOG.md:64` adds "use WhoPaysChip for any future chip surface instead of re-inlining." W2-full adds a two-card who-pays choice to step 1 and W5 adds carrier checkboxes to the same page; PR #136 adds a review-step estimate on top. Q1's middle option — a collapsed "Show optional settings" disclosure — is the right instinct and should cover W2 as well. Worth noting the decided `2026-07-17_seller-link-buyer-pays…:195` already specified `FlexPreferencesForm` as the "optional advanced" carrier constraint, which is that same answer.

**13. Two behavioural facts in Jones's own account that the proposal never looks at.** He created two seller links 55 seconds apart (`AmLCs8yLeU` at 15:58:36, `2CDhMhga6f` at 15:59:31; the shipment hangs off the second), and **both are still `status='active'` with `max_shipments` NULL** — so an abandoned duplicate link is live and purchasable for an item he already sold. That also contradicts §5's parenthetical that single-use closes the link; neither of his is single-use. And K1ZQ9FR is still `label_created` four days on with no carrier scan — we do not actually know his label worked.

**14. Add the `can_print` gate to the print page while you are in the file.** `LabelPrintPage.tsx:114` fetches the same `tracking?code=` endpoint that already computes `can_print` (`tracking/index.ts:714`), but `PrintData` (`:40-47`) does not declare it and the page gates only on `label_url` (`:250`). Three lines, and it mirrors a gate that already exists.

**15. §6.4 is the first time anyone will hold a real label — collect the debts.** `LOG.md:2575` still owes the physical print-and-scan acceptance for the half-sheet from 2026-07-17, and it was never discharged. `WISHLIST.md:200` asks whether EasyPost `reference = <link UUID>` actually prints on a seller's label. Both are free at that moment.

### Nits

- `email-templates.ts:163` should be `:164` — `:163` is the 22px SendMo code, `:164` is the 11px carrier line.
- `tracking/index.ts:782-789` should be `782-785`; `786-787` are `print_count` / `last_printed_at`.
- The §1 diagram says "GAP A: 5 rows"; six render for Jones, and §W3 itself lists six.
- §W3 calls the row "Amount"; `email-templates.ts:149` relabels it "Shipping paid by buyer" on the seller variant.
- The `LinkShareCard.tsx:70` quote drops the trailing "I'll get it in the mail." That clause cuts against the "seller is passive" reading, so it is not a neutral trim.
- `DetailsCard.tsx:75` also gates on `!data.is_test`. It will not hide the tracking number from real sellers (two of three seller-link sales are live, Jones's included) — it will hide it from you during test-mode verification.
- `LOG.md:2555` was correct at the `df30c08` in the frontmatter; the proposal's own LOG commit pushed it to `2574`. Re-anchor the number, do not replace the citation.
- Frontmatter says HEAD `df30c08`; it is now `fe815ff`.
- `SellerBuilder.tsx:228` hardcodes `speed_preference: "standard"` and `LinkShareCard.tsx:166` renders it capitalized, so every seller's ready screen reads "Standard" for a link whose stored `preferred_speed` is NULL. Free to fix while W2/W5 are in that file.
- `ShipmentLabelSection.tsx` is a second, dead Download surface with a live unit test — nothing renders it.
- W2's "I'd rather pay for shipping myself" departs from the decided naming lane (`LOG.md:60`: "Label link" / "Checkout link"). Fine either way; make the departure deliberate.
- `WISHLIST.md:77` sits inside an entry that opens "⚠️ SUPERSEDED 2026-07-17 … Read the proposal, not this entry" (`:74`). Cite `2026-07-17_seller-link-buyer-pays…:87,:197,:200` instead.
- W1's case is stronger than the proposal makes it: `_shared/rate-filters.ts:19-20` already hedges `SERVICE_DENYLIST` for both FedEx spellings, 40 lines above the broken compare at `:59`. The file already knows EasyPost returns vendor-suffixed carrier ids. That makes W1 an extension of an existing pattern, not a new construct (rule 6).

### What the proposal got right

- **Every code citation holds.** I opened them cold: `rate-filters.ts:51,58-59`, `price-band.ts:84-89`, `seller-band-sweep/index.ts:82`, `TrackingPage.tsx:310-327`, `SellerBuilder.tsx:225-232`, `LabelPrintPage.tsx:167,176,186,203`, `DetailsCard.tsx:75`, `label-notice.ts`, `links/index.ts:842,852`. Both negatives reproduce: `grep -rn "object-fit\|objectFit" src/` → 0 hits; no test imports `rate-filters`. In a document this long, that reliability is what makes review possible at all.
- **The label forensics survive independent re-measurement.** I decoded the PNGs myself: Jones's is 800×1400, last ink row 1199, blank tail exactly 200 rows, ink height 6.0000in at 200dpi. The USPS labels are 1200×1800 edge to edge. The 14.3% squash figure is exact.
- **The carrier-matcher bug is real end to end.** `rates/index.ts:414` sets the raw EasyPost string, `:429` passes it into `rateDisplayFilterReason`, `:59` compares `"upsdap"` to `"ups"`, and nothing normalizes anywhere on the path (`normalizeCarrier` at `senderState.ts:124-131` is client-only and unexported).
- **"Do not reuse the admin renderer" is the single most valuable line in the document.** `_shared/label-notice.ts` really does carry EasyPost cost, estimated Stripe fee, net margin, sender IP and the PaymentIntent id. Sending that to a customer would be an incident. Keep that paragraph verbatim.
- **The two self-corrections in §1** — that the label was not too big for a 12×13 parcel, and that trimming the blank tail changes the printed physical size by exactly zero. Both are correct, both prevent a false customer-facing claim, and most authors quietly delete this kind of thing instead of recording it.
- **The W4a/W4b split.** Separating what fixes Jones from an independent bug he never hit is the right architecture, and demoting the distortion fix from "the answer" to "an unrelated bug" is honest.
- **W3's Defect 2 surface-by-surface table** is the sharpest thing in the document, and every row checks out.
- **The `funder='seller'` restraint** — naming the migration 040 seam, showing the two hardcodes, and deferring it to its own proposal instead of folding it in.
- **The prod numbers.** Seller links 7 with 0 constrained, flexible 27 with 2 constrained (one of which is a draft that `rates/index.ts:150` never resolves — "latent" is exactly the right word), 4 of 7 live labels UPS, `label.printed` count 4. All reproduce.
