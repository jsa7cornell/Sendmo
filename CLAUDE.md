# SendMo — Claude Code Agent Instructions
> **AI agents — read before every session:**
> 1. Read `../CLAUDE.md` (AI Brain global context) — services, credentials protocol, global rules.
> 2. Read this entire file (`CLAUDE.md`) — developer instructions, architecture, rules.
> 3. Read `PRD.md` — product requirements, flows, acceptance criteria.
> 4. Read `DECISIONS.md` — *why* decisions were made, integration gotchas, hard-won debugging knowledge.
>
> At the **end of every session**, propose updates to `DECISIONS.md`, `CLAUDE.md`, or `../CLAUDE.md` for anything new discovered. If nothing changed, say "No doc updates needed this session."

## What is SendMo?

SendMo is a prepaid shipping web app. Recipients create a link once, senders click it, enter package details, and print a label. The recipient pays. Core tagline: **"Prepaid shipping made easy."**

**Two recipient flows:**
1. **Full Prepaid Label** — Recipient knows exactly what's being shipped. Enters all details, gets PDF label immediately.
2. **Flexible Shipping Link** — Sender fills in details later. Recipient sets preferences (speed, distance, size hint). Stripe hold released after actual shipping cost captured.

## Tech Stack (Non-Negotiable)

| Layer | Tech | Notes |
|-------|------|-------|
| Frontend | React 18 + Vite + TypeScript + Tailwind + shadcn/ui | |
| Hosting | Vercel | Auto-deploy from GitHub |
| Backend | Supabase Edge Functions (Deno/TypeScript) | All server logic here |
| Database | Supabase PostgreSQL | Project: `fkxykvzsqdjzhurntgah` |
| Auth | Supabase Auth | Magic link (passwordless) |
| Shipping | EasyPost API | Rates, labels, tracking |
| Payments | Stripe | Immediate capture (full label) / manual capture (flexible link) |
| Email | Resend | Transactional emails |
| Storage | Supabase Storage | Label PDFs |
| Monitoring | Sentry + PostHog | |

## Repository Structure

```
sendmo/
├── CLAUDE.md                    # THIS FILE — read every session
├── DECISIONS.md                 # Why decisions were made + integration gotchas
├── .env.local                   # Local secrets (never commit)
├── .env.example                 # Template for secrets
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css                # CSS variables / design tokens
│   ├── pages/
│   │   ├── Index.tsx            # Landing page
│   │   ├── RecipientOnboarding.tsx
│   │   ├── SenderFlow.tsx
│   │   ├── Dashboard.tsx
│   │   ├── FAQ.tsx
│   │   └── NotFound.tsx
│   ├── components/
│   │   ├── recipient/           # RecipientStep*.tsx, ProgressBar, MagicGuestimator, etc.
│   │   ├── sender/              # SenderStep*.tsx components (pending)
│   │   └── ui/                  # shadcn/ui components + SmartAddressInput
│   ├── hooks/
│   │   └── useRecipientFlow.ts  # State management for onboarding flow
│   └── lib/
│       ├── api.ts               # API client (verifyAddress, fetchRates, buyLabel, pricing)
│       ├── types.ts             # Shared TypeScript types
│       └── utils.ts             # Utilities (cn, carrier display, speed tier classification)
├── supabase/
│   ├── migrations/              # SQL migration files
│   └── functions/               # Edge Functions (Deno)
│       ├── addresses/           # POST /api/addresses/verify
│       ├── links/               # POST /api/links, GET /api/links/:shortCode, PATCH /api/links/:id
│       ├── rates/               # POST /api/rates
│       ├── labels/              # POST /api/labels
│       ├── payments/            # POST /api/payments/authorize, /capture
│       ├── email/               # POST /api/email/verify, /confirm
│       └── webhooks/            # POST /api/webhooks/stripe, /easypost
└── tests/
    ├── e2e/                     # Playwright end-to-end tests
    ├── unit/                    # Vitest unit tests
    └── integration/             # API integration tests
```

