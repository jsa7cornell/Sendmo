---
title: Handoff — code review PR #68 (onboarding deferral + origin carrying)
slug: pr68-code-review-handoff
project: sendmo
status: draft
blocked_on: null
created: 2026-08-18
last_updated: 2026-08-18
author: Claude Fable 5 — the implementing session. Written for an independent reviewer at John's request. Everything below was verified against the code and a real browser, not inferred; where something is unproven it says so.
reviewer: null
outcome: null
---

> **You are code-reviewing [PR #68](https://github.com/jsa7cornell/Sendmo/pull/68) before merge. John will read your findings.**
>
> **Do not merge.** Do not deploy. Report findings.
>
> **One-line summary:** three commits that make every onboarding question independently skippable, make the flow survive a closed tab, and let a flexible link carry the ship-from address its creator already knew. **It cannot be merged without migration 041 being applied, and it contains one deliberate privacy extension that wants a second opinion.**

## What is in the PR

| Commit | What |
|---|---|
| `d4475b5` | Split step 10 into **10 = ship-from address** and **14 = shipment details + carrier**, each independently skippable |
| `62e2ac1` | Flow state moved sessionStorage → **localStorage** with a 7-day TTL and an explicit resume offer |
| `efa47c8` | A **flexible** link can carry the origin + parcel its creator knew; `SenderFlow` prefills from it |

22 files, +857/−43. No payment-path change. One migration.

## The two things to review hardest

### 1. Migration 041 is load-bearing — without it this 500s in production

Migration 040's per-type CHECK is:

```sql
ELSE recipient_address_id IS NOT NULL AND origin_address_id IS NULL
```

That **forbids an origin on a non-seller link**, which is exactly what `efa47c8` now writes. Setting one throws `sendmo_links_addr_by_type_check`. **Unit tests never touch the DB, so nothing local catches this** — it is the same class as the seller-link review's B1 (`status='used'`, a value the live schema had renamed).

[`041_flexible_link_may_carry_origin.sql`](../supabase/migrations/041_flexible_link_may_carry_origin.sql) drops **only** the `AND origin_address_id IS NULL` clause. Please check that it still guarantees:
- a seller link **must** have an origin and **must not** have a recipient
- every non-seller link **must** have a recipient

It is strictly relaxing, so no existing row can be invalidated — worth confirming that reasoning rather than taking my word.

**Merge order matters:** the migration must be applied before or with the merge, or the flex-create path breaks the moment someone defers a question.

### 2. A deliberate privacy extension

`links` GET now returns `origin_prefill` — the full ship-from street — **for `flexible` links only**. Seller links keep city/state, because there the origin is the seller's and the reader is a stranger buyer.

The consequence, stated plainly: **anyone holding a flexible link's URL can see the street the creator entered.**

My reasoning, which you should challenge rather than accept:
- The flex payload *already* exposes recipient name + city/state/zip to link-holders, so this extends an existing stance rather than inventing one.
- PLAYBOOK Rule 7 forbids showing the **recipient's** address in the sender UI. Here the sender is shown *their own* address — a different party — so I read Rule 7 as not engaged. **Check that reading.**
- The feature has no value without the exposure: storing the origin server-side only would save nobody any typing, because the sender enters their own address anyway.

If you think this is wrong, the fallback is to drop `origin_prefill` and accept that "address given, package deferred" discards the creator's typing.

## Everything else worth your attention

- **`deferToSender` assigns `next` inside a `setData` updater** (`RecipientFlowContext`). It works and is `flushSync`'d, but an impure reducer is a smell — React double-invokes updaters in StrictMode. Worth deciding if it should be restructured.
- **Step numbering is `[0, 1, 10, 14, 11, 12, 13]`** — order comes from the array, not the numbers. Deliberate, so `shipping` keeps step 10 and existing `/full-label/shipping` deep links resolve. Confirm nothing else assumes ascending order.
- **The parcel step is now unreachable without a valid origin phone**, because step-10 validation gates it. That made an existing phone-gate spec's scenario structurally impossible; it was restructured, not deleted. Check it still asserts something real.
- **localStorage vs sessionStorage** is a privacy change too — addresses now persist on a shared computer for up to 7 days. Guards: `startFlowAs` resets on every door pick, resume is offered never automatic, drafts expire. Judge whether the TTL is right.
- **`RecipientStepFullShipping` now renders two different steps via a `mode` prop** rather than being split into two components. Chosen because the rate fetch needs both halves' values. Reasonable or a fudge?

## Traps that have already bitten this work — check the tests aren't lying

Three separate times this week a test passed against broken code. Please spot-check that the new specs actually fail without their fix:

1. **URL-only transition assertions.** The URL flips *before* the outgoing step unmounts. A spec that asserts the URL and then reads a field belonging to the step being *left* passes against a UI that never moved. New specs wait for the new step to mount (`toHaveCount(0)` on the old field).
2. **Playwright matches routes most-recent-first.** In `sender-origin-prefill.spec.ts`, a `functions/v1/**` catch-all registered *after* the specific `links**` mock wins — `linkData` becomes `{}` and the prefill assertion passes **vacuously** against an empty form. The specific route is registered last on purpose.
3. **jsdom's `window.localStorage` here has no methods** (`setItem` undefined) and `persist()` swallows storage errors by design — so storage unit tests would assert against a silent no-op. `recipientFlowStorage.test.ts` installs an in-memory Storage.

Also: read Playwright results with `grep -E '[0-9]+ (failed|passed|skipped)'`. A short `tail` hides the failure count and reads exactly like a clean run — it has fooled two sessions.

## How to verify locally

```bash
# Confirm nothing else owns :5173 — a stale vite from another checkout
# silently tests a different app (infra-audit finding A4c)
for pid in $(lsof -ti:5173); do lsof -a -p $pid -d cwd -Fn | grep '^n'; done

npx tsc -b --noEmit
npx vitest run                                    # expect 688
npx playwright test --reporter=line 2>&1 | grep -E '[0-9]+ (failed|passed|skipped)'   # expect 80 passed / 5 skipped / 0 failed
npx eslint src/ 2>&1 | grep problems              # expect 27 — same as main
```

**The preview pane cannot verify step transitions.** `AnimatePresence mode="wait"` never completes its exit there, so the outgoing step stays mounted under the new URL and reads exactly like a routing bug. Use Playwright for anything that crosses a step; the pane is fine for single-step layout and copy.

## What is NOT in this PR, deliberately

- **Collapsing `full_label`/`flexible` into one flow** with `link_type` derived (John's idea). Real architecture change; wants its own proposal.
- **A skippable *recipient* address** (John's second idea). New product shape — note it is the seller link's *shape* with the **opposite payer** (the creator still pays), so it must never be described as the seller flow.
- **Proving the flex path end-to-end.** Still open from PR #67 and still unowned: 19 flexible links have produced **0 shipments, ever** in production. This PR routes more people onto that path. Someone must create a link, have **a different person** open it, ship, and confirm the creator's card is charged. A failure there is a launch blocker, not a bug.

## Context worth reading first

- [`2026-08-18_link-first-shipment-step.md`](2026-08-18_link-first-shipment-step.md) — the decided proposal this continues, including its self-review
- [`2026-08-18_link-first-onboarding-handoff.md`](2026-08-18_link-first-onboarding-handoff.md) — why the link needed to stop being an escape
- LOG entries for 2026-08-18 — every gotcha above, with the incident that produced it
- [`2026-07-17_seller-link-buyer-pays…`](2026-07-17_seller-link-buyer-pays_reviewed-2026-07-17_decided-2026-07-17.md) — the seller-link decisions this must not disturb
