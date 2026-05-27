# Business Identifier Sweep — Handoff for John
**Date:** 2026-05-27
**Trigger:** First live charge (YPPY9AK, $9.18) appeared as "stripe" on Amex statement instead of "SendMo". Launch-blocking.

---

## What was fixed in code (already in working tree — review before committing)

### 1. `statement_descriptor_suffix` on every customer-facing PI

| File | Change | Result on bank statement |
|------|--------|--------------------------|
| `supabase/functions/_shared/stripe.ts` | Added optional `statement_descriptor_suffix` param to `createPaymentIntent`, `createOffSessionShipmentPI` | — |
| `supabase/functions/payments/index.ts` | Passes `statement_descriptor_suffix: "LABEL"` on every full-label PI | "SENDMO* LABEL" |
| `supabase/functions/labels/index.ts` | Passes `statement_descriptor_suffix: resolvedLink.short_code` on every flex off-session PI | "SENDMO* YPPY9AK" |
| `supabase/functions/_shared/stripe.ts` (`createAdjustmentRecharge`) | Passes `statement_descriptor_suffix: params.publicCode` on every carrier-adjustment recharge PI | "SENDMO* YPPY9AK" |

**Requirement:** the account-level statement descriptor in Stripe Dashboard **must be set to "SENDMO"** for any suffix to render. If it isn't set, the suffix alone will not appear. See Step 1 below.

### 2. Customer `name` on Stripe Customer objects

| File | Change |
|------|--------|
| `supabase/functions/_shared/stripe.ts` (`createCustomer`) | Added optional `name` param, wired into the API request |
| `supabase/functions/payments/index.ts` (`getOrCreateCustomerForUser`) | Reads `profiles.full_name`, passes to `createCustomer` |
| `supabase/functions/payment-methods/index.ts` (`ensureCustomer`) | Same — reads `full_name` from profile select, passes to `createCustomer` |

**Effect:** new Stripe Customer objects will have the recipient's name. Existing customers (created before this change) won't be updated retroactively — that's a manual Stripe Dashboard operation if needed, low priority.

### What code does NOT fix (requires Stripe Dashboard)

- Account-level statement descriptor ("SENDMO")
- Receipt email branding (logo, business name, support email)
- Customer Portal branding
- Stripe's own dashboard appearance (business name, logo, support info)

---

## Manual Stripe Dashboard Steps for John

**Do these in order — Step 1 is the most urgent (it activates all the suffix code above).**

---

### Step 1 — Set the account-level statement descriptor (CRITICAL)

This is the base that appears on every bank statement. Without it, bank statements show "STRIPE" or the default fallback. With it + the suffix code, customers will see "SENDMO* LABEL" or "SENDMO* YPPY9AK".

**Statement descriptor rules:** 5–22 chars, ASCII only, no `< > \ ' " *`, must contain at least one letter.

**Do this in BOTH test mode AND live mode** (Stripe settings are mode-isolated for some fields):

1. Go to **https://dashboard.stripe.com/settings/account**
2. Find **"Public business information"** → **"Statement descriptor"**
3. Set value: `SENDMO`
4. Find **"Shortened descriptor"** (used when the combined descriptor + suffix > 22 chars): set to `SENDMO`
5. Click **Save**
6. Switch to **Test mode** (toggle in top-left) and repeat steps 1–5 at the same URL