## Environment Variables

```bash
# Supabase
VITE_SUPABASE_URL=https://fkxykvzsqdjzhurntgah.supabase.co
VITE_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # Edge functions only, never expose to frontend

# EasyPost
EASYPOST_API_KEY=...            # Use TEST key (EZTKxxxx) for development

# Stripe
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Resend
RESEND_API_KEY=...

# App
VITE_APP_URL=http://localhost:5173
VITE_SHORT_LINK_BASE=sendmo.co/s   # Production domain is sendmo.co
```

## Design System (Strict)

### Colors (CSS Variables in index.css)
```css
--background: 0 0% 96%;
--foreground: 210 11% 15%;
--card: 0 0% 100%;
--primary: 214 89% 52%;        /* SendMo blue */
--primary-foreground: 0 0% 100%;
--muted: 210 14% 95%;
--muted-foreground: 210 7% 46%;
--destructive: 0 72% 51%;
--success: 142 71% 45%;
--border: 210 14% 89%;
```

### Component Patterns
- Cards: `bg-card rounded-2xl border border-border shadow-sm p-5`
- Selected state: `border-primary bg-primary/5`
- Validated error summary: `rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3`
- Primary buttons: `rounded-xl shadow-sm`
- Font: Inter (400, 500, 600, 700)

### Validation Pattern ("try-then-show")
1. User clicks Continue → set `tried = true`
2. Red borders + "Required" labels appear on empty fields
3. Validation summary block animates in above Continue button
4. List all issues

### Animations (Framer Motion)
- Step transitions: `initial={{ opacity: 0, x: 20 }}` → `animate={{ opacity: 1, x: 0 }}`
- `AnimatePresence mode="wait"` wraps all steps
- Price updates: `animate={{ scale: [1, 1.02, 1] }}`

## Key Business Logic

### Pricing
```
DisplayPrice = EasyPostRate × 1.15   (standard, credit card)
DisplayPrice = EasyPostRate × 1.10   (SendMo Balance — post-MVP)
```
Never show the SendMo fee separately. Single "Shipping" price.

### Price Cap
- Recipients set max they'll pay (default $100)
- Cap applies to display price (includes margin)
- Senders see only methods where display price ≤ cap

### Payment Flows
- **Full label**: Stripe charges immediately (`capture_method: 'automatic'`)
- **Flexible link**: Stripe auth hold at 110% of high range + insurance (`capture_method: 'manual'`), captured when sender prints label

### Short Codes
- 10-char alphanumeric, no ambiguous chars (no 0/O, 1/I/l)
- Generated server-side with `crypto.getRandomValues()`
- UNIQUE constraint in DB with retry on collision (max 3)

## Database Tables (Production Schema)

See `supabase/migrations/001_initial_schema.sql` for full schema.  
See `supabase/migrations/002_add_refund_fields.sql` for label refund columns.

Key tables: `profiles`, `addresses`, `sendmo_links`, `shipments`, `payments`, `balances`, `webhook_events`

**Shipments — refund fields (added in migration 002):**

| Column | Type | Description |
|--------|------|-------------|
| `refund_status` | TEXT | `none` \| `submitted` \| `refunded` \| `rejected` \| `not_applicable` |
| `refund_submitted_at` | TIMESTAMPTZ | When the void request was submitted |
| `cancelled_at` | TIMESTAMPTZ | When the label was cancelled |
| `carrier_refund_id` | TEXT | External carrier refund reference ID |

## API Routes

