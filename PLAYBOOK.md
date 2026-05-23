# SendMo — Project Playbook
> **Agents: read before every session:**
> 1. Read `../CLAUDE.md` (AI Brain global context) — services, credentials protocol, global rules.
> 2. Read this entire file (`PLAYBOOK.md`) — developer instructions, architecture, rules.
> 3. Read `SPEC.md` — product requirements, flows, acceptance criteria.
> 4. Read `LOG.md` — *why* decisions were made, integration gotchas, hard-won debugging knowledge.
>
> At the **end of every session**, propose updates to `LOG.md`, `PLAYBOOK.md`, or `../CLAUDE.md` for anything new discovered. If nothing changed, say "No doc updates needed this session."

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
├── PLAYBOOK.md                  # THIS FILE — read every session
├── LOG.md                        # Decisions & deploy history
├── .env.tpl                     # op:// secret references (committed)
├── .env.example                 # Template showing var names
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
│   │   ├── AppHeader.tsx        # Shared persistent nav header (auth-aware, used by all pages)
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
RESEND_API_KEY=...              # Must also be set as Supabase secret for Edge Functions

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
DisplayPrice = EasyPostRate × 1.15 + $1.00   (standard, credit card)
DisplayPrice = EasyPostRate × 1.10 + $1.00   (SendMo Balance — post-MVP)
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

See `supabase/migrations/001_initial_schema.sql` for the base schema, `002_add_refund_fields.sql` for label refund columns, and `017_stripe_phase_a_transactions_ledger.sql` for the Stripe Phase A ledger.

**Core tables:** `profiles`, `addresses`, `sendmo_links`, `shipments`, `balances`, `webhook_events`, `event_logs`, `notification_contacts`, `notifications_log`, `email_verifications`.

**Stripe Phase A ledger** (migration 017, shipped 2026-05-12 — the legacy `payments` table was dropped):

| Table | Role |
|-------|------|
| `transactions` | **Append-only money-movement ledger (Rule 16).** Signed `amount_cents` (+ = SendMo gains, − = SendMo loses). REVOKE UPDATE/DELETE + trigger enforce immutability. Writer map (amended migration 032 — see [proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md](proposals/2026-05-22_reconciliation-and-carrier-adjustments_reviewed-2026-05-22_decided-2026-05-22.md) §2.1): `charge` / `refund` / `refund_fee_recovered` / `fee_stripe` / `chargeback` → `stripe-webhook` (sole writer, unchanged); `comp_grant` → `labels` (unchanged); **`label_cost`** → **`labels`** (added migration 032 — SendMo paid EasyPost for the label, negative); **`easypost_refund`** → **`webhooks` (refund.successful push) + `tracking` (lazy poll)** (added migration 032; idempotency keyed on EasyPost Refund object id `rfnd_…` — whichever writer lands first wins, collision = safe no-op); **`carrier_adjustment`** → **`webhooks` ShipmentInvoice handler** (added H2 — `shipment.invoice.created/updated` arm; idempotency keyed on EasyPost ShipmentInvoice id `si_…`; recovery dispatched per the tiered policy in `_shared/adjustments.ts`); `reconciliation-sweep` (reserved for H4 — sweep fires `resolveRecovery` for adjustments found via the pull path). |
| `stripe_intents` | Stripe PaymentIntent / SetupIntent state mirror (NOT the ledger). UPSERTed by the webhook. `transfer_group` is the Phase-3 Connect seam (`sm_<shipment_id>`). |
| `payment_methods` | Saved cards / ACH for Phase B+. Soft-delete via `deleted_at`. |
| `holds` | Flex-link manual-capture authorizations (Phase E). |
| `refunds` | Mirror of Stripe Refund objects (Phase F). |
| `carrier_adjustments` | Post-pickup rate adjustments from EasyPost (Phase G recovery loop). |
| `user_wallet_balance` (view) | Derived per-(user, mode) balance from `transactions`. Read by Phase 2 wallet UI. |

