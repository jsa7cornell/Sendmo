# Handoff — OAuth + session length investigation

> Paste the body below into a fresh Claude Code session at `~/AI Brain/sendmo/`. Two related but distinct auth bugs to investigate. Diagnose first, fix second — don't shotgun changes.

---

## You're investigating two SendMo auth bugs

John is the only user hitting these so far, but they'll bite every authenticated user once the product opens up. Both are reproducible.

### Bug 1 — Google OAuth bounces user out of the onboarding flow

**Reproduce:** Start a Full Label shipment as an unauthenticated user. Get to step 1 (Destination) at `/onboarding/full-label`. Click "Continue with Google". After Google auth completes, the user lands on `/` (home / marketing page) instead of returning to the onboarding flow they were in. Their typed destination / picked rates may or may not be preserved in sessionStorage.

**Code site:** `src/components/recipient/RecipientStepAddress.tsx:57-71`

```tsx
async function handleGoogle() {
  // ...
  const { error: oauthErr } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href },
  });
  // ...
}
```

`redirectTo: window.location.href` SHOULD bring them back to the same URL, but it doesn't. Possible causes (investigate, don't assume):

1. **Supabase production redirect URL allowlist doesn't include `/onboarding/**`.** `supabase/config.toml` has `additional_redirect_urls = [..., "https://sendmo.co/**", ...]` but the *production Supabase dashboard* may not match. The local config.toml is only for local dev — production uses the dashboard config. Check at https://supabase.com/dashboard/project/fkxykvzsqdjzhurntgah/auth/url-configuration.
2. **`Site URL` is `/dashboard` or `/`.** When the redirectTo doesn't match the allowlist, Supabase falls back to Site URL.
3. **Step state is in component state, not URL params.** Returning to `/onboarding/full-label` resets to step 0 if step is React state. Verify by inspecting how step is managed in the parent (likely `src/pages/onboarding/full-label.tsx` or `OnboardingLayout`).
4. **`detectSessionInUrl: true` + React Router race.** The hash fragment from Supabase's OAuth callback (`#access_token=...`) may be stripped before the redirect destination component mounts.

**How to verify cause:** Open DevTools Network tab, attempt the flow, watch the redirect chain. Stops at: Google → `https://fkxykvzsqdjzhurntgah.supabase.co/auth/v1/callback?code=...` → `<your_site>/...#access_token=...`. The final URL is the smoking gun.

**Acceptance:** After Google auth from any onboarding step, user lands back on the same step with their typed-so-far state intact (destination, package details, rate selection — these are already in sessionStorage per the code's own comment at line 61).

### Bug 2 — Session length is too short, user gets logged out frequently

**Reproduce:** Sign in. Use the app. Come back N hours later (John can quantify N — please ask). User is signed out, has to magic-link / OAuth again.

**Likely cause(s):**
- **Default Supabase JWT lifespan is 3600s (1 hour).** Without auto-refresh working, the user gets booted at the first JWT expiry.
- **Refresh token rotation:** Supabase rotates refresh tokens on use. If the client misses a refresh window, the next request is rejected.
- **`autoRefreshToken: true` is set in `src/lib/supabase.ts:8`.** So in theory the client refreshes automatically. But auto-refresh only fires while the tab is active — if the user closes the tab and returns, the session may already be expired *and* the refresh token may be too stale.

**Investigate:**
- What's the JWT expiry set to in the production Supabase dashboard? (Auth → Sessions → "Access token (JWT) expiry time"). Recommend bumping to 7 days, with refresh tokens rotated. Or set "Inactivity Timeout" to a sensible value.
- Is `persistSession: true` actually persisting? `localStorage.getItem("sb-fkxykvzsqdjzhurntgah-auth-token")` should return a JSON blob with `expires_at` and `refresh_token` fields. Look for those.
- Are there any places in the code that explicitly call `supabase.auth.signOut()`? Grep for it. A stray signOut in a useEffect cleanup or onUnmount could be the culprit.

**WISHLIST early observations:** Skim `WISHLIST.md` for any auth/session entries — there were a few prior notes about magic-link + auth flow gotchas (item at line 33 references the prior site URL bug, fixed 2026-03-19). The current symptoms may overlap.

**Acceptance:** A signed-in user stays signed in for at least 1 week of intermittent use without re-auth, unless they explicitly sign out.

## Read these first, in order

1. **`~/AI Brain/CLAUDE.md`** — global agent rules (Rule 0: secrets, Rule 0.5: destructive DB ops)
2. **`~/AI Brain/sendmo/PLAYBOOK.md`** — project rules. Rule 19 (browser-verify product-surface fixes)
3. **`~/AI Brain/sendmo/LOG.md`** — most recent entries for context on what's stable
4. **`~/AI Brain/sendmo/WISHLIST.md`** — search "auth", "session", "OAuth", "magic link" for prior observations
5. **This file** for scope

## Tools available

- **Supabase MCP:** `mcp__supabase__execute_sql` for queries, `mcp__supabase__get_logs --service auth` for auth-specific logs (very useful here), `mcp__supabase__get_edge_function` for verifying deployed source. Cannot read or set secrets via MCP — those changes go through the dashboard or CLI.
- **Stripe MCP:** Not relevant for this task.
- **Playwright MCP:** Useful for reproducing the OAuth bounce. Note: dashboard requires real auth (Playwright can't log in via Supabase from a sandboxed context — see the 2026-05-14 LOG entry for the limitation). For OAuth specifically you can verify the redirect chain by inspecting the Network tab manually.

## Method, not vibes

The previous agent (me) wasted credibility on shotgun fixes for the Stripe `allow_redisplay` and the secret key issue today. **Don't repeat that.** For each bug:

1. Reproduce it once and write down what you saw (URLs, network, console)
2. Pick the *most likely* cause from the list above based on the evidence — not the first plausible one
3. Verify the hypothesis BEFORE touching code (e.g., check the dashboard config, inspect the localStorage blob, check the redirect chain)
4. THEN make the smallest change that fixes the verified cause
5. Browser-verify per Rule 19
6. LOG entry

If the cause turns out to be production Supabase dashboard config (very likely for Bug 1), the "fix" is *telling John what to change in the dashboard* — not a code change. Surface that clearly.

## Wrap-up protocol

When done:
1. LOG.md entry under `## Decisions & Gotchas` with structured `Browser-verified:` block per Rule 19
2. Cross-link to this handoff doc
3. Update wallofshame.md if you hit any non-obvious traps
4. Commit + push (auth code path — ask John first per his rules)

Good luck.
