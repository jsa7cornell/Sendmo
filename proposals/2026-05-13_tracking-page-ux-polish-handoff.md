# Handoff prompt — `/t/<public_code>` UX polish

> This is a handoff for the next agent. Paste the body below into a fresh
> Claude Code session in the SendMo project.

---

## You're polishing the most important user-facing page in SendMo

`/t/<public_code>` is the canonical shipment-management surface. Decided 2026-05-11 (sender-flow Round 2) and reinforced 2026-05-13 in dogfood: every shipment action — print, download, share, cancel, cancel-and-start-over, track — happens here. The Dashboard's "SendMo Label ID" column links here. Email templates ("Your label is ready", "In transit", "Delivered") link here. The page renders for four distinct viewer types AND seven shipment states, and as of today's dogfood the page is functional but visually rough. Tighten it.

Read these **in order** before touching code. Skipping the proposals = re-deciding decided questions:

1. `~/AI Brain/CLAUDE.md` — global agent rules. **Rule 0** (don't echo secrets) and **Rule 0.5** (agents don't write to prod DB — migrations through John).
2. `~/AI Brain/sendmo/PLAYBOOK.md` — project rules. Pay attention to **Rule 7** (never expose recipient address in sender UI), **Rule 14** (server-side state for critical decisions), and the white-label policy in §"Label Cancellation / Void" (never surface carrier branding when SendMo has its own identifier).
3. `~/AI Brain/sendmo/SPEC.md` §13.1 (Label Void & Refund Policy), §16 (Email Notifications), §18 (Mobile & Accessibility).
4. `~/AI Brain/sendmo/proposals/2026-05-11_sender-flow-wizard_reviewed-2026-05-11_decided-2026-05-11.md` — Round 2 established `/t/<public_code>` as *the* shipment page. Read the "privacy" decision (anyone-with-URL can see Print/Download — Option (a)).
5. `~/AI Brain/sendmo/proposals/2026-05-11_label-cancel-and-change_reviewed-2026-05-12_decided-2026-05-12.md` — full architecture of cancel: three-path auth, async refund state machine, link lifecycle, audit-log shape. **This is your contract — don't break it.**
6. The last ~6 entries of `~/AI Brain/sendmo/LOG.md` — especially "2026-05-13 Test-mode visibility," "2026-05-13 Cancel-flow Phase B slice 1," and "2026-05-13 Orphan-shipment recovery." They tell you what just shipped and the shape of the state machine.

## The deliverable (three asks, prioritized)

### Ask 1 — UI cleanup with state-awareness

The page renders **seven distinct shipment states** crossed with **four viewer types** = effectively 28 combinations. Audit the current rendering and tighten it. The state matrix you must support:

| Shipment state | What the page should emphasize | Cancel / Change visible? |
|---|---|---|
| `label_created` (live) | Print, Download, Share, drop-off instructions; Cancel/Change for authorized viewers | yes (admin, link_owner, sender with cancel_token) |
| `label_created` (test, `is_test=true`) | Big amber TEST banner; Print/Download still useful (synthetic but real-looking); NO Cancel (server-rejects) | **no** — already gated, don't regress |
| `in_transit` | Live tracking events, ETA, carrier badge; no label preview | no — past void window |
| `out_for_delivery` | Same as in_transit but more urgent visual | no |
| `delivered` | Delivery-performance badge (`✨ N days early` / `🎯 Right on time` / `🐢 N days late`); no label section | no |
| `return_to_sender` | Red banner "package being returned"; explain what happens next | no |
| `cancelled` | Red terminal banner with **timestamp + who cancelled** (Ask 2 below); refund_status sub-state |  no |

Plus the four **viewer types** the server already distinguishes (see `tracking/index.ts` response + `TrackingPage.tsx` derivation):

- **Admin** — JWT + `profiles.role='admin'`. Should see everything.
- **Recipient / link owner** — JWT + `viewer_is_recipient=true` (server-derived from JWT vs `sendmo_links.user_id`). Owns the link, can manage shipments end-to-end.
- **Sender (anonymous)** — has a `cancel_token` in `sessionStorage[\`sendmo:cancel_token:${publicCode}\`]` OR arrives via `?cancel=<hex>` URL from the email transport. Can cancel.
- **Anonymous third-party** — URL-holder without token (e.g. forwarded link). Can view label + Print + Share but **not Cancel**. Per the Round-2 privacy decision this is intentional.

**Plus** the refund_status sub-states for `cancelled` shipments. From the proposal §2.3:

- `none` — pre-cancel (n/a on a cancelled shipment, but defensive code should handle it)
- `submitted` — Stripe refund initiated, waiting for `charge.refunded` webhook. Yellow/blue "Cancellation in progress — refund pending"
- `refunded` — webhook landed, money is back on the card. Green "Refund of $X.XX issued"
- `rejected` — carrier rejected void (label was scanned before cancel went through), or Stripe refund failed. Red "Cancellation rejected — contact support"
- `not_applicable` — comp shipment, no money to refund. Neutral "No charge was made"

**Don't repaint the wheel.** The existing components have a lot right:
- Celebration banner on `?fresh=1`
- Terminal banner for `cancelled` / `return_to_sender`
- TEST banner for `is_test`
- Status card with carrier link (hidden for test)
- Progress card (hidden in terminal states)
- Tracking History card
- Ship-Again CTA
- Label section with Print/Download/Share + Cancel/Change row

Audit these and tighten visual hierarchy, spacing, and copy. **Look especially at:** the cancelled state (screenshot example: `/t/NEC7J3E`) — the red banner is fine but feels sparse; the page jumps from banner to a near-empty Status card without showing who/when/why. Same shipment as a delivered example: `/t/Z7BCPTY` (test, auto-advances) and the live delivered one: `/t/71NF1E8`.

### Ask 2 — Cancellation timestamp + actor on the cancelled-state page

When `status='cancelled'`, surface:

- **When it was cancelled**: `shipments.cancelled_at` (already in the schema, already populated by `cancel-label`). Show as relative time + absolute on hover, e.g. *"Cancelled 8 minutes ago · May 13, 2026 at 3:07 PM"*.
- **Who cancelled it**: this needs server work.
  - The `event_logs` row for `event_type='shipment.cancelled'` already carries `properties.actor` ∈ `{'admin', 'link_owner', 'session_token', 'email_token'}`. Translate for the UI:
    - `admin` → "Cancelled by SendMo admin"
    - `link_owner` → "Cancelled by you" if `viewer_is_recipient`, else "Cancelled by the recipient"
    - `session_token` → "Cancelled by the sender"
    - `email_token` → "Cancelled by the sender" (same UX)
  - **You'll need to extend the server** because today the `actor` lives in `event_logs.properties` (not on `shipments`). Two options:
    - (a) Add `shipments.cancelled_by_actor TEXT` column. Migration 021. Have `cancel-label` write it alongside `cancelled_at`. Tracking response surfaces it.
    - (b) Have the `tracking` function look up the latest `shipment.cancelled` event_logs row when status='cancelled' and surface `actor` in the response. No migration.
  - **Author lean: (b).** No migration; the data is already there. Trade-off: an extra query per cancelled-shipment tracking fetch. Acceptable — cancelled shipments are a small minority.
  - **Bonus** if you also surface a friendly user identifier when actor is `admin` or `link_owner` (we have `auth.users.id` via `event_logs`-via-session-id correlation, but we don't currently capture `user_id` in the cancel audit row). **Add `user_id` to the audit properties** in `cancel-label/index.ts` so future agents can resolve a display name. Don't display the user_id in the UI today — just capture it.

### Ask 3 — AppHeader user/login must always render on `/t/<public_code>`

Currently `TrackingPage.tsx` passes `actions={<span className="text-sm text-muted-foreground">Track Package</span>}` to `AppHeader`. Reading `AppHeader.tsx:17-54`: the `actions` prop **overrides** the default `<UserMenu>` slot. Result: viewers don't see the sign-in button (anonymous) or user menu (logged-in) on this page.

Fix options:
- Drop the `actions` prop entirely. AppHeader's default behavior renders the user menu (signed in) or sign-in button (anonymous). "Track Package" was decorative; not needed.
- Render `actions={<>{userMenu}{trackPackageLabel}</>}` — keep both. More cluttered but preserves the label.
- Move "Track Package" into the page body as a subtitle, e.g. under the SendMo logo or above the status card.

**Author lean: drop the actions prop entirely.** The page already says everything it needs to in the body (status banner, status card title, etc.). The "Track Package" header label was duplicative.

Verify the user-menu shows for: (a) signed-in admin viewing `/t/<own_label>`, (b) signed-in recipient viewing `/t/<own_label>`, (c) anonymous viewer of a forwarded `/t/<code>` URL (should show "Sign in" affordance). Don't break the privacy decision — anonymous viewers still see Print/Download per Round-2 Option (a).

## Files you'll touch

- `src/pages/TrackingPage.tsx` — main surface; state-conditional rendering, AppHeader fix
- `src/components/tracking/ShipmentLabelSection.tsx` — already supports `labelUrl: string | null` and the cancel row; don't regress
- `src/components/AppHeader.tsx` — read; probably no changes, just verify the default surface
- `supabase/functions/tracking/index.ts` — extend response to include `cancelled_by_actor` (Ask 2 option b), and optionally `cancelled_by_label` (pre-translated copy)
- `supabase/functions/cancel-label/index.ts` — add `user_id` to the event_logs audit properties for future-proofing
- `src/components/tracking/*.tsx` — new sub-components if you split things out (resist over-splitting; the existing structure is fine)

## Files you will NOT touch

- `supabase/migrations/020_*.sql` — cancel_token / link enum migration already shipped. Don't add a new migration unless you're certain Ask 2 needs it (the author leaned no).
- `proposals/2026-05-11_label-cancel-and-change_*_decided-*.md` — load-bearing contract. Don't edit.
- `supabase/functions/labels/index.ts` — out of scope. The mint of cancel_token / link `in_use` flip is correct as-is.
- `supabase/functions/stripe-webhook/index.ts` — refund-status state-machine close already lands here; don't touch.

## Recently decided things you should not re-decide

- **Email-token auth, not cookie.** Cookies don't survive cross-origin from `*.supabase.co` to `sendmo.co`. The cancel-flow uses `X-Cancel-Token` header sourced from sessionStorage. See proposal §2.2.
- **`refund_status='submitted'` is reachable**, not an error state. It's the legitimate "cancellation in progress" state during the async Stripe refund window. UI must render a pending state for it, not skip from `none` to `refunded`.
- **Link revival is optimistic.** `in_use → active` flips when carrier void succeeds, even before Stripe refund clears. Worst case is two simultaneous labels on one link if the void later rejects. John accepted this.
- **No test-cancel stub.** Test shipments cannot be cancelled (server returns 422). Don't add a bypass. Live Comp is the test path.
- **No carrier branding in user-facing copy.** SPEC §13.1 + PLAYBOOK §"Label Cancellation / Void." Always SendMo language ("voided" not "USPS void"; "refunded" not "Stripe refund").

## Testing

- Run `npx tsc -b --noEmit` and `npx vitest run --root . --dir tests/unit` before every commit. The current baseline is 245 passing.
- Add unit tests for new state-conditional rendering. The pattern is in `tests/unit/cancelLabelDialog.test.tsx` and `tests/unit/ShipmentLabelSection.test.tsx`.
- **Manual dogfood live URLs** (already in the DB, no setup needed):
  - `/t/NEC7J3E` — cancelled (test the cancelled state with `not_applicable` refund)
  - `/t/RA2W2NG`, `/t/RPSAZXG`, `/t/ECWHJES` — live `label_created`, you have 3 more to play with
  - `/t/Z7BCPTY` — test-mode `delivered` (test the TEST banner + delivered combo)
  - `/t/71NF1E8` — live `delivered` (the only real live-delivered shipment in the DB)
  - `/t/K6SX3ES`, `/t/C9HYVQY`, `/t/G4J26F0`, `/t/NNDX92J` — older test-mode shipments in various states
- For viewer-type testing: sign in to admin via `/login` (the only admin is jsa7cornell@gmail.com). For "anonymous third-party" use an incognito window. For "sender with cancel_token" the only way to seed sessionStorage right now is to walk through the sender wizard at `/s/<short_code>` — pick a `link_type='flexible'` link with `status='active'`. There's only one flex link in the DB right now (`short_code=mUgagu3HrS` per `My Label Link` widget on John's Dashboard).

## Push policy

Per `~/.claude/CLAUDE.md`: routine pushes to `main` are OK without asking. **Ask before pushing if** your work touches migrations (probably no for this scope), Stripe code paths (no for this scope), or anything destructive. Edge Function deploys still need `--no-verify-jwt` per the long-standing gotcha.

## Wrap

End your session by writing to `LOG.md` cross-linking this handoff doc and the decided cancel-flow proposal. Title: `[2026-05-13] Tracking page UX polish — Ask 1 / 2 / 3 from John dogfood`. Keep the format consistent with the recent entries.

If you find a real bug along the way (not just polish), flag it in a follow-up entry — don't bundle. Examples of things to flag separately if you stumble on them:
- The `Dashboard.tsx` "Created on" copy reading "Created on May 13, 2026" for shipments that were *actually* created on May 12 — recovered rows show their *recovery* created_at, not their EasyPost-buy timestamp. Cosmetic, but the orphan recovery LOG entry should mention this if it's true.
- Any duplicate render of the AppHeader or its slots.
- Any unhandled state in the 28-combo matrix (e.g. `label_created + viewer_is_recipient=false + no cancel_token + admin` — should land as "view-only" not "broken").

Good luck. The page matters.