Also shipped in 017: `shipments.payment_method` (`card`/`balance`/`split`/`comp`/`us_bank_account`), `shipments.stripe_payment_intent_id`, `shipments.escrow_id` (Phase-3 slot), `sendmo_links.is_test` (server-derived per round-1 B3), `profiles.stripe_customer_id_test` / `_live`.

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
| POST | `/api/email` | No | `{ action: "send", email }` or `{ action: "confirm", email, code }` |
| GET | `/api/tracking?number=XXX` | No | Public tracking lookup (non-PII fields only) |
| POST | `/api/webhooks` | Webhook sig | EasyPost tracker.updated events |
| POST | `/api/webhooks/stripe` | Webhook sig |

## Agent Roles & Responsibilities

When working as a Claude Code agent, you may be assigned one of these roles:

### Backend Agent
- Writes Supabase Edge Functions (Deno/TypeScript)
- Implements EasyPost integration (addresses, rates, labels, tracking)
- Implements Stripe integration (payment intents, capture, refunds)
- Writes DB migration SQL

### Frontend Agent
- Writes React/TypeScript components
- Follows design system STRICTLY (no deviations from color tokens)
- Implements Framer Motion animations
- Uses shadcn/ui components

### Test Agent
- Writes Vitest unit tests for business logic
- Writes Playwright e2e tests for critical flows
- Writes integration tests for API endpoints
- Maintains CI/CD pipeline (GitHub Actions)

### Database Agent
- Writes Supabase SQL migrations
- Defines RLS policies
- Creates indexes for performance
- Documents schema changes

## Current Phase: Phase 1 MVP

**Goal**: Full Prepaid Label path working end-to-end first, then Flexible Link path.

**Priority**: Live label for John's mom → Auth UI → Flexible Link → Sender flow

