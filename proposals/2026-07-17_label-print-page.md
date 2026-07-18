---
title: Label print page — a SendMo-controlled print experience (buttons, printer tips, sizing presets incl. half-page) replacing the raw-label tab
slug: label-print-page
project: sendmo
status: decided
blocked_on: null
created: 2026-07-17
last_updated: 2026-07-17
reviewed: null
decided: 2026-07-17
executed: null
pr: null
author: Claude Opus 4.8 — drafted from user requests (multiple "give me a print page, not a raw file"; one "let me print the label on exactly half a page"). Revised 2026-07-17 after verifying the actual label format (PNG, not PDF) and S3 CORS behavior.
reviewer: null
outcome: null
---

> **2026-07-17 — DECIDED (John).** OQ resolutions: **OQ1** dedicated `/t/:code/print` route. **OQ2** ship 4×6 / **half-sheet (default)** / full-page — half-sheet is the primary/default per John; 4×6 + full-page kept as selectable (near-free, thermal users need native 4×6). **OQ3** keep the existing optimistic on-click `logLabelPrint` (easier; already built) — raw-label link click also logs. **OQ4** print page is **primary** (tracking "Print" navigates to it); the always-present raw-label link lives **on the print page**. **OQ5** **v1 frontend-only, no download-proxy** — raw-label link + browser save covers file access; proxied one-click download deferred to fast-follow. **OQ6** fold Bug A + Bug B fixes into this PR. **OQ7** persist last preset in localStorage. Implementation follows below.

## 1. Context

### 1.1 What users are asking for

Two related requests from real users:

1. **"When I click Print, don't just load a file — load a *page* with print buttons and information to configure the printer."** Today the raw carrier image opens in the browser's built-in image/file viewer, which is a dead end: no SendMo branding, no drop-off instructions, no guidance on printer settings, and the print affordance is whatever the browser happens to expose.
2. **"Let me format the label to print on exactly half a page."** This user wants to control the label's size/placement on the sheet — e.g. put the label on the top half of a Letter sheet (fold/tear, save paper), rather than accept whatever the viewer's scale defaults to.

Plus John's directive on this revision: **always keep a dumb, always-present link to the raw label** as a fallback that can never break, no matter what the print page does.

### 1.2 Verified facts about the label (checked 2026-07-17 — do not re-assume)

These were confirmed against prod, not inferred. They overturn the first draft of this proposal, so they lead:

- **The label is a PNG, not a PDF.** Every `shipments.label_url` points at `https://easypost-files.s3.us-west-2.amazonaws.com/.../<hash>.png`, served `Content-Type: image/png`. The buy call ([`labels/index.ts:1211`](../supabase/functions/labels/index.ts)) sends no `label_file_type`, so EasyPost returns its default **PNG**.
- **Dimensions: 1200×1800 px = exactly 4″ × 6″ **portrait** at 300 dpi**, ~55 KB. Verified on the live KMDCNEW label. This holds across carriers in the current book (USPS GroundAdvantage and UPSDAP Ground samples all `.png`).
- **The S3 host returns no CORS headers** (no `Access-Control-Allow-Origin`, even with an `Origin` request header). Consequence: a cross-origin `fetch()` of the label **bytes** from the browser is blocked. But a plain `<img src={label_url}>` **displays and prints fine without CORS** — CORS only gates reading pixels (canvas export) or `fetch()`, neither of which the print page needs.

### 1.3 How Print works today (and two bugs the verification exposed)

- **Primary CTA** ([`TrackingPage.tsx:476`](../src/pages/TrackingPage.tsx), `ActionButtonsRow`) is literally `<a href={data.label_url} target="_blank" onClick={handlePrintClick}>`. It opens the label image in a new tab. `handlePrintClick` ([:297](../src/pages/TrackingPage.tsx)) fires `logLabelPrint` (optimistic `print_count` bump + `label.printed` event_log) but controls nothing about printing.
- **Bug A (pre-existing, flag for ride-along):** the **Download** handler ([:320](../src/pages/TrackingPage.tsx)) does `fetch(label_url)` to build a blob download. Because S3 sends no CORS headers, that fetch **throws in the browser and silently falls back to `window.open(label_url)`** — so "Download" almost certainly never actually downloads a file today; it opens the image in a tab. (The Download path works from `curl`/server contexts, which is likely why it looked fine.)
- **Bug B (pre-existing, flag for ride-along):** the same handler names the file `sendmo-<code>.pdf` and the Print button copy reads **"Print Label (PDF)"** — but the bytes are **PNG**. Any download that did succeed would be a `.pdf` file containing PNG data. Cosmetic-but-wrong; fix the copy + extension.

