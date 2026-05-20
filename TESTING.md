# SendMo — Testing Map

> A one-page index of SendMo's test infrastructure: what each layer is, how to
> run it, and where the authoritative detail lives. This is a **map, not a
> manual** — conventions live in the linked sections so they don't get
> duplicated (and rot) here.

## Quick reference

| Command | What it runs | Hits real services? |
|---|---|---|
| `npm test` | Unit + e2e (the everyday check) | No |
| `npm run test:unit` | Unit tests only — fast | No |
| `npm run test:unit:watch` | Unit tests in watch mode | No |
| `npm run test:coverage` | Unit tests + coverage report | No |
| `npm run test:e2e` | Playwright e2e suite | Mostly no — see below |
| `npm run test:e2e:ui` | Playwright in interactive UI mode | Mostly no |
| `npm run test:integration` | API + EasyPost integration tests | **YES — real DB + EasyPost** |
| `npm run test:all` | Unit + integration + e2e | **YES (integration leg)** |

`npm test` deliberately **skips** integration — those tests cost real EasyPost
API calls and touch a real database. Run integration explicitly and only when
you mean to.

## The four layers

### 1. Unit tests — `tests/unit/`
- **Runner:** Vitest (`vitest.config.ts`), jsdom environment, no network.
- **Scope:** individual components (`*.test.tsx`) and lib functions (`*.test.ts`) — pricing, phone formatting, validation, step routing, etc.
- **Run:** `npm run test:unit`. This is the fast inner loop.

### 2. Integration tests — `tests/integration/` ⚠️
- **Runner:** Vitest (`vitest.integration.config.ts`) for the API tests; a plain Node script (`easypost-test.mjs`) for the EasyPost checks.
- **Scope:** real round-trips against the database and the EasyPost **test** API — flex-link API, recipient-flow API, label rating.
- **⚠️ Danger:** these connect to a **real database**. On 2026-05-04 an integration run pointed at a *production* connection string truncated every row in prod. Before running, verify the target DB is local/test (see `~/AI Brain/CLAUDE.md` → Credential Access Protocol → Rule 0.5). Never run these against prod.

### 3. End-to-end tests — `tests/e2e/`
- **Runner:** Playwright (`playwright.config.ts`), real Chromium. The dev server (`npm run dev`, port 5173) is started automatically.
- **The mocked suite (default):** every Supabase Edge Function call is intercepted with `page.route` — no real EasyPost/Stripe/Google/DB traffic. This is the suite you keep green.
- **Real-service specs (NOT part of the mocked suite):** `buy_label_debug.spec.ts`, `playwright_verify.spec.ts`, `cors_verify.spec.ts` hit live services — run them deliberately, not in the everyday check.
- **Setup:** `.env.local` needs `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (both publishable/public) so the dev server boots — the mocked suite needs nothing more. Browser-verifying a **Stripe surface** (the payment step, `/label-test`) additionally needs a real `VITE_STRIPE_PUBLISHABLE_KEY_TEST` (`pk_test_…`, also publishable).
- **Authed specs:** `tests/e2e/global-setup.ts` mints a real session from a dedicated test user. `E2E_TEST_USER_EMAIL` / `E2E_TEST_USER_PASSWORD` are configured in `.env.local` + CI secrets, so the authed `/links/new` phone-gate spec runs (and passes) in CI; absent them, authed specs skip themselves and the suite stays green. Test-user setup is documented in `global-setup.ts`'s header comment.
- **Conventions (authoritative):** `PLAYBOOK.md` → **"E2e Testing (Playwright)"** — how specs are organized (by user flow, with `phone-gate.spec.ts` as the one named cross-cutting regression spec), the stable-locator rule, the mock-everything rule, and the current suite-health snapshot. Read it before adding or fixing an e2e spec.

### 4. Manual browser verification
- For any fix touching a rendered surface (`src/components/`, `src/pages/`, `supabase/functions/`), `PLAYBOOK.md` Rule 19 requires verifying the fix in a real browser before writing the `LOG.md` entry (the `Browser-verified:` block).

## Continuous integration

`.github/workflows/test.yml` ("Provide Tests") runs on every push and PR to `main`: ESLint (non-blocking), `tsc -b`, unit tests, the mocked e2e suite, and a scoped authed-e2e step (real Supabase — the `/links/new` phone-gate spec). `tsc` + unit are **blocking**. The **e2e steps are currently non-blocking** (`continue-on-error`) — a deliberate state while the suite is stabilised; once it's reliably green they should be made blocking.

## Helper skills (slash commands, in `.claude/commands/`)

- **`/runtest`** — run the Playwright e2e suite; quick pass/fail check.
- **`/buildtest`** — author a new Playwright spec for a bug class with full variant coverage.
- **`/verifyfix`** — verify a fix in a real browser per PLAYBOOK Rule 19 before the LOG entry.

## Golden rules

- A red e2e spec is worse than none — people stop trusting the suite. When you touch a flow, fix or honestly scope its spec; never leave it red.
- Mock every Edge Function in the e2e suite; use stable locators (ids, roles), never incidental copy text.
- Never run integration tests against a database you haven't verified is local/test.
