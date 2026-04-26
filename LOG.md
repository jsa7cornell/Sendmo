# SendMo — Log (Decisions & Deploys)

This file combines two critical logs: **Decisions & Gotchas** (why decisions were made, hard-won debugging knowledge) and **Deploy Log** (what shipped to production and when).

Agents should read this alongside PLAYBOOK.md. Before ending any session, propose additions here if you discovered anything new.

---

## Decisions & Gotchas

When an agent discovers something important — an API quirk, a "why did we choose X", a bug pattern — propose an addition using this format:

```markdown
### [YYYY-MM-DD] Short title
**Category:** Architecture | EasyPost | Stripe | Supabase | Testing | Security
**Context:** What situation led to this discovery.
**Decision/Finding:** What was decided or discovered.
**Why:** The reasoning or evidence.
**Watch out:** What breaks if you ignore this.
```

### Pricing & Rate Strategy

### [2026-03-19] EasyPost rate competitiveness — confirmed same tier as Pirate Ship
**Category:** Architecture
**Context:** John needed to know if EasyPost was giving competitive wholesale rates and whether SendMo's retail prices are competitive with Pirate Ship and similar services.
**Decision/Finding:** EasyPost provides USPS Merchant Discount Pricing, which sits in the same sub-commercial tier as Pirate Ship's USPS Connect eCommerce rates. Both are estimated at 40–48% below USPS retail for Priority Mail and 38–42% below retail for Ground Advantage. SendMo's *wholesale cost* is therefore on par with the lowest-cost competitors. The customer-facing price gap vs. Pirate Ship is entirely explained by our 15% markup — not inferior EasyPost rates.
**Why:** EasyPost and Pirate Ship both negotiated directly with USPS for sub-commercial access. Neither publishes exact rates. SendMo's pricing gap is a business model decision (margin vs. zero-fee rebate model), not a sourcing problem.
**Watch out:**
- (1) Pirate Ship charges zero markup (they earn carrier rebates), so they're structurally cheaper than us by exactly our markup %. Don't try to compete on price with them — differentiate on the link-based model.
- (2) Honest marketing claim: "Save 30–35% off USPS retail rates." This is true and defensible. Don't claim "cheapest rates."
- (3) UPS retail is heavily marked up — our EasyPost UPS rates may be 55–70% below UPS retail, which is a strong marketing story.
- (4) After each USPS rate change (~January and ~July), verify that EasyPost's merchant discount hasn't narrowed. Re-run RATE_ANALYSIS.md estimates.
- (5) Dollar margin is thin on cheap Ground Advantage shipments (~$0.49 on a $3.74 label). After Stripe's $0.30 flat fee, these labels could run at near-zero net margin — consider minimum charge threshold.
- (6) Full analysis in `RATE_ANALYSIS.md` — includes rate comparison tables, margin analysis, and marketing recommendations.

---

### Architecture Decisions

### [2026-03-19] Shared AppHeader component — single persistent nav for all pages
**Category:** Architecture
**Context:** Five+ pages each had their own inline `<nav>` elements with slightly different auth logic, button styles, and logo placements. Changing the header (adding a nav item, updating the logo) required editing every page.
**Decision/Finding:** Created `src/components/AppHeader.tsx` — a single auth-aware header used by all pages. Uses `useAuth()` to conditionally render "My Account" + sign-out (logged in) or "FAQ" + "Sign In" (logged out). Accepts an optional `actions` prop that completely replaces the right slot when provided.
**Why:** One component to update, consistent nav everywhere. The `actions` prop allows pages like TrackingPage to show a contextual label ("Track Package") instead of auth buttons, without forking the component.
**Watch out:** (1) `actions={undefined}` gives the default auth controls; `actions={null}` renders nothing in the right slot — be explicit. (2) AppHeader uses `useAuth()` and `useNavigate()` — it must be inside both `AuthProvider` and `BrowserRouter`. (3) The logo links to `/` — don't add a second home link elsewhere on the page.

### [2026-03-19] Flow badge reads from context — no prop drilling needed
**Category:** Architecture
**Context:** Once a user picks "Full Prepaid Label" or "Flexible Shipping Link" in onboarding, they need a persistent visual indicator of which flow they're in (especially since both share the same `/onboarding/*` URL space).
**Decision/Finding:** Added a pill badge directly in `RecipientOnboarding.tsx` that reads `data.path` from `RecipientFlowContext`. Shows a Package icon + "Full Prepaid Label" or Link2 icon + "Flexible Shipping Link". Hidden on step 0 (path choice) since the user hasn't chosen yet.
**Why:** The context is already available at the `RecipientOnboarding` layout level — no new props needed. Step components don't need to know about the badge at all.
**Watch out:** The badge renders only when `data.path && currentStep !== 0`. If a third path is added, update the badge's conditional rendering.

### [2026-03-19] AnimatePresence timing — screenshots during exit animation show stale content
**Category:** Testing
**Context:** When verifying step transitions via the preview tool, clicking a path choice card and immediately taking a screenshot showed the old step 0 content instead of the new step 1 address form.
**Decision/Finding:** `AnimatePresence mode="wait"` ensures the exit animation plays fully (0.25s) before the enter animation starts. Screenshots taken within that window capture the exiting content, making the new step appear blank.
**Why:** This is expected Framer Motion behavior, not a bug. The transition duration is 0.25s (set in RecipientOnboarding.tsx).
**Watch out:** When testing step transitions via `preview_eval` + `preview_screenshot`, either (1) wait for the animation to settle before screenshotting, or (2) navigate directly via `window.location.href` to the target URL for isolated verification of that step's rendered state.

### [2026-03-19] Notification dispatcher pattern — channel-agnostic, auditable, idempotent
**Category:** Architecture
**Context:** Needed to send tracking notifications to both sender and recipient, with plans to add SMS and push later. The original webhook handler called `sendEmail()` directly, which would mean duplicating logic for each new channel and each new recipient type.
**Decision/Finding:** Created a notification dispatcher (`_shared/notifications.ts`) that: (1) looks up `notification_contacts` for a shipment, (2) routes each contact to the appropriate channel handler (email now, SMS/push stubs), (3) logs every attempt to `notifications_log` for audit, (4) checks for duplicates before sending (idempotency). The webhook handler now calls `dispatchNotifications()` instead of `sendEmail()` directly.
**Why:** Adding SMS is just adding a handler function — no changes to webhooks, labels, or any calling code. The `notification_contacts` table decouples "who to notify" from "how to notify." The `notifications_log` with a unique index on `(shipment_id, contact_id, event_type)` WHERE `status='sent'` prevents duplicate sends from webhook retries.
**Watch out:** (1) The dispatcher is fire-and-forget — don't await it in the webhook response path. (2) The unique index only prevents duplicates for `status='sent'` — failed attempts can be retried. (3) `notification_contacts` rows are inserted during label purchase; if the DB persist fails (fire-and-forget), the contacts won't exist and no notifications will be sent for that shipment.