### 1.4 The actual technical constraint (restated correctly)

The first draft claimed "we can't CSS-control a PDF's print scaling, so we need pdf.js." **That was wrong on the premise.** The label is already a raster **image**, so we can place it in an HTML document and size it with ordinary print CSS (physical `in` units + `@page`). No pdf.js, no format conversion, no byte-fetch, no CORS dependency.

The real remaining constraints are two:

- **Barcode fidelity.** The label must print at its true size and not be down-scaled below native, or carriers can fail to scan the barcode. The PNG is 300 dpi, so it's crisp; the job is to (a) never shrink it below native and (b) get the browser to print at Actual Size / 100%.
- **Geometry.** The label is **portrait 4″w × 6″h**. The top half of a Letter portrait sheet is 8.5″w × **5.5″h** — a 6″-tall label **does not fit** there portrait. To put it on half a page at native size you must **rotate it 90° to 6″w × 4″h landscape**, which fits the top half with room to spare and **without any scaling** (barcode-safe). This corrects the first draft, which wrongly implied the portrait label fits as-is.

## 2. Problem statement

The Print action hands the user off to a generic image/file viewer with no instructions and no layout control, producing (a) confusion about printer settings, (b) no path to the half-page / paper-saving layout users want, and (c) a missed chance to keep drop-off guidance in front of the user at the moment they're preparing the package. Meanwhile Download is quietly broken and mislabeled.

## 3. Proposed solution

A dedicated **SendMo print page** that owns the layout, plus an **always-present raw-label fallback link** that bypasses all of it.

### 3.1 Surface

New route **`/t/:code/print`** (recommended over an in-page modal — see OQ1): a focused, print-clean page reachable from the existing Print CTA. It contains:

- **A live preview** of the label as it will print, inside the selected layout — just `<img src={label_url}>` in a sized container. No CORS, no conversion.
- **Layout presets** (segmented control), default = **4×6 label**:
  - **4×6 label** — image at native 4″×6″ portrait, top-left. For thermal label printers and cut-to-size. Barcode at native size.
  - **Half sheet (Letter)** — image **rotated 90° to 6″w × 4″h** and placed on the **top half** of an 8.5×11 portrait sheet, with a dashed fold/tear guide at the 5.5″ line. This is the explicit request. No scaling → barcode safe.
  - **Full page (Letter)** — image scaled **up** to fill a Letter sheet with margins; big and easy to read. (Up-scaling is barcode-safe.)
  - Print stylesheet: `@page { size: letter portrait; margin: 0 }`, geometry in `in` units, chrome hidden via `@media print { .no-print { display:none } }`.
- **Print button** → `window.print()`.
- **Printer-configuration tips** inline (the "configure the printer" ask):
  - Set scale to **100% / "Actual size"** (never "Fit to page") — most important for barcode scannability.
  - Turn **off** browser headers/footers (date/URL) in the print dialog.
  - Portrait orientation; Letter/A4 as appropriate.
  - Which preset suits which printer (thermal 4×6 vs home inkjet on Letter).
- **Drop-off instructions** reused from the existing `HowToShipStrip` so guidance stays consistent.

### 3.2 The always-present raw-label fallback (per John's directive)

A plain, dependency-free **"Open the raw label"** link — a bare `<a href={label_url} target="_blank" rel="noopener noreferrer">` — is rendered **unconditionally and persistently**, both on the print page and back on the tracking page's action area. It must survive every failure mode of the fancy path:

- pdf/JS bundle fails, print CSS misbehaves, an odd browser, JS disabled, or a mobile browser with no real print pipeline → the user can always fall back to opening the exact carrier file and using the OS/browser's own print/share.
- It is intentionally **not** gated on preset state, image-load success, or anything else. If `label_url` exists, the raw link exists.
- **This link is also the robustness guard for the PNG assumption (§1.2):** if EasyPost ever returns a PDF (or the format changes), the `<img>` preview may not render, but the raw link still hands over the actual file. The preview should feature-detect (image loads / content-type) and, on failure, collapse gracefully to just the raw link + tips rather than showing a broken image.

