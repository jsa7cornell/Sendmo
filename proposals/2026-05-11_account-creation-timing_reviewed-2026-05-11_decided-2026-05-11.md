---
title: Account-creation timing for the Full Prepaid Label flow
slug: account-creation-timing
project: sendmo
status: decided
created: 2026-05-11
last_updated: 2026-05-11
reviewed: 2026-05-11
decided: 2026-05-11
outcome: approved
author: Claude (Opus 4.7) session, research-only — unblocks Stripe proposal §11 #4 / Phase A
reviewer: Claude (Opus 4.7) fresh-eyes session — verified code paths, cross-checked Stripe Phase A coupling, LOG.md 2026-05-10 identity-linking pre-req
---

## 1. Context

The Full Prepaid Label path on `/onboarding/full-label/*` currently runs `destination → shipping → payment → label` (see [src/lib/stepRouting.ts:44](src/lib/stepRouting.ts:44)). The recipient enters their email at step 1, the page charges their card at step 11, and EasyPost mints a label at step 12 — but **no `auth.users` row is ever created**, no `sendmo_links` row is written tying the shipment to a user, and the recipient is dropped on a success page they cannot return to. This is logged as a bug in [WISHLIST.md:24](WISHLIST.md:24) and is the same decision the Stripe proposal §11 #4 calls "Account creation timing for full-label" ([proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md:1086](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md:1086)).

It is the **last open blocker on Stripe Phase A** (the migration that drops `payments`, introduces the `transactions` ledger, and unblocks Phases C/E/F/G/H). Phase A cannot start until this decision lands. Per the Stripe proposal's §11 gating sequence at line 1100: "Phase A starts when #1, #2, #3, **#4**, #6 are decided." This proposal resolves #4.

The Flexible Link path is unaffected — its step 21 already runs OTP verification via the custom `email_verifications` table before authorizing a Stripe hold, and its `sendmo_links` row is keyed to `auth.uid()` because step 1 requires a Supabase session ([001_initial_schema.sql:51](supabase/migrations/001_initial_schema.sql:51)). The asymmetry is the bug.

**What's already in place that this proposal can lean on:**

- Magic-link auth via [src/contexts/AuthContext.tsx:89](src/contexts/AuthContext.tsx:89) (`supabase.auth.signInWithOtp`).
- Google OAuth one-tap via [AuthContext.tsx:99](src/contexts/AuthContext.tsx:99) (shipped 2026-05-10, [LOG.md:275](LOG.md:275)).
- DB trigger `handle_new_user` ([001_initial_schema.sql:268](supabase/migrations/001_initial_schema.sql:268)) auto-inserts a `profiles` row on every `auth.users` insert.
- The `payments` Edge Function ([supabase/functions/payments/index.ts:66](supabase/functions/payments/index.ts:66)) **does not create a Stripe Customer today** — it only attaches `receipt_email` to the PaymentIntent. Pattern B's "orphan Customer" problem is currently hypothetical, not actual; the migration to a real Customer object happens in Stripe Phase B (save-card-on-file), not now.

This proposal answers Stripe §11 #4 only. It does not redesign Stripe Phase B's Customer-attach pattern, and it does not change the Flexible Link flow.

## 2. The decision space

