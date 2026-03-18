# SendMo — Deployment Changelog

> **Every agent: add an entry here when merging to `main`.**
> Vercel auto-deploys every push to `main`, so every merge = a production deploy.
> Newest entries go at the top. Follow the template exactly.

---

## Entry Template

```markdown
## [YYYY-MM-DD] — Short title

**Branch:** `feat/branch-name`
**Commit:** `abc1234`
**Deploy:** Vercel auto-deploy / manual `vercel --prod`

### What shipped
- Bullet list of user-visible or infra changes

### What changed (files)
- `src/pages/NewPage.tsx` — new page
- `src/lib/api.ts` — added fetchFoo()
- `supabase/migrations/011_*.sql` — new table

### Tests
- X unit tests added/modified, Y total passing
- E2E: (any new coverage)

### Breaking changes
- None (or describe)

### Notes
- Anything agents in future sessions should know (gotchas, follow-ups, known issues)
```

---

## [2026-03-18] — Email notifications via Resend (OTP, label confirmation, tracking)

**Branch:** `feat/email-notifications`
**Commit:** `6a1b169`
**Deploy:** Vercel auto-deploy (after merge to main)

### What shipped
- OTP email verification for Flexible Link onboarding (6-digit code, SHA-256 hashed, 10-min expiry)
- Label confirmation email sent to recipient after label purchase
- Tracking update emails triggered by EasyPost webhook (in_transit, out_for_delivery, delivered)
- Branded HTML email templates (SendMo blue header, white body, gray footer)
- Resend REST API client for Deno Edge Functions (no SDK needed)
- Rate limiting: 3 sends per email per 10 min, 5 verify attempts per code
- Frontend wired to real API (replaced stubbed setTimeout in RecipientStepEmailVerify)

### What changed (files)
- `supabase/migrations/010_email_verifications.sql` — new table for hashed OTPs
- `supabase/functions/_shared/email-templates.ts` — 3 branded HTML templates
- `supabase/functions/_shared/resend.ts` — Resend REST API client
- `supabase/functions/email/index.ts` — OTP send + confirm Edge Function
- `supabase/functions/webhooks/index.ts` — EasyPost webhook handler + tracking emails
- `supabase/functions/labels/index.ts` — added label confirmation email (fire-and-forget)
- `src/components/recipient/RecipientStepEmailVerify.tsx` — replaced stubs with real API calls
- `src/lib/api.ts` — added `sendOTP()`, `confirmOTP()`
- `tests/unit/emailTemplates.test.ts` — 8 tests for email templates
- `tests/unit/otpLogic.test.ts` — 13 tests for OTP generation, hashing, expiry, rate limits

### Tests
- 21 new unit tests added (8 template + 13 OTP logic)
- 131 total unit tests passing (up from 110)
- E2E: no new coverage this deploy

### Breaking changes
- None

### Notes
- `RESEND_API_KEY` must be added to `.env.local` and set as Supabase secret before emails will send
- `noreply@sendmo.co` must be verified in Resend dashboard (domain verification)
- Migration 010 must be pushed: `npx supabase db push`
- Edge Functions must be deployed: `npx supabase functions deploy email` and `webhooks`
- Email addresses are never logged in event_logs (PII rule)
- All email sends are fire-and-forget — never block the main response

---

## [2026-03-18] — Auth, Flexible Link path, E2E tests

**Branch:** `feat/flexible-link` (merged), plus auth and test commits
**Commit:** `f65bfc2`
**Deploy:** Vercel auto-deploy

### What shipped
- Supabase Auth with magic link (passwordless) login
- Protected routes — `/onboarding`, `/dashboard` require auth
- Flexible Link recipient path (Steps 20-23): preferences, email verify, payment auth, link ready
- Comprehensive Playwright E2E test suite
- Updated CLAUDE.md with auth, flexible link, and test status