**Current status (as of 2026-03-18)**:
- [x] Backend Edge Functions deployed and working (addresses, rates, labels, cancel-label, admin-report, autocomplete, place-details, ingest, test-db-insert, email, webhooks, tracking)
- [x] Database schema applied (11 migrations on remote Supabase — includes email_verifications, notification_contacts, notifications_log)
- [x] LabelTest page working (test harness for backend APIs)
- [x] Admin page working (PIN-gated, reporting + label void)
- [x] **Recipient onboarding flow (Full Prepaid Label path)** — Steps 0→1→10→11(verify)→12(payment)→13(label); step 11 is the Supabase OTP confirm-email step inserted 2026-05-11 (auto-skipped for authenticated users); real Stripe + EasyPost test rates
- [x] Admin test/live toggle — floating toolbar on /onboarding (Test | Live Comp | Live Charge, since 2026-05-11)
- [x] Magic Guestimator — 15 item types + urgency keywords, client-side
- [x] Landing page (hero, how it works, value props, use cases, CTA, footer)
- [x] Service name polish — 30+ EasyPost service name mappings + camelCase fallback
- [x] **Vercel production deploy** — sendmo.co live, auto-deploys from GitHub `main`, env vars configured
- [x] **Domain setup** — sendmo.co → Vercel (A record 76.76.21.21), www.sendmo.co CNAME, wind.sendmo.co → coyote-wind
- [x] **EasyPost live key** — set as Supabase secrets (EASYPOST_API_KEY + EASYPOST_TEST_API_KEY)
- [x] **Comp label ledger** — migration 009 adds `payment_method` column ('card'|'balance'|'comp')
- [x] **Auth UI (link + OTP code login)** — Supabase Auth with both magic-link and 6-digit OTP paths. `/login` has Google CTA + email field; success view has a 6-digit input plus the link-in-email option. Magic-link email template ("Confirm your email for SendMo") emits both `{{ .Token }}` and `{{ .ConfirmationURL }}` so users pick whichever is faster. Custom SMTP via Resend (sendmo.co domain verified 2026-05-12). ProtectedRoute + AuthContext auto-create profile on first sign-in. ?welcome=1 query-param triggers a one-shot "Signed in as X" banner on /dashboard for any auth handoff (magic-link click, Google return, /login OTP-verify).
- [x] **Dashboard with real data** — connected to Supabase via AuthContext, shows shipment history for authenticated user, user menu with sign out
- [x] **Recipient onboarding flow (Flexible Link path)** — Steps 20-23: shipping preferences, email OTP verification, payment (stubbed), link activated view
- [x] **E2E tests (Playwright)** — 12 tests covering home, admin, auth, onboarding, 404
- [x] **Unit tests** — 145 tests across 14 files, all passing
- [x] **Email notifications (Resend)** — OTP verification, label confirmation, tracking updates. Edge Functions deployed (`email`, `webhooks`), sendmo.co domain verified, API key set as Supabase secret.
- [x] **Shipping notifications (sender + recipient)** — Notification dispatcher with channel-based routing (email now, SMS/push extensible). notification_contacts + notifications_log tables (migration 011). Role-aware email templates with ETA, carrier, and "Track Package" button. Public tracking page at `/track/:trackingNumber`.
- [x] **Sender flow (5-step wizard at /s/:shortCode)** — 2026-05-11: Intro → Package → Rates → Review → Done. Routes around blocked Stripe Phase E via hardened comp-only path (admin-JWT-or-active-flex-link gate, server-resolved to_address + recipient_email, server-derived cap enforcement). See LOG entry 2026-05-11 "Sender flow wizard". Components in `src/components/sender/`.
- [x] **Stripe Phase A — `transactions` ledger** (shipped 2026-05-12, migration 017): legacy `payments` table dropped; append-only `transactions` ledger + `stripe_intents`, `payment_methods`, `holds`, `refunds`, `carrier_adjustments` tables stood up; `stripe-webhook` is the sole writer for charge/refund/chargeback rows; comp labels now book negative margin. Unblocks Phases B/C/D/E/F/G/H. See LOG entry "Stripe Phase A — `transactions` ledger" and [proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md).
- [x] **Stripe Phase B — save card on file** (shipped 2026-05-13, commit `541f0b9`): `/payment-methods` Edge Function (POST creates SetupIntent, DELETE detaches); `stripe-webhook` now handles `setup_intent.succeeded` + `payment_method.attached` + `payment_method.detached`; Dashboard wallet card lists saved cards with brand/last4/exp + Add/Remove. Migration 022 introduces `profiles.admin_active_mode` (server-trusted) + `set_admin_active_mode()` RPC, replacing the client-supplied mode pattern. AppHeader gains a global 3-mode admin toolbar. WISHLIST "Real wallet card on Dashboard" closes. See LOG 2026-05-13 "Stripe Phase B + Phase C" and [proposals/2026-05-13_phase-b-saved-cards-implementation_reviewed-2026-05-13_decided-2026-05-13.md](proposals/2026-05-13_phase-b-saved-cards-implementation_reviewed-2026-05-13_decided-2026-05-13.md).
- [x] **Stripe Phase C — live charge dogfood gate** (shipped 2026-05-13): `payments/index.ts` now derives `isLive` server-side from `profile.admin_active_mode === 'live_charge'` (no longer trusts the client `live_mode` param per Rule 14) AND enforces a `PAYMENTS_ALLOWED_USERS` env-var allowlist of UIDs allowed to charge live. Empty allowlist = closed. The manual dogfood half of Phase C (5 successful self-charges, penny-correct reconciliation, void→refund test) is John's bar to meet — code in place.
- [x] Server-side admin token validation — `requireAdmin` helper + `profiles.role` (shipped 2026-05-11 via migration 016)

**What exists on disk but is a stub**:
- `src/pages/SenderFlow.tsx` — placeholder text (needs 5-step sender wizard)
- `src/components/sender/` — empty directory
- `src/components/recipient/RecipientStepFlexPayment.tsx` — Stripe payment stubbed with mock form

**Live production URL**: https://sendmo.co (auto-deploys from GitHub `main`, also accessible at sendmo.vercel.app)
**Loveable prototype reference**: https://sendmo.lovable.app (still live, use for visual reference only — production builds from SPEC specs)

## Critical Rules for All Agents