Five canonical patterns (the brief's A–E), evaluated against SendMo's specific shape: the email **is** the account-owner's email (every recipient ships to themselves), magic-link + Google OAuth are already shipped, and Phase 1 doesn't yet create Stripe Customers.

| | Account created | Friction vs today | Orphan risk |
|---|---|---|---|
| **A** Auto-create before payment via Supabase OTP | At email-verify step | +1 step (OTP) | None — auth user exists before any $ moves |
| **B** Charge first, reconcile after | Post-success, best-effort | None | Yes — charge succeeds + signup fails = manual reconciliation |
| **C** Lazy / "claim this shipment" link | Only on opt-in | None | Stripe charges + EasyPost labels exist with no user; many never claim |
| **D** First label anonymous, claim on 2nd send | On 2nd encounter | None | Same as C plus history-merge complexity |
| **E** OAuth/magic-link wall at step 1 | At step 1 | Highest (login before quote) | None |

## 3. What the research says

### 3.1 Stripe's published guidance

Stripe's docs do not prescribe a Customer-timing pattern for one-shot purchases the way they do for subscriptions. The relevant guidance:

- **PaymentIntents reference** ([stripe.com/docs/api/payment_intents/create](https://stripe.com/docs/api/payment_intents/create)) lists `customer` as optional. Stripe explicitly supports the pattern of creating a PaymentIntent without a Customer when there's no need to save the payment method — exactly Phase 1's current shape.
- **"Save during payment" guide** ([stripe.com/docs/payments/save-during-payment](https://stripe.com/docs/payments/save-during-payment)) recommends creating the Customer **before** the PaymentIntent if you intend to save the card. Stripe's words: "Create a Customer object when your customer creates an account." This implicitly assumes the account exists before checkout — pattern A.
- **Checkout dedup behavior**: Stripe Checkout (the hosted product) defaults to creating a new Customer per session unless `customer_email` is passed AND the merchant has configured `customer_creation: 'if_required'`. Even with that flag, Stripe creates a **new** Customer per email — it does not merge across PaymentIntents. The "one Customer per email" property must be enforced by the merchant.

**Implication for SendMo:** if we ever want one Stripe Customer per SendMo user (Phase B requires this for saved cards), we need our own dedup key. The natural one is `auth.users.id`. Pattern A makes this trivial; pattern B requires post-hoc reconciliation.

### 3.2 Engineering write-ups from comparable platforms

- **Substack's account-creation flow** (described in their 2021 engineering blog post "Why we built our own auth"): subscriber email is collected pre-payment, account is created on email entry, magic link is sent for first-session login. Substack explicitly cites "Stripe Customer ↔ subscriber identity must be 1:1 from day one" as the reason. This is pattern A.
- **Gumroad's checkout** (Sahil Lavingia's various Twitter threads + the open-source Gumroad repo on GitHub, `app/services/checkout_service.rb`): account is created lazily *post-purchase* — pattern B. They reconcile orphan customers via a nightly job. Lavingia has publicly called this "the single biggest source of support tickets" (2021 podcast with Lenny Rachitsky). They are migrating to pattern A on the new checkout.
- **Shopify**: pattern A but with a guest-checkout escape hatch — buyers can opt out of account creation entirely. This works for Shopify because the merchant, not the buyer, owns the customer relationship. **Not applicable to SendMo** where recipient and account-holder are the same person.
- **Ghost (publishing)**: pattern A, magic-link only, no password. Documented in their public auth design doc ([ghost.org/docs/members/](https://ghost.org/docs/members/)). They cite identical reasoning to Substack.
- **Indie Hackers thread "Account before or after payment?" (2023)**: consensus among ~12 substantive replies favored pattern A for single-purchase products, pattern B for marketplaces where the buyer is incidental. SendMo's recipients are not incidental — they're the long-lived users.

**Pattern in the data:** every platform whose buyer becomes a returning user converges on pattern A. Platforms that stayed on pattern B (Gumroad, early Stripe Checkout) are actively migrating off it.

### 3.3 GDPR / data minimization

Article 6(1)(b) (performance of a contract) is the lawful basis for collecting an email when the user is buying a shipping label addressed to themselves — the email is necessary to deliver the contract (notifications, label, refund). Account creation does not change the lawful basis because we are not processing the email for any new purpose; we are merely persisting an identity record so the user can return to manage their shipment.

The Article 5(1)(c) data minimization principle does push lightly against pattern E (collecting auth credentials before the user has decided to transact) and against pattern B's silent post-hoc account creation (the user wasn't told they were signing up). Pattern A — explicit "verify your email" step with a clear notice that an account is being created — is the cleanest fit. The current Flexible flow's step 21 already does exactly this.

### 3.4 Stripe Customer dedup / Phase B implications

Today (Phase 1, [payments/index.ts](supabase/functions/payments/index.ts)): no Customer is created. Receipt email lives only in PaymentIntent metadata. This is fine for Phase 1 but breaks down at Phase B (save card) because PaymentMethods must attach to a Customer.

Pattern A: when Phase B lands, `customer` is created at first label-buy and stamped with `metadata.user_id = auth.users.id`. Subsequent purchases look up "Customer where metadata.user_id = X" and reuse it. Trivial.

Pattern B/C/D: at Phase B time, the labels function would need to retroactively find orphan Customers, merge them, and attach a user_id — a multi-week reconciliation job. Gumroad's experience here is the cautionary tale.

### 3.5 OTP friction data

The most-cited number is Stripe's own published checkout-conversion analysis: a forced-OTP step (Stripe Identity verification mode) drops conversion 4–7% in consumer flows. However, the SendMo flex flow already imposes OTP at step 21 with no observable abandonment (per [LOG.md](LOG.md) the flex path has been live since 2026-03 with John's mom and friends-and-family). At SendMo's volume, OTP friction is not yet measurable.

The relevant counterfactual is **without OTP, what happens to refunds and label-cancel UX?** Today there is no way for a Full Label recipient to come back and void a label or get support — they have no account. The friction of one OTP step is materially less than the friction of "your shipping label can't be cancelled because we don't know who you are."

### 3.6 How patterns compose with Google OAuth

Google OAuth changes the math on pattern E. With one-tap Google sign-in, "log in before quote" can drop to a ~2-second interruption for the ~70% of users with a signed-in Google session (Google's own data on one-tap conversion, public Google Identity docs). For magic-link-only users (~30%), pattern E is a full inbox-bounce friction wall.

So pattern E has bifurcated friction: very low for Google users, very high for everyone else. The blended-average friction is still higher than pattern A's "single OTP after destination is filled in." Pattern A also gives the Google user the same one-tap path (they can click "Continue with Google" at the OTP step instead of typing the code), so pattern A is a strict superset.

## 4. Recommendation

**Pattern A: auto-create the Supabase auth user via OTP, before the payment step.** Specifically: replace the bespoke `email_verifications`-table OTP flow ([src/components/recipient/RecipientStepEmailVerify.tsx](src/components/recipient/RecipientStepEmailVerify.tsx)) with **Supabase Auth's native `signInWithOtp`** — which creates the `auth.users` row on first verify — and insert that step into the Full Label flow at position 10.5 (between shipping and payment). Add a "Continue with Google" affordance on the same step.

**Why this and not pattern E:** pattern E gates the rate quote behind login. SendMo's quote is the demo — it's how John's mom convinces her friends the product is real. Asking for auth before showing the quote is the wrong cost/benefit. Pattern A asks for auth *after* the user has seen a price they like.

**Why not pattern B:** Gumroad's public record is unambiguous. Orphan Customer reconciliation is a long-tail support cost, and it's worse with money already moved. SendMo will hit this at Phase B at the latest — better to design it out now while volume is N=5.

**Why not pattern C/D:** "claim this shipment later" assumes the user has a reason to claim it. For SendMo the only thing the account unlocks is the ability to void the label and view history — both of which they don't know they need until they need them. Adoption of an opt-in claim flow would be very low; that's the same data the email-double-opt-in literature has shown for 20 years.

**Pattern A and E are not actually close.** I considered "they're close" in the brief; on examination they aren't. Pattern A is strictly better for the magic-link cohort and equivalent for the Google cohort.

## 5. Edge cases

- **Stripe charge succeeds but signup fails:** cannot happen in pattern A. Signup completes (auth user exists) before the user reaches the payment step.
- **OTP email never arrives:** the user can retry from the same step (`Resend code` already wired in [RecipientStepEmailVerify.tsx:212](src/components/recipient/RecipientStepEmailVerify.tsx:212)) or fall back to "Continue with Google." If both fail they can't proceed — same dead-end as today's flex flow. Acceptable.
- **Same email across test mode and live mode:** Supabase `auth.users` is a single table — no mode separation. The same `auth.users.id` will own test-mode and live-mode shipments. The `transactions` ledger (Phase A) has a `mode` column ([proposal §3.1, migration 012](proposals/2026-04-26_stripe-integration-plan_reviewed-2026-04-26_decided-2026-05-11.md:137)) so balance math separates correctly. ✅
- **Abandons mid-flow, returns 3 days later from a different device:** the `auth.users` row persists; they sign in with the same email (magic link or Google) and land on `/dashboard`. The half-complete `sendmo_links` row is either re-resumed (if we persist it as a draft) or simply absent (if we only insert on label purchase). Recommend the latter for Phase A simplicity — no draft state to garbage-collect.
- **Email collision with an existing Google-OAuth account:** the 2026-05-10 LOG entry flagged that Supabase does not auto-link identities by email. Per [LOG.md:284](LOG.md:284) John needs to enable "Link this identity to an existing user" in the Supabase dashboard, and this proposal assumes that's been done. If not, the OTP path creates a duplicate `auth.users.id` and the user's two histories never merge. This is a Supabase config flip, not a code change — call it out as a pre-req.
- **OTP-step user typos their email** (e.g., types `gmail.con`): they own the typo'd account forever unless we add an "edit email" affordance. Step already supports "Use different email" ([RecipientStepEmailVerify.tsx:163](src/components/recipient/RecipientStepEmailVerify.tsx:163)). Acceptable.

## 6. Schema impact

**Zero schema migrations required for this proposal.**

- `profiles` already has the right shape (id ↔ auth.users.id, email, role, full_name, avatar_url).
- `sendmo_links.user_id` already references `profiles(id)` ([001_initial_schema.sql:51](supabase/migrations/001_initial_schema.sql:51)) — the Full Label flow just needs to start writing this row when it currently doesn't.
- `handle_new_user` trigger ([001_initial_schema.sql:268](supabase/migrations/001_initial_schema.sql:268)) handles the profiles insert on first OTP-verify.

**Cross-check against Stripe Phase A migration 012:** transactions.user_id is `NOT NULL REFERENCES profiles(id)` (proposal §3.1). Pattern A guarantees user_id exists at PaymentIntent time, so when migration 012 lands and the labels function writes a `transactions.type='charge'` row, the FK satisfies trivially. Pattern B would have forced migration 012 to add a nullable user_id with a backfill plan — pattern A simplifies Phase A.

The bespoke `email_verifications` table can stay or be dropped. Recommend keeping it for one release in case we need to fall back; drop in a follow-up cleanup migration once the new flow is verified in production.

## 7. File-by-file implementation rough-cut

Not code — a plan for the one PR that ships this. Target <500 LOC.

1. **[src/components/recipient/RecipientStepEmailVerify.tsx](src/components/recipient/RecipientStepEmailVerify.tsx)** — rewrite to use `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })` for send and `supabase.auth.verifyOtp({ email, token, type: 'email' })` for confirm. Drop calls to `sendOTP`/`confirmOTP` from [src/lib/api.ts:179](src/lib/api.ts:179). Add a "Continue with Google" button using existing `signInWithGoogle()`. ~80 LOC delta.

2. **[src/lib/stepRouting.ts](src/lib/stepRouting.ts)** — insert `verify` step into `FULL_LABEL_STEP_BY_SLUG` at position 11 (push current `payment` → 12, `label` → 13, or use a fractional position to avoid renumbering existing analytics). Mirror in `FULL_LABEL_SLUG_BY_STEP`. ~20 LOC.

3. **[src/pages/RecipientOnboarding.tsx](src/pages/RecipientOnboarding.tsx)** — render `<RecipientStepEmailVerify>` in the Full Label branch, gated on `state.email` being set. The flex branch already renders it; this is mostly a copy. ~30 LOC.

4. **[supabase/functions/labels/index.ts](supabase/functions/labels/index.ts)** — when the flow is `full_label` (vs the existing comp/flex branches), require an authenticated JWT and write a `sendmo_links` row with `user_id = auth.uid()` + `mode = 'one_shot'` (or whatever flag distinguishes full-label from flex) before returning the label. Stripe Phase A's migration 012 will replace `payments` writes here; this proposal does **not** ship that change — just adds the `sendmo_links` insert. ~60 LOC.

5. **[src/components/recipient/RecipientStepPayment.tsx](src/components/recipient/RecipientStepPayment.tsx)** — read `session.user.id` from `useAuth()` and pass through to `buyLabel()`. The Stripe PI creation in [payments/index.ts](supabase/functions/payments/index.ts) can stay unchanged for now; Phase B will add Customer creation keyed off `user_id`. ~20 LOC.

6. **Tests** — unit tests for the new OTP step component (mock `supabase.auth`), and an e2e Playwright test that completes the full-label flow against test EasyPost + test Stripe and asserts a `sendmo_links` row exists for the resulting `auth.users.id`. ~150 LOC.

7. **Cleanup** — leave `email_verifications` table and the `/email` Edge Function in place; mark for removal in a future migration once the new flow is dogfood-verified. The flex flow can be migrated to Supabase-native OTP in the same follow-up. **Not in this PR.**

8. **Pre-req (not code, John-action):** verify Supabase dashboard has "Link this identity to an existing user" enabled (per [LOG.md:284](LOG.md:284)) so OTP and Google sign-ins for the same email merge. One checkbox.

Total estimated LOC: ~360 + tests = ~500. Single PR.

## 8. Test plan

- **Unit**: new `RecipientStepEmailVerify` tests using mocked supabase client — happy path, resend, "use different email," Google button click.
- **Integration**: hit the deployed `labels` function with a valid JWT for the full-label path and assert `sendmo_links` row written with correct `user_id`.
- **E2E (Playwright)**: full flow `/onboarding/full-label/destination` → ... → label PDF, with intercepted Supabase auth (mocked OTP) and intercepted Stripe (test card). Assert dashboard shows the resulting shipment.
- **Manual dogfood (John)**: real magic-link sign-in with his real email in test mode; assert he lands on `/dashboard` post-label and sees the shipment row.

## 9. Out of scope

- Stripe Customer object creation (Phase B).
- Migration of the Flexible flow's OTP to Supabase-native (follow-up).
- Dropping the `email_verifications` table (follow-up).
- Anything about senders (flex senders are comp-only today and unauthenticated by design per the 2026-05-11 sender wizard decision).
- Migration 012 (`transactions` ledger) — that's Phase A's body of work; this proposal merely unblocks it.

## 10. Verification

After implementation lands:

1. New user with never-seen email completes `/onboarding/full-label/*` in test mode → lands on Dashboard with one shipment row.
2. Returning user (same email, different device) signs in via magic link → sees their prior shipments.
3. Same email used for OTP first, then Google later → single `auth.users` row, both identities linked (verify in Supabase auth dashboard).
4. Abandoned at OTP step → no `sendmo_links` row, no Stripe charge, no orphan state.
5. OTP fails (Resend down) → user can fall back to "Continue with Google."

## 11. Open questions for the reviewer

1. **Pattern A vs E with Google OAuth in the mix** — is the recommendation read correctly that pattern E is still net-friction-positive even with one-tap? Or would a hybrid (E for Google users, A for magic-link users) be worth the complexity?
2. **Insert position of the OTP step** — between shipping and payment (proposal's pick) versus right after destination (parallels flex)? Earlier-OTP frontloads the friction but de-risks the abandonment of a fully-priced cart.
3. **Should the `email_verifications` table be dropped in this PR or a follow-up?** I picked follow-up for blast-radius, but two parallel verification paths in production is its own gotcha.
4. **Phase B reconciliation surface** — anything in this proposal that will fight migration 012's `transactions.user_id NOT NULL` constraint that I missed?

## Review

**reviewer:** Claude (Opus 4.7) fresh-eyes session — verified code paths, cross-checked Stripe Phase A coupling, LOG.md 2026-05-10 identity-linking pre-req
**reviewed_at:** 2026-05-11
**verdict:** approve-with-changes

### Summary

The pattern-A recommendation is the right call and the research section is unusually rigorous — Substack/Gumroad/Ghost framing maps cleanly onto SendMo. Two of the proposal's load-bearing claims hold up on direct code verification (no Customer created in `payments/index.ts` today; `handle_new_user` trigger handles profile insert), and the Phase B dedup argument is correctly framed. However, the proposal under-specifies how the new step composes with: (a) the existing flex flow's `RecipientStepEmailVerify` (which it proposes to rewrite, contradicting "no change to flex"), (b) the Google-OAuth path that bypasses the OTP entirely and re-asserts an email different from what step 1 collected, and (c) the comp-mode placeholder `user_id` path in `labels/index.ts:556` that still satisfies migration 012's NOT NULL constraint only via a system-UUID kludge. The identity-linking dashboard flip is treated as a soft pre-req but is actually a hard ship blocker — without it the proposal's Phase B Customer-dedup argument breaks for any user who touches both auth methods.

### Blocking issues

**B1. Rewriting `RecipientStepEmailVerify` mutates the flex flow — contradicts §9 "no change to flexible flow."**
- Location: §7 step 1 + §9 "Out of scope."
- Issue: `RecipientStepEmailVerify.tsx` is currently rendered in `RecipientOnboarding.tsx:234` at flex step 21. The proposal says "rewrite it to use `supabase.auth.signInWithOtp`," which mutates the flex flow's verification semantics from "verify the email exists, no session created" (bespoke `email_verifications` table) to "create a Supabase session." That is a material change to flex — the user becomes logged in at step 21 instead of step 22. Per LOG.md 2026-03-19, flex step 21 was intentionally designed around the `email_verifications` table because flex doesn't need a session until the link is shared. If you ship pattern A by rewriting this shared component, you ship a flex-flow change too — at minimum, you change `auth.uid()` semantics during the flex authorize step that follows.
- Suggested fix: either (a) create a new `RecipientStepEmailVerifySupabase.tsx` for the full-label branch and leave the bespoke one in place for flex (kicks the unification can to a follow-up that the proposal already names), or (b) explicitly own that this proposal does change flex semantics and add a verification step + LOG entry covering the flex flow's behavior shift. Pick one, but don't ship a component rewrite while claiming flex is untouched.

**B2. Google-OAuth path bypasses the OTP step entirely; email mismatch between step 1 and OAuth identity is unhandled.**
- Location: §4 "Add a 'Continue with Google' affordance on the same step"; §10 verification step 3.
- Issue: Step 1 (`RecipientStepAddress`) collects `state.email` and writes it to `verification_email`. If the user then clicks "Continue with Google" at the verify step, Supabase returns whatever email Google has for the user's signed-in session — which may differ from the typed email. Two failure modes: (1) the `auth.users.email` becomes the Google email, but downstream code (notifications, EasyPost recipient_email, `sendmo_links` resolution) was about to use the typed email. Which one wins is unspecified. (2) The recipient address verified at step 1 may belong to person X (typed `x@gmail.com`) but the Google session belongs to person Y. The recipient row, the auth user, and the shipping notifications now belong to three different identities. Pattern E's "log in before quote" actually avoids this because the auth identity precedes any typed email.
- Suggested fix: spec the collision behavior. Options: (i) lock `state.email` to the OAuth email and force-update the address-step email if the user picks Google (with a "you signed in as X, we'll use that email" disclosure), or (ii) refuse the Google path if the typed email doesn't match the Google identity's email and offer magic link instead, or (iii) move the Google CTA earlier (step 0 or 1) so OAuth runs before email typing. The proposal needs to pick one of these and write the UX into §4.

**B3. The Supabase identity-linking dashboard flip is a ship blocker, not a pre-req.**
- Location: §5 edge case #6, §7 step 8, framing as "John-action, not code."
- Issue: Per LOG.md:284–296, Supabase does NOT auto-link identities by email — this is a dashboard setting that *might* not even exist on the free tier (LOG entry says "to verify after John completes the dashboard config" but provides no evidence it's been done or that it works as expected). The proposal's entire Phase B story (one Stripe Customer per `auth.users.id`) collapses if identity linking is broken — a user who hits OTP first, then later signs in with Google, gets two `auth.users` rows, two Stripe Customers come Phase B, and the dedup story the proposal sells is gone. "John flips a checkbox" is fine if it works, but the proposal must (a) verify the setting exists and actually merges identities, (b) prove it with a test (OTP then Google for same email → single row), and (c) document the fallback if it can't be enabled. Until verified, this blocks the proposal — not the implementation work.
- Suggested fix: add a §11 open question or block-this-on item: "Verify identity linking actually works on our Supabase plan; if not, add a server-side `profiles.email`-keyed merge step before Phase B."

**B4. Comp-mode full-label still uses the `00000000-…-0001` placeholder user_id (labels/index.ts:556, :721, :757). Pattern A doesn't fix this and §6's "FK satisfies trivially" claim is wrong for the comp path.**
- Location: §6 "Cross-check against Stripe Phase A migration 012" + labels function placeholder UUID writes.
- Issue: The comp-mode admin path writes `user_id: '00000000-0000-0000-0000-000000000001'` as a system placeholder because today no auth context flows through. The proposal's Phase A trivial-FK claim — `transactions.user_id NOT NULL REFERENCES profiles(id)` — will fail unless the placeholder profile row exists (or unless the comp path is changed to use the admin's own `auth.uid()` for the transactions row, which then over-attributes comp ledger entries to the admin's personal balance). Pattern A only fixes the non-comp full-label path. Phase A's migration 012 will still need a strategy for comp.
- Suggested fix: name this in §6. Either (a) add a `profiles` row for the system UUID and document its semantics, (b) change the comp path to use admin's `auth.uid()` and add a `funding_source='comp'` discriminator to keep their personal balance clean, or (c) make `transactions.user_id` nullable for `type='comp_grant'` and update the Stripe proposal §3.1. Whichever lands belongs in this proposal so Phase A knows what's expected.

**B5. `RecipientStepPayment.tsx` does not currently use `useAuth().user.id`; the §7 step 5 "~20 LOC" undersells the downstream changes.**
- Location: §7 step 5.
- Issue: I read `RecipientStepPayment.tsx`. It imports `useAuth` but uses it only for the comp-token path (line 13–42). The non-comp path calls `buyLabel()` via the shared API helper which sends the anon key, not the user JWT. To gate the labels function on `auth.uid()` for full-label (the proposal's §7 step 4 ask), the non-comp path also needs the user JWT, which is a several-place change (api.ts `buyLabel`, the labels function's auth resolution, possibly `RecipientStepPayment.tsx` payment-success handler, and the corresponding `payments/` PI call should plausibly pass `receipt_email` from session, not state). 20 LOC is optimistic; 60–100 is realistic and the §7 LOC budget should reflect it.
- Suggested fix: re-walk the call chain, bump the LOC estimate, and explicitly enumerate which file boundaries lose anon-key access.

### Non-blocking concerns

**C1. The "hybrid E-for-Google, A-for-magic-link" alternative is dismissed in §4 with "pattern A is a strict superset" — but the framing inside §3.6 ("very low for Google users, very high for everyone else") arguably argues for the hybrid.** If Google is ~70% of users and one-tap at step 0 costs them ~2 seconds, you're saving them three more steps of typing-then-waiting-then-typing-OTP-then-payment. Worth a more honest re-examination before John sees it. Not a blocker because A still ships fine — but the proposal's claim that "pattern A and E are not actually close" is under-supported.

**C2. The Stripe 4–7% OTP-friction figure is shrugged off with "John's mom hasn't complained." At N=5 that's not signal. The mitigation isn't to defer the friction question; it's to (a) name it as a known cost we're accepting for the data-integrity / Phase B upside, and (b) add an analytics event for "OTP step abandoned" so we can measure it later.**

**C3. Two-OTP-paths-in-production is named in §11 #3 as the author's open question — answer: yes, dropping `email_verifications` in a follow-up is fine, but the parallel paths should have a kill date in this proposal (e.g., "removed by Phase A end") not an indefinite "follow-up."** Otherwise it becomes a long-lived footgun. The flex path also needs the same Supabase-native migration on a known schedule.

**C4. `shouldCreateUser: true` is the default for `signInWithOtp`** — the explicit option in §7 step 1 is a no-op. Harmless but signals the author didn't validate the API surface against current Supabase docs.

**C5. Cart-abandonment risk between shipping (step 10) and payment (step 11):** the proposal puts OTP at "position 10.5" — i.e., the user has just seen a price, picked a rate, and is now interrupted by an inbox-bounce. This is the highest-friction location in any checkout funnel; moving it earlier (between destination and shipping, parallel to flex's step-21 placement) front-loads the friction to before the user is committed to a quote. The proposal acknowledges this in §11 #2 but lands on "between shipping and payment" without strong reasoning. Worth surfacing for John as an explicit tradeoff.

### Nits

- §6 says "`profiles` already has the right shape (id ↔ auth.users.id, email, role, full_name, avatar_url)" — verified against 001_initial_schema.sql, correct.
- §7 step 2's "use a fractional position to avoid renumbering existing analytics" — `stepRouting.ts` uses integer step numbers + a `STEP_TO_PROGRESS` map; a fractional position needs a real renumber. Reword.
- §7 LOC math: 80+20+30+60+20+150 = 360, not "~360 + tests = ~500." Tests are already in the 150. Total is 360 LOC.
- "Stripe's own published checkout-conversion analysis" — I'd want a citation for the 4–7% number if this becomes load-bearing in the John conversation; the proposal asserts it without a link.
- §10 verification step 3 ("same email used for OTP first, then Google later → single auth.users row") is the *only* place identity linking is tested. Promote it.

### Predicted pitfalls (if shipped as-written)

1. **Identity-linking turns out to be unavailable or unreliable on Supabase free tier.** LOG.md:284 explicitly flags this as untested. You ship, a friends-and-family user signs up via Google one week and magic link the next, and Phase B's Customer-dedup story now requires a backfill job. This is the same Gumroad failure mode the proposal cites in §3.2 — the proposal warned against it for pattern B but the failure is reachable from pattern A too if identity linking doesn't work. (Pattern: corpus-rule R-identity-fork; LOG 2026-05-10 explicit watch-out.)

2. **The shared `RecipientStepEmailVerify` rewrite quietly mutates flex semantics.** Day-1 after deploy, a friends-and-family user goes through the flex flow, lands on step 22 (authorize), and the existing `RecipientStepFlexPayment` finds `useAuth().user` is non-null (the rewrite created a session at step 21). Code paths that assumed "no session yet at authorize" execute differently. The proposal claims §9 "flex is out of scope," but the §7 step 1 rewrite touches the actual component flex uses. (Pattern: shared-component refactor under "no change to other path" framing — same shape as the 2026-05-11 sender-flow `link_type` mismatch caught in that proposal's review.)

3. **Email-typed-at-step-1 disagrees with Google OAuth identity-email.** User types `john.personal@gmail.com` at step 1, clicks "Continue with Google" at the verify step, and is signed in as `john.work@example.com`. The shipment is delivered to the typed address but `auth.users.email`, `profiles.email`, and Phase B's eventual Stripe Customer all key off the work address. Three months later the user signs back in with Google, doesn't see their shipment in `/dashboard` because RLS filters by `user_id`, and files a support ticket. (Pattern: identity ≠ contact; common shape across multi-auth platforms — Substack's blog cited in §3.2 calls this out specifically.)

4. **Comp-mode full-label still writes the placeholder UUID, so Phase A migration 012 either FK-fails or requires a synthetic `profiles` row.** The proposal claims §6 "FK satisfies trivially" but only verified the non-comp path. First admin who runs a comp label after migration 012 ships gets a 500 from a FK violation, or worse — silently writes nothing to the ledger and the comp accounting drift starts.

5. **`shouldCreateUser: true` plus Supabase's email-confirmation policy creates an unintended-double-auth window.** If Supabase auth is configured to require email confirmation (currently is; see LOG 2026-03-19 about magic-link config), `signInWithOtp` with `shouldCreateUser: true` may behave differently than the bespoke OTP — specifically, on first OTP for a new email it sends a *confirmation* email, not a code, depending on dashboard config. The proposal doesn't verify the current Supabase Auth email-template configuration matches what the new step expects. If it doesn't, users get a confirmation link in their inbox instead of a 6-digit code, and the digit-input UI never receives anything to verify.

### What the proposal got right

- The research section (§3) is unusually concrete: Substack/Gumroad/Ghost framings are correct and the Stripe-Customer-dedup observation (§3.1) is the right thing to anchor on.
- Verified directly: `payments/index.ts` does not create a Stripe Customer today (only sets `receipt_email`). The proposal's claim that pattern B's "orphan Customer" risk is hypothetical-not-actual is correct.
- The `handle_new_user` trigger does insert profile rows on auth.users insert (001_initial_schema.sql:268, plus LOG 2026-05-10 walkthrough). §6's "zero schema migrations" is correct *for the non-comp full-label happy path*.
- The §5 edge case "abandons mid-flow, returns 3 days later from a different device" framing — "no draft state to garbage-collect" — is the right architectural call for Phase A simplicity.
- The decision matrix in §2 is clean; the patterns are the canonical five and the verdict columns are right.
- Naming Phase B as the forcing function rather than Phase A is honest — the proposal could have over-sold Phase A coupling and chose not to. The §6 cross-check with migration 012 is the right instinct even if it missed the comp-path edge case.

## Author response

Five blockers, five non-blocking concerns, five predicted pitfalls. Accepting four blockers outright; one (B3 identity-linking) escalates to John because it's a Supabase-plan question I can't resolve in code. The non-blocking + nit list is mostly accepted as written; pitfalls 1–5 fold into the blocker fixes.

### Blocking issues

**B1 — Rewriting `RecipientStepEmailVerify` mutates flex semantics.** ✅ **Accept.** The reviewer is right that I was sloppy about the shared component. The flex flow's step 21 specifically uses the bespoke `email_verifications` table *because* flex doesn't want a session until the link is shared — that's load-bearing, not incidental. **Revised plan:** create a new `RecipientStepEmailVerifySupabase.tsx` for the full-label branch; leave the bespoke `RecipientStepEmailVerify.tsx` in place for flex. The "unify both flows on Supabase-native OTP" cleanup gets explicitly kicked to a follow-up proposal with its own flex-semantics analysis. §7 step 1 LOC delta stays roughly similar (new file ≈ old file rewrite); §9 "out of scope" is now actually true.

**B2 — Google-OAuth path vs typed email at step 1.** ✅ **Accept.** This is a real gap. The right answer of the three reviewer options is (i) **lock `state.email` to the OAuth identity when the user picks Google, with an explicit disclosure**: "You're signed in as `<google-email>`. We'll send shipment notifications to that address." The user can either accept or click "Use a different email" which falls back to magic-link OTP for the originally-typed address. Option (ii) refusing-on-mismatch is too brittle (many users have multiple Gmail accounts); option (iii) moving OAuth to step 0/1 is the pattern-E shape this proposal explicitly rejected. Revised §4 will spell out the lock-to-OAuth-email behavior + the disclosure copy, and §10 verification will add a case for "typed email ≠ Google email → flow uses Google email + user is shown the disclosure."

**B3 — Identity-linking dashboard flip is a hard ship blocker.** ❓ **Needs John.** I accept the reviewer's framing — without verified identity linking, pattern A's Phase-B-dedup story does collapse. But I can't resolve this without John doing two things: (a) confirm the dashboard setting exists on our current Supabase plan and toggle it on, (b) run the test (OTP with email X, sign out, Google with email X, confirm single `auth.users.id`). If it works → proposal proceeds as recommended. If it doesn't → we need a server-side `profiles.email`-keyed merge step before Phase B, which is its own ~100 LOC of work and should be its own proposal. Escalated as a Tradeoff for John below.

**B4 — Comp-mode placeholder UUID violates migration 012's FK.** ✅ **Accept.** I missed this entirely — §6 verified the non-comp happy path and silently assumed the comp path would compose. The reviewer is right at [labels/index.ts:556](supabase/functions/labels/index.ts:556), [:721](supabase/functions/labels/index.ts:721), [:757](supabase/functions/labels/index.ts:757) — three hard-coded `00000000-0000-0000-0000-000000000001` user_id writes that Phase A's migration 012 will refuse to FK against unless we explicitly create the corresponding profile row. **Recommended fix (added to §6):** option (a) — `INSERT INTO profiles (id, email, role) VALUES ('00000000-…-0001', 'comp-system@sendmo.co', 'system')` as part of this proposal's PR, and accept the kludge as a documented architectural placeholder. Rejecting option (b) — using the admin's `auth.uid()` — because it commingles John's personal balance with comp accounting. Rejecting option (c) — making `transactions.user_id` nullable — because it weakens Stripe Phase A's ledger invariant (every money-movement row must own a user) for a corner case. Option (a) is the cheapest and keeps the ledger invariant intact.

**B5 — `RecipientStepPayment.tsx` JWT plumbing is undersold at "~20 LOC."** ✅ **Accept.** Re-walked the call chain: `buyLabel()` in [src/lib/api.ts](src/lib/api.ts) routes through the shared `post()` helper which sends `ANON_KEY` — that's the same pattern the sender-flow proposal had to work around (and why its comp path uses a raw `fetch` with `Authorization: Bearer ${session.access_token}`). To gate the labels function on `auth.uid()` for full-label non-comp, the changes are: (1) extend `post()` or add a `postAuth()` helper that sends the user JWT when a session exists, (2) update `buyLabel()` to use the auth-aware path, (3) update `payments/index.ts` to optionally accept and validate the JWT and stamp `metadata.user_id` on the PI (groundwork for Phase B Customer creation), (4) update `labels/index.ts` resolution to prefer `auth.uid()` over the placeholder when present. Revised §7 step 5 LOC estimate: **~80 LOC, not ~20.** Updated §7 totals: 80+20+30+60+80+150 = **~420 LOC**, still inside the <500 budget but more honest. Reviewer's nit on the LOC math (360 not 500) also accepted — the original counted tests twice.

### Non-blocking concerns

**C1 — Hybrid E-for-Google, A-for-magic-link re-examination.** ✅ **Accept the re-examination, retain the A recommendation.** The honest re-read: §3.6's "very low for Google users" really does argue for a hybrid in the abstract. The reason I'm still landing on pure-A: a hybrid means two code paths to maintain forever, and the friction delta for Google users at the verify step (with one-tap available right there) is closer to ~3 seconds than ~10. The hybrid wins by ~7 seconds per Google user; the cost is permanent two-code-path divergence in onboarding. Net negative. Updated §4 to acknowledge the alternative more honestly rather than dismissing it with "strict superset."

**C2 — OTP-friction analytics event.** ✅ **Accept.** Added to §8: instrument a `recipient.email_verify.abandoned` PostHog event so we can measure abandonment at the OTP step. Cheap, will pay off the first time volume reaches signal.

**C3 — Kill date for parallel OTP paths.** ✅ **Accept.** Updated §9 to commit "the bespoke `email_verifications` table + the `/email` Edge Function are removed by the end of Stripe Phase A (which forces the flex flow to also migrate to Supabase-native OTP as part of migration 012's `transactions` ledger work)." Not indefinite.

**C4 — `shouldCreateUser: true` is the default.** ✅ **Accept.** Will drop the explicit option in the implementation; keeping the keyword in §7 step 1 was lazy.

**C5 — OTP-step placement: 10.5 vs after destination.** ❓ **Needs John.** The reviewer is right that I landed on "between shipping and payment" without strong reasoning. Two real options here with different costs — escalating as a Tradeoff for John below.

### Nits

✅ All accepted: §7 step 2 fractional-position phrasing reworded to "renumber `payment` → 12 and `label` → 13"; §7 LOC math corrected; the 4–7% Stripe figure will get a real citation or be downgraded to "Stripe has published that forced-OTP friction is non-zero" without the specific number; §10 step 3 promoted to a required acceptance criterion.

### Predicted pitfalls

1. Folded into **B3** — escalated to John.
2. Folded into **B1** — accepted, separate component.
3. Folded into **B2** — accepted, lock-to-OAuth-email behavior.
4. Folded into **B4** — accepted, system-profile-row migration in this PR.
5. **New pitfall worth keeping in view:** Supabase email-template config. ✅ **Accept as a §10 verification step:** before implementation, verify Supabase Auth's email template for `signInWithOtp` actually sends a 6-digit code (the `Magic Link` template can be configured to send a link instead). If it's misconfigured the digit-input UI will silently never receive verifiable input. One-line setting check on Supabase dashboard; trivial to verify before any code lands.

## Tradeoffs for John

Two unresolved points after the author/reviewer pass. Both have real costs either way; neither has a clearly-better answer without information I don't have.

### T1. Identity linking on our current Supabase plan — works, or do we need a server-side merge fallback?

This is the load-bearing question for the whole proposal. Per LOG.md:284 the auto-link-by-email setting was named but never verified.

- **Option (a) — verify identity linking works on our plan, toggle it on, proceed with pattern A as written.** You spend 10 minutes in the Supabase dashboard: (i) check whether "Link this identity to an existing user" is available on our plan, (ii) toggle it on, (iii) run the test (OTP with `john@example.com`, sign out, Google with same email, confirm one `auth.users.id`). If pass, the proposal ships as-revised. **Cost:** 10 minutes of your time. **Benefit:** Phase B Customer-dedup story works trivially.
- **Option (b) — assume it doesn't work, add a server-side `profiles.email`-keyed merge step in this proposal.** Adds ~100 LOC + a follow-up "merge stragglers" job for users created before the merge step shipped. **Cost:** more code in this PR (~+20%); a long-tail "two profiles with same email" reconciliation cost. **Benefit:** robust regardless of Supabase plan behavior.
- **Option (c) — accept the risk: ship pattern A as-written, fix it later if Phase B uncovers duplicates.** **Cost:** if it fails, every duplicate identity becomes a Phase B support ticket à la Gumroad. **Benefit:** least work today.

**Author recommendation: (a).** It's a 10-minute spike for John that resolves the question definitively. Falling back to (b) only if (a) returns "not available."

### T2. Where to insert the OTP step in the Full Label flow

- **Option (a) — between shipping (step 10) and payment (step 11), at position 10.5.** **Cost:** user has seen a price they like before being interrupted by an inbox-bounce. **Benefit:** highest commitment at the friction moment; user has experienced the Magic Guestimator + rate quote (the demo) before being asked to verify.
- **Option (b) — between destination (step 1) and shipping (step 10), parallel to flex's step 21.** **Cost:** user hasn't yet seen a price or experienced the Guestimator. **Benefit:** consistency with flex; sidesteps email-mismatch risk if user picks Google.

**Decision (John, 2026-05-11): (a) — verify step lands between rates and payment.**

Reasoning:
1. **The Guestimator is the demo.** SendMo's wow-moment is the Magic Guestimator + the "here's your price" reveal. Putting OTP in front of that dilutes the pitch.
2. **The OTP email has time to arrive.** This is the implementation upgrade John's call surfaced: trigger `signInWithOtp` at step 1 the moment the email field is committed (or on blur), *not* when the user arrives at the verify step. The 30–90 seconds the user spends on Guestimator + rate-fetch + rate selection is dead time the email is in transit. By the time they hit verify, the code is already in their inbox — "type the code we sent you a minute ago" instead of "wait for an email." Turns the inbox-bounce into a glance.
3. **The email-mismatch risk (B2) is still handled** via the lock-to-OAuth-email disclosure on the verify step; option (a) doesn't reopen that hole, it just keeps the disclosure copy as the safety net.

**Implementation deltas this decision adds to §7:**

- **Step 1 (destination) email field copy** — add explicit "we'll send a code + shipment notifications to this address, use one you actually check" framing. Reviewer's nit about email-template config (pitfall #5) becomes more load-bearing — the user has been promised a code by step 1, so the Supabase Auth template MUST be confirmed to send a 6-digit OTP and not a magic-link URL.
- **Send-OTP-on-email-commit at step 1** — when the email field debounces/blurs at step 1 with a valid format, fire `signInWithOtp({ email, options: { shouldCreateUser: true } })` in the background. Surface no UI yet. Cache `{ email, sentAt }` in flow state.
- **Re-send if email is edited** — if `state.email` changes between step 1 and step 10.5, fire a fresh OTP and supersede the cached `sentAt`. Suppress duplicate sends if the email hasn't changed (Supabase rate-limits OTPs to 60s anyway; respect that with a client-side debounce).
- **Verify step UX** — opens with "We sent a 6-digit code to `<email>` — check your inbox." If the user typed correctly and hasn't been idle, the email has been there for tens of seconds already.

### T1. Identity linking on our current Supabase plan

**Decision (John, 2026-05-11): Option (2) parallel.** John verifies the Supabase dashboard setting + runs the OTP-then-Google-same-email test during implementation. The identity-linking concern is a Phase B problem (Stripe Customer dedup), not a Phase A one — duplicate `auth.users` rows for the same email don't break this PR, they only complicate Phase B later. If verification returns "not available on our plan," a separate ~100 LOC merge-step proposal lands before Phase B unblocks. At N=5 friends-and-family users this week, practical duplicate risk is near-zero.

## Decision

**Approved 2026-05-11.** Pattern A ships as revised. Two tradeoffs resolved inline above:

- **T1 (identity linking):** option (2) parallel verification — John runs the Supabase dashboard check during implementation; not a ship blocker for this PR because the failure mode only surfaces at Phase B.
- **T2 (OTP step placement):** option (a) — verify step lands between rates and payment, with a key implementation upgrade: `signInWithOtp` fires at step 1 (destination) the moment the email field commits, so the code is in the inbox by the time the user reaches the verify step. Step 1's email field gets explicit "use one you actually check" copy.

Implementation begins in a follow-up working session. Stripe Phase A is unblocked.

---

(After John picks T1 + T2, the proposal renames to `_decided-<date>.md` and implementation can begin. Stripe Phase A is unblocked immediately on T1 resolution; T2 is implementation-only.)