### [2026-03-19] Public tracking page — Edge Function, not direct PostgREST
**Category:** Architecture
**Context:** The tracking page at `/track/:trackingNumber` needs to show shipment status publicly (no auth). Options: (1) query PostgREST directly with anon key, (2) dedicated Edge Function.
**Decision/Finding:** Created a dedicated `tracking` Edge Function that returns only safe, non-PII fields (tracking_number, carrier, service, status, timestamps). Uses service role internally but exposes nothing sensitive.
**Why:** PostgREST with anon key would require an RLS policy that exposes shipments to unauthenticated users — risky surface area. The Edge Function acts as a controlled view, returning only what the tracking page needs. If we add more tracking data later (EasyPost tracker details, delivery photo), it's one function to update.
**Watch out:** The tracking function uses service role key — never return addresses, names, emails, or financial data from it. Only expose what appears on the tracking page UI.

### [2026-03-18] Resend REST API used directly — no SDK in Deno Edge Functions
**Category:** Architecture
**Context:** Needed to send transactional emails (OTP, label confirmation, tracking) from Supabase Edge Functions (Deno runtime). The Resend npm SDK has Node.js dependencies that don't work cleanly in Deno.
**Decision/Finding:** Use the Resend REST API directly via `fetch("https://api.resend.com/emails", ...)` with Bearer token auth. Created `_shared/resend.ts` as a thin wrapper (~50 lines). No SDK, no `npm:resend` import.
**Why:** Deno's `fetch` is native and reliable. The Resend REST API is simple (one endpoint, JSON body). Avoids npm compatibility issues and keeps the function bundle small.
**Watch out:** If Resend changes their API, we only need to update `_shared/resend.ts`. The `RESEND_API_KEY` must be set as a Supabase secret — it's not in `.env.local` yet (John needs to add it).

### [2026-03-18] OTP codes hashed with SHA-256 before DB storage
**Category:** Security
**Context:** Email verification OTPs are stored in `email_verifications` table. Storing plaintext codes would allow anyone with DB access to bypass verification.
**Decision/Finding:** OTP codes are hashed with SHA-256 (`crypto.subtle.digest`) before storage. On verify, the submitted code is hashed and compared to the stored hash. Plaintext code only exists in memory during generation and in the email sent to the user.
**Why:** Defense in depth. Even if the DB is compromised (SQL injection, leaked backup, admin error), codes can't be extracted. SHA-256 is fast enough for 6-digit codes and sufficient since OTPs expire in 10 minutes.
**Watch out:** SHA-256 of a 6-digit number is technically brute-forceable (only 900,000 possibilities), but the 5-attempt limit and 10-minute expiry make this impractical. If stronger protection is needed later, add a per-row salt.

### [2026-03-18] Email Edge Function uses action-based routing, not path-based
**Category:** Architecture
**Context:** Supabase Edge Functions map one folder to one URL path (`/functions/v1/email`). We needed both "send OTP" and "confirm OTP" endpoints.
**Decision/Finding:** Single `email` function accepts `{ action: "send", email }` or `{ action: "confirm", email, code }` in the POST body. No path parsing needed.
**Why:** Simpler than creating two separate function directories (`email-send`, `email-confirm`). The function is small enough that both handlers fit in one file. Frontend calls `post("email", { action: "send", ... })` — clean and consistent.
**Watch out:** If the email function grows (e.g., adding "resend", "check-status"), consider splitting into separate functions. For now, two actions is manageable.

### [2026-03-18] Parallel feature branches merged cleanly — auth, flexible link, tests
**Category:** Architecture
**Context:** Three parallel Claude sessions built auth UI (feat/auth-ui), flexible link path (feat/flexible-link), and E2E tests simultaneously. Sender flow session (feat/sender-flow) did not produce distinct work.
**Decision/Finding:** All branches merged to main cleanly via fast-forward (auth-ui) and merge commit (flexible-link). No conflicts because each session touched different files. 110 unit tests + 12 E2E tests all pass post-merge.
**Why:** Parallel sessions work well when features are file-isolated. Auth touched App.tsx/contexts/pages, flexible link touched recipient components/hooks, tests touched tests/.
**Watch out:** Sender flow still needs to be built — SenderFlow.tsx is a placeholder. Future parallel sessions should ensure they don't modify the same files.

### [2026-03-19] Magic link login was broken — Supabase Site URL pointed to old Vercel deploy URL
**Category:** Supabase
**Context:** Clicking "Send magic link" on /login appeared to succeed (no error returned) but no email arrived. Investigating revealed: (1) Supabase Auth Site URL was set to `https://sendmo-john-andersons-projects-89a4aa08.vercel.app/` instead of `https://sendmo.co`, (2) the redirect allowlist only contained the old Vercel URLs, (3) John's account had `confirmed_at: null` / `email_confirmed_at: null` — the account existed but was never confirmed, blocking subsequent OTP sends, (4) the Supabase client had no `detectSessionInUrl: true` configuration so magic link redirects wouldn't be picked up.
**Decision/Finding:** Fixed via `supabase config push`: Site URL → `https://sendmo.co`, redirect allowlist → `sendmo.co/**` + `localhost:5173/**`. Manually confirmed John's email via SQL (`UPDATE auth.users SET email_confirmed_at = NOW()`). Added `detectSessionInUrl`, `persistSession`, `autoRefreshToken` to the Supabase client config.
**Why:** Supabase sends magic link emails using the Site URL as the base for the confirmation link. Wrong URL = link points to a non-functional domain. Unconfirmed accounts can't receive new OTPs.
**Watch out:** (1) When changing production domain, ALWAYS update Supabase Auth Site URL via `supabase config push` or the dashboard. (2) Free tier can't configure session timebox — JWT expiry stays at 1 hour, sessions rely on refresh tokens. (3) Free tier email rate limit is 4/hour — show user-friendly error when rate limited. (4) The `supabase/config.toml` now contains auth settings that get pushed to remote — don't delete them. (5) Custom SMTP is configured via Resend (`smtp.resend.com:465`, user `resend`, pass = Resend API key via `env(SMTP_PASS)`). Emails send from `noreply@sendmo.co`. The SMTP password is passed as an env var during `config push`, never committed to git.

### [2026-03-18] Auth integration — Supabase magic link with auto-profile creation
**Category:** Architecture
**Context:** Needed passwordless auth for dashboard access and future role-based admin gating.
**Decision/Finding:** AuthContext wraps the entire app, uses `supabase.auth.signInWithOtp()` for magic link emails. On first login, auto-creates a `profiles` row via `ensureProfile()`. ProtectedRoute redirects unauthenticated users to /login. Dashboard now fetches real shipment data for the authenticated user.
**Why:** Magic link is the simplest auth UX — no passwords, no OAuth setup. Auto-profile creation means no separate signup step.
**Watch out:** (1) Email redirect URL is `window.location.origin/dashboard` — must match Supabase Auth config. (2) The admin PIN gate is still in place — needs to be replaced with `profile.role === 'admin'` check. (3) Supabase Auth email templates should be customized before public launch.

### [2026-03-18] Vercel env vars must be set separately from .env.local
**Category:** Architecture
**Context:** First production deploy to sendmo.co showed a blank page, then API errors ("Unexpected token '<'"). The Vite build was running but `VITE_SUPABASE_URL` was undefined, so API calls went to relative URLs and got HTML back.
**Decision/Finding:** Vercel ignores `.env.local`. All `VITE_*` environment variables must be set in Vercel via `vercel env add` or the dashboard. After adding/changing vars, a redeploy is required (`vercel --prod`).
**Why:** Vite inlines `import.meta.env.VITE_*` at build time. If the var is missing during the Vercel build, it's baked in as `undefined`.
**Watch out:** When adding a new `VITE_*` var to `.env.local`, always also add it to Vercel. The `vercel.json` `framework: "vite"` setting ensures Vercel runs the build correctly.

