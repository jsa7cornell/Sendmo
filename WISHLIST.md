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

## Data / Reporting

- [ ] **Comp labels should show negative margin** — When a live label is created via "Live Comp" mode (no revenue), the admin report should show margin as negative (cost to SendMo), not zero.

## Features

- [ ] **Register EasyPost webhook URL** — Configure EasyPost dashboard to send `tracker.updated` events to `https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/webhooks`. The webhook handler is already built and deployed — just needs the URL registered. This will give us real-time status updates pushed by EasyPost instead of polling on page load. Currently we use a 30-min TTL cache on the tracking function; webhooks would make this near-instant and eliminate API polling entirely.
- [ ] **Cache tracking events in DB** — Store EasyPost tracking events (message, status, datetime, location) in a `tracking_events` table so the tracking page can show event history even when serving from cache (within the 30-min TTL). Currently events only show when a fresh EasyPost fetch happens.
- [ ] **Payment transaction ledger** — Per CLAUDE.md rule 16, financial balance changes must use an append-only ledger table. Create a `transactions` table: `id, user_id, shipment_id, type ('charge'|'refund'|'credit'|'fee'), amount_cents, stripe_ref, description, created_at`. All money movement flows through this table. Required before Stripe goes live.
- [ ] **Stripe refund on label void** — When EasyPost confirms `refund_status = 'refunded'` (via webhook), trigger a Stripe refund on the associated `payment_intent`. Wire up `processRefund()` in `src/lib/refundService.ts` (currently stubbed). Requires: Stripe refund API call, payment status update, ledger entry.
- [ ] **User payment history page** — Show all transactions (charges, refunds, credits) for the authenticated user. Read from the `transactions` ledger table. Accessible from Dashboard.

---

*Last updated: 2026-03-18*
