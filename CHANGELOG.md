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

## [2026-03-19] — URL-based step routing for recipient onboarding

**Branch:** `feat/url-step-routing`
**Commit:** `4fbc307`
**Deploy:** Vercel auto-deploy

### What shipped
- Onboarding steps now have real URLs: `/onboarding/address`, `/onboarding/shipping`, `/onboarding/payment`, `/onboarding/label` (full label) and `/onboarding/preferences`, `/onboarding/verify`, `/onboarding/authorize`, `/onboarding/link-ready` (flex)
- Browser back/forward buttons work naturally through the flow
- Step guards: direct URL access blocked if prior steps not completed (redirects to first incomplete step)
- Cross-path slug rejection: flex slugs rejected when full_label path is active (and vice versa)
- Flow state lifted to React Context — persists across URL changes
- Direction-aware animation (forward vs backward slide)

### What changed (files)
- `src/lib/stepRouting.ts` — new: slug↔step mappings, step ordering, guard logic, progress bar mapping
- `src/contexts/RecipientFlowContext.tsx` — new: flow state context with navigate()-based transitions
- `src/pages/RecipientOnboarding.tsx` — rewritten as layout reading step from URL
- `src/App.tsx` — nested routes with shared OnboardingLayout provider
- `tests/unit/stepRouting.test.ts` — 27 new tests
- `tests/unit/recipientFlowContext.test.tsx` — 11 new tests
- `tests/e2e/url-step-routing.spec.ts` — 10 new tests

### Tests
- 38 new unit tests (stepRouting + RecipientFlowContext), 188 total passing
- 10 new E2E tests (URL changes, browser back, step guards, cross-path rejection), 31 total E2E passing

### Breaking changes
- Onboarding URLs changed from `/onboarding` (single page) to `/onboarding/:step` (URL per step). No external links to old step URLs existed, so no user impact.

### Notes
- Step components required zero changes — context exposes backward-compatible `state: RecipientFlowState`
- Steps 11→12 (payment→label ready) happen within the same `RecipientStepPayment` component, so URL stays at `/payment`
- `useRecipientFlow` hook still exists for its tests but the context wraps similar logic
- Sender flow (`SenderFlow.tsx`) is still a placeholder — URL routing for it will be added when sender flow is built

---

## [2026-03-19] — Shipping notifications for sender + recipient, tracking page

**Branch:** `feat/shipping-notifications`
**Commit:** `22b35a9`
**Deploy:** Vercel auto-deploy

### What shipped
- Both sender AND recipient get notified on in_transit, out_for_delivery, delivered
- Role-aware email templates ("Your package..." vs "The package you sent...")
- Estimated delivery date and carrier info in tracking emails
- "Track Package" button in emails linking to public tracking page
- Public tracking page at `/track/:trackingNumber` with status timeline
- Notification dispatcher architecture (email now, SMS/push extensible later)
- `notification_contacts` table — who to notify about each shipment
- `notifications_log` table — audit trail with idempotency (no duplicate sends)
- Tracking Edge Function — lightweight read-only endpoint, no auth required
- Labels function stores sender + recipient emails as notification contacts

### What changed (files)
- `supabase/migrations/011_notification_contacts.sql` — 2 new tables + indexes
- `supabase/functions/_shared/notifications.ts` — notification dispatcher
- `supabase/functions/_shared/email-templates.ts` — role-aware tracking emails with ETA + tracking link
- `supabase/functions/_shared/cors.ts` — added GET method
- `supabase/functions/webhooks/index.ts` — uses dispatcher instead of direct email
- `supabase/functions/labels/index.ts` — stores notification contacts, accepts sender_email
- `supabase/functions/tracking/index.ts` — new public tracking endpoint
- `src/pages/TrackingPage.tsx` — new tracking page
- `src/App.tsx` — added `/track/:trackingNumber` route
- `tests/unit/emailTemplates.test.ts` — updated (13 tests, role + ETA + tracking link)
- `tests/unit/notifications.test.ts` — new (9 tests, dispatch logic + idempotency)

### Tests
- 14 new/updated tests (9 notification + 5 email template)
- 145 total unit tests passing (up from 131)
- E2E: no new coverage this deploy

