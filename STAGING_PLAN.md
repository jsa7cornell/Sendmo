# SendMo Next Phase (Staging Architecture & MVP Execution)

The following is a detailed, step-by-step master plan for launching the SendMo MVP safely. This plan establishes a hard separation between staging and production environments within a single Vercel repository, introduces a secure Admin mode, guarantees API safety rails, and outlines the frontend and payments tasks.

---

## Part 1: Staging Environment Setup & Architecture

**Goal:** Set up a proper staging environment with two fully isolated databases. Staging should be the default for all non-production deploys (Vercel previews).

### 1. Supabase: Create a Staging Project
We will create a second Supabase project (free tier) to serve exclusively as the staging database for SendMo.
1. **Provision Staging Project:** Create a new Supabase project (e.g., `sendmo-staging`).
2. **Schema Mirroring:** Apply `001_initial_schema.sql` and `002_add_refund_fields.sql` exactly as they exist in production. This includes all tables, RLS policies, functions, and triggers.
3. **Test Data Seeding:** Insert test profiles, addresses, and sample shipments to allow immediate testing in the staging environment without manual data entry.
4. **Migration Strategy Documentation:** Add instructions to `PLAYBOOK.md` and `LOG.md` on how to keep schemas in sync (e.g., using `supabase db push` against distinct linked project references).

### 2. Vercel: Environment Variable Separation
We will use a single Vercel project with environment-level overrides to route traffic safely.
*Note: Since SendMo uses Vite, we will use the `VITE_APP_ENV` prefix instead of `NEXT_PUBLIC_` to ensure variables are exposed to the client bundle correctly.*

**Production Environment (Main Branch):**
- **Supabase URL & Anon Key**: Points to the original Production project (`fkxykvzsqdjzhurntgah`).
- **Supabase Service Role Key**: Production key.
- **EasyPost API Key**: LIVE key.
- **Payment Keys**: Stripe LIVE publishable and secret keys.
- **App Env**: `VITE_APP_ENV=production`

**Preview / Staging Environments (All other branches):**
- **Supabase URL & Anon Key**: Points to the new Staging project.
- **Supabase Service Role Key**: Staging key.
- **EasyPost API Key**: TEST key (`EZTKxxxx`).
- **Payment Keys**: Stripe TEST publishable and secret keys.
- **App Env**: `VITE_APP_ENV=staging`

### 3. Environment Awareness in the Frontend App
It must be visually obvious when you are transacting in the Staging environment to prevent user confusion.
1. **Staging Banner Component:** Create (`src/components/ui/StagingBanner.tsx`).
2. **Logic Check:** A simple, persistent colored bar at the top of the interface that renders *only* if `import.meta.env.VITE_APP_ENV === 'staging'`.
3. **Production Guarantee:** The banner component strictly returns `null` in production. 

### 4. Admin Mode (Per-User, Not Per-Environment)
Admin capabilities must be tied to the user, not the environment, working identically in staging and production.
1. **Database Schema Update:** Add an `is_admin` boolean column (default `false`) to the `profiles` table in **both** Supabase projects.
2. **Backend Security (RLS & Edge Functions):** 
   - Write RLS policies to restrict admin routes/actions to users where `is_admin = true`.
   - Update Edge Functions (like `cancel-label`) to ensure only `is_admin` users can trigger overrides.
3. **Frontend Implementation:**
   - **Nav Indicator:** Add a small badge or icon (e.g., "Admin") in the header when the authenticated user profile has `is_admin: true`.
   - **Admin Panel:** Create a basic gated route at `/admin`. If a non-admin attempts to access it, they are redirected to `/dashboard`.
   - *Note: We will not build a UI to manage admin users yet. We will set the `is_admin` flag manually via the Supabase SQL editor.*

### 5. Safety Guardrails (Zero Tolerance for Key Mismatches)
We must ensure live API keys are never accidentally deployed to staging, and test keys never make it to production.
1. **Server-Side Initialization Check:** Write a utility in the Edge Functions shared logger or base setup. If `VITE_APP_ENV === 'production'` and an EasyPost test key (starts with `EZTK`) or Stripe test key (starts with `sk_test_`) is detected, the function will `throw Error("FATAL: Environment key mismatch")` and halt.
2. **Documentation Block:** Add a clear comment block at the top of `.env.example` explaining the two-environment setup and the strict requirement for isolating Test and Live keys.

---

## Part 2: MVP Execution (Frontend & Payments)

Once the core environment and safety architecture are established, we will proceed with the feature development.

### 6. Authentication Integration
- Connect Supabase Magic Link auth.
- Sync successful auth logins to the `profiles` table.

### 7. The Frontend Work
- **Global Layout & Routing:** Setup React Router, Shadcn/UI integration, Error Boundaries.
- **Recipient Onboarding Flow (`/get-started`):**
  - Implement Path Choice (Full vs. Flexible).
  - Implement "Try-Then-Show" validation rules.
  - Implement dynamic, aesthetic UI with Framer Motion transitions.
- **Sender Fulfill Flow (`/send/:linkId`):**
  - Build the Sender UI that queries the link by ID.
  - Form validation for package dimensions and origin address without exposing the destination address to the Sender.

### 8. Payments Integration & Edge Functions
- **Address Validation:** Write the `addresses/verify` function connecting to EasyPost.
- **Payments Flow (Stripe):**
  - Implement `payments/authorize` (Stripe PaymentIntents for 110% hold).
  - Implement `payments/capture` (Charge actual calculated rate).
  - Ensure Edge Functions dictate the final price (via EasyPost API calculation), ignoring client-side price inputs.
- **Webhooks:** Implement idempotent Stripe and EasyPost handlers (`webhook_events` table).