### [2026-03-18] vercel.json required for SPA routing + Vite build
**Category:** Architecture
**Context:** Vercel was serving raw source files (0ms builds) and returning 404 on client-side routes like `/admin`.
**Decision/Finding:** Added `vercel.json` with `buildCommand`, `outputDirectory`, `framework: "vite"`, and SPA rewrites (`"source": "/(.*)"` → `"/index.html"`).
**Why:** Without explicit config, Vercel's framework detection wasn't picking up Vite, and client-side routes need catch-all rewrites to serve `index.html`.
**Watch out:** The GitHub token (`ghp_*`) lacks `workflow` scope — cannot push `.github/workflows/` files. If CI is needed, update the token scope on GitHub.

### [2026-03-18] Domain setup — sendmo.co is production, sendmo.com is aspirational
**Category:** Architecture
**Context:** sendmo.co is the owned domain (Cloudflare DNS). sendmo.com is not yet purchased (parked on Afternic).
**Decision/Finding:** sendmo.co is the production domain, pointing to Vercel via A record (76.76.21.21). www.sendmo.co CNAMEs to Vercel. wind.sendmo.co points to the WINDow/coyote-wind project. sendmo.com was removed from Vercel — it will be added back if/when purchased.
**Why:** Clean separation. No dangling domain configs for unowned domains.
**Watch out:** When sendmo.com is purchased, add it to Vercel and set up Cloudflare DNS (or transfer nameservers). Until then, don't reference sendmo.com in any user-facing copy or code.

### [2026-03-18] Admin mode: PIN gate → sessionStorage → floating toolbar (Option A)
**Category:** Architecture
**Context:** John needs to create real (live) labels for testing and personal use before Stripe/auth are built, but the test/live toggle must be invisible to regular users.
**Decision/Finding:** `/admin` page now requires a 4-digit PIN (hardcoded as `2026` for now). On success, sets `sessionStorage.sendmo_admin = 'true'`. The `/onboarding` page checks this flag and shows a floating toolbar at bottom-right with "Test" (default) and "Live Comp" modes. When "Live Comp" is selected, `live_mode: true` is passed to the `rates` and `labels` Edge Functions, which use the live EasyPost API key.
**Why:** Simplest approach that works before auth ships. PIN gate means regular users never see the toggle. sessionStorage clears on tab close.
**Watch out:** (1) The PIN is hardcoded in client JS — this is temporary, replace with role-based check when auth ships. (2) `live_mode: true` is accepted by Edge Functions from any caller — add server-side admin token validation before launch. (3) Live labels cost real money on EasyPost. (4) No comp ledger entry yet — add `payment_method: 'comp'` to payments table when the transaction system is built.

### [2026-03-18] Rate fetch debounce must use refs to avoid infinite loops
**Category:** Architecture
**Context:** `RecipientStepFullShipping` uses a `useEffect` to debounce rate fetches when package details change. The initial implementation put `onUpdate` (a state setter) and the full `state` object in the dependency array of a `useCallback`. When rates came back and `onUpdate` set new rates in state, this recreated the callback, re-triggered the effect, and caused an infinite fetch loop (hundreds of 400 errors hitting the rates API).
**Decision/Finding:** Use `useRef` for `onUpdate` and `state` inside the effect. Only put primitive, rate-triggering values (address verified/street, dimensions, weight, packaging type) in the dependency array. This ensures re-fetches only happen when the user actually changes package details — not when rate results arrive.
**Why:** React's `useEffect` reruns when any dependency changes reference. Callback functions and objects change reference every render. Refs are stable across renders.
**Watch out:** This pattern is needed anywhere a debounced API call writes results back to the same state it reads from. If you add new fields that should trigger rate re-fetch, add them to the explicit dependency list — not via `state` object spread.

### [2026-03-18] Stripe stubbed with MockPaymentForm — real EasyPost test labels generated
**Category:** Architecture | Stripe
**Context:** Stripe integration is deferred, but the Full Label flow needs to generate a real label to prove the pipeline works end-to-end.
**Decision/Finding:** `RecipientStepPayment` contains a `MockPaymentForm` sub-component that renders decorative card fields (readonly, Stripe test card prefilled) with a visible "Test Mode" badge. On click, it simulates a 1.5s payment delay, then calls the real `labels` Edge Function (EasyPost test mode, free). No Stripe SDK loaded, no PaymentIntent created.
**Why:** Decouples label generation testing from payment integration. EasyPost test mode is free and produces real tracking numbers + PDF labels.
**Watch out:** When replacing with real Stripe: (1) swap MockPaymentForm for `<Elements>` + `<PaymentElement>`, (2) call `payments/authorize` before `labels`, (3) remove the simulated delay. The mock is clearly marked with `// TODO: Replace with <Elements>` comments.

### [2026-03-19] Service name display — explicit mapping table over regex parsing
**Category:** Architecture
**Context:** EasyPost returns service names in inconsistent casing: camelCase (`Groundadvantage`, `Upsgroundsavergreaterthan1lb`), ALL_CAPS_UNDERSCORE (`FEDEX_2_DAY`), and TitleCase (`Priority`). The original `serviceDisplayName()` only handled underscores.
**Decision/Finding:** Added a lookup table of 30+ known EasyPost service names → human-readable display names (e.g., `Upsgroundsavergreaterthan1lb` → "Ground Saver"). Falls back to camelCase splitting + title-casing for unknown services.
**Why:** Regex alone can't turn "Upsgroundsavergreaterthan1lb" into "Ground Saver" — that requires explicit mapping. The lookup table is fast and deterministic.
**Watch out:** When new carriers/services appear in EasyPost, they'll fall through to the regex fallback (which is usually readable enough). Add explicit mappings for any that look ugly.

### [2026-03-18] Edge Functions use `from_address`/`to_address` and `weight_oz` — not `from`/`to`/`weight`
**Category:** EasyPost
**Context:** The `api.ts` client initially sent `from`/`to` and `weight`, but the `rates` and `labels` Edge Functions expect `from_address`/`to_address` and `weight_oz`.
**Decision/Finding:** `api.ts` now matches the Edge Function field names exactly. The `parcel` object sends `weight_oz` (total ounces) not `weight` (ambiguous units).
**Why:** Field name mismatch caused silent 400 errors from the Edge Functions.
**Watch out:** When adding new API functions, always read the Edge Function's `await req.json()` destructuring to confirm exact field names before writing the client call.

### [2026-03-18] Guestimator speed keyword ordering — economy before express
**Category:** Architecture
**Context:** The Magic Guestimator parses urgency keywords to suggest a speed tier. "no rush" should match economy, but "rush" also appears in the express keyword list. If express keywords are checked first, "no rush" false-matches as express.
**Decision/Finding:** Check economy keywords (including multi-word "no rush") before express keywords (including single-word "rush"). Order: economy → standard → express.
**Why:** Multi-word phrases are more specific than single words and should take priority.
**Watch out:** When adding new keywords, consider substring conflicts. Always put longer/multi-word phrases in groups that are checked first.