Naming note: to users this is "the label file," not "the PDF" — since it's a PNG. Copy should say "label" / "label file," and Bug B's "(PDF)" wording gets corrected in the same change.

### 3.3 Print-count integration

Preserve the current `label.printed` logging. Fire `logLabelPrint` when the user actually invokes printing on the new page. `window.onafterprint` is the most accurate trigger; the current optimistic-on-click behavior is the simpler match. Pick one (**OQ3**) — recommend `onafterprint` now that we own the print moment. The always-present raw-label link should also log a print (it *is* a print intent) — decide in OQ3.

### 3.4 Mobile reality

The reference screenshot is a phone, and much traffic prints from mobile where the browser print pipeline is limited/absent. The print page must degrade gracefully: still show the preview and presets, and lean on the **always-present raw-label link** so a mobile user can hand the file to their OS print/share sheet. Half-page sizing is desktop-primary; that's acceptable.

### 3.5 On a *true* Download (optional, separate from the ask)

If we want Download to actually save a file with a clean name (fixing Bug A properly rather than just relabeling), the only robust cross-origin route is to **proxy the label through our own origin** — a tiny edge function that streams `label_url` back with `Content-Disposition: attachment; filename="sendmo-<code>.png"` and a same-origin URL. That's the sole piece of server work anywhere in this proposal, and it's optional / out of the core ask (**OQ5**). Without it, "Download" can only be "open the file in a tab," i.e. the raw-label link.

### 3.6 What does NOT change

- The purchased label, `label_url`, the buy flow, pricing, and reprint/lock-on-scan semantics are untouched.
- The tracking-page layout stays; the Print CTA's destination changes (raw file tab → `/t/:code/print`), with the raw-label link preserved and always present.

## 4. Scope / effort sketch

- **v1 (frontend-only):** new `/t/:code/print` route + component; `<img src={label_url}>` in a sized container; three layout presets with an `@media print` stylesheet; the rotate-90° half-sheet; printer tips; reuse `HowToShipStrip`; the always-present raw-label link (on both the print page and the tracking action area); repoint the Print CTA; move `logLabelPrint` to `onafterprint`; correct the "(PDF)" copy → "label." **No pdf.js, no format conversion, no fetch, no CORS work, no schema, no edge deploy.**
- **Ride-along bug fixes (recommend folding in):** Bug A (Download fetch is CORS-dead) and Bug B (`.pdf` naming / "(PDF)" copy on a PNG). Cheapest correct fix without server work: make "Download" the raw-label open (or drop it in favor of the always-present raw link) and fix the copy; do the real proxied download only if OQ5 says yes.
- **Verification (Rule 19 + a physical step):** browser-verify each preset renders and prints clean (print-to-PDF to inspect geometry), **plus a real print + USPS/UPS scan test of the half-sheet output** — barcode scannability, not visual correctness, is the acceptance bar.

## 5. Open questions (for John)

- **OQ1 — Surface:** dedicated route `/t/:code/print` (recommended: shareable, back-button, print-clean, trivial `@media print` scoping) vs an in-page modal (no navigation, messier print scoping)?
- **OQ2 — Presets for v1:** ship **4×6 / Half-sheet (rotated) / Full-page** (recommended)? Any others (2-up per page, A4)? Default = 4×6 — agree? (Note: the rasterization fork from the first draft is **gone** — the label is already a PNG, so this is pure CSS.)
- **OQ3 — Print-count trigger:** move to `window.onafterprint` (recommended, accurate) vs keep optimistic on-click? And does clicking the raw-label fallback also count as a print?
- **OQ4 — Replace vs augment:** make the print page the **primary** Print destination and keep the raw-label link always present as fallback (recommended), or keep raw-file as primary and add the print page as an opt-in "Advanced print"?
- **OQ5 — Real Download:** fix Bug A properly with a same-origin **label-proxy edge function** (`Content-Disposition` + `.png`) so "Download" truly saves a file — yes, or is "open the raw label in a tab" good enough for v1 (no server work)?
- **OQ6 — Ride-along scope:** fold Bug A + Bug B fixes into this PR (recommended — they're in the same 20 lines), or split them out?
- **OQ7 — Persist layout choice:** remember the user's last preset (localStorage) — worth it for v1, or skip?
