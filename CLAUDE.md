# SendMo — Claude Code Agent Instructions

> Read this file at the start of EVERY session. This is the single source of truth for all agents.

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
│   │   ├── recipient/           # RecipientStep*.tsx components
│   │   ├── sender/              # SenderStep*.tsx components
│   │   └── ui/                  # shadcn/ui components
│   └── lib/
│       ├── api.ts               # API client helpers
│       ├── types.ts             # Shared TypeScript types
│       └── utils.ts             # Utilities
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
VITE_SHORT_LINK_BASE=sendmo.co/s
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

Key tables: `profiles`, `addresses`, `sendmo_links`, `shipments`, `payments`, `balances`, `webhook_events`

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

**Goal**: Both recipient paths (Full Label + Flexible Link) working end-to-end with real APIs.

**Done when**:
- [ ] Recipient can create a full prepaid label (with real EasyPost label PDF)
- [ ] Recipient can create a flexible shipping link  
- [ ] Sender can use the link to generate a label
- [ ] Stripe captures real payment
- [ ] Dashboard shows shipment history
- [ ] Email notifications working

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

---

*Last updated: 2026-02-24 | PRD version: 6.1*
