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

_(add future feature ideas here)_

---

*Last updated: 2026-03-18*
