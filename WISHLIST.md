# SendMo — Wishlist

> Running list of improvements, bugs, and polish items. Prioritize from top down.
> Add new items at the bottom. Mark items `[x]` when shipped.

---

## UX / Polish

- [ ] **Production-quality headers and graphics** — Add SendMo logo to nav, email templates, landing page. Replace placeholder text/icons with branded assets. Consistent header across all pages.
- [ ] **Label download link should be secure** — After Full Label flow completes, the label PDF link should be a signed/expiring URL (not a public EasyPost URL). Prevents unauthorized access to shipping labels.

## Bugs

- [x] **Magic link login doesn't send email** — Root cause: Supabase Auth Site URL was pointed at old Vercel deploy URL. Fixed 2026-03-19: config push to set `sendmo.co`, confirmed John's account, added `detectSessionInUrl` to client.
- [ ] **Full Label flow doesn't create account or link** — After completing the Full Prepaid Label flow, the recipient should have: (1) email verified via OTP, (2) Supabase Auth account auto-created, (3) a `sendmo_links` record in their dashboard. Currently the flow generates a label but doesn't persist the recipient's account or link.

## Test / CI debt (2026-04-26)

- [ ] **Clean up ~30 lint errors** — Mostly `@typescript-eslint/no-explicit-any` and `no-unused-vars`, accumulated invisibly while ESLint config was broken. Lint is non-blocking in CI and predeploy.sh until cleaned up. Bulk are mechanical (`unknown` for `any`, `_` prefix for unused vars).
- [ ] **Fix Google Maps autocomplete in CI e2e** — ~14 e2e tests fail because `fillSmartAddress` waits for "Townsend"/"Montgomery" suggestion buttons that never render: `VITE_GOOGLE_MAPS_API_KEY` isn't set in CI, so `@googlemaps/js-api-loader` never loads. Pick one: (a) add a Maps API key to CI env, (b) add a playwright route mock for the Maps script, or (c) refactor tests to use the manual-entry path. E2E is non-blocking in CI until fixed.
- [ ] **Audit + restore the deleted `payments/` edge function dir** — empty directory found at `supabase/functions/payments/`. Either fill it in for the Stripe work or remove the placeholder so predeploy.sh stops skipping it.
- [ ] **Bump `actions/checkout`, `setup-node`, `upload-artifact` to versions on Node 24** — GitHub deprecation warning; runner forces Node 24 by 2026-06-02.

## Data / Reporting

- [ ] **Comp labels should show negative margin** — When a live label is created via "Live Comp" mode (no revenue), the admin report should show margin as negative (cost to SendMo), not zero.

## Features

### Phase 2: Sender Flow & Flexible Link
- [ ] **Sender flow (5-step wizard)** — Build the sender experience at /s/:shortCode: intro, origin + package details, choose shipping method, review + confirm, label ready

### Phase 3+: Premium Features & Analytics
- [ ] **Saved addresses / locations** — Let users store their frequently-used addresses for quick re-use in future shipments. Scoped to authenticated users.
- [ ] **Reusable templates** — Allow recipients to save link preferences (distance, size hint, speed tier) as reusable templates. Pre-populate future links with a single tap.
- [ ] **Branded ship-to links** — Custom domains or subdomain support (e.g., company.sendmo.co/join) so links feel more professional/personal to the recipient's brand.
- [ ] **Shipment tracking dashboard** — Real-time tracking dashboard for the recipient to monitor all packages being shipped to them. Shows status, ETA, carrier, last update.
- [ ] **Resend link for repeats** — Quick "Send again" button that lets the recipient re-send their link to a new sender without re-entering all preferences.
- [ ] **Analytics: viewed, completed, shipped** — Track link analytics (views, completion rate, shipments, total $ received). Accessible from Dashboard.

### Existing Features (In Progress)
- [ ] **Register EasyPost webhook URL** — Configure EasyPost dashboard to send `tracker.updated` events to `https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/webhooks`. The webhook handler is already built and deployed — just needs the URL registered. This will give us real-time status updates pushed by EasyPost instead of polling on page load. Currently we use a 30-min TTL cache on the tracking function; webhooks would make this near-instant and eliminate API polling entirely.
- [ ] **Cache tracking events in DB** — Store EasyPost tracking events (message, status, datetime, location) in a `tracking_events` table so the tracking page can show event history even when serving from cache (within the 30-min TTL). Currently events only show when a fresh EasyPost fetch happens.
- [ ] **Payment transaction ledger** — Per CLAUDE.md rule 16, financial balance changes must use an append-only ledger table. Create a `transactions` table: `id, user_id, shipment_id, type ('charge'|'refund'|'credit'|'fee'), amount_cents, stripe_ref, description, created_at`. All money movement flows through this table. Required before Stripe goes live.
- [ ] **AI-powered FAQ / Help center** — Replace the static FAQ page with a smart help experience. Include: (1) AI-based search that answers questions from a knowledge base (shipping policies, pricing, how-it-works, troubleshooting), (2) a curated list of real questions people actually ask (sourced from support emails, user testing, etc.), and (3) unified FAQ + Help in one place (accessible from header for both signed-in and signed-out users). Consider embedding an AI chat widget or search-first UX.
- [ ] **Flexible label generation** — After the sender selects a shipping rate on the flex link flow, generate and display the actual shipping label (PDF). Requires: Stripe payment capture on the flex link's authorized hold, EasyPost label buy call with the selected rate, label PDF storage in Supabase Storage, and a download/print UI on the done step. Currently the done step shows a placeholder ("Label generation coming soon").
- [ ] **Stripe refund on label void** — When EasyPost confirms `refund_status = 'refunded'` (via webhook), trigger a Stripe refund on the associated `payment_intent`. Wire up `processRefund()` in `src/lib/refundService.ts` (currently stubbed). Requires: Stripe refund API call, payment status update, ledger entry.
- [ ] **User payment history page** — Show all transactions (charges, refunds, credits) for the authenticated user. Read from the `transactions` ledger table. Accessible from Dashboard.

---

*Last updated: 2026-04-26*