**Verification:** after saving in live mode, run the following to confirm the setting has taken effect on the existing charge:
```bash
EP_LIVE=$(op read 'op://Secrets/STRIPE_SECRET_KEY_LIVE/credential')
curl -s -u "${EP_LIVE}:" "https://api.stripe.com/v1/payment_intents/pi_2TagbWxS6gsndgF32zGP8SHp" | jq '.charges.data[0].statement_descriptor'
unset EP_LIVE
```
(The existing charge won't change — this only proves the key is set. New charges will use the new descriptor.)

---

### Step 2 — Receipt email branding

Stripe sends automatic receipt emails when a PI succeeds (if `receipt_email` is set — confirmed wired in SendMo). By default these receipts show Stripe's branding. Add SendMo branding:

1. Go to **https://dashboard.stripe.com/settings/branding**
2. **Business name:** `SendMo`
3. **Logo:** upload `sendmo.co/icon-192.png` (192×192 PNG, the production icon). Download it first, then upload.
4. **Brand color:** `#2563EB` (SendMo blue)
5. **Icon:** same as logo
6. Click **Save**
7. Switch to **Test mode** and repeat steps 1–6 at the same URL

---

### Step 3 — Support email and phone on receipts

Stripe receipt emails show a "Questions? Contact us" section using the support info below. Without it, recipients see no way to reach SendMo.

1. Go to **https://dashboard.stripe.com/settings/public**
   (or via Account → Settings → "Public business information")
2. **Support email:** `support@sendmo.co`
3. **Support phone:** (add your business phone, or leave blank if you prefer email-only — leaving it blank is fine)
4. **Support website:** `https://sendmo.co`
5. Click **Save**
6. Repeat in **Test mode**

---

### Step 4 — Business name and address

Stripe uses the business name in multiple customer-facing places (receipts, Customer Portal, bank dispute records).

1. Go to **https://dashboard.stripe.com/settings/account**
2. **Business name:** `SendMo`
3. **Business website:** `https://sendmo.co`
4. Confirm the business address is correct (used in bank dispute records — needs to match your legal entity)
5. Click **Save**
6. **Note:** account-level settings like legal business name are typically shared between test/live mode — you may only need to do this once. Confirm after saving by toggling modes.

---

### Step 5 — Stripe Customer Portal branding (if you enable it later)

If you ever enable the Stripe Customer Portal (https://dashboard.stripe.com/settings/billing/portal), set:
- **Business name:** `SendMo`
- **Privacy policy URL:** `https://sendmo.co/privacy` (or omit if not yet published)
- **Terms of service URL:** `https://sendmo.co/terms` (or omit)
- **Logo:** upload the SendMo icon (same as Step 2)

SendMo does not currently use the Customer Portal, so this is low priority.

---

## Other surfaces audited (no action needed)

### Email From: address (Resend)
`_shared/resend.ts` defaults to `"SendMo <noreply@sendmo.co>"` — already correctly branded. The `sendmo.co` domain is verified in Resend (confirmed in LOG.md 2026-05-12 "Auth UI" entry: "Custom SMTP via Resend (sendmo.co domain verified 2026-05-12)"). No change needed.

### Email subject lines
All six lifecycle email templates in `_shared/email-templates.ts` already include "SendMo" in subject lines:
- OTP: "Your SendMo verification code"
- Label confirmation: "A label was printed using your prepaid link — SendMo"
- Tracking updates: "📦 Your package is In Transit — SendMo"
- Refund submitted: "Your $X.XX refund is on its way — SendMo"
- Refund completed: "Your $X.XX refund has been issued — SendMo"
- Refund unsuccessful: "Refund unsuccessful — $X.XX — SendMo"
- Carrier adjustment: "A small carrier adjustment of $X.XX — SendMo"
- Budget reached: "Your SendMo account reached its daily/weekly spending limit"
- Payment declined: "Action needed — your SendMo link needs payment update"
- Radar blocked: "A charge on your SendMo link was blocked as suspicious"

All clearly identify SendMo. No changes needed.

### Email HTML content
`email-templates.ts` `layout()` function has SendMo logo + name in the header and "SendMo — Prepaid shipping made easy" in the footer. Correctly branded.

### `receipt_email` on PaymentIntents
Confirmed wired — `payments/index.ts` passes `receipt_email: body.receipt_email` to `createPaymentIntent`. Stripe will send its native receipt email to that address.

### Label PDF
EasyPost-generated PDF — carrier/EasyPost branding, not a SendMo surface. Standard for all shipping label providers.

---

## Why the first live charge showed "stripe"

The Stripe account's statement descriptor was never set (or was set to the default). Stripe's fallback for an unset descriptor is to use the connected/platform account name or "STRIPE". The code-side fix (suffix = "LABEL" / short_code) only takes effect once the account-level descriptor is set in Dashboard (Step 1 above). The two work together: `SENDMO` (account) + `* LABEL` (per-PI suffix) = `SENDMO* LABEL`.

---

## Priority order for John

1. **Step 1** (statement descriptor) — activates all the code changes, fixes the root problem
2. **Step 2** (receipt branding) — SendMo logo on Stripe receipt emails  
3. **Step 3** (support contact) — recipients can reach you from the receipt
4. **Step 4** (business name) — legal / dispute records cleanliness
5. **Step 5** (Customer Portal) — deferred, not in use yet

Steps 1–4 take ~10 minutes total in the Stripe Dashboard.
