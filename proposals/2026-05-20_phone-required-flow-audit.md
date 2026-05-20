# Phone-Required Flow Audit — independent review

**Date:** 2026-05-20
**Scope:** the "phone is a hard requirement" work (commits `9d9b55b`, `ef48637`, `9635058`, `d2dde62`, `b1e6715`, plus adjacent `1990473`, `9037018`, `059a31f`).
**Type:** read-only review. No code changed.
**Reviewer hypothesis (from the two already-found bugs):** incomplete coverage — a server requirement added without auditing every client path, and divergence between flows hitting the same endpoint.

---

## Resolution (2026-05-20, commit `b15245c`)

Findings **1, 2, 3, 4, 6 fixed** in one batch:
- **1 + 6** — `rates` Edge Function now validates phone on both addresses; the duplicated server validator was lifted into `supabase/functions/_shared/phone.ts` (shared by `links` + `rates`).
- **3** — `LabelTest` threads phone into `getRates`/`purchaseLabel` + gates it in `verifyAddresses`.
- **2** — `canFetchRates` now checks phone on both addresses.
- **4** — `senderState` `STORAGE_VERSION` bumped 1→2.

Tests added: `canFetchRates` phone gate + `SenderStepPackage` phone gate (the latter was the untested gap flagged below). **Finding 5** is a subset of 1 — closed by it. **Finding 7** (`recipient_address_complete` checks street only) left as-is — a documented deliberate tradeoff, not a regression. Remaining test-coverage items (flex-onboarding e2e, `links` PATCH branches) are not yet done. Browser verification of the deployed `rates` 400 path + the `/label-test` end-to-end run is still owed.

---

## Summary verdict

The phone work is **mostly healthy but has one real coverage gap and several latent risks** consistent with the known failure pattern.

The core client-entry path is solid: `SmartAddressInput` is genuinely the single shared address form, `AddressInput.phone` / `CreateLinkParams.phone` / `UpdateLinkParams.phone` are now non-optional (so `tsc` enforces caller coverage — exactly the structural guard that was missing for `d2dde62`), and `addressToApi` fails loud. The three onboarding/dashboard link-creation flows are all gated and all carry phone through. Client and server `isUsablePhone` are the same library, same version (`1.13.2`), same logic.

**The one place the pattern repeated and is NOT yet fixed: the `rates` Edge Function has no server-side phone validation.** `rates` is the function that actually bakes the phone into the EasyPost shipment — and the EasyPost shipment is what FedEx/UPS validate at `/buy`. `links` POST/PATCH got server-side validation; `rates` did not. This is the same "server requirement added to one endpoint, not the sibling endpoint that needs it" divergence as `b1e6715`, one layer down.

Everything else is RISK-tier (latent, currently masked by a client-side guard) or NIT.

No confirmed *ships-broken-today* user-facing BUG in the committed code — `d2dde62` and `b1e6715` already closed those. The findings below are one structural BUG (defense-in-depth gap, not user-visible yet) and a set of RISKs.

---

## Per-flow table