1. **No `.env.local` files** — use `op run --env-file=.env.tpl -- <command>` to inject secrets at runtime. If a `.env.local` exists, delete it.
2. **NEVER** expose `SUPABASE_SERVICE_ROLE_KEY` to frontend code
3. **ALWAYS** use EasyPost TEST key (`EZTKxxxx`) during development
4. **ALWAYS** use Stripe test mode (`pk_test_`, `sk_test_`) during development
5. **ALWAYS** validate inputs server-side in Edge Functions (client-side is UX only)
6. **ALWAYS** use Stripe Elements — never handle raw card numbers
7. **NEVER** show recipient's address in sender UI (privacy requirement)
8. **ALWAYS** verify webhook signatures (Stripe + EasyPost)
9. **ALWAYS** use RLS — all DB access scoped to authenticated user
10. **ALWAYS** write a test before marking a feature complete
11. **ALWAYS** adhere strictly to the testing strategy defined in `SPEC.md` Section 22.
12. **ALWAYS** write a regression test when fixing a bug based on what was learned, before implementing the fix.
14. **ALWAYS** derive critical decisions (pricing, refund eligibility, test/live mode) from server-side state (DB, env vars) — **NEVER** trust client-provided parameters for these determinations.
15. **ALWAYS** anticipate "Phase 3 Escrow" (money transmission) when altering `payments` or `shipments`. Ensure enum constraints are easily expandable for future `escrow` states.
16. **NEVER** use simple `UPDATE` statements for modifying financial balances. **ALWAYS** utilize immutable, append-only ledger tables (e.g., `transactions`) for tracking money movement (funding, holds, disputes, fees, releases) due to strict money transmission regulations and required audit trails.
17. **ALWAYS** add a `LOG.md` entry when merging to `main`. Every push to `main` is a production deploy. Follow the template in `LOG.md`. Include: what shipped, files changed, test counts, breaking changes, and notes for future agents.
18. **ALWAYS** run `npx tsc -b --noEmit` before pushing to `main`. Vitest/esbuild strips types without checking them — only `tsc` catches unused imports, type errors, etc. A passing test suite does NOT mean the Vercel build will succeed.
19. **ALWAYS** browser-verify product-surface fixes — agent confidence is not a substitute. Every `Category` involving a fix or ship that touches `src/components/**`, `src/pages/**`, `supabase/functions/**` (Edge Function response shapes consumed by UI), or any rendered surface must include a structured `Browser-verified:` block in the LOG entry. Three valid shapes, **exactly one** per entry — no free-text "I'm confident" path exists:

    ```
    Browser-verified:
      spec: tests/e2e/<path>.spec.ts
      variants-covered: [<list of variants exercised>]
    ```

    ```
    Browser-verified:
      mcp-session: <snapshot/screenshot artifact path or transcript excerpt>
      variants-covered: [<list of variants exercised>]
    ```

    ```
    Browser-verified:
      n/a-category: pure-logic | agent-internal | infra | copy-only | migration
      n/a-reason: <one line — why no DOM/wire-shape consumer is affected>
    ```

    **Variant axis discipline:** verify *the variants of the changed code path*, not just the one named in the bug report. For SendMo this typically looks like `{full-prepaid, flexible-link} × {test-mode, live-comp, live-charge}` for payment paths, or `{label_created, in_use, cancelled, completed}` for shipment-lifecycle paths. If you can't name the variant axis, the fix is broader than you've modeled — stop and trace.

    **`agent-internal` is the most-abused enum slot.** Before claiming it, ask: can a stream-fixture, integration test, or non-browser-but-deterministic test verify the contract? If yes, wire it (Browser-verified becomes `spec:`, not `n/a-category:`). Agents proposing `agent-internal` MUST name the tighter alternative considered and explain why it's infeasible or not worth the cost. Ducking the alternative is the rationalization shape the rule exists to catch.

    **Mechanical enforcement:** the `Stop` hook in `.claude/settings.json` (`scripts/claude-hooks/check-browser-verified.sh`) scans modified paths at session close and prints a reminder if product-surface globs were touched but no `Browser-verified:` block is detected. Advisory — exits 0 — but the LOG entry needs the field to satisfy Rule 19.

    **Slash commands** in `.claude/commands/`: `/runtest` (quick pass/fail), `/verifyfix <commit-or-path>` (daily-use, forces variant-axis naming + tighter-rigor-or-defend discipline), `/buildtest <bug>` (author a new spec with regression-proof validation).

    **Sibling on AgentEnvoy:** PLAYBOOK Rule 29. Same empirical basis: agent confidence was the failure mode in 4 of 4 catchable bugs from the 2026-05-13 AgentEnvoy cluster. Cross-project proposal: [`agentenvoy/proposals/2026-05-13_claude-production-verification-infra_reviewed-2026-05-13_decided-2026-05-13.md`](../agentenvoy/proposals/2026-05-13_claude-production-verification-infra_reviewed-2026-05-13_decided-2026-05-13.md).

