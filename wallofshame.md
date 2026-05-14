# Wall of Shame — Agent-induced mistakes worth remembering

> This file collects mistakes Claude/AI agents have made while working on SendMo, with enough context that future agents can avoid the same trap. Each entry follows the same shape:
>
> - **What I did wrong**
> - **What I should have done**
> - **How to recognize this trap in the future**
>
> When you (future agent) screw up in a non-obvious way, add to this file. Brevity wins; future-you needs to skim it fast.

---

## 2026-05-14 — Stripe `allow_redisplay` parameter-path guessing

### What I did wrong

Tried to set `allow_redisplay='always'` on Stripe SetupIntents by guessing the parameter path twice without confirming via docs:

1. First attempt: `payment_method_options.card.allow_redisplay` → Stripe rejected with `"Received unknown parameter: payment_method_options[card][allow_redisplay]"`. Add Card succeeded but I claimed it would work.
2. Second attempt: top-level `allow_redisplay` on the SetupIntent → Stripe rejected with `"Received unknown parameter: allow_redisplay"`. **Add Card itself broke in live production.** Modal showed the error inline; users couldn't save cards.
3. Third action: full revert to remove the field — Add Card works again, but saved-card display still incomplete.

Total damage: ~30 min of John's time, two failed Vercel + Supabase deploys, real test cards entered into a broken flow, eroded trust on the saved-card-display feature.

### What I should have done

**Read Stripe's API reference for `allow_redisplay` before touching anything.** Three minutes of doc reading would have shown the field doesn't belong on SetupIntent at all — it belongs on PaymentMethod (settable via `POST /v1/payment_methods/{pm}` after attach), OR via `payment_method_data` when confirming the SetupIntent client-side, OR via the Customer Session's `allow_redisplay_filters` to opt-in `'unspecified'` PMs.

When the first attempt failed: STOP and read docs. Don't guess a sibling field name and re-deploy. Live production payment paths aren't a place to iterate by trial-and-error.

### How to recognize this trap

- You're about to push a Stripe parameter change and you can't cite the exact docs page that confirms the parameter exists on that resource at that API version
- Stripe just returned `"Received unknown parameter"` — your next move is to **read docs**, not guess a sibling path
- The code path is in production and changes can break a live flow within ~60 seconds of deploy

**Rule:** any new Stripe API parameter goes through `WebSearch "stripe API <field>"` or `mcp__stripe__search_stripe_documentation` *before* the first deploy.

---

## 2026-05-14 — Old-format publishable key misdiagnosed as malformed

### What I did wrong

When I first saw the publishable key `pk_ubEH3eeJrviRXBR9HA9ukifeBcCZB` (31 chars, no `_test_`/`_live_` infix), I diagnosed it as truncated or corrupted and told John "Vercel env var is broken, set the real value." It was actually a legitimate **older-format** Stripe publishable key — Stripe has been issuing 30-31 char keys since 2012 and they still authenticate. The SendMo account is from Oct 10, 2012, so all its keys were the legacy short format.

This sent John on a 10-minute detour chasing a non-existent Vercel env var bug while the real issue (an unrelated Vite minifier collapse from a duplicated env var value) was the actual problem.

### What I should have done

**Test the key against Stripe's API before declaring it malformed.** A single `curl -u "pk_ubEH3…:" https://api.stripe.com/v1/payment_methods` returns either `401 secret_key_required` (key is valid and recognized) or `401 invalid_api_key` (key is genuinely garbage). I eventually ran exactly that test and got the "recognized as valid" response — but only *after* John had spent time trying to fix Vercel.

### How to recognize this trap

- You're looking at a string and your gut says "that's the wrong format" — based on what you've seen in newer accounts/docs
- Before declaring a credential malformed, **probe it against the real API**. Stripe's error messages are precise: `secret_key_required` ≠ `invalid_api_key`.
- Stripe accounts created before ~2019 use the legacy short-format keys (`pk_<random30>` / `sk_<random30>`). These are not malformed; they just predate the modern format and trigger some Stripe.js Payment Element feature degradation (which is its own real problem — see LOG 2026-05-14 for that recovery).

---

## 2026-05-14 — Trusted the Stripe Dashboard wizard's "saved" event list

### What I did wrong

After rebuilding the live webhook endpoint `Sendmo-live-2026` via the Stripe Dashboard "Add destination" wizard, I asked John "did you select the right events?" He said yes. I trusted his confirmation and moved on. Several attempts later it became clear that `payment_method.attached` — explicitly intended to be subscribed — wasn't actually in the saved subscription list. The wizard had silently dropped it (or John had clicked through too fast for it to register).

This led to multiple failed live Add Card attempts, ~20 min of debugging, and an unnecessary endpoint rebuild attempt before we caught it by going to the endpoint's Overview → "Show events" panel and reading the literal list.

### What I should have done

**Always verify a webhook endpoint's enabled_events list by reading the saved subscription list directly**, not by trusting the wizard's confirmation step. Either via:
- Dashboard: endpoint detail → Overview → "Show events" → eyeball + Ctrl-F for each handler-required event
- API: `stripe v2 core event_destinations retrieve we_…` and check `enabled_events`

This is the same trap as "trust but verify" in any UI-driven workflow: a click doesn't mean the side effect happened.

### How to recognize this trap

- You just used a wizard or multi-step form that ends with a confirmation/save step
- The next thing you do depends on a specific item from the form being persisted exactly as ticked
- If yes → **verify by reading the saved state**, not by trusting the form. The Stripe MCP doesn't expose webhook endpoints, but the Dashboard's Overview tab and the Workbench shell's `stripe v2 core event_destinations retrieve` both work for verification.

---

## 2026-05-14 — Dashboard typography hiding `l` vs `I` in IDs

### What I did wrong

Copied the webhook endpoint ID `we_0TVIzcxS6gsndgF3RS0sJg9j` from the Stripe Dashboard's destination details panel. Used it in both `stripe webhook_endpoints retrieve` (v1) and `stripe v2 core event_destinations retrieve` (v2) calls. Both returned `not_found`. Spent 5 minutes assuming the endpoint was somehow misconfigured, hypothesizing that v2 had a different ID format, etc.

The real bug: the dashboard renders `l` (lowercase L) and `I` (capital i) **identically** in its monospace-ish font. The actual endpoint ID had a lowercase `l`: `we_0TV**l**zcxS6gsndgF3RS0sJg9j`. Only when I asked John to run the `list` command and got the JSON response did the correct ID surface.

### What I should have done

**Never retype an ID from a dashboard.** Always copy it from the API response (JSON output, curl response, etc.) where the font is unambiguous.

### How to recognize this trap

- You're typing or copying any opaque ID (starts with `we_`, `cus_`, `pi_`, `sub_`, etc.) from a UI
- Dashboard fonts vary; some collapse `l`/`I` and `0`/`O`. Especially the Stripe Dashboard, GitHub PR pages, some Supabase admin views.
- **Fix:** when you need the ID, get it from an API call (`stripe v2 core <resource> list`, `mcp__supabase__execute_sql` against a table, etc.) and paste from JSON output.

---

## How to use this file

When you (future agent) hit a non-obvious bug or make a mistake, ask yourself:
1. Would a future agent making the same call save time by reading my mistake?
2. Is the trap structural (something about Stripe/Supabase/Vercel/the SendMo codebase) or one-off?

If both yes → add an entry. Keep entries terse. The signal is in the "How to recognize this trap" section; everything else is supporting context.