| Flow | Collects phone? | Validates before server call? | Passes phone through? | Regression test? | Verdict |
|---|---|---|---|---|---|
| Onboarding flex link (step 1 → 22 → `createFlexLink`) | Yes (`SmartAddressInput` @ step 1) | Yes — `getValidationErrors` step 1 (`useRecipientFlow.ts:140`) | Yes — `RecipientStepFlexPayment.tsx:33` → `CreateLinkParams.phone` | Yes — `validation.test.ts:69-89` | **OK** |
| Onboarding full-label (step 1 dest + step 10 origin → `fetchRates` → `labels`) | Yes (both addresses) | Step transition: yes (`getValidationErrors` step 1 + 10). **Rate fetch: NO** — `canFetchRates` omits phone | Yes — `addressToApi` includes + guards phone | Partial — `validation.test.ts:152` covers step-10 origin gate; nothing covers `canFetchRates` / rate-fetch | **RISK** (finding 2) |
| Dashboard `/links/new` create (`LinksEditor` create mode) | Yes (`AddressForm`) | Yes — `phoneOk` gate, `LinksEditor.tsx:67,84` (fixed in `b1e6715`) | Yes — `LinksEditor.tsx:159` | Yes — `LinksEditor.test.tsx` (create: 3 tests) | **OK** |
| Dashboard link EDIT (`LinksEditor` edit mode → `updateFlexLink`) | Yes (`AddressForm`) | Yes — `phoneOk` gate, `LinksEditor.tsx:94` | Yes — `LinksEditor.tsx:112` | Yes — `LinksEditor.test.tsx` (edit: 2 tests) | **OK** |
| Sender flow (`/s/<code>` → `SenderStepPackage` → `fetchSenderRates` → `labels`) | Yes — sender origin in `SenderStepPackage` | Client: yes — `isUsablePhone`, `SenderStepPackage.tsx:59`. Server (`rates`): **NO** | `from`: yes (`addressToApi`); `to`: server-resolved | **No** — `SenderStepPackage` has no unit test; `sender-flow.spec.ts` doesn't assert the phone gate | **RISK** (findings 1, 5) |
| Admin manual shipment (`admin_insert_shipment` RPC, migration 025) | n/a — RPC params | n/a | `p_from_phone` / `p_to_phone` plumbed; `labels` passes `from_address.phone ?? null` | n/a | **OK** (migration is correct; see finding 7 caveat) |
| `LabelTest` (`/label-test` — public route, internal tool) | Form collects phone (`SmartAddressInput`) | **No phone gate anywhere** | **Phone DROPPED** — verify body, `verifiedAddresses`, and `labels` body all omit phone | `LabelTest.test.tsx` exists; no phone assertion | **BUG** (finding 3) |
| `SenderPreview` / `LinkSharePreview` (demo/preview routes) | Mock data | n/a | Mock addresses seed `phone` (`9635058`) | n/a | **OK** |
| Profile / account address editing | No standalone address editor exists — addresses are only created via the flows above | n/a | n/a | n/a | **OK** (no such flow) |
| Saved-address / "use my saved address" prefill (`RecipientStepAddress`, `RecipientFlowContext`, `LinksNew`, `LinksEdit`, `loadSavedSender`) | Rehydrates phone | Re-gated by the flow's normal phone gate after prefill | `phone` selected in every query | `RecipientStepAddress.test.tsx` covers the OAuth auto-advance gate | **OK / RISK** (finding 4 — legacy phone-less rows) |

---

## Findings

### 1. BUG (defense-in-depth) — `rates` Edge Function has no server-side phone validation

**File:** `supabase/functions/rates/index.ts` (whole request handler; address build at lines 99-114).

`rates` is the function that POSTs the EasyPost `/v2/shipments` call (lines 121-142). **The phone baked into that shipment is the phone FedEx/UPS validate** — the `labels` `/buy` call (`labels/index.ts:710`) only sends `{rate, end_shipper_id}` and buys the *already-created* shipment by ID. `from_address`/`to_address` in the `labels` request body are used **only** for DB persistence via `admin_insert_shipment` (`labels/index.ts:847-874`), never for the carrier call.

So the carrier-facing phone is set exactly once, in `rates`, and `rates` validates it **zero times**:
- `links` POST got `isUsablePhone()` server-side validation (`links/index.ts:543`).
- `links` PATCH got it (`links/index.ts:770`).
- `rates` got **only** `phone: addr.phone ?? undefined` (line 82, flex resolve) and `phone: addr.phone || undefined` (line 104, `buildAddress`) — pulls it through, never checks it.

This is the *exact* `b1e6715` pattern one layer down: a server requirement enforced on one endpoint but not the sibling endpoint that structurally needs it. The links function comment even says "Server enforces independently of the client form (Rule 5 — client-side validation is UX only)" — `rates` violates that rule.

**Why it doesn't ship broken *today*:** every current client caller of `rates` routes the address through `addressToApi()` first (`fetchRates` and `fetchSenderRates` in `api.ts:91-92` and `:519`), and `addressToApi` throws on `!addr.phone` (`api.ts:69`). So today the client throw-guard is the only thing standing between a phone-less address and a phone-less EasyPost shipment.

**Why it's still a BUG, not a NIT:** (a) the `addressToApi` guard is `!addr.phone` (truthiness) — a phone of `"123"` passes `addressToApi` but is not a usable phone; that phone-less-in-practice shipment then reaches `/buy` and FedEx rejects it after the user may already be charged (the `labels` auto-refund path then runs); (b) any future caller of `rates` that doesn't go through `addressToApi` (a new flow, a test, a direct API hit) silently creates a phone-less shipment; (c) Rule 5 is explicit that the server must validate independently.