### What changed (files)
- `src/pages/RecipientOnboarding.tsx` — added flex link steps 20-23
- `src/components/recipient/RecipientStepFlex*.tsx` — 4 new step components
- `src/hooks/useRecipientFlow.ts` — flex link state + step navigation
- `src/lib/api.ts` — added `sendOTP()`, `confirmOTP()`
- `tests/e2e/` — new Playwright suite
- Auth provider, login page, route guards

### Tests
- 157 unit tests passing
- New E2E test suite (Playwright)

### Breaking changes
- Routes now require auth (except landing, FAQ, `/s/:shortCode`)

### Notes
- Admin PIN still hardcoded (`2026`) — replace with `profile.role === 'admin'` before launch
- Stripe still stubbed — real integration blocked on auth completion

---

## [2026-03-17] — Vercel production deploy + domain setup

**Branch:** direct to `main`
**Commit:** `26a277b`
**Deploy:** Vercel auto-deploy + manual domain config

### What shipped
- sendmo.co live on Vercel (A record → 76.76.21.21)
- www.sendmo.co CNAME redirect
- wind.sendmo.co pointing to coyote-wind project
- SPA rewrites in `vercel.json` for client-side routing
- EasyPost live key set as Supabase secrets
- Comp label ledger — migration 009 adds `payment_method` column

### What changed (files)
- `vercel.json` — SPA rewrites, build config
- `supabase/migrations/009_*.sql` — payment_method column
- `CLAUDE.md` — production URL, env var docs, Vercel deployment section

### Tests
- No new tests this deploy

### Breaking changes
- None

### Notes
- Vercel does NOT read `.env.local` — all `VITE_*` vars must be in Vercel dashboard
- After changing env vars, must redeploy with `vercel --prod`

---

## [2026-03-16] — Full Prepaid Label flow + admin mode

**Branch:** direct to `main`
**Commit:** `ba8c354`
**Deploy:** Vercel auto-deploy

### What shipped
- Recipient onboarding flow (Full Prepaid Label path): Steps 0→1→10→11→12
- Admin page with PIN gate, reporting, label void
- Admin test/live toggle on `/onboarding`
- Magic Guestimator (15 item types + urgency keywords)
- Dashboard with shipment history (mock data)
- Landing page (hero, how it works, value props, use cases, CTA, footer)
- 30+ EasyPost service name mappings
- All backend Edge Functions deployed (addresses, rates, labels, cancel-label, admin-report, autocomplete, place-details, ingest, test-db-insert)
- Database schema: 8 migrations applied on remote Supabase

### What changed (files)
- `src/pages/` — RecipientOnboarding, Dashboard, Index, Admin, FAQ
- `src/components/recipient/` — all step components, ProgressBar, MagicGuestimator, ShippingMethodCard
- `src/hooks/useRecipientFlow.ts` — state management
- `src/lib/api.ts` — verifyAddress, fetchRates, buyLabel, pricing helpers
- `src/lib/utils.ts` — carrier/service display, speed tier classification
- `supabase/functions/` — 9 Edge Functions
- `supabase/migrations/` — 001-008

### Tests
- 131 unit tests passing
- LabelTest page for manual backend testing

### Breaking changes
- First real deploy — no prior production state

### Notes
- Stripe payment stubbed (shows success without real charge)
- EasyPost test mode by default; live mode via admin toggle only

---

## [2026-03-14] — Initial setup

**Branch:** direct to `main`
**Commit:** `a2b96d4`
**Deploy:** Initial Vercel deploy

### What shipped
- React + Vite + TypeScript + Tailwind + shadcn/ui scaffold
- EasyPost Edge Functions (addresses, rates)
- LabelTest page for development
- CI pipeline (lint, typecheck, test)
- PRD.md, CLAUDE.md, DECISIONS.md

### What changed (files)
- Everything (initial commit)

### Tests
- Basic test framework setup

### Breaking changes
- N/A (first deploy)
