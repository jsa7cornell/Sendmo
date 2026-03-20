# SendMo — Decision Log & Integration Gotchas

> AI agents: Read this file alongside CLAUDE.md. It captures **why** decisions were made and **hard-won** debugging knowledge. Before ending any session, propose additions here if you discovered anything new.

---

## How to Use This File

When an agent discovers something important — an API quirk, a "why did we choose X", a bug pattern — it should propose an addition to this file using the following format:

```markdown
### [YYYY-MM-DD] Short title
**Category:** Architecture | EasyPost | Stripe | Supabase | Testing | Security
**Context:** What situation led to this discovery.
**Decision/Finding:** What was decided or discovered.
**Why:** The reasoning or evidence.
**Watch out:** What breaks if you ignore this.
```

---

## Pricing & Rate Strategy

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

## Architecture Decisions

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

## EasyPost Integration Gotchas

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

## Supabase / Database Gotchas

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

## Testing Gotchas

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

## Label Cancellation / Refund Gotchas

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

## Logging / Observability Gotchas

### [2026-02-25] `log()` is fire-and-forget — don't await it on the critical path
**Category:** Architecture  
**Context:** Logging was being awaited, adding latency to every API response.  
**Decision/Finding:** The `log()` helper in `_shared/logger.ts` should never be awaited on the critical path. Use `log({...})` without `await`.  
**Why:** Log ingestion latency (DB write) should not block the user-facing response.  
**Watch out:** This means log failures are silent. Add a try/catch inside `logger.ts` itself to swallow errors gracefully.

---

*Last updated: 2026-03-19 | Add new entries at the top of each category section.*