20. **Telemetry before browser.** When a user reports "I'm stuck on / not seeing / something's not working" and the symptom touches a state machine, edge function, or auth surface, **query DB and edge-function logs in the first 1-2 turns**, before asking the user to inspect DevTools / Network / sessionStorage / localStorage. Concretely:
    - **Supabase MCP connected?** Run the most relevant `SELECT` for the affected table(s). For onboarding flows: query `sendmo_links` / `shipments` / `payment_methods` filtered by the user's `user_id` and `created_at > now() - interval '1 hour'`. For payment flows: also pull `stripe_intents` and `transactions`.
    - **`mcp__supabase__get_logs` available?** Pull `edge-function` logs — recent POST/GET status codes against the relevant function paths almost always tell you whether the client even made the call, whether the server returned 2xx/4xx/5xx, and at what cadence.
    - **`event_logs` table** (`public.event_logs`) — search by `entity_id` / `entity_type` / `event_type ILIKE '%<surface>%'` for the affected flow. Edge functions log generously here.

    Only after telemetry rules out server-side behavior should you fall back to "check your browser." Inverting this order — asking the user to clear storage + open DevTools as the first move — burns a lot of conversation context and consistently misses the actual cause when the actual cause is server-visible.

    **Generalizable shape:** "system claims success, user reports failure" → **server telemetry first**. "system shows error, user reports error" → client inspection first. The first shape is the dangerous one — it's exactly the case where the user's mental model and the system's reality have diverged, and the divergence point is almost always visible in the logs/DB.

    **Reference incident:** [LOG.md → 2026-05-19 navigate vs setData race entry](LOG.md). The symptom was "user stuck on `/onboarding/flexible/authorize`," and 30 minutes were spent on "clear sessionStorage / check DevTools" before the actual cause (`<Navigate>` bounce in the page guard) showed up clearly in a 5-second `SELECT` against `sendmo_links` + a 5-second `get_logs` call. The smoking-gun pattern (link created as `'active'` + immediate `POST /payment-methods` + user still on same URL) would have surfaced on turn 1 with telemetry-first.

21. **ALWAYS verify the deploy after pushing to `main`.** Every push to `main` triggers a production deploy (Vercel) and CI workflows. A push is **not "done"** until those are confirmed green — a red deploy is a production failure, not a finished task. After any push to `main`:
    - **Vercel** — confirm the production build at https://sendmo.co went live. Vercel's result is mirrored as a GitHub commit status (context `Vercel`) on the pushed SHA, so it shows up in the checks below.
    - **GitHub Actions** — run `gh run list --branch main --limit 5` and confirm the workflows for *your* commit are green: **"Provide Tests"** (lint / `tsc -b` / unit / e2e — note a `tsc -b` failure also breaks the Vercel build) and **"Deploy Supabase Edge Functions"** (only runs when `supabase/functions/**` changed).
    - CI takes ~12 min. Wait for a **conclusive** result — `gh run watch <run-id>` or re-check — rather than ending the session on a still-running run. A pending run is not a green run.
    - If anything is red — a `tsc -b` error, a failed edge-function deploy, a red Vercel build — the work is **not** done. Fix forward immediately. Do not end the session on a red `main`.

    **Reference incident:** 2026-05-21 — a `tsc -b` error sat red on Vercel + CI for ~18h across 5 pushes because no agent verified the deploy after pushing.

    **Mechanical enforcement:** the `Stop` hook `scripts/claude-hooks/check-deploy-green.sh` (registered in `.claude/settings.json`) queries the GitHub check-runs + commit statuses for the current `main` HEAD at session close and prints any red/pending result. Advisory — exits 0 — but a red or pending result means Rule 21 is not yet satisfied.

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