All backend logic lives in Supabase Edge Functions:

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/addresses/verify` | No |
| POST | `/api/links` | Yes |
| GET | `/api/links/:shortCode` | No |
| PATCH | `/api/links/:id` | Yes |
| POST | `/api/rates` | No |
| POST | `/api/labels` | No (link auth) |
| POST | `/api/payments/authorize` | Yes |
| POST | `/api/payments/capture` | Internal |
| POST | `/api/cancel-label` | Admin only |
| POST | `/api/email/verify` | No |
| POST | `/api/email/verify/confirm` | No |
| POST | `/api/webhooks/stripe` | Webhook sig |
| POST | `/api/webhooks/easypost` | Webhook sig |

## Agent Roles & Responsibilities

When working as a Claude Code agent, you may be assigned one of these roles:

### 🏗️ Backend Agent
- Writes Supabase Edge Functions (Deno/TypeScript)
- Implements EasyPost integration (addresses, rates, labels, tracking)
- Implements Stripe integration (payment intents, capture, refunds)
- Writes DB migration SQL

### 🎨 Frontend Agent  
- Writes React/TypeScript components
- Follows design system STRICTLY (no deviations from color tokens)
- Implements Framer Motion animations
- Uses shadcn/ui components

### 🧪 Test Agent
- Writes Vitest unit tests for business logic
- Writes Playwright e2e tests for critical flows
- Writes integration tests for API endpoints
- Maintains CI/CD pipeline (GitHub Actions)

### 🗄️ Database Agent
- Writes Supabase SQL migrations
- Defines RLS policies
- Creates indexes for performance
- Documents schema changes

## Current Phase: Phase 1 MVP

**Goal**: Full Prepaid Label path working end-to-end first, then Flexible Link path.

**Priority**: Live label for John's mom → Auth UI → Flexible Link → Sender flow

**Current status (as of 2026-03-18)**:
- [x] Backend Edge Functions deployed and working (addresses, rates, labels, cancel-label, admin-report, autocomplete, place-details, ingest, test-db-insert)
- [x] Database schema applied (8 migrations on remote Supabase)
- [x] LabelTest page working (test harness for backend APIs)
- [x] Admin page working (PIN-gated, reporting + label void)
- [x] **Recipient onboarding flow (Full Prepaid Label path)** — Steps 0→1→10→11→12, Stripe stubbed, real EasyPost test rates
- [x] Admin test/live toggle — floating toolbar on /onboarding (Test | Live Comp)
- [x] Magic Guestimator — 15 item types + urgency keywords, client-side
- [x] Landing page (hero, how it works, value props, use cases, CTA, footer)
- [x] Service name polish — 30+ EasyPost service name mappings + camelCase fallback
- [x] **Vercel production deploy** — sendmo.co live, auto-deploys from GitHub `main`, env vars configured
- [x] **Domain setup** — sendmo.co → Vercel (A record 76.76.21.21), www.sendmo.co CNAME, wind.sendmo.co → coyote-wind
- [x] **EasyPost live key** — set as Supabase secrets (EASYPOST_API_KEY + EASYPOST_TEST_API_KEY)
- [x] **Comp label ledger** — migration 009 adds `payment_method` column ('card'|'balance'|'comp')
- [x] **Auth UI (magic link login)** — Supabase Auth with magic link, Login page, ProtectedRoute, AuthContext, auto-create profile on first login
- [x] **Dashboard with real data** — connected to Supabase via AuthContext, shows shipment history for authenticated user, user menu with sign out
- [x] **Recipient onboarding flow (Flexible Link path)** — Steps 20-23: shipping preferences, email OTP verification, payment (stubbed), link activated view
- [x] **E2E tests (Playwright)** — 12 tests covering home, admin, auth, onboarding, 404
- [x] **Unit tests** — 110 tests across 11 files, all passing
- [ ] Sender flow (5-step wizard at /s/:shortCode) — SenderFlow.tsx is a placeholder
- [ ] Stripe payment integration (stubbed for now, real integration needed)
- [ ] Email notifications (OTP, label, tracking via Resend)
- [ ] Server-side admin token validation (replace PIN gate with role-based check)

**What exists on disk but is a stub**:
- `src/pages/SenderFlow.tsx` — placeholder text (needs 5-step sender wizard)
- `src/components/sender/` — empty directory
- `src/components/recipient/RecipientStepFlexPayment.tsx` — Stripe payment stubbed with mock form

**Live production URL**: https://sendmo.co (auto-deploys from GitHub `main`, also accessible at sendmo.vercel.app)
**Loveable prototype reference**: https://sendmo.lovable.app (still live, use for visual reference only — production builds from PRD specs)

## Critical Rules for All Agents

1. **NEVER** commit `.env.local` or any file containing secrets
2. **NEVER** expose `SUPABASE_SERVICE_ROLE_KEY` to frontend code
3. **ALWAYS** use EasyPost TEST key (`EZTKxxxx`) during development
4. **ALWAYS** use Stripe test mode (`pk_test_`, `sk_test_`) during development
5. **ALWAYS** validate inputs server-side in Edge Functions (client-side is UX only)
6. **ALWAYS** use Stripe Elements — never handle raw card numbers
7. **NEVER** show recipient's address in sender UI (privacy requirement)
8. **ALWAYS** verify webhook signatures (Stripe + EasyPost)
9. **ALWAYS** use RLS — all DB access scoped to authenticated user
10. **ALWAYS** write a test before marking a feature complete
11. **ALWAYS** adhere strictly to the testing strategy defined in `PRD.md` Section 22.
12. **ALWAYS** write a regression test when fixing a bug based on what was learned, before implementing the fix.
14. **ALWAYS** derive critical decisions (pricing, refund eligibility, test/live mode) from server-side state (DB, env vars) — **NEVER** trust client-provided parameters for these determinations.
15. **ALWAYS** anticipate "Phase 3 Escrow" (money transmission) when altering `payments` or `shipments`. Ensure enum constraints are easily expandable for future `escrow` states.
16. **NEVER** use simple `UPDATE` statements for modifying financial balances. **ALWAYS** utilize immutable, append-only ledger tables (e.g., `transactions`) for tracking money movement (funding, holds, disputes, fees, releases) due to strict money transmission regulations and required audit trails.

## Vercel Deployment

**Production URL**: https://sendmo.co (also https://sendmo.vercel.app)
**Auto-deploys**: Every push to `main` triggers a build + deploy
**Build command**: `npm run build` (tsc + vite build)
**Output directory**: `dist`
**Framework**: Vite (configured in `vercel.json`)

**Environment variables on Vercel** (must be set in Vercel dashboard or CLI, NOT from .env.local):
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anon/publishable key
- `VITE_APP_URL` — `https://sendmo.co`
- `VITE_GOOGLE_MAPS_API_KEY` — Google Maps API key for address autocomplete

