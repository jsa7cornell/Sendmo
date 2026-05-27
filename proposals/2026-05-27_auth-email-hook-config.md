# Auth Email Hook — config steps for John

Pre-launch G2 from the 2026-05-27 email audit. Wires Supabase Auth's
signup / login / magiclink / recovery / email_change emails through our
custom `otpEmail` template (Resend, SendMo-branded). Without this, users
see Supabase-default emails with zero SendMo branding.

## Status

- ✅ Edge function written: `supabase/functions/auth-email-hook/index.ts`
- ✅ `config.toml` registered with `verify_jwt = false` (Auth Hook uses HMAC, not JWT)
- ✅ Auto-deploys via push-to-main
- ⏳ **Two manual steps below — you do these.**

## Step 1 — Generate the hook secret + store in 1Password

```bash
# Generate 32 random bytes, base64-encode, wrap in the Supabase format.
RAW_B64=$(openssl rand 32 | base64)
HOOK_SECRET="v1,whsec_${RAW_B64}"

# Store in 1Password — replace the field name with your convention.
op item create \
  --category='API Credential' \
  --vault=Secrets \
  --title='SEND_EMAIL_HOOK_SECRET' \
  credential="${HOOK_SECRET}"

# Print for the next two steps (do NOT paste into chat).
echo "$HOOK_SECRET"
```

Copy the printed value to your clipboard. Format is `v1,whsec_<base64>` — both
prefixes are required by the verification code.

## Step 2 — Set as Supabase function secret

Two ways, pick one:

**Option A — CLI:**
```bash
op run --env-file=.env.local -- supabase secrets set \
  SEND_EMAIL_HOOK_SECRET="$(op read 'op://Secrets/SEND_EMAIL_HOOK_SECRET/credential')" \
  --project-ref fkxykvzsqdjzhurntgah
```

**Option B — Dashboard:**
1. `dashboard.supabase.com/project/fkxykvzsqdjzhurntgah/settings/edge-functions`
2. Add secret: name = `SEND_EMAIL_HOOK_SECRET`, value = paste from clipboard
3. Save

## Step 3 — Register the hook in Supabase Auth

1. `dashboard.supabase.com/project/fkxykvzsqdjzhurntgah/auth/hooks`
2. Find **"Send Email Hook"**
3. Enable + configure:
   - Hook type: **HTTPS** (not "Postgres")
   - URI: `https://fkxykvzsqdjzhurntgah.supabase.co/functions/v1/auth-email-hook`
   - HTTP method: POST (default)
   - Secret: paste the SAME `v1,whsec_<base64>` value from clipboard
4. Click **Enable**

## Step 4 — Verify

Trigger a real OTP send. Easiest:

1. Sign out of `sendmo.co` (or use an incognito tab)
2. Go to sign-in / signup
3. Enter your email
4. Watch for the OTP email in your inbox

You should see:
- **From**: `SendMo <noreply@sendmo.co>` (not `noreply@supabase.co` or similar)
- **Subject**: "Your SendMo verification code"
- **Body**: branded with SendMo logo + the 6-digit code in a styled blue box

If you see Supabase-default copy instead → hook isn't firing. Check
`supabase functions logs auth-email-hook --project-ref fkxykvzsqdjzhurntgah`
for invocation errors or signature mismatches.

Common failure modes:
- Secret mismatch between Dashboard and function env → `Invalid signature` logged
- `SEND_EMAIL_HOOK_SECRET` not set → returns 500 + "Hook misconfigured"
- Hook URI typo in Dashboard → no invocation at all → falls back to default email
- Resend domain `sendmo.co` not verified → email send fails → 500 returned (Supabase Auth retries)

## What this fixes

Pre-G2:
- User enters email on signup → Supabase Auth sends a Supabase-branded
  email (subject "Confirm your signup" or similar, from `noreply@supabase.co`)
- User sees an email about "Supabase" — confusing for a SendMo signup

Post-G2:
- User enters email on signup → Supabase Auth invokes our hook → renders
  `otpEmail(token)` → sends via Resend from `noreply@sendmo.co`
- User sees a clean SendMo-branded email with their code

## What the hook handles

All Supabase Auth `email_action_type` values:
- `signup` — new user signup
- `login` — OTP login (passwordless)
- `magiclink` — magic-link login
- `recovery` — password reset (we don't use today but the hook supports it)
- `email_change_current` / `email_change_new` — email change confirmation
- `invite` — admin invite

All use the same `otpEmail(code)` template since each carries a 6-digit `token`.
Future: branch on action_type if we need different copy per flow.

## Rollback

If the hook misbehaves and we need to fall back to default Supabase emails:
- Supabase Dashboard → Authentication → Hooks → Send Email Hook → **Disable**
- Supabase Auth resumes sending its default emails immediately. No code change needed.

The hook is a soft layer — disabling it doesn't break auth; users just see the
default emails again.