**Suggested fix:** in `rates/index.ts`, after `to_address` is resolved and before the EasyPost `/shipments` POST, validate both `from_address.phone` and `to_address.phone` with the same `isPossiblePhoneNumber`-based `isUsablePhone` helper already used in `links/index.ts:10-18` (lift it to `_shared/` so all three functions share one copy — see finding 6). Return `422` with the actionable phone message for the flex `to_address` (it's a link-owner data problem) and `400` for `from_address`.

---

### 2. RISK — `canFetchRates` omits the phone check; full-label rate fetch surfaces a raw internal error

**File:** `src/hooks/useRecipientFlow.ts:198-208` (`canFetchRates`); consumed at `src/components/recipient/RecipientStepFullShipping.tsx:83`.

`getValidationErrors` step 10 checks `isUsablePhone(state.originAddress.phone)` (`useRecipientFlow.ts:164`). But `canFetchRates` — the *separate* predicate that gates the debounced `fetchRates` call in `RecipientStepFullShipping` — checks `verified`, `street`, dimensions, weight, but **not phone** (lines 199-207). Two predicates for "is this address ready", only one knows about phone — a smaller echo of the `b1e6715` two-flows divergence.

Consequence: in the full-label flow a user can have a complete, verified origin/destination address with an empty or short phone. The debounced effect fires `fetchRates` → `addressToApi(s.originAddress)` throws (`api.ts:69`) → the `catch` sets `ratesError` to the raw string `addressToApi: incomplete address (street=true, city=true, state=true, zip=true, phone=false)` (`RecipientStepFullShipping.tsx:~120`). That internal diagnostic string is shown to the end user as the rates error.

The step-10 phone gate still correctly blocks *advancing to payment*, so this is not a "buy without phone" bug — it's an ugly, confusing error message at the rates panel instead of a clean inline phone-field error.

**Severity RISK** (degraded UX + a parity gap that will bite a future refactor, not a broken purchase).

**Suggested fix:** add `if (!isUsablePhone(state.originAddress.phone) || !isUsablePhone(state.destinationAddress.phone)) return false;` to `canFetchRates`. Then the rates panel simply shows "complete the form" copy until phone is filled, instead of fetching and throwing.

---

### 3. BUG — `LabelTest` drops phone end-to-end (verify, rates, and labels payloads)

**File:** `src/pages/LabelTest.tsx`. Public route `/label-test` (`App.tsx:101`) — **not** behind `ProtectedRoute`.

`LabelTest`'s `SmartAddressInput` collects a phone, and the "Pre-fill Test Data" button seeds `phone` (`LabelTest.tsx:425,435`, fixed in `9635058`). But the phone never makes it to a server call:

- **`verifyAddresses` (lines 209-230):** the `from`/`to` objects POSTed to `addresses` omit `phone`. The `addresses` function returns `verifiedAddresses` (`setVerifiedAddresses(data)`, line 242). `supabase/functions/addresses/index.ts` has **zero** `phone` references — it neither receives nor returns a phone.
- **`getRates` (lines 302-303):** sends `from_address: verifiedAddresses?.from_address` / `to_address: verifiedAddresses?.to_address` — i.e. the phone-less verify response, **not** the raw `fromAddr`/`toAddr` AddressInputs that *do* carry phone. So the EasyPost shipment is created phone-less.
- **`purchaseLabel` (lines 360-374):** the `from_address`/`to_address` in the `labels` body explicitly list `name, street1, city, state, zip, country` — no `phone`. These feed `admin_insert_shipment` `p_from_phone`/`p_to_phone`, which therefore persist `NULL`.

Net effect: any FedEx/UPS label bought through `LabelTest` fails at `/buy` with `PHONENUMBEREMPTY`; any USPS label that does succeed writes addresses rows with `phone = NULL`.

There is **no phone gate** anywhere in `LabelTest` (`isUsablePhone` is never imported), unlike every other flow.

**Severity:** BUG for the tool itself. Lower blast radius than a user-facing flow (it's an internal label-testing tool), but it is a public route, it is the canonical "does label buying work" smoke-test surface, and it directly contradicts `9635058`'s own claim that it audited "no other path creates addresses." It also commits NULL-phone rows to the real `addresses` table.

**Suggested fix:** thread `phone` into all three payloads — `verifyAddresses` `from`/`to`, `getRates` (read `fromAddr.phone`/`toAddr.phone` since `verifiedAddresses` can't carry it unless `addresses` is also changed), and `purchaseLabel` `from_address`/`to_address`. Add an `isUsablePhone` gate before `getRates`, mirroring `SenderStepPackage`.

---

### 4. RISK — legacy phone-less saved addresses surface as `verified` with an empty phone

**Files:** `src/components/recipient/RecipientStepAddress.tsx:99-114`, `src/contexts/RecipientFlowContext.tsx:212-242`, `src/pages/LinksNew.tsx:16-47`, `src/pages/LinksEdit.tsx:43-79`, `src/components/sender/senderState.ts:40-51`.

Every prefill path was correctly updated to `SELECT ... phone ...` and to fall back `recentAddr.phone || profile?.phone || ""`. The fallback chain is right. But for any user whose most-recent `addresses` row predates 2026-05-19, `phone` is `NULL` and `profiles.phone` is almost certainly also empty (it was never collected before) → prefilled `phone: ""`.

The address itself prefills with `verified: !!recentAddr.is_verified` → typically `true`. So the user lands on a step showing a fully-verified address with a silently-empty phone field.

This is **handled, not broken**, in the gated flows:
- `RecipientStepAddress` OAuth auto-advance gates on the full `errors` array (fixed in `1990473`), so it won't auto-skip past a missing phone.
- `getValidationErrors` / `LinksEditor.phoneOk` / `SenderStepPackage` all re-gate phone, so the user is forced to fill it.

It remains a **RISK** because: (a) it depends entirely on every consumer re-gating — finding 1 and 2 show that's not uniformly true (`rates` doesn't, `canFetchRates` doesn't); (b) `loadSavedSender` (`senderState.ts`) rehydrates a whole `AddressInput` from `localStorage` key `sendmo:sender:v1` — a sender who saved before phone existed gets a stored object with **no `phone` key at all** (not even `""`). `SenderStepPackage` re-gates via `isUsablePhone(senderAddress.phone)` which is null-safe, so it's caught — but `STORAGE_VERSION` was **not** bumped when the `AddressInput` shape changed to require `phone`. Per `senderState.ts:29-32`'s own contract ("Bump VERSION when the shape changes"), this is a missed version bump.

**Suggested fix:** (a) bump `STORAGE_VERSION` to `2` in `senderState.ts` so pre-phone stored senders are dropped rather than rehydrated half-shaped; (b) treat finding 1 + 2 as the real fix — once `rates` and `canFetchRates` both gate phone, legacy phone-less data can't slip through any path.

---

### 5. RISK — no server-side phone validation on the sender's origin address

**File:** `supabase/functions/rates/index.ts` + `supabase/functions/labels/index.ts`.

Subset of finding 1, called out separately because the prompt explicitly asks about the sender flow. The sender's **origin** address phone:
- is gated client-side in `SenderStepPackage.tsx:59` (`isUsablePhone`) — good;
- is carried through `fetchSenderRates` → `addressToApi(from)` (`api.ts:519`), which throws on empty phone — good;
- is **never validated server-side**. `rates` builds the EasyPost shipment from the client `from_address` with no check (finding 1). `labels` passes `from_address.phone ?? null` straight into `admin_insert_shipment` with no check.

So the sender-origin phone has client-only enforcement. If `SenderStepPackage`'s gate ever regresses, or a non-UI caller appears, a phone-less origin reaches EasyPost. Same fix as finding 1 (validate `from_address.phone` in `rates`).

---

### 6. RISK / NIT — three independent `isUsablePhone` implementations; one is digit-count, not the library

**Files:** `src/lib/phone.ts:45` (client), `supabase/functions/links/index.ts:10-18` (server), `src/components/forms/AddressForm.tsx` (uses the client one — fine).

Client `src/lib/phone.ts` and server `links/index.ts` agree: both wrap `isPossiblePhoneNumber(s, "US")` from `libphonenumber-js@1.13.2` (client via npm `^1.13.2`, server via `https://esm.sh/libphonenumber-js@1.13.2`). Same library, pinned same version, same logic, same `+`-prefix international behavior. **Parity confirmed for `links`.**

Two caveats:
- **The duplication is a Rule-6 smell.** `links/index.ts` re-declares its own `isUsablePhone`. When `rates` and `labels` get phone validation (findings 1, 5) there will be a strong pull to copy it a third and fourth time. Lift one `isUsablePhone` into `supabase/functions/_shared/` (alongside `cors.ts`, `logger.ts`) and import it everywhere — one definition, no drift.
- **A stale digit-count check still ships.** `AddressForm`'s original `hasUsablePhone` (`phone.replace(/\D/g,"").length >= 10`, introduced in `9635058`) was replaced by `isUsablePhone` in `9d9b55b` — confirmed gone from `AddressForm.tsx` (now imports from `@/lib/phone`). But the **`links` PATCH** still has a bare digit-count in spirit: `9635058` added `phone.replace(/\D/g, "").length < 10` and `9d9b55b` switched POST + PATCH to `isUsablePhone`. Verified current `links/index.ts:770` uses `isUsablePhone(phone)` — good, the digit-count is gone. **No live divergence** — but note `isPossiblePhoneNumber` and a 10-digit count *disagree* on edge cases (e.g. a valid 7-digit-after-`+`-country intl number, or an 11-digit US number with leading `1`), so any new hand-rolled check anywhere would reintroduce client/server drift. Use the shared helper only.

**Severity:** RISK for the duplication (will cause drift the moment findings 1/5 are implemented), NIT for the confirmed-no-current-divergence state.

---

### 7. NIT — `recipient_address_complete` (links GET) ignores phone

**File:** `supabase/functions/links/index.ts:462`.

`recipient_address_complete: !!(link.recipient_address ...)?.street1` — checks `street1` only. `SenderFlow.tsx:82` uses this flag to fail-fast before the sender fills the form. A legacy flex link whose recipient address has a street but `NULL` phone reports `recipient_address_complete: true`, so the sender completes the entire wizard and only fails at `/buy` with the friendly phone-error rewrite (`labels/index.ts:799-808`).

This is a **deliberate, documented tradeoff** — `9635058`'s commit message: "historical addresses are not backfilled — links created before this change will fail FedEx/UPS until the owner edits the address; the labels function gives them a clear message + USPS still works." So it is not a regression. Flagged only so it's a *known* gap: the friendlier behavior would be to include `&& isUsablePhone(phone)` in `recipient_address_complete` so `SenderFlow` shows the "ask the link owner to update their address" screen up-front instead of after a wasted form. Optional.

---

### 8. NIT — `migration 025` correctness (verified, no action)

`supabase/migrations/025_admin_insert_shipment_phone.sql` was reviewed in full. The approach is sound: explicit `DROP` of the exact 29-arg signature before `CREATE` (avoids the 018/019 overload collision), two new params appended at the end with `DEFAULT NULL` (satisfies Postgres's "defaults must be trailing" rule and is deploy-order-safe with named-param callers), `GRANT` re-issued for the new 31-arg signature, and a post-migration verification query. `labels/index.ts` calls it with named params including `p_from_phone`/`p_to_phone`. **Correct.** The only residual: if `LabelTest` keeps sending phone-less `from_address`/`to_address` (finding 3), this RPC dutifully persists `NULL` — the migration is fine, the caller is the bug.

---

### 9. NIT — adjacent behavior introduced by the phone work: no regressions found

Checked the format-as-you-type / delete-detection changes (`9d9b55b`, `ef48637`) for collateral damage:
- `SmartAddressInput.tsx:379` uses `value.phone ?? ""` — null-safe, defends against `sessionStorage`/`localStorage` state predating the `phone` field (this is the `4883777` "null-safe phone checks" fix).
- The autocomplete-pick (`handleSelect`, lines 188-206) and `handleReset` (line 233) onChange paths all explicitly preserve `phone: value.phone` — verified; phone is no longer wiped when the user picks an address or hits "Change". This was a real bug class (`9635058` commit body calls it out) and is correctly handled.
- `parseDescriptionToComponents` return type correctly `Omit`s `phone` (line 30) so the spread at line 191 doesn't clobber it.
- Delete detection reads `(e.nativeEvent as InputEvent).inputType` (`SmartAddressInput.tsx:384`) — the `ef48637` fix; the older shorter-paste-misclassified-as-deletion bug is gone and is regression-tested (`phone.test.ts:25-31`).
- Placeholder is the format mask `(•••) •••-••••` (`SmartAddressInput.tsx:388`, the `91a8831` "not a fake number" fix) — not a real-looking number.

No regression in existing address entry from the phone work.

---

## Test coverage gaps

| Gap | Why it matters | Suggested test |
|---|---|---|
| `rates` Edge Function phone validation | Finding 1 — the single most important phone gate has no test because it has no code. Once added (finding 1 fix), it needs a guard. | Integration test: POST `rates` with a phone-less `from_address` → expect `400`; phone-less resolved flex `to_address` → expect `422`. |
| `canFetchRates` phone branch | Finding 2 — `canFetchRates` has zero tests at all (`grep canFetchRates tests/` → nothing). Drift here silently degrades the full-label rates panel. | Unit test in `useRecipientFlow.test.ts`: `canFetchRates` returns `false` when origin/destination phone is missing/short, `true` when present. |
| `SenderStepPackage` phone gate | Finding 5 — the entire sender origin flow has no unit test; `sender-flow.spec.ts` doesn't assert the phone gate. This is the LinksEditor situation pre-`b1e6715` (a flow gating phone with no regression test pinning it). | Unit test mirroring `LinksEditor.test.tsx`: `SenderStepPackage` does not call `onSubmit` when `senderAddress.phone` is empty/short; the inline "Phone number — the shipping carriers require it" error appears. |
| `LabelTest` phone plumbing | Finding 3 — `LabelTest.test.tsx` exists but asserts nothing about phone. | Once finding 3 is fixed: assert the `rates` and `labels` request bodies include `phone`. |
| Onboarding **flex** path e2e | `onboarding.spec.ts` exercises the full-label path (`fillSmartAddress` fills phone). There is no e2e covering the flex-link onboarding path (step 1 → 20 → 21 → 22 → `createFlexLink`) — which is exactly the path `d2dde62` found broken. A flex-path e2e would have caught that 400 before users did. | E2e: complete the flex onboarding flow; assert the link is created (no 400) and that an empty phone at step 1 blocks advancement. |
| `links` PATCH "phone unchanged" equality | `9635058` added phone to the PATCH equality check (`links/index.ts:788`). No test pins that a price-cap-only PATCH (no `recipient_address`) is *not* phone-gated, nor that an address PATCH with an unchanged phone is treated as unchanged. | Integration test for both PATCH branches. |

---

## What is genuinely fine (verified, not assumed)

- **Type-level guards** — `AddressInput.phone` (`types.ts:176`), `CreateLinkParams.recipient_address.phone` (`api.ts:390`), `UpdateLinkParams.recipient_address.phone` (`api.ts:481`) are all required `string`. `FlexPaymentInput = Omit<CreateLinkParams, ...>` inherits the required `phone`. No `phone?` optional anywhere in a request type. `tsc` now forces every caller — the structural fix that should have prevented `d2dde62`.
- **The three link-creation flows** (onboarding flex, dashboard create, dashboard edit) all gate phone client-side AND the server validates independently (`links` POST/PATCH). Both layers present.
- **`emptyAddress()`** is the single constructor (`utils.ts`), seeds `phone: ""`, and the two duplicate local `emptyAddress` definitions (LabelTest, SenderPreview) were deleted in `9635058` — verified, they now import the canonical one.
- **`addressToApi`** fails loud on missing phone — verified `api.ts:69`.
- **Client/server `isUsablePhone` parity** — same library, same pinned version, same logic — verified.
- **`migration 025`** — overload-collision-safe, deploy-order-safe — verified.
- **Format-as-you-type / delete detection** — no regression to existing address entry — verified.
- **OAuth-return auto-advance** — gates on the full `errors` array including phone (`RecipientStepAddress.tsx`, fix `1990473`), regression-tested — verified.

---

## Recommended priority

1. **Finding 1** (`rates` server-side phone validation) — closes the actual repeat of the known pattern; do this with the shared-helper refactor from finding 6.
2. **Finding 3** (`LabelTest` drops phone) — it's a public route that buys real labels and writes NULL-phone rows.
3. **Finding 2** (`canFetchRates`) — quick one-liner, removes a raw internal error string from the user-facing rates panel.
4. **Findings 4 (STORAGE_VERSION bump) + 6 (shared helper)** — cheap hardening.
5. **Test gaps** — `SenderStepPackage` + `canFetchRates` + flex-onboarding e2e are the highest-value additions; they pin flows that currently gate phone with nothing holding them in place.
6. **Finding 7** — optional UX nicety.