**Important**: Vercel does NOT read `.env.local`. All `VITE_*` vars must be added via `vercel env add` or the Vercel dashboard. After adding/changing env vars, redeploy with `vercel --prod`.

---

## How to Run Locally

```bash
# Install dependencies
npm install

# Start Supabase locally
npx supabase start

# Run migrations
npx supabase db reset

# Start dev server
npm run dev

# Run Edge Functions locally
npx supabase functions serve

# Run tests
npm run test              # unit tests
npm run test:e2e          # playwright tests
```

## EasyPost Test Data

Use these for development (they always work in test mode):

**Test addresses**:
```
From: 388 Townsend St, San Francisco, CA 94107
To: 149 New Montgomery St, San Francisco, CA 94105
```

**Test package**: 10x10x10 inches, 5 lbs, Box

**Expected test rates**: USPS Ground Advantage ~$8-12 (test mode)

## Stripe Test Cards

```
Success: 4242 4242 4242 4242, any future date, any CVC
Decline: 4000 0000 0000 0002
Auth required: 4000 0025 0000 3155
```

## EasyPost Webhook Events (tracked)
- `tracker.updated` with status `in_transit`, `out_for_delivery`, `delivered`, `return_to_sender`

## Stripe Webhook Events (tracked)
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded`

## Label Cancellation / Void

**White-label rule:** Never surface carrier (EasyPost) branding to users. All refund policy text must use "SendMo" language only.

**Policy summary (for UI copy):**
- Labels can be voided before the package is scanned by the carrier.
- Refunds are processed within 2–4 weeks after void confirmation.
- Credits are applied to the user's SendMo account balance.

**Eligibility guards (enforced in `cancel-label` function):**
- `shipment.status` must be `label_created` (not in_transit, delivered, etc.)
- `shipment.refund_status` must be `none` (no prior void attempt)
- `easypost_shipment_id` must be present

**Admin usage:** `/admin` → Actions column → "Void" button → `CancelLabelModal`
**User-facing:** Planned for post-MVP production launch.

---

## Admin Mode (Test/Live Toggle)

`/admin` is PIN-gated (PIN: `2026`). After entering the PIN, `sessionStorage.sendmo_admin` is set to `true`.

When admin session is active, `/onboarding` shows a floating toolbar at bottom-right with two modes:
- **Test** (default): Uses EasyPost test key. Generates dummy labels. Free.
- **Live Comp**: Passes `live_mode: true` to Edge Functions. Uses EasyPost live key. Generates real, printable labels. Costs real money on EasyPost. No Stripe charge (comp).

**To create a real label for someone:**
1. Go to `/admin` → enter PIN `2026`
2. Go to `/onboarding` → select "Live Comp" in the floating toolbar
3. Complete the Full Prepaid Label flow as normal
4. The generated PDF is a real shipping label

**TODO (before launch):**
- Replace hardcoded PIN with `profile.role === 'admin'` check (requires auth)
- Add server-side admin token validation on Edge Functions
- Add `payment_method: 'comp'` support in the payments table

---

## Logging & Observability (Agent Query Guide)

### Overview

All Edge Functions write structured events to the `event_logs` table via the `ingest` function.
Use **Supabase SQL Editor** (service role) to query this table for debugging.

**Key facts:**
- Written by: `addresses`, `rates`, `labels` functions (and future functions)
- Retention: 90 days (pg_cron purge, transactional tables kept indefinitely)
- Auth: written via service role — no RLS restrictions on writes
- Log helper: `supabase/functions/_shared/logger.ts`

### Event Taxonomy

| event_type | source | When emitted |
|---|---|---|
| `address.verified` | addresses fn | Successful EasyPost verification |
| `address.soft_warning` | addresses fn | EasyPost accepted but couldn't confirm delivery |
| `address.hard_error` | addresses fn | Address rejected (Google or EasyPost) |
| `address.google_fallback` | addresses fn | EasyPost rejected but Google-verified → accepted with warning |
| `rate.fetched` | rates fn | EasyPost returned ≥1 rates successfully |
| `rate.no_results` | rates fn | EasyPost returned 0 rates (with carrier messages) |
| `rate.error` | rates fn | EasyPost returned an error response |
| `label.created` | labels fn | Label successfully purchased |
| `label.buy_error` | labels fn | EasyPost label buy call failed |
| `label.endshipper_error` | labels fn | EndShipper creation failed |

### How to Instrument a New Edge Function

```typescript
import { log } from "../_shared/logger.ts";