### [2026-03-18] Build Full Prepaid Label path first, compatible with Flexible Link
**Category:** Architecture
**Context:** Project had many starts and stops. Backend is 100% built but frontend is all stubs. Need to ship something real ASAP — John wants to send a label to his mom.
**Decision/Finding:** Build the Full Prepaid Label recipient path first (Steps 0→1→10→11→12). Flexible Link shares Steps 0 and 1, so building shared components first ensures compatibility. Stripe is stubbed initially (frontend mock + backend placeholder) to unblock the flow.
**Why:** Full Label is the simplest end-to-end path (recipient enters everything, pays, gets PDF). It exercises addresses, rates, labels, and payment — all the core APIs. Flexible Link adds Steps 20-23 later using the same page component with branching logic.
**Watch out:** The `RecipientOnboarding.tsx` page must use step-based state management that supports both paths from the start. Don't hardcode Full Label assumptions into shared components.

### [2026-03-18] Supabase project survives pause but DNS goes offline
**Category:** Supabase
**Context:** Supabase project `fkxykvzsqdjzhurntgah` was paused due to inactivity. On restore, DNS took a few minutes to propagate. The anon key in `.env.local` uses a non-standard format (`sb_publishable_...` instead of `eyJ...` JWT).
**Decision/Finding:** After restore, all 8 migrations were still applied (only migration 008 needed pushing — it hadn't been applied before the pause). All 9 Edge Functions remained ACTIVE and deployed. Database tables exist but are empty (no test data).
**Why:** Supabase preserves migrations and Edge Functions across project pauses. Data in tables is also preserved but the project had no data to begin with.
**Watch out:** After restoring a paused project, always verify: (1) DNS resolves, (2) tables exist, (3) Edge Functions are listed as ACTIVE. The anon key format may vary — test it with a real API call, don't just check the format.

### [2026-03-18] Previous stack (Next.js/Prisma) was abandoned — current stack is Supabase Edge Functions
**Category:** Architecture
**Context:** An earlier iteration of SendMo used Next.js 14 + Prisma ORM + Vercel Postgres + single index.html frontend with dark navy/teal design. This was completely replaced.
**Decision/Finding:** Current stack: React/Vite/TS + Tailwind/shadcn frontend, Supabase Edge Functions (Deno) backend, Supabase PostgreSQL, clean blue/white design. No Prisma, no Next.js, no dark theme.
**Why:** Supabase Edge Functions offer zero cold-start, co-located DB access, and simpler deployment. React/Vite is faster to develop with than a single-file approach.
**Watch out:** Old session notes referencing Prisma, Next.js API routes, dark navy design, or "buyer/seller" terminology are from the abandoned stack. Current terminology: "recipient" (creates link, pays) and "sender" (clicks link, ships).

### [2026-02-25] DB insertions for third-party operations (EasyPost) should be fire-and-forget
**Category:** Architecture | EasyPost | Supabase
**Context:** When a user buys a label from EasyPost, the operation succeeds but we also need to persist to the database to track shipments. Previously, failure to sync would result in orphaned records.
**Decision/Finding:** The `labels` Edge Function injects a fire-and-forget call (no `await`) to call the `admin_insert_shipment()` RPC using the service role *after* EasyPost succeeds. We must return the label URL and tracking number to the user immediately, even if the DB write fails or takes a long time.
**Why:** The critical path is delivering the label to the user. A DB outage or latency spike on our end should not prevent a user from seeing the label they just paid for. By using fire-and-forget DB writes to a robust RPC with full FK handling, we separate the external API transaction from our internal bookkeeping.
**Watch out:** If a DB insert fails, the `labels` function relies on structured logging (`label.db_persisted` vs. `label.db_persist_error`) to record the outcome. This ensures an audit trail. We must monitor these logs.

### [2026-02-24] Use Supabase Edge Functions for all backend logic
**Category:** Architecture
**Context:** Needed a scalable backend without managing servers.
**Decision:** All server logic lives in Supabase Edge Functions (Deno/TypeScript). No Express server, no separate API service.
**Why:** Zero cold-start penalty vs. Lambda, co-located with DB, native Deno secrets management, easy local dev with `supabase functions serve`.
**Watch out:** Deno imports use URL syntax (`import x from "npm:package"`), not Node `require()`. Third-party packages must be Deno-compatible.

### [2026-02-24] White-label EasyPost — never expose carrier branding to users
**Category:** Architecture
**Context:** SendMo is a white-label shipping product.
**Decision:** EasyPost must never appear in any user-facing UI, error messages, or email copy. All policies (refunds, cancellations, tracking) are presented as "SendMo policies."
**Why:** Brand integrity and competitive sensitivity.
**Watch out:** Error messages from EasyPost API often include carrier names. Always strip/replace before returning to frontend.

### [2026-02-24] Two-file documentation system (PRD.md + CLAUDE.md + DECISIONS.md)
**Category:** Architecture
**Context:** Multiple overlapping PRD versions were causing confusion.
**Decision:** Consolidate all product knowledge into `PRD.md`, developer/agent instructions into `CLAUDE.md`, and decision rationale into `DECISIONS.md`.
**Why:** Single source of truth for each audience. Agents always know where to look.
**Watch out:** Never let a fourth "source of truth" accumulate. Update the three canonical files, not random new ones.

### [2026-02-25] Server-side state is always truth — never derive critical decisions from client-provided data
**Category:** Architecture
**Context:** The `cancel-label` v1 accepted `live_mode` from the client request body to decide whether to call the real carrier API. This was wrong — a malicious or buggy client could set `live_mode=true` on a test label, causing a real carrier API call, or `live_mode=false` on a live label, bypassing the carrier entirely.
**Decision/Principle:**
> **Any decision that affects server behavior or data integrity must be derived from server-side sources (DB, env vars, JWT claims) — never from client-provided parameters.**

Specific rules that follow from this principle:
1. `is_test` is a DB column set at creation time — never sent by the client
2. User identity/role is read from JWT claims — never from a request body `user_id`
3. Pricing is computed server-side from rates — never trusted from the client
4. Refund eligibility is checked from DB state — not from a client-asserted status
**Watch out:** Watch for any Edge Function that accepts a parameter that could change a security or financial outcome. If the client can provide it, the server must re-validate it from a trusted source.

---

### EasyPost Integration Gotchas

### [2026-02-25] Luma AI Select is for Headless Automation, not UI highlighting
**Category:** EasyPost
**Context:** Explored using EasyPost Luma AI to add a "Recommended" badge to the best shipping rate in the Sender UI.
**Decision/Finding:** Decided to hold off on Luma AI for now. Luma AI Select is designed primarily to *automatically purchase* the best rate based on dashboard rules, replacing the UI choice entirely ("Autopilot"). It is not designed to simply flag a rate as "recommended" in an array of options.
**Why:** Implementing Luma just to highlight a UI option adds unnecessary orchestration complexity. If we want UI badges, a simple custom server-side rule (e.g., "cheapest under 4 days") is better. If we want to use Luma, we should pivot the Sender UX to "Autopilot" and remove the carrier choice entirely.
**Watch out:** If this feature is revisited, decide on the UX goal first. If keeping the list of choices, build a custom backend rule. If removing choices, use Luma AI.

### [2026-02-24] USPS requires `EndShipper` — causes `ProviderEndShipper` error if missing
**Category:** EasyPost
**Context:** USPS label purchases were failing with a cryptic `ProviderEndShipper` error.
**Decision/Finding:** USPS requires an `EndShipper` object in the EasyPost buy request. This is not required for UPS or FedEx.
**Why:** USPS regulation — the entity responsible for the shipment must be declared.
**Watch out:** The `EndShipper` must use the `SB_SERVICE_ROLE_KEY` env var (not `SUPABASE_SERVICE_ROLE_KEY`). Also, the EndShipper address must match a real, verified business address.

### [2026-02-24] EasyPost address verification — "soft warning" vs "hard error"
**Category:** EasyPost
**Context:** Rural addresses were being rejected even though they're valid and deliverable.
**Decision/Finding:** EasyPost returns a `verifiable` flag. If `verifiable: false` but Google Maps confirms the address exists, treat it as a **soft warning** (accepted with a note) not a hard rejection.
**Why:** Rural Route addresses, RFD addresses, and some PO Boxes pass USPS delivery but fail EasyPost's street-level verification.
**Watch out:** Don't block the user flow for soft warnings. Return `{ verified: true, warning: "...", address_type: "rural" }`. Log as `address.soft_warning` event.

### [2026-02-24] EasyPost Google Fallback — when EasyPost rejects but Google confirms
**Category:** EasyPost
**Context:** Some valid addresses were being hard-rejected by EasyPost's verifier.
**Decision/Finding:** Implemented a Google Maps geocoding fallback. If EasyPost rejects AND Google confirms the address exists with high confidence, accept with a warning.
**Why:** EasyPost's verifier is strict for non-standard address formats. Google's geocoder is more permissive and often correct.
**Watch out:** Log all fallback events as `address.google_fallback` for monitoring. Track the fallback rate — if it spikes, something upstream changed in EasyPost's behavior.

### [2026-02-24] PO Box and Military (APO/FPO/DPO) — USPS only
**Category:** EasyPost
**Context:** PO Box addresses were being offered UPS/FedEx rates that would always fail.
**Decision/Finding:** Detect PO Box and APO/FPO/DPO addresses in the `addresses` function. Return `{ is_po_box: true }` or `{ is_military: true }` and `usps_only: true`.
**Why:** UPS and FedEx do not deliver to PO Boxes or military addresses. Offering those rates leads to purchase failures.
**Watch out:** Filter non-USPS rates in the `rates` function when `usps_only: true`. Log `address_type` in all events for audit queries.

### [2026-02-24] Same address validation — sender = recipient must be blocked
**Category:** EasyPost
**Context:** Edge case testing revealed a user could accidentally configure the same address for both sender and recipient.
**Decision/Finding:** Added frontend validation to block identical from/to addresses before calling the rates API.
**Why:** EasyPost will return rates for same-address shipments (technically valid), but they're always user errors.
**Watch out:** Compare normalized addresses (lowercase, trimmed) not raw strings.

---

### Supabase / Database Gotchas

### [2026-02-24] Use `SB_SERVICE_ROLE_KEY` not `SUPABASE_SERVICE_ROLE_KEY` in Edge Functions
**Category:** Supabase
**Context:** Supabase CLI injects `SUPABASE_SERVICE_ROLE_KEY` automatically in local dev, but production secrets use a custom name.
**Decision/Finding:** This project uses `SB_SERVICE_ROLE_KEY` as the env var name for the service role key in Edge Functions.
**Why:** Avoids collision with Supabase's auto-injected local variable; explicit name makes it clear this is a secret you must set manually.
**Watch out:** After deploying a new function, always run `npx supabase secrets set SB_SERVICE_ROLE_KEY=...`. Forgetting this causes silent auth failures.

### [2026-02-24] RLS policies block service role writes — use the service client
**Category:** Supabase
**Context:** Edge functions were failing to write test data to the database even with RLS "disabled."
**Decision/Finding:** RLS applies to the `anon` and `authenticated` roles. The service role bypasses RLS, but only if you create the client with the service role key: `createClient(url, serviceRoleKey)`.
**Why:** Default Edge Function client uses the `anon` key. You must explicitly create a second client for admin operations.
**Watch out:** Never use the service role client for user-facing operations. Only use it in admin functions or background jobs.

### [2026-02-24] Foreign key constraints — insert order matters
**Category:** Supabase
**Context:** Label creation was failing with FK constraint violations.
**Decision/Finding:** Insert order: `profiles` → `addresses` → `sendmo_links` → `shipments` → `payments`. Violating this order causes FK errors.
**Why:** Each table references the previous one. The DB enforces referential integrity.
**Watch out:** In tests, always seed in this order. In the `labels` function, always verify the upstream records exist before inserting.

### [2026-02-25] System user pattern — well-known UUID for pre-auth label records
**Category:** Supabase
**Context:** All label records during the label-test phase need a valid FK to `profiles`, but real Supabase Auth (magic link) hasn't shipped yet. The old hack used a hardcoded fake UUID `b0000000-...` inserted ad hoc from the `test-db-insert` Edge Function.
**Decision/Finding:** Migration `004_system_user_and_helpers.sql` inserts a well-known system/admin identity into `auth.users` + `profiles`:
- UUID: `00000000-0000-0000-0000-000000000001`
- Email: `admin@sendmo.co`, full_name: `SendMo Admin`

All label-test shipments use `p_user_id = '00000000-0000-0000-0000-000000000001'`. When real auth ships, the label flow passes the actual `auth.uid()` — no other code changes.
**Why:** Reproducible, auditable, idempotent (`ON CONFLICT DO NOTHING`). Admin queries via service role always bypass RLS so the system user's records are always readable for reporting. No separate "admin" RLS policy needed.
**Watch out:** The system user UUID is a sentinel — never issue it to real users. Direct SQL insert into `auth.users` only works in service-role migrations (`npx supabase db push`). If you recreate the DB, the migration re-runs and the row is silently skipped on conflict.

### [2026-02-25] `admin_insert_shipment()` RPC — transactional FK-ordered insert
**Category:** Supabase
**Context:** Edge Functions calling the anon Supabase client can't insert into tables protected by RLS. The old approach was three separate round-trips from TypeScript with careful ordering and error recovery. Any step failure left orphaned rows.
**Decision/Finding:** Created a `SECURITY DEFINER` PostgreSQL function `admin_insert_shipment(p_user_id, ...)` that performs all inserts atomically in FK order:
```
addresses (from) → addresses (to) → sendmo_links → shipments
```
Returns the new `shipments.id`. Called via `supabase.rpc('admin_insert_shipment', {...})` with the anon client — the function body runs as its owner (service role), bypassing RLS entirely.
**Why:** Atomicity (all rows committed or none), single network round-trip, FK ordering guaranteed by the function, no orphaned rows on partial failure. Also future-proof: passing a different `p_user_id` at call time is the only change needed when real auth users arrive.
**Watch out:** `GRANT EXECUTE ... TO anon, authenticated` is required — without it, the anon client gets a `permission denied` even though the function is SECURITY DEFINER. The function is in `public` schema; do not move it to a private schema without re-granting.

---

### Testing Gotchas

### [2026-02-24] Always write a regression test BEFORE fixing a bug
**Category:** Testing
**Context:** Bugs were being fixed without tests, leading to regressions.
**Decision:** Rule 12 in CLAUDE.md — write the regression test first (red), then fix (green).
**Why:** Forces you to understand the failure mode before changing code. Guarantees the bug is caught if reintroduced.
**Watch out:** The test must fail without the fix and pass with it. Don't write tests that pass either way.

### [2026-02-24] EasyPost TEST key is `EZTKxxxx` prefix — LIVE key charges real money
**Category:** Testing
**Context:** Developers could accidentally use the live EasyPost key during development.
**Decision/Finding:** Always validate that the API key starts with `EZTK` before making EasyPost calls in development. Refuse to proceed if it starts with `EZak` (live key).
**Why:** Live EasyPost labels cost real money and cannot be easily refunded during testing.
**Watch out:** This check should be in the Edge Function OR enforced by having separate `.env.local` and `.env.production` files with different keys.

---

### Label Cancellation / Refund Gotchas

### [2026-02-25] Label void eligibility — check `shipment.status` AND `refund_status`
**Category:** EasyPost
**Context:** The cancel-label function needed robust eligibility guards.
**Decision/Finding:** A label can only be voided if: (1) `shipment.status = 'label_created'`, (2) `refund_status = 'none'`, (3) `easypost_shipment_id` is present.
**Why:** EasyPost rejects void requests after the carrier scans the package. Our DB guards must mirror this constraint.
**Watch out:** EasyPost refund processing takes 2–4 weeks. Update `refund_status` to `submitted` immediately upon successful void API call, not `refunded`. A webhook will eventually confirm when the refund is processed.

### [2026-02-25] EasyPost test labels cannot be refunded via API — is_test is a DB attribute, not a client mode
**Category:** Architecture / EasyPost
**Context:** After implementing cancel-label, admin void attempts on test labels returned "Label void request was rejected by the carrier." The first fix (v1) was to accept `live_mode` from the client and simulate success in test mode. This was wrong — it allowed the client to determine server behavior.
**Decision:** `is_test` is a boolean column on `shipments`, set **server-side at creation time** by the function that knows which API key was used. It is never derived from client-provided parameters.
**Fix applied:**
- Migration `005_add_is_test_to_shipments.sql` — adds `is_test BOOLEAN NOT NULL DEFAULT false`
- `test-db-insert` — always sets `is_test: true` (these records always use the test key)
- `labels` — should set `is_test: !isLive` when writing the shipment record (Phase 1 production path)
- `cancel-label` — removed `live_mode` from the request API; reads `is_test` from DB instead
- `Admin.tsx` — removed heuristic guessing (email patterns, tracking prefixes); reads `sh.is_test` from DB
- `CancelLabelModal` — removed `live_mode` from the POST body entirely
**Why:** The client cannot be trusted to determine whether a shipment is real or synthetic. That decision is made once, by the server, at creation time, and stored durably in the DB.
**Watch out:** Test labels get a clear, honest rejection: "Test labels cannot be voided. Void is only available for live shipments." No silent simulation — behavior is deterministic and honest.

---

### Logging / Observability Gotchas

### [2026-02-25] `log()` is fire-and-forget — don't await it on the critical path
**Category:** Architecture
**Context:** Logging was being awaited, adding latency to every API response.
**Decision/Finding:** The `log()` helper in `_shared/logger.ts` should never be awaited on the critical path. Use `log({...})` without `await`.
**Why:** Log ingestion latency (DB write) should not block the user-facing response.
**Watch out:** This means log failures are silent. Add a try/catch inside `logger.ts` itself to swallow errors gracefully.

---

## Deploy Log

Every merge to `main` triggers a Vercel auto-deploy. This section tracks what shipped and when.

### [2026-03-19] — Full sender flow + links pipeline + friendly error copy

**Branch:** `main`
**Commit:** `5346656`
**Deploy:** Vercel auto-deploy

**What shipped**
- Links Edge Function (GET + POST). Creates flex links with recipient preferences, retrieves by short code. Handles expired/used/cancelled statuses.
- Preference-aware rate filtering. Rates Edge Function filters by carrier, speed tier (preferred or faster), and price cap from link preferences.
- Full sender wizard. 4-step flow at `/s/:shortCode`: address → package → rates → done. Fetches link, shows preferences banner, uses SmartAddressInput + Magic Guestimator.
- RecipientStepLinkReady now persists flex links to DB on mount via `createFlexLink()` API call.
- Friendly error copy. "Hmm, that link didn't work", "Rates are playing hide and seek", "No options for this one", "One and done!" etc.
- "prepaid by [name]" shows on rate cards and shipment summary.
- "Your label is ready!" Done step with label placeholder (pending Stripe integration).
- SmartAddressInput name label fix. Now configurable via `nameLabel`/`nameHint` props. Sender side shows "Sender's Name" instead of "Recipient Name".
- SenderPreview page. `/sender-preview` with 7 interactive scenarios for testing all sender states.

**What changed (files)**
- `supabase/functions/links/index.ts` — new Edge Function
- `supabase/functions/rates/index.ts` — added preference filtering (carrier, speed, price cap)
- `src/lib/api.ts` — added `createFlexLink()`, `fetchLink()`, `fetchSenderRates()`, `LinkData` type
- `src/pages/SenderFlow.tsx` — full sender wizard (was stub)
- `src/pages/SenderPreview.tsx` — new preview/mockup page
- `src/components/recipient/RecipientStepLinkReady.tsx` — now persists to DB
- `src/components/ui/SmartAddressInput.tsx` — configurable name label
- `src/App.tsx` — added SenderPreview route

**Tests**
- 188 unit tests passing (17 files)
- 14 E2E tests passing

**Breaking changes**
- None

**Notes for future agents**
- Links Edge Function is NOT yet deployed to Supabase — run `npx supabase functions deploy links` and `npx supabase functions deploy rates`
- Done step has a label placeholder — actual label generation requires Stripe payment integration (see WISHLIST.md)
- SenderPreview.tsx is a dev tool — remove or gate behind admin before launch

---

### [2026-03-19] — UI polish: persistent header, flow badge, path choice redesign, dashboard identity

**Branch:** `feat/ui-polish` (merged to `main`)
**Commit:** `4644a33`
**Deploy:** Vercel auto-deploy

**What shipped**
- Shared AppHeader component. Persistent nav header across all pages (auth-aware, logo links home). Replaces per-page inline navs.
- Flow indicator badge. Pill below header during onboarding shows "Full Prepaid Label" or "Flexible Shipping Link" once a path is chosen
- Dashboard identity. Replaced "Dashboard" heading with avatar circle (first letter of email) + email + tagline. Compact sign-out icon button.
- Path choice redesign. RecipientStepPathChoice now has illustrated cards with gradient hero bands, 3-icon scenes, feature bullet points, and descriptive copy
- Name field label. SmartAddressInput name field now reads "Recipient Name (probably your name!)"
- NotFound page. "Lost in transit" headline with Package icon, Go home + Go back buttons
- SenderFlow placeholder. Added AppHeader to sender checkout placeholder
- Index page. Replaced inline nav with AppHeader, fixed footer email to support@sendmo.co

**What changed (files)**
- `src/components/AppHeader.tsx` — **new**: shared persistent header with `actions` prop override
- `src/components/recipient/RecipientStepPathChoice.tsx` — rewritten with illustrated cards
- `src/components/ui/SmartAddressInput.tsx` — updated name field label
- `src/pages/Dashboard.tsx` — avatar identity section, compact sign-out
- `src/pages/Index.tsx` — uses AppHeader, fixed footer email
- `src/pages/NotFound.tsx` — rewritten with AppHeader + "Lost in transit"
- `src/pages/RecipientOnboarding.tsx` — added AppHeader + flow badge pill
- `src/pages/SenderFlow.tsx` — added AppHeader
- `src/pages/TrackingPage.tsx` — uses AppHeader with breadcrumb action
- `tests/unit/App.test.tsx` — updated 2 assertions to match new copy

**Tests**
- 0 new tests, 2 test assertions updated
- 188 total unit tests passing

**Breaking changes**
- None (frontend-only, no API or DB changes)

**Notes**
- AppHeader `actions` prop completely replaces the right slot — pass `undefined` (or omit) for default auth-aware buttons
- Flow badge reads `data.path` from RecipientFlowContext — no new props needed
- Path choice illustrations use only Tailwind + Lucide icons (no external image assets)
- Page title in browser tab still shows "temp-app" — may want to fix in index.html

---

### [2026-03-19] — User-facing label void, live tracking, dashboard enhancements

**Branch:** direct to `main` (3 commits)
**Commits:** `0358c11`, `cb49ec9`, `de24fe8`
**Deploy:** Vercel auto-deploy + Supabase Edge Functions (`cancel-label`, `tracking`)

**What shipped**
- Dashboard enhancements: sender name column, status with dates ("Shipped on Mar 18"), clickable tracking links to `/track/:number`
- Live tracking from EasyPost: tracking page + function fetch real-time status, events, and ETA from EasyPost tracker API. 30-min TTL cache (terminal statuses never re-fetched). Auto-syncs DB when status changes.
- User-facing label void: "Void Label" button on eligible shipments in dashboard. CancelLabelModal with confirmation, loading, success/error states. Server-side JWT auth + ownership check on cancel-label function. Refund status badges (pending/refunded/rejected).
- Refund service stub: `src/lib/refundService.ts` — interface for future Stripe refund integration
- Resend domain verified: `noreply@sendmo.co` confirmed as sending address, RESEND_API_KEY set as Supabase secret
- DB fix: reassigned all sendmo_links from system user to John's real account

**What changed (files)**
- `src/pages/Dashboard.tsx` — sender name, status dates, tracking links, void button + modal, refund badges
- `src/pages/TrackingPage.tsx` — live EasyPost events timeline, estimated delivery, TTL cache
- `src/components/CancelLabelModal.tsx` — added optional `accessToken` prop for authenticated calls
- `src/lib/refundService.ts` — new stub for Stripe refund integration
- `supabase/functions/tracking/index.ts` — live EasyPost fetch, 30-min TTL, DB sync
- `supabase/functions/cancel-label/index.ts` — JWT auth + ownership via sendmo_links join
- `WISHLIST.md` — added EasyPost webhooks, event caching, payment ledger, Stripe refund, payment history

**Tests**
- No new unit tests this deploy (UI-heavy changes)
- 145 total unit tests still passing

**Breaking changes**
- `cancel-label` now verifies JWT ownership for authenticated callers (admin anon-key path preserved)

**Notes**
- EasyPost webhooks still not registered — tracking relies on TTL-cached polling for now (WISHLIST item)
- Refund service is a stub — needs Stripe integration + transaction ledger before going live
- Label void only shows for live labels with status=label_created and refund_status=none
- All eligibility checks enforced server-side — client-side is UX only

---

### [2026-03-19] — URL-based step routing for recipient onboarding

**Branch:** `feat/url-step-routing`
**Commit:** `4fbc307`
**Deploy:** Vercel auto-deploy

**What shipped**
- Onboarding steps now have real URLs: `/onboarding/address`, `/onboarding/shipping`, `/onboarding/payment`, `/onboarding/label` (full label) and `/onboarding/preferences`, `/onboarding/verify`, `/onboarding/authorize`, `/onboarding/link-ready` (flex)
- Browser back/forward buttons work naturally through the flow
- Step guards: direct URL access blocked if prior steps not completed (redirects to first incomplete step)
- Cross-path slug rejection: flex slugs rejected when full_label path is active (and vice versa)
- Flow state lifted to React Context — persists across URL changes
- Direction-aware animation (forward vs backward slide)

**What changed (files)**
- `src/lib/stepRouting.ts` — new: slug↔step mappings, step ordering, guard logic, progress bar mapping
- `src/contexts/RecipientFlowContext.tsx` — new: flow state context with navigate()-based transitions
- `src/pages/RecipientOnboarding.tsx` — rewritten as layout reading step from URL
- `src/App.tsx` — nested routes with shared OnboardingLayout provider
- `tests/unit/stepRouting.test.ts` — 27 new tests
- `tests/unit/recipientFlowContext.test.tsx` — 11 new tests
- `tests/e2e/url-step-routing.spec.ts` — 10 new tests

**Tests**
- 38 new unit tests (stepRouting + RecipientFlowContext), 188 total passing
- 10 new E2E tests (URL changes, browser back, step guards, cross-path rejection), 31 total E2E passing

**Breaking changes**
- Onboarding URLs changed from `/onboarding` (single page) to `/onboarding/:step` (URL per step). No external links to old step URLs existed, so no user impact.

**Notes**
- Step components required zero changes — context exposes backward-compatible `state: RecipientFlowState`
- Steps 11→12 (payment→label ready) happen within the same `RecipientStepPayment` component, so URL stays at `/payment`
- `useRecipientFlow` hook still exists for its tests but the context wraps similar logic
- Sender flow (`SenderFlow.tsx`) is still a placeholder — URL routing for it will be added when sender flow is built

---

### [2026-03-19] — Shipping notifications for sender + recipient, tracking page

**Branch:** `feat/shipping-notifications`
**Commit:** `22b35a9`
**Deploy:** Vercel auto-deploy

**What shipped**
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

**What changed (files)**
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

**Tests**
- 14 new/updated tests (9 notification + 5 email template)
- 145 total unit tests passing (up from 131)
- E2E: no new coverage this deploy

**Breaking changes**
- `trackingUpdateEmail()` signature changed — now accepts optional carrier, ETA, trackingUrl, role params (backwards compatible, all optional)

**Notes**
- Migration 011 must be pushed: `npx supabase db push`
- Deploy new Edge Functions: `npx supabase functions deploy tracking webhooks`
- `sender_email` param is optional in labels function — comp labels may not have it
- SMS/push channels are stubbed in the dispatcher — add handlers when ready
- Tracking page fetches from Edge Function, not direct DB (keeps RLS clean)

---

### [2026-03-19] — Fix magic link login + custom SMTP via Resend

**Branch:** `feat/fix-auth-login`
**Commit:** `f7d503b`
**Deploy:** Vercel auto-deploy

**What shipped**
- Magic link login now works — Supabase Site URL corrected from old Vercel deploy URL to `sendmo.co`
- Emails send from `SendMo <noreply@sendmo.co>` via Resend SMTP (was `supabase auth`)
- Landing page nav shows Dashboard + sign out when logged in (was always "Sign In")
- "Sign In" button links to `/login` directly (was `/dashboard` → redirect)
- User-friendly error for rate limiting, spam folder hint on success screen
- Supabase client configured with `detectSessionInUrl`, `persistSession`, `autoRefreshToken`
- John's account confirmed via SQL (was stuck with `email_confirmed_at: null`)

**What changed (files)**
- `src/lib/supabase.ts` — auth config options
- `src/pages/Index.tsx` — conditional nav (signed in vs anonymous)
- `src/pages/Login.tsx` — better error messages, resend link
- `supabase/config.toml` — auth site_url, redirect allowlist, SMTP config
- `tests/unit/auth.test.tsx` — 5 new tests
- `DECISIONS.md` — auth debugging findings
- `WISHLIST.md` — marked magic link bug as fixed

**Tests**
- 5 new auth unit tests, 136 total passing

**Breaking changes**
- None

**Notes**
- Free tier can't change JWT expiry (1hr) — sessions persist via refresh tokens (`autoRefreshToken: true`)
- SMTP password passed as `env(SMTP_PASS)` during `supabase config push` — never in git
- To re-push SMTP config: `SMTP_PASS=re_xxx npx supabase config push --project-ref fkxykvzsqdjzhurntgah`
- Free tier email rate limit: 4/hour (now shows friendly error instead of raw Supabase message)

---

### [2026-03-18] — Email notifications via Resend (OTP, label confirmation, tracking)

**Branch:** `feat/email-notifications`
**Commit:** `6a1b169`
**Deploy:** Vercel auto-deploy + Supabase Edge Functions

**What shipped**
- OTP email verification for Flexible Link path (6-digit code, SHA-256 hashed, 10-min expiry)
- Label confirmation email sent after successful purchase (fire-and-forget)
- Tracking update email on EasyPost webhook status changes (in_transit, out_for_delivery, delivered)
- Rate limiting: 3 sends per email per 10 min, 5 verification attempts per code
- Branded HTML email templates (SendMo blue header, white body, gray footer)
- RecipientStepEmailVerify wired to real API calls (replaces stubbed setTimeout)

**What changed (files)**
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

**Tests**
- 21 new unit tests (email templates + OTP logic), 131 total passing

**Breaking changes**
- None

**Notes**
- RESEND_API_KEY set as Supabase secret, sendmo.co domain verified in Resend
- All email sends are fire-and-forget — never block user-facing responses
- No PII logged in event_logs (email addresses excluded per policy)

---

### [2026-03-18] — Auth, Flexible Link path, E2E tests

**Branch:** `feat/flexible-link` (merged), plus auth and test commits
**Commit:** `f65bfc2`
**Deploy:** Vercel auto-deploy

**What shipped**
- Supabase Auth with magic link (passwordless) login
- Protected routes — `/onboarding`, `/dashboard` require auth
- Flexible Link recipient path (Steps 20-23): preferences, email verify, payment auth, link ready
- Comprehensive Playwright E2E test suite
- Updated CLAUDE.md with auth, flexible link, and test status

**What changed (files)**
- `src/pages/RecipientOnboarding.tsx` — added flex link steps 20-23
- `src/components/recipient/RecipientStepFlex*.tsx` — 4 new step components
- `src/hooks/useRecipientFlow.ts` — flex link state + step navigation
- `src/lib/api.ts` — added `sendOTP()`, `confirmOTP()`
- `tests/e2e/` — new Playwright suite
- Auth provider, login page, route guards

**Tests**
- 157 unit tests passing
- New E2E test suite (Playwright)

**Breaking changes**
- Routes now require auth (except landing, FAQ, `/s/:shortCode`)

**Notes**
- Admin PIN still hardcoded (`2026`) — replace with `profile.role === 'admin'` before launch
- Stripe still stubbed — real integration blocked on auth completion

---

### [2026-03-17] — Vercel production deploy + domain setup

**Branch:** direct to `main`
**Commit:** `26a277b`
**Deploy:** Vercel auto-deploy + manual domain config

**What shipped**
- sendmo.co live on Vercel (A record → 76.76.21.21)
- www.sendmo.co CNAME redirect
- wind.sendmo.co pointing to coyote-wind project
- SPA rewrites in `vercel.json` for client-side routing
- EasyPost live key set as Supabase secrets
- Comp label ledger — migration 009 adds `payment_method` column

**What changed (files)**
- `vercel.json` — SPA rewrites, build config
- `supabase/migrations/009_*.sql` — payment_method column
- `CLAUDE.md` — production URL, env var docs, Vercel deployment section

**Tests**
- No new tests this deploy

**Breaking changes**
- None

**Notes**
- Vercel does NOT read `.env.local` — all `VITE_*` vars must be in Vercel dashboard
- After changing env vars, must redeploy with `vercel --prod`

---

### [2026-03-16] — Full Prepaid Label flow + admin mode

**Branch:** direct to `main`
**Commit:** `ba8c354`
**Deploy:** Vercel auto-deploy

**What shipped**
- Recipient onboarding flow (Full Prepaid Label path): Steps 0→1→10→11→12
- Admin page with PIN gate, reporting, label void
- Admin test/live toggle on `/onboarding`
- Magic Guestimator (15 item types + urgency keywords)
- Dashboard with shipment history (mock data)
- Landing page (hero, how it works, value props, use cases, CTA, footer)
- 30+ EasyPost service name mappings
- All backend Edge Functions deployed (addresses, rates, labels, cancel-label, admin-report, autocomplete, place-details, ingest, test-db-insert)
- Database schema: 8 migrations applied on remote Supabase

**What changed (files)**
- `src/pages/` — RecipientOnboarding, Dashboard, Index, Admin, FAQ
- `src/components/recipient/` — all step components, ProgressBar, MagicGuestimator, ShippingMethodCard
- `src/hooks/useRecipientFlow.ts` — state management
- `src/lib/api.ts` — verifyAddress, fetchRates, buyLabel, pricing helpers
- `src/lib/utils.ts` — carrier/service display, speed tier classification
- `supabase/functions/` — 9 Edge Functions
- `supabase/migrations/` — 001-008

**Tests**
- 131 unit tests passing
- LabelTest page for manual backend testing

**Breaking changes**
- First real deploy — no prior production state

**Notes**
- Stripe payment stubbed (shows success without real charge)
- EasyPost test mode by default; live mode via admin toggle only

---

### [2026-03-14] — Initial setup

**Branch:** direct to `main`
**Commit:** `a2b96d4`
**Deploy:** Initial Vercel deploy

**What shipped**
- React + Vite + TypeScript + Tailwind + shadcn/ui scaffold
- EasyPost Edge Functions (addresses, rates)
- LabelTest page for development
- CI pipeline (lint, typecheck, test)
- PRD.md, CLAUDE.md, DECISIONS.md

**What changed (files)**
- Everything (initial commit)

**Tests**
- Basic test framework setup

**Breaking changes**
- N/A (first deploy)

---

*Last updated: 2026-03-30*