### Breaking changes
- `trackingUpdateEmail()` signature changed — now accepts optional carrier, ETA, trackingUrl, role params (backwards compatible, all optional)

### Notes
- Migration 011 must be pushed: `npx supabase db push`
- Deploy new Edge Functions: `npx supabase functions deploy tracking webhooks`
- `sender_email` param is optional in labels function — comp labels may not have it
- SMS/push channels are stubbed in the dispatcher — add handlers when ready
- Tracking page fetches from Edge Function, not direct DB (keeps RLS clean)

---

## [2026-03-19] — Fix magic link login + custom SMTP via Resend

**Branch:** `feat/fix-auth-login`
**Commit:** `f7d503b`
**Deploy:** Vercel auto-deploy

### What shipped
- Magic link login now works — Supabase Site URL corrected from old Vercel deploy URL to `sendmo.co`
- Emails send from `SendMo <noreply@sendmo.co>` via Resend SMTP (was `supabase auth`)
- Landing page nav shows Dashboard + sign out when logged in (was always "Sign In")
- "Sign In" button links to `/login` directly (was `/dashboard` → redirect)
- User-friendly error for rate limiting, spam folder hint on success screen
- Supabase client configured with `detectSessionInUrl`, `persistSession`, `autoRefreshToken`
- John's account confirmed via SQL (was stuck with `email_confirmed_at: null`)

### What changed (files)
- `src/lib/supabase.ts` — auth config options
- `src/pages/Index.tsx` — conditional nav (signed in vs anonymous)
- `src/pages/Login.tsx` — better error messages, resend link
- `supabase/config.toml` — auth site_url, redirect allowlist, SMTP config
- `tests/unit/auth.test.tsx` — 5 new tests
- `DECISIONS.md` — auth debugging findings
- `WISHLIST.md` — marked magic link bug as fixed

### Tests
- 5 new auth unit tests, 136 total passing

### Breaking changes
- None

### Notes
- Free tier can't change JWT expiry (1hr) — sessions persist via refresh tokens (`autoRefreshToken: true`)
- SMTP password passed as `env(SMTP_PASS)` during `supabase config push` — never in git
- To re-push SMTP config: `SMTP_PASS=re_xxx npx supabase config push --project-ref fkxykvzsqdjzhurntgah`
- Free tier email rate limit: 4/hour (now shows friendly error instead of raw Supabase message)

---

## [2026-03-18] — Email notifications via Resend (OTP, label confirmation, tracking)

**Branch:** `feat/email-notifications`
**Commit:** `6a1b169`
**Deploy:** Vercel auto-deploy + Supabase Edge Functions

### What shipped
- OTP email verification for Flexible Link path (6-digit code, SHA-256 hashed, 10-min expiry)
- Label confirmation email sent after successful purchase (fire-and-forget)
- Tracking update email on EasyPost webhook status changes (in_transit, out_for_delivery, delivered)
- Rate limiting: 3 sends per email per 10 min, 5 verification attempts per code
- Branded HTML email templates (SendMo blue header, white body, gray footer)
- RecipientStepEmailVerify wired to real API calls (replaces stubbed setTimeout)

### What changed (files)
- `supabase/functions/email/index.ts` — new Edge Function (send OTP + confirm OTP)
- `supabase/functions/webhooks/index.ts` — new EasyPost webhook handler with tracking emails
- `supabase/functions/_shared/email-templates.ts` — 3 branded HTML templates
- `supabase/functions/_shared/resend.ts` — Resend REST API client for Deno
- `supabase/functions/labels/index.ts` — added label confirmation email (fire-and-forget)
- `supabase/migrations/010_email_verifications.sql` — email_verifications table
- `src/components/recipient/RecipientStepEmailVerify.tsx` — wired to real sendOTP/confirmOTP
- `src/lib/api.ts` — added sendOTP(), confirmOTP()
- `tests/unit/emailTemplates.test.ts` — 8 template tests
- `tests/unit/otpLogic.test.ts` — 13 OTP logic tests

### Tests
- 21 new unit tests (email templates + OTP logic), 131 total passing

### Breaking changes
- None

### Notes
- RESEND_API_KEY set as Supabase secret, sendmo.co domain verified in Resend
- All email sends are fire-and-forget — never block user-facing responses
- No PII logged in event_logs (email addresses excluded per policy)

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