# Start dev server (always use op run for secrets)
op run --env-file=.env.tpl -- npm run dev

# Run Edge Functions locally
npx supabase functions serve

# Run tests
npm run test              # unit tests
npm run test:e2e          # playwright tests
```

## E2e Testing (Playwright)

> Convention established 2026-05-20. Specs live in `tests/e2e/*.spec.ts`; config in `playwright.config.ts`.
>
> **Full test-infra map:** [`TESTING.md`](TESTING.md) — all four test layers (unit / integration / e2e / browser-verify), the run commands, and which ones hit real services. This section below remains the authoritative source for **e2e conventions** specifically.

### How specs are organized

- **Default axis — by user flow.** One spec per flow/surface: `onboarding.spec.ts`, `sender-flow.spec.ts`, `admin.spec.ts`, `tracking-*.spec.ts`. A new test goes in the spec for the flow it exercises.
- **Exception — cross-cutting regression specs.** A *small, named* set of specs may be organized by a load-bearing invariant that spans flows — **only** when that invariant is proven-fragile. The bar: spans ≥3 flows AND has a real regression history. Current (only) example: `phone-gate.spec.ts` — the phone requirement broke 4× across 4 surfaces, so one spec proves the gates hold everywhere. Don't add by-concern specs casually.
- **No mega-spec.** Playwright parallelizes by file; one giant spec is slow and hides failures.

### Writing specs

- **Mock every Edge Function** via `page.route` — no real EasyPost/Stripe/Google/DB traffic. Reference pattern: `mockEdgeFunctions` in `phone-gate.spec.ts`.
- **Stable locators only** — ids (`#origin-name`), roles + accessible names. Never match incidental copy: a `/Ship from/i` text match silently rotted when a heading was reworded.
- Naming: `<flow>.spec.ts`, kebab-case.

### Local setup

- `.env.local` (gitignored via `*.local`) needs `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` — both publishable/public — so the Vite dev server boots. `npx playwright test` starts the server itself.

### Authenticated specs

- `tests/e2e/global-setup.ts` mints a real Supabase session for a dedicated test user (GoTrue password grant) → `playwright/.auth/user.json` (gitignored — it holds a real token).
- Requires `E2E_TEST_USER_EMAIL` / `E2E_TEST_USER_PASSWORD` in `.env.local` + CI secrets. Absent → `global-setup` is a no-op and authed `describe`s skip themselves; the suite stays green. Pattern: the `/links/new` describe in `phone-gate.spec.ts`.

### Suite health & known gaps (snapshot 2026-05-20, post-de-rot)

The locator-drift de-rot pass is **complete** — the mocked e2e suite is green (38 passed / 6 skipped / 0 failed). Triage:

- **Green / trustworthy:** the full mocked suite — `phone-gate`, `onboarding` (now also carries the consolidated full-label coverage: validation gates, Magic Guestimator, back-nav), `auth`, `auth-section-and-flex-otp`, `admin`, `not-found`, `label-flow`, `sender-flow`, `tracking-lifecycle-states`, `tracking-anonymous-payment-gating`, `home`.
- **Deleted:** `full-label-flow.spec.ts` — overlapped `onboarding.spec.ts`; unique coverage was moved there, then it was removed.
- **Not part of the mocked suite — leave alone:** `url-step-routing.spec.ts` (churn from in-progress `feat/url-step-routing` work); `buy_label_debug.spec.ts`, `playwright_verify.spec.ts`, `cors_verify.spec.ts` (hit real services).
- **Honestly skipped:** `sender-flow` valid-link tests (need `SENDMO_TEST_LINK_CODE`); the authed `/links/new` + `tracking-anonymous-payment-gating` describes (need `E2E_TEST_USER_*` / real services).
- **Coverage gaps:** the OTP → payment → label tail of full-label onboarding (needs OTP interception); `/admin`'s reporting page (needs an admin-role session, not just any authed user); `/label-test`'s label step is broken against the live backend — the `labels` function now requires `payment_intent_id` (see LOG 2026-05-20).

**Rule:** a red e2e spec is worse than none — people stop trusting the suite. When you touch a flow, fix or honestly scope its spec; never leave it red.

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

## Admin Mode (Test / Live Comp / Live Charge)

`/admin` requires the signed-in user's profile to have `role='admin'`. The hardcoded `2026` PIN was removed 2026-05-11; gate is now `requireAdmin()` in [`supabase/functions/_shared/auth.ts`](supabase/functions/_shared/auth.ts) (server-side) + `useAuth().isAdmin` (client-side).

When admin session is active, the app shell (AppHeader) shows a 3-mode toolbar to the left of the user menu, visible on every page (Phase B B2 fix, 2026-05-13 — replaces the floating toolbar that was scoped to `/onboarding` only). Mode is server-trusted via `profiles.admin_active_mode` + the `set_admin_active_mode()` RPC; the client never sends a mode param. Three modes (per Stripe proposal §6 Phase C, decided 2026-05-11):

- **Test** (default): EasyPost TEST API + Stripe TEST mode. Fake label, test cards. Free.
- **Live Comp** (amber): EasyPost LIVE API + **no Stripe charge**. Real, printable label; SendMo eats the EasyPost cost. Recorded as `payment_method=comp` in the admin report. Use for dogfood, friends-and-family, marketing comps. Requires admin JWT — the labels function's `comp:true` path is gated on `profile.role='admin'`.
- **Live Charge** (red): EasyPost LIVE API + real Stripe charge. Real money moves end-to-end. Phase C self-charge mode — dogfood the real payment + reconciliation path before public launch.

**Prior to 2026-05-11 the toolbar had only 2 modes ("Test" + "Live Comp"), and "Live Comp" actually charged the card in Stripe live mode** — a long-standing mismatch with the PLAYBOOK's documented intent. The 3-mode rework brings code in line with what was always documented and adds the explicit Live Charge mode the Stripe proposal calls for.

**To generate a real comp label** (no money moves):
1. Sign in with your admin account → go to `/admin` (loads the report directly, no PIN).
2. Go to `/onboarding` → select **Live Comp** in the floating toolbar.
3. Complete the Full Prepaid Label flow as normal.
4. At the payment step you'll see an amber "Generate Comp Label" button (not Stripe Elements). Click it.
5. The generated PDF is a real shipping label.

**To dogfood a real charge** (your card actually gets billed):
1. Same as above but pick **Live Charge** in the toolbar.
2. Use your real card in the Stripe Elements form. The "LIVE" badge will be red.
3. Verify the charge in your bank within minutes; verify it reconciles in the admin report.

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
| `refund.admin_initiated` | refunds fn | Admin issued a Stripe refund via `/refunds` (H3 — info severity) |
| `refund.admin_initiated_failed` | refunds fn | Admin refund Stripe call failed (H3 — error severity) |
| `refund.failed` | stripe-webhook | Stripe `charge.refund.updated` with `status='failed'` — card couldn't accept refund (H3 D1 — error severity) |
| `refund.failed_alert_email_error` | stripe-webhook | The admin alert email for a failed refund itself failed to send (H3 — error severity) |

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
See SPEC.md §23 for full architecture.

---

*Last updated: 2026-03-30 | SPEC version: 6.1*

## Documentation Structure

**Four-file knowledge system:**

| File | Purpose |
|------|---------|
| `SPEC.md` | Product specifications — vision, flows, UI specs, rate tables, phased execution |
| `PLAYBOOK.md` | Developer instructions — tech stack, repo structure, env vars, design tokens, agent roles |
| `LOG.md` | Decision & deploy log — *why* choices were made, integration gotchas, hard-won debugging knowledge, and deployment history |
| `CLAUDE.md` (thin harness) | Claude agent entry point — links to Brain-level context and project PLAYBOOK |

Archived reference docs live in `_archive/` — see SPEC.md Appendix B for index.