// Basic event
await log({
  event_type: "my_function.success",
  session_id: sessionId,          // from req.headers.get("x-session-id")
  severity: "info",               // "info" | "warn" | "error"
  entity_type: "label",           // what entity this relates to
  entity_id: someId,
  duration_ms: Date.now() - start,
  properties: { /* any useful debug fields */ },
});
```

**Rules:**
1. Always pass `session_id` — it's the primary debug join key
2. Always measure `duration_ms` for external API calls (EasyPost, Stripe, etc.)
3. Use `severity: "error"` only when the **caller receives an error response**
4. `log()` is fire-and-forget — never `await` it on the critical path if latency matters
5. Never log secrets, card numbers, or PII (names, emails) in `properties`

### Investigation Queries (Copy-Paste)

```sql
-- ① What happened in a specific session? (full timeline)
SELECT event_type, severity, properties, created_at
FROM event_logs
WHERE session_id = 'SESSION_ID_HERE'
ORDER BY created_at;

-- ② What address types fail most? (agent debugging)
SELECT
  properties->>'address_type'  AS addr_type,
  properties->>'error_source'  AS error_source,
  properties->>'error_message' AS reason,
  count(*) AS occurrences
FROM event_logs
WHERE event_type = 'address.hard_error'
  AND created_at > now() - INTERVAL '7 days'
