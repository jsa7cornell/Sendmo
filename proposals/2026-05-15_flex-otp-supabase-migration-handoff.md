# Addendum handoff — migrate flex step 21 OTP to Supabase Auth

> Paste the body below into the existing OAuth/session agent session (it's an in-scope extension of the same domain). The original OAuth handoff at `proposals/2026-05-14_oauth-and-session-handoff.md` covered OAuth bounce + session length; this adds a third related task.

---

## Third bug: flex onboarding's bespoke OTP needs to migrate to Supabase Auth

**Why now:** Phase E (flex-link real payments, committed `ab92b3d` on 2026-05-15) requires a Supabase session at step 22 to call `createFlexLink` and `createFlexHold` (both need a JWT). The current flex step 21 uses the bespoke `email_verifications` table OTP, which doesn't create a Supabase session. Result: today's deploy errors with "You must be signed in to create a link" on every flex onboarding attempt.

**Why this was deferred (and why it's now due):** The 2026-05-11 account-creation-timing proposal explicitly committed to migrating flex from the bespoke OTP to Supabase-native `signInWithOtp` "by the end of Stripe Phase A." That migration was deferred through Phases B/C/D (cards, dogfood, saved-card display) because none of those touched flex. Phase E touches flex with real money, so the deferred commitment is now coming due. This is not surprise scope — it's the documented next domino.

Quote from the proposal (review response B1):
> "The flex flow's step 21 specifically uses the bespoke `email_verifications` table *because* flex doesn't want a session until the link is shared — that's load-bearing, not incidental."

The "load-bearing" framing was true when step 22 was a mock. With real Stripe holds at step 22, the framing inverts: we need a session AT step 22, and the natural place to create it is step 21.

## The actual work

The full-label flow already shipped this exact pattern at step 11 — your job is to mirror it for flex step 21.

1. **Read the existing model:**
   - [src/components/recipient/RecipientStepEmailVerifySupabase.tsx](src/components/recipient/RecipientStepEmailVerifySupabase.tsx) — the full-label Supabase-Auth-backed verify step. Uses `supabase.auth.verifyOtp({ type: "email" })` for code path and session auto-detect for the email-link path.
   - [src/components/recipient/RecipientStepAddress.tsx](src/components/recipient/RecipientStepAddress.tsx#L39-L55) — `maybePrimeOtp` fires `supabase.auth.signInWithOtp` silently on email blur at step 1 for the full-label path. The redirect URL is `/onboarding/full-label/verify?confirmed=1`.

2. **What to change for flex:**
   - **Option A (recommended): replace** the existing `RecipientStepEmailVerify.tsx` (bespoke OTP) with a Supabase-Auth-backed equivalent for flex. The new component sets `state.email_verified = true` only when `session` is non-null. Keep the same prop shape so `RecipientOnboarding.tsx` swap is one line.
   - **Option B: extend** `maybePrimeOtp` to also fire for the flex path (it's currently gated on `path === "full_label"`). Then the Supabase OTP is already in the inbox by the time the user reaches step 21. Step 21 becomes a Supabase-Auth verify step.
   - Both work; A is cleaner (one path).

3. **Drop the bespoke `email_verifications` table:**
   - The 2026-05-11 proposal commits to removing the table once flex is migrated. After A or B lands and verifies, drop the table in a follow-up migration. Also remove the `/email` Edge Function action that hits it (search `supabase/functions/email/` for `email_verifications` usage).
   - **Don't delete in the same PR as the migration** — keep one release of overlap so a rollback path exists. The kill date the proposal named was "end of Phase A," so we're already overdue; one more release of overlap is acceptable.

4. **Update the SPEC.md flex section** to reflect Supabase-Auth at step 21 (currently says "5-digit OTP, bespoke email_verifications").

## How to verify

After the migration:

1. **Test mode dogfood path:**
   - Sign out completely (`localStorage.clear()` if needed).
   - Go to `/onboarding`, pick "Flexible shipping link."
   - Fill destination + email, advance through step 20 (preferences).
   - At step 21: enter the 6-digit code from the inbox (or click the email link).
   - **Critical:** after verification, `useAuth().session` must be non-null. Open the React DevTools or `console.log(session)` to confirm.
   - Advance to step 22: PaymentElement should render (Phase E flow). If you see "You must be signed in to create a link," the session didn't land — debug.
   - Use test card `4242 4242 4242 4242`, complete hold authorization.
   - Step 23 should show the activated link.

2. **The Phase E LOG entry** (which I'll write separately) needs a `Browser-verified:` block per Rule 19 — your work unblocks that verification, so coordinate with the next agent on it.

## Coordinating with the other open tasks

The OAuth-bounce and session-length bugs from the original handoff doc may share root cause with this one:
- **OAuth bounce:** likely Supabase Site URL / redirect allowlist config in production. Same surface as the new Supabase-OTP `emailRedirectTo` URL — verify both at once.
- **Session length:** likely JWT expiry config + missing refresh. The new flex step 21 needs `persistSession: true` + auto-refresh working correctly, so a fix to session length benefits both.

If you're already mid-investigation on those, this third task is a natural addition to the same session.

## References

- Master proposal: [proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md](proposals/2026-05-11_account-creation-timing_reviewed-2026-05-11_decided-2026-05-11.md) — read §C3 "Kill date for parallel OTP paths" and review B1 about the original flex-untouched commitment.
- Phase E commit: `ab92b3d` (2026-05-15) — the flex_hold + capture work that triggers this need.
- Original OAuth handoff: [proposals/2026-05-14_oauth-and-session-handoff.md](proposals/2026-05-14_oauth-and-session-handoff.md).