GROUP BY 1,2,3 ORDER BY 4 DESC;

-- ③ How often does the Google fallback fire? (address robustness metric)
SELECT
  count(*) FILTER (WHERE event_type = 'address.google_fallback') AS fallbacks,
  count(*) FILTER (WHERE event_type = 'address.verified')        AS verified,
  round(100.0 *
    count(*) FILTER (WHERE event_type = 'address.google_fallback') /
    nullif(count(*) FILTER (WHERE event_type = 'address.verified'), 0), 1
  ) AS fallback_pct
FROM event_logs WHERE created_at > now() - INTERVAL '7 days';

-- ④ Addresses flagged as PO Box or military (carrier restriction audit)
SELECT
  properties->>'input_street1' AS street1,
  properties->>'input_zip'     AS zip,
  properties->>'address_type'  AS addr_type,
  created_at
FROM event_logs
WHERE event_type IN ('address.verified', 'address.soft_warning')
  AND (properties->>'is_po_box' = 'true' OR properties->>'is_military' = 'true')
ORDER BY created_at DESC LIMIT 50;

-- ⑤ EasyPost rate fetch latency distribution
SELECT
  min(duration_ms)  AS p0,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
  max(duration_ms)  AS p100
FROM event_logs
WHERE event_type = 'rate.fetched'
  AND created_at > now() - INTERVAL '24 hours';

-- ⑥ Label failures by carrier
SELECT
  properties->>'carrier'       AS carrier,
  properties->>'error_message' AS error,
  count(*) AS failures
FROM event_logs
WHERE event_type = 'label.buy_error'
  AND created_at > now() - INTERVAL '7 days'
GROUP BY 1,2 ORDER BY 3 DESC;

-- ⑦ Rate fetch with 0 results — why are carriers rejecting?
SELECT
  properties->'carrier_messages' AS carrier_messages,
  properties->>'from_zip'        AS from_zip,
  properties->>'to_zip'          AS to_zip,
  created_at
FROM event_logs
WHERE event_type = 'rate.no_results'
ORDER BY created_at DESC LIMIT 20;

-- ⑧ All errors in the last hour (quick health check)
SELECT event_type, session_id, properties->>'error_message' AS msg, created_at
FROM event_logs
WHERE severity = 'error'
  AND created_at > now() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

### Future: ClickHouse Migration Path

When `event_logs` exceeds ~5M rows or query performance degrades, migrate to ClickHouse Cloud.
**Recommended path (Option B):** add a pg_cron export job that batches new rows to ClickHouse HTTP API every 5 minutes.
No changes to the `ingest` function or Edge Function instrumentation.
See PRD.md §23 for full architecture.

---

*Last updated: 2026-03-19 | PRD version: 6.1*

## Documentation Structure

**Three-file knowledge system:**

| File | Purpose |
|------|---------|
| `PRD.md` | Product requirements — vision, flows, UI specs, rate tables, phased execution |
| `CLAUDE.md` | Developer instructions — tech stack, repo structure, env vars, design tokens, agent roles |
| `DECISIONS.md` | Decision log — *why* choices were made, integration gotchas, hard-won debugging knowledge |

Archived reference docs live in `_archive/` — see PRD.md Appendix B for index.
