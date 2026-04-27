---
title: Links manager — authenticated link create/edit outside the onboarding wizard
slug: links-manager
project: sendmo
status: decided
created: 2026-04-26
reviewed: 2026-04-26
revised: 2026-04-26
decided: 2026-04-26
author: Claude (sendmo dashboard polish session, 2026-04-26)
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-04-26
outcome: approved
---

> **Revision note (2026-04-26):** Sections 2, 3, and 5 below have been revised in response to the review at the bottom. All revised passages are flagged inline (`[revised: B1/B2/...]`). The original draft is preserved in git history; per-point author response is in §9.

## 1. Context

### What's broken

Today, when an authenticated SendMo user has no `sendmo_links` row, the Dashboard's "My Label Link" card shows a "Create my link" CTA that deep-links into `/onboarding?path=flexible`. The onboarding wizard then walks the user through:

1. **Step 1 — Address + email** (fine; we just shipped silent prefill in [RecipientStepAddress.tsx](src/components/recipient/RecipientStepAddress.tsx))
2. **Step 20 — Flex preferences** (fine)
3. **Step 21 — Email OTP verify** (**inappropriate for auth'd users** — their email is already proven by Supabase magic-link auth)
4. **Step 22 — Payment authorize** (**inappropriate for auth'd users** when stubbed; will need different framing once Stripe lands; eventually a *saved card* path, not a fresh card capture)
5. **Step 23 — Link ready** (fine; calls `createFlexLink` which already requires a Bearer token)

So the current "Create my link" CTA puts a returning user through two screens (OTP, mock Stripe form) that don't apply to them. This is a footgun the user noticed in their own session today.

### Why this is more than a tactical patch

The onboarding flow was designed as a single new-user pathway: anonymous user → enters preferences → proves email → captures payment → link created. But the codebase already reveals the seams:

- `createFlexLink` *requires* a JWT ([RecipientStepLinkReady.tsx:56](src/components/recipient/RecipientStepLinkReady.tsx) errors out if `!session?.access_token`). So the "anonymous" framing is partly fictional — link creation requires auth today, and the OTP step doesn't currently auto-create a Supabase Auth user. ([WISHLIST.md](WISHLIST.md) "Full Label flow doesn't create account or link" tracks this gap.)
- The wizard step components are tightly coupled to `RecipientFlowState` — each takes the entire state shape as a prop and emits `Partial<RecipientFlowState>` on update. That makes them hard to reuse outside the wizard without dragging the wizard's state model along.
- There's no `/links/:id/edit` path at all, even though [WISHLIST.md](WISHLIST.md) flags it ("Edit my label link from Dashboard"). Users who want to change their address or speed today have no way to do it short of creating a new link.

A patch (e.g., "skip step 21/22 if `user`") would unblock today's friction but bake in the wizard pattern as the only way to create or edit a link, and would not give us an `/links/:id/edit` path. The user explicitly asked for the strategic version: "please architect and build the right way for someone to create their link without going into onboarding."

### What "right" looks like

Three durable surfaces, separated by user state:

| Surface | URL | Audience | Wizard? |
|---|---|---|---|
| **Onboarding** | `/onboarding/...` | Unauthenticated first-time users | Yes (5-step wizard + OTP + payment) |
| **Links — create** | `/links/new` | Authenticated users with no link (or wanting another) | No — single page form |
| **Links — edit** | `/links/:id/edit` | Authenticated users editing an existing link | No — same form, prefilled |

Onboarding stays as the unauthenticated path (post-MVP it grows the OTP→auto-account-creation glue noted in WISHLIST). The new `/links/*` surface is purpose-built for the "I am already logged in" case and shares form components with onboarding via a thin presenter layer.

## 2. Architecture

### Component decoupling — the keystone change

The wizard step components today look like:

```ts
interface Props {
  state: RecipientFlowState;          // entire wizard state
  onUpdate: (p: Partial<RecipientFlowState>) => void;
  onContinue: () => void;
  onBack: () => void;
  // ...
}
```

That coupling means the only caller is the wizard. To reuse them on `/links/new` and `/links/:id/edit` without dragging the wizard along, we extract **pure presenter** components that take only the data they actually display, and let *callers* (the wizard for onboarding; new page components for `/links/*`) own the state container.

**Extraction targets** (the parts that genuinely should be shared):

1. `AddressForm` — visible address fields + email, controlled. Today's [RecipientStepAddress.tsx](src/components/recipient/RecipientStepAddress.tsx) already takes individual props (address, email, onAddressChange, onEmailChange) — it's *almost* a presenter. We just move the prefill side-effect *out* (it belongs to whatever caller decides whether prefill is appropriate; on `/links/new` it's a no-op because the form is already prefilled by the page on first render).

2. `FlexPreferencesForm` — the speed pills, optional carrier/price-cap section, and price grid modal from [RecipientStepFlexPreferences.tsx](src/components/recipient/RecipientStepFlexPreferences.tsx). New props:
   ```ts
   interface FlexPreferencesValue {
     speed_preference: SpeedTier;
     preferred_carrier: string;
     price_cap: number;
   }
   interface FlexPreferencesFormProps {
     value: FlexPreferencesValue;
     onChange: (v: FlexPreferencesValue) => void;
   }
   ```
   No buttons inside the form — the caller renders Continue/Save/etc. The big `PriceGridModal` sub-component stays internal.

3. **[revised: Nit + P3]** `LinkShareCard` — the share-this-link UI from [RecipientStepLinkReady.tsx](src/components/recipient/RecipientStepLinkReady.tsx) (link + QR + copy + SMS/email share). Promoted from v2 to v1 because the inline success view on `/links/new` (P3) needs it. Reused by: wizard's `RecipientStepLinkReady` adapter, `LinksEditor` inline success view, and eventually a `/links` list page (still v2).

The wizard step files become thin adapters: read from `RecipientFlowState`, render the presenter, write back.

### New pages

**`/links/new`** — auth-required (`ProtectedRoute`). Single page with two cards stacked:

```
┌────────────────────────────────────────────┐
│ Create your shipping link                  │
├────────────────────────────────────────────┤
│ Where should packages be delivered?        │  ← AddressForm (controlled)
│ [name] [smart-address-input] [email]       │
├────────────────────────────────────────────┤
│ How fast and what's your max price?        │  ← FlexPreferencesForm
│ [speed pills] [optional: carrier, cap]     │
├────────────────────────────────────────────┤
│ [Cancel]              [Create link →]      │
└────────────────────────────────────────────┘
```

On submit: same `createFlexLink` call as today's wizard. On success, navigate to a success view (or directly back to Dashboard with the new link surfaced — see Open Questions §7).

**Why single-page, not multi-step:** the user is already authenticated, the data is short (address + 3 preferences), and we save them the next/back ceremony. The wizard's value is for first-time users who need pacing; for repeats, the wizard is friction.

**`/links/:id/edit`** — same form, prefilled from the existing `sendmo_links` row (and its joined `addresses` row). On submit: `PATCH /api/links/:id` (already exists per [PLAYBOOK.md](PLAYBOOK.md) §"API Routes" — though we need to verify the edge function actually implements PATCH; see §3).

**`/links` (optional, v1.5)** — list of the user's links with status, address summary, share controls. Could be deferred; for v1 the Dashboard card serves as the entry point.

### How onboarding changes

Minimal. The existing `/onboarding/*` wizard still serves anonymous users. The only edit: **if a logged-in user lands at `/onboarding` (or `/onboarding/preferences`, etc.), we redirect them to `/links/new`** (preserving any `?path=flexible` intent). This kills the deep-link-into-wizard footgun the user hit today and gives us one canonical authenticated entry point.

Dashboard's "Create my link" CTA changes from `/onboarding?path=flexible` → `/links/new`.

### Stripe hold deferral

The current onboarding step 22 (`RecipientStepFlexPayment.tsx`) is a stub. Real Stripe integration is being designed in [proposals/stripe-integration-plan.md](proposals/stripe-integration-plan.md) (status: in-review, drafted today). **This proposal does not relitigate that.** For `/links/new` v1, link creation skips the payment-hold step entirely, exactly as it does in practice today (the stub doesn't actually capture anything). When the Stripe proposal lands, both surfaces (onboarding and `/links/new`) wire the same Stripe Elements component at the same moment in their respective flows.

**[revised: P8]** The two surfaces want different Stripe primitives, both defined in the Stripe proposal §4.1:
- **Onboarding (anon → first link):** `PaymentIntent` with `setup_future_usage = "off_session"` and `capture_method = "manual"` — captures the card AND authorizes the flex hold in one Stripe call. Required because the user has no Customer/PaymentMethod yet.
- **`/links/new` (auth'd, returning user):** `SetupIntent` at create-time (saves card to Customer if not already saved), then `PaymentIntent` against the saved `payment_method` with `capture_method = "manual"` for the actual hold. Splits cleanly because the auth'd user already has a `stripe_customer_id`.

This handshake is documented here so the future implementer doesn't have to re-derive it from the Stripe proposal during the wire-up.

### Auth assumption

Magic-link sign-in already proves email ownership ([Login flow] uses Supabase Auth magic-link, per [PLAYBOOK.md](PLAYBOOK.md) §"Tech Stack" "Auth: Magic link (passwordless)"). So we treat `auth.users.email_confirmed_at` as authoritative — no OTP step on `/links/*`.

## 3. File-by-file plan

### New files

**`src/components/links/LinksEditor.tsx`** — **[revised: P6]** shared editor used by both create and edit pages. Takes `mode: "create" | "edit"`, `initialValue: FlexFormValue | null`, and `linkId: string | null`. Owns form state, validation, and submit dispatch (POST or PATCH based on mode). Renders `AddressForm` + `FlexPreferencesForm` + Cancel/Submit buttons + the inline success card (per P3) on success.

```tsx
interface FlexFormValue {
  address: AddressInput;
  speed_preference: SpeedTier;
  preferred_carrier: string;
  price_cap: number;
  size_hint: "envelope" | "smallbox" | "largebox" | null;
}

interface LinksEditorProps {
  mode: "create" | "edit";
  initialValue: FlexFormValue | null;  // null on create (page resolves prefill)
  linkId: string | null;               // required when mode === "edit"
}

export default function LinksEditor({ mode, initialValue, linkId }: LinksEditorProps) {
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState<FlexFormValue>(initialValue ?? defaultFlexValue());
  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdShortCode, setCreatedShortCode] = useState<string | null>(null);

  async function handleSubmit() {
    setTried(true);
    if (!value.address.verified) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "create") {
        const result = await createFlexLink(toApiPayload(value), session!.access_token);
        setCreatedShortCode(result.short_code);  // triggers inline success card (P3)
      } else {
        await updateFlexLink(linkId!, toApiPayload(value), session!.access_token);
        navigate(`/dashboard?updated_link=${linkId}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  // Inline success card — P3 (replaces redirect-to-Dashboard)
  if (createdShortCode) {
    return <LinkShareCard shortCode={createdShortCode} value={value} onDone={() => navigate("/dashboard")} />;
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">{mode === "create" ? "Create" : "Edit"} your shipping link</h1>
      <AddressForm
        value={value.address}
        tried={tried}
        onChange={(address) => setValue((v) => ({ ...v, address }))}
      />
      {/* Recipient notification email — P4: read from user.email by default */}
      <NotificationEmailField defaultEmail={user!.email!} />
      <FlexPreferencesForm
        value={{ speed_preference: value.speed_preference, preferred_carrier: value.preferred_carrier, price_cap: value.price_cap }}
        onChange={(prefs) => setValue((v) => ({ ...v, ...prefs }))}
      />
      {tried && !value.address.verified && <ValidationSummary errors={["Destination address is required"]} />}
      {error && <ErrorBanner message={error} />}
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate("/dashboard")}>Cancel</Button>
        <Button className="flex-1" onClick={handleSubmit} disabled={submitting}>
          {submitting ? "Saving…" : mode === "create" ? "Create link" : "Save changes"}
        </Button>
      </div>
    </main>
  );
}
```

**`src/pages/LinksNew.tsx`** — **[revised: P6]** thin wrapper. Resolves prefill (profile + most-recent-address, same logic as today's [RecipientStepAddress.tsx:33-64](src/components/recipient/RecipientStepAddress.tsx)) and renders `<LinksEditor mode="create" initialValue={prefill} linkId={null} />`.

**`src/pages/LinksEdit.tsx`** — **[revised: P6]** thin wrapper. Loads `sendmo_links` row + joined `addresses` row by `:id` from URL (Supabase client from frontend, scoped by user_id via RLS). On load: `<LinksEditor mode="edit" initialValue={loadedValue} linkId={id} />`. Renders a loader while fetching and a 404 if not found / not owned.

**`src/components/forms/AddressForm.tsx`** — **[revised: P4]** extracted from [RecipientStepAddress.tsx:66-105](src/components/recipient/RecipientStepAddress.tsx). Pure controlled form. **No email field** (notifications email is rendered separately as `NotificationEmailField` so the auth'd surface can default to `user.email` while the wizard surface keeps the freeform input). The prefill `useEffect` moves to the *caller* — `LinksNew.tsx` runs it on mount, and the wizard adapter (`RecipientStepAddress.tsx`) runs it for the unauth-just-signed-up case.

**`src/components/forms/NotificationEmailField.tsx`** — **[revised: P4]** new presenter. For auth'd surfaces: renders `Notifications go to: <user.email> [change]`. Clicking [change] reveals an input prepopulated with `user.email` and a confirm button. For the wizard adapter: bypassed (wizard keeps its own freeform `Input`, since the unauth user has no `user.email` to default to).

**`src/components/forms/FlexPreferencesForm.tsx`** — extracted from [RecipientStepFlexPreferences.tsx:209-386](src/components/recipient/RecipientStepFlexPreferences.tsx). Strips out the Continue/Back buttons; keeps PriceGridModal as an internal subcomponent. Takes `value` and `onChange` instead of `state` and `onUpdate`.

**`src/components/links/LinkShareCard.tsx`** — **[revised: Nit + P3]** extracted from [RecipientStepLinkReady.tsx:131-244](src/components/recipient/RecipientStepLinkReady.tsx). The share UI: success banner, link + copy button, QR placeholder, SMS/email share buttons, link preferences summary. Takes `shortCode`, `value`, and `onDone`. Reused by `LinksEditor` (inline success card per P3), `RecipientStepLinkReady` (wizard adapter — stays a thin caller that ALSO does the `createFlexLink` POST that the wizard relies on at step 23), and eventually a `/links` list page (v2). The wizard's existing `createFlexLink` flow inside `RecipientStepLinkReady` is preserved unchanged — only the share-UI subtree is extracted.

### `LinksEditor` — PATCH endpoint design (B1)

**[revised: B1]** The PATCH endpoint is the missing piece for `/links/:id/edit`. Full design:

**Endpoint:** `PATCH /api/links/:id` (the `links` Edge Function gains a third method handler).

**Auth:** Bearer JWT in `Authorization` header (same as POST today). Decode via `supabase.auth.getUser(token)` → `user.id`. 401 if missing/invalid.

**Ownership check:** explicit `user_id = auth_user.id` filter on the `sendmo_links` row read. Belt-and-suspenders alongside RLS — and necessary because the existing `links` function uses the service role key (bypasses RLS), per [supabase/functions/links/index.ts:20](supabase/functions/links/index.ts). 404 if the link is not found OR not owned (same response either way — don't leak existence).

**Status guard:** only `status IN ('active', 'draft')` links can be edited. Reject `used`, `cancelled`, `expired` with **409 Conflict** + `{ error: "This link is no longer editable", status: <current> }`. Rationale: editing a used link silently mutates what a sender already saw / shipped against; editing a cancelled link is unintended state revival.

**Mutable fields:**

| Field | Mutable? | Notes |
|---|---|---|
| `speed_preference` | yes | |
| `preferred_carrier` | yes | `null` when payload is `"any"` |
| `max_price_cents` | yes | from `price_cap_dollars * 100` |
| `size_hint` | yes | |
| `notes` | yes | |
| `recipient_address_id` | yes — but via insert-new-row pattern (see below) | |
| `link_type` | no | changing flexible↔full_label is structurally different; create a new link |
| `status` | no | status transitions go through dedicated endpoints (cancel-label, etc.) |
| `short_code` | no | immutable; senders may have it saved |
| `user_id` | no | |
| `created_at` | no | |

**Address handling — insert-new-row pattern:** When the payload contains an updated `recipient_address` that differs from the current row's address, **insert a new `addresses` row** and update `sendmo_links.recipient_address_id` to point at it. Do **not** UPDATE the existing `addresses` row in place. Reason: `shipments` table has FKs to `addresses` (per migration 001 schema); editing in place would silently rewrite the destination of historical shipments. Insert-new-and-repoint preserves history.

Address-equality check: compare `street1, street2, city, state, zip` (case-insensitive, trimmed). If unchanged, skip the insert and leave `recipient_address_id` alone.

**Request shape:**
```ts
PATCH /api/links/:id
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "recipient_address"?: { name, street1, street2?, city, state, zip, verified },
  "speed_preference"?: "economy" | "standard" | "express",
  "preferred_carrier"?: string,            // "any" → stored as null
  "price_cap_dollars"?: number,
  "size_hint"?: "envelope" | "smallbox" | "largebox" | null,
  "notes"?: string | null
}
```

All fields optional — payload is a partial. Empty payload → 400.

**Response shape:**
```ts
200 OK
{
  "id": uuid,
  "short_code": string,
  "updated_at": iso8601,
  "recipient_address": { name, city, state, zip },   // truncated, no street
  "speed_preference": ...,
  "preferred_carrier": ...,
  "max_price_cents": ...,
  "size_hint": ...
}
```

**Error responses:**
- 400 — invalid payload (empty, malformed, validation fail)
- 401 — missing/invalid JWT
- 404 — link not found OR not owned by caller
- 409 — link status is non-editable (`used`, `cancelled`, `expired`)
- 500 — DB error (logged with `event_logs`)

**Audit:** log `link.updated` event to `event_logs` with `entity_id = link.id`, `properties: { changed_fields: [...], previous_address_id, new_address_id }`. Useful for "what did the user change before that confused sender" debugging.

### Modified files

**`src/App.tsx`** — register the new routes and update `OnboardingLayout` to redirect auth'd users:

```tsx
<Route path="/links/new" element={<ProtectedRoute><LinksNew /></ProtectedRoute>} />
<Route path="/links/:id/edit" element={<ProtectedRoute><LinksEdit /></ProtectedRoute>} />
```

**[revised: B3]** Verified via grep: `RecipientFlowProvider` is mounted *only* inside `OnboardingLayout` today ([src/App.tsx:19-25](src/App.tsx)); no other consumers exist anywhere in `src/`. So the redirect can be added inline in `OnboardingLayout`'s body without moving the provider mount — auth'd users hit `<Navigate>` before the provider ever renders, anon users get the existing provider-wrapped Outlet:

```tsx
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

function OnboardingLayout() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  if (loading) return null;                           // wait for auth resolution
  if (user) {
    const path = searchParams.get("path");
    return <Navigate to={`/links/new${path === "flexible" ? "" : path === "full_label" ? "?path=full_label" : ""}`} replace />;
  }
  return (
    <RecipientFlowProvider>
      <Outlet />
    </RecipientFlowProvider>
  );
}
```

(Note: `?path=full_label` for auth'd users isn't supported by `/links/new` v1 — full-label is single-shot label purchase, not a reusable link. If we get a `path=full_label` query param on the redirect, we drop it and send the user to `/links/new` for a flexible link, or — better — show a flash message on the dashboard. Refining this is a v1.1 polish item.)

**`src/pages/Dashboard.tsx`** — three changes:

1. **[CTA]** Change "Create my link" link from `/onboarding?path=flexible` → `/links/new`.
2. **[revised: B2]** Add an **Edit** icon button on the link card (when a link exists). Placement: top-right corner of the link card, `<Pencil>` icon from `lucide-react`, `aria-label="Edit link"`, navigates to `/links/${link.id}/edit`. Sketch:
   ```tsx
   <button
     type="button"
     onClick={() => navigate(`/links/${link.id}/edit`)}
     className="absolute top-3 right-3 w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center"
     aria-label="Edit link"
   >
     <Pencil className="w-4 h-4 text-muted-foreground" />
   </button>
   ```
3. **[Banner]** Surface `?updated_link=<id>` query param if present (success toast: "Link updated"). The created-link case is now handled by the inline success card in `LinksEditor` (per P3), so no `?new_link=` banner is needed — but keep `?updated_link=` since edit redirects back to Dashboard.

**`src/components/recipient/RecipientStepAddress.tsx`** — refactor to use the new `AddressForm` presenter. Keep the prefill `useEffect` here (wizard caller wants prefill for the unauth → first-link case where the user just signed up). Email field stays inline (wizard keeps its freeform input — see `NotificationEmailField` rationale above). Net delta: file gets shorter.

**`src/components/recipient/RecipientStepFlexPreferences.tsx`** — refactor to use the new `FlexPreferencesForm`. Adapter shape:
```tsx
const value = {
  speed_preference: state.speed_preference,
  preferred_carrier: state.preferred_carrier,
  price_cap: state.price_cap,
};
return (
  <>
    <FlexPreferencesForm value={value} onChange={(v) => onUpdate(v)} />
    {/* validation summary, Back/Continue buttons */}
  </>
);
```

**`src/components/recipient/RecipientStepLinkReady.tsx`** — **[revised: Nit reconciliation]** refactor the share-UI subtree out into `LinkShareCard` and call it. The wizard's `createFlexLink` POST + loading/error states stay in `RecipientStepLinkReady`; only the rendered success view delegates to `LinkShareCard`. Net delta: file gets shorter; wizard behavior unchanged.

**`src/lib/api.ts`** — add `updateFlexLink(linkId, payload, token)` to mirror the existing `createFlexLink`. Calls `PATCH /api/links/:id`.

**`supabase/functions/links/index.ts`** — **[revised: B1]** add the PATCH handler designed in the subsection above. The full implementation lives in the edge function; this proposal commits to the contract.

**`WISHLIST.md`** — once shipped, mark "Edit my label link from Dashboard" as done (this proposal subsumes it).

### Files explicitly NOT touched

- `RecipientStepEmailVerify.tsx` (step 21) — stays as-is for the unauth onboarding path. WISHLIST item "Full Label flow doesn't create account or link" addresses the auto-account-create story; that's its own proposal.
- `RecipientStepFlexPayment.tsx` (step 22) — stays as the stub. The Stripe proposal owns its replacement.

### Modified files

**`src/App.tsx`** — register the new routes:
```tsx
<Route path="/links/new" element={<ProtectedRoute><LinksNew /></ProtectedRoute>} />
<Route path="/links/:id/edit" element={<ProtectedRoute><LinksEdit /></ProtectedRoute>} />
```

**`src/contexts/RecipientFlowContext.tsx`** — at the top of `RecipientFlowProvider`, add an auth check that redirects authenticated users away from `/onboarding/*` to `/links/new` (preserving query params if any). Either `useAuth()` here or guard at route level (cleaner: guard at route in `App.tsx`):

```tsx
// In App.tsx — wrap onboarding routes in an AuthRedirect
function OnboardingLayout() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  if (loading) return null;
  if (user) {
    // Authenticated users belong on /links/new
    const path = searchParams.get("path");
    return <Navigate to={`/links/new${path ? `?path=${path}` : ""}`} replace />;
  }
  return <RecipientFlowProvider><Outlet /></RecipientFlowProvider>;
}
```

**`src/pages/Dashboard.tsx`** — change "Create my link" CTA from `/onboarding?path=flexible` → `/links/new`. (Already an honest one-liner.) Also surface a banner for `?new_link=...` query param if present, so the just-created link gets visual confirmation on the dashboard.

**`src/components/recipient/RecipientStepAddress.tsx`** — refactor to use the new `AddressForm` presenter. Keep the prefill `useEffect` here (wizard caller wants prefill for the unauth → first-link case where the user just signed up). Net delta: file gets shorter.

**`src/components/recipient/RecipientStepFlexPreferences.tsx`** — refactor to use the new `FlexPreferencesForm`. Adapter shape:
```tsx
const value = {
  speed_preference: state.speed_preference,
  preferred_carrier: state.preferred_carrier,
  price_cap: state.price_cap,
};
return (
  <>
    <FlexPreferencesForm value={value} onChange={(v) => onUpdate(v)} />
    {/* validation summary, Back/Continue buttons */}
  </>
);
```

**`supabase/functions/links/index.ts`** — verify (or add) PATCH support. [PLAYBOOK.md](PLAYBOOK.md) §"API Routes" lists `PATCH /api/links/:id` as an endpoint, but the file only handles GET and POST today. We need to add:
```ts
if (req.method === "PATCH") {
  // Auth check (Bearer token)
  // URL parse: /links/:id
  // Validate user owns the link (RLS or explicit user_id check)
  // Upsert recipient address (insert new row, update FK)
  // Update sendmo_links row: max_price_cents, preferred_speed, preferred_carrier, size_hint, recipient_address_id
  // Return updated link
}
```
This is the meat of `/links/:id/edit`; without it that page is read-only.

**`WISHLIST.md`** — once shipped, mark "Edit my label link from Dashboard" as done (this proposal subsumes it).

### Files explicitly NOT touched

- `RecipientStepEmailVerify.tsx` (step 21) — stays as-is for the unauth onboarding path. WISHLIST item "Full Label flow doesn't create account or link" addresses the auto-account-create story; that's its own proposal.
- `RecipientStepFlexPayment.tsx` (step 22) — stays as the stub. The Stripe proposal owns its replacement.

## 4. Test plan

### Unit (Vitest)

- `AddressForm.test.tsx` — controlled form renders all fields, fires onChange on edit, shows error states when `tried && !verified`.
- `FlexPreferencesForm.test.tsx` — speed pill click updates value, optional section toggles, price cap selection updates value, modal opens/closes.
- Existing `RecipientStepAddress` and `RecipientStepFlexPreferences` tests get updated to assert the adapter wires presenter → state correctly (or replaced if they were testing the inlined view).

### Integration (Playwright e2e)

- `links-new.spec.ts` — sign in (or use an existing test session), navigate to `/links/new`, fill address + preferences, submit, assert redirect to `/dashboard?new_link=<code>` and that the dashboard card shows the new link.
- `links-edit.spec.ts` — seed a link, navigate to `/links/:id/edit`, change speed, save, assert DB row updated (via API check or by re-reading the dashboard card).
- `auth-redirect.spec.ts` — signed-in user navigates to `/onboarding/preferences` → asserted redirect to `/links/new`.
- Existing onboarding e2e tests should still pass unchanged (anonymous flow).

### Manual verification

- Anon user: `/onboarding` → wizard works as before.
- Auth'd user, no link: Dashboard "Create my link" → `/links/new` → submit → Dashboard shows new link.
- Auth'd user, with link: Dashboard "Edit" (once added) → `/links/:id/edit` → change speed/cap → save → Dashboard reflects change.
- Auth'd user types `/onboarding/preferences` directly → redirected to `/links/new`.

## 5. Out of scope

- **Stripe hold integration on `/links/new`** — owned by [proposals/stripe-integration-plan.md](proposals/stripe-integration-plan.md). When Stripe lands, a follow-up wires the Elements component at submit-time on both surfaces.
- **Anon user OTP → auto-create-account flow** — separate WISHLIST item. Onboarding stays partially-broken-for-truly-anonymous-users for now; this proposal doesn't fix it but doesn't make it worse.
  - **[revised: P7]** *Cross-proposal note for the future auto-account-create work:* once an anonymous user mid-onboarding gets auto-signed-in, this proposal's `OnboardingLayout` redirect would yank them straight to `/links/new`, dropping their wizard state. The auto-account-create proposal needs a bypass mechanism — either a sentinel like `?just_signed_up=1` in the URL (recognized by `OnboardingLayout` to skip the redirect for one navigation), or moving the auth check to fire only on an *explicit* visit to `/onboarding`, not on a mid-flow re-render. Flagging here so the next proposal author doesn't ship the auto-account-create flow only to find the redirect breaks it.
- **`/links` list page** — Dashboard's link card is the v1 entry point. A full list view (multiple links, draft/active/used filters) is a v2 once users have more than one link.
- **Multi-link support** — Today the Dashboard shows the user's *primary* link (first active flexible link). Multiple links per user is a separate design question (which is "primary"? can users have full_label and flexible at the same time?). For now, both `/links/new` and `/links/:id/edit` operate on the assumption of "the user's flexible link" (singular).
- **Branded share-this-link page** — WISHLIST item. Out of scope here.
- **Label PDF, tracking, sender flow** — entirely separate codepaths.

## 6. Verification (post-implementation walkthrough)

1. `npm run build && npx tsc -b --noEmit` — clean.
2. `npm run test` — unit tests green.
3. `npm run test:e2e` — anonymous onboarding still passes; new auth-flow tests pass.
4. Local dev (`op run --env-file=.env.tpl -- npm run dev`):
   1. Sign in as a test user with no `sendmo_links` rows.
   2. Land on `/dashboard` → "Create my link" → confirms route is `/links/new`.
   3. Page shows prefilled address + email; speed pill defaults to Standard; price cap $100.
   4. Submit empty form → red validation states.
   5. Fill address (Google Places autocomplete + verify), submit → redirect to `/dashboard?new_link=<code>`; banner visible; link card now shows the link.
   6. Click "Edit" on the link card → `/links/:id/edit`; form prefilled with existing values.
   7. Change speed to Express, save → redirect to dashboard; card reflects "Express".
   8. Sign out; navigate to `/onboarding` → wizard renders normally.
   9. Sign in again; navigate manually to `/onboarding/preferences` → redirected to `/links/new`.
5. Deploy to Vercel preview. Repeat steps 4.1–4.7 against preview URL.
6. Promote to prod. Smoke-test on sendmo.co.

## 7. Open questions (where the reviewer should especially weigh in)

1. **Single-page vs two-step on `/links/new`?** I've proposed single-page (address + prefs stacked). Alternative: keep the two-step pacing for symmetry with onboarding. Single-page is fewer clicks but a denser page. For an auth'd user who just wants to set up their primary link in 30 seconds, I think single-page wins, but I'm not certain.

2. **`/links/new` success — redirect to Dashboard, or in-place "link ready" view?** I've proposed redirect-to-Dashboard with a banner. Alternative: render an inline success card with copy/share UI (matching today's `RecipientStepLinkReady`). Pro of inline: user can immediately copy/share without an extra click. Pro of redirect: confirms the dashboard is the home for their links, and the share UI lives there too. I lean redirect because it teaches the user where to find their link, but it costs them an extra click to share.

3. **Cancel button on `/links/new` for users with no link** — does it just go back to Dashboard (where they have nothing useful)? Should it be hidden for first-link case? Or maybe the form is just embedded directly on the Dashboard for the no-link case, no separate page at all? That's a more radical option (#3b: skip `/links/new` entirely for the create-first-link case; embed the form on Dashboard).

4. **Decoupling `RecipientStepAddress` and `RecipientStepFlexPreferences` — worth the refactor cost?** Alternative: duplicate the JSX into `LinksNew.tsx` and accept drift risk. Pro of duplicate: zero refactor risk to the working onboarding flow. Pro of extract: single source of truth, future changes (new fields, new pills) land in one place. I'm proposing extract because the surfaces are going to keep growing (Stripe hold UI, multi-link support, edit), but if onboarding is going to be deprecated entirely once auto-account-create lands, extract is wasted work.

5. **PATCH endpoint on `/links/:id`** — the playbook claims it exists; the code doesn't show it. Worth confirming with `git log` whether it was removed, never built, or lives elsewhere before I commit to building it from scratch.

6. **Where does email live for an auth'd user creating a link?** Today's wizard captures `email` separately on step 1 (the user types it). For an auth'd user, their `auth.users.email` is the obvious source — should `AddressForm` even show an email field on `/links/new`, or should we just use `user.email` silently and only show it as "Notifications will go to: foo@bar.com [change]"? Less typing for the common case, but loses the ability to pipe notifications to a different address. (Sender notification email is a separate field set on the *sender* side at full-label flow, per the recently-shipped WISHLIST fix — so this is just about *recipient* notifications.)

---

## Review

```yaml
reviewer: Claude (opus-4-7) — fresh-eyes reviewer, 2026-04-26
reviewed_at: 2026-04-26
verdict: approve-with-changes
```

### Summary

Solid problem framing in §1 — the "patch vs refactor" fork is correctly drawn, the wizard's coupling to `RecipientFlowState` is real, and extracting presenters is the right call. The proposal cleanly defers Stripe to its sibling proposal without folding scope. Two real gaps need to land in the body before implementation: PATCH endpoint design is missing (author flagged it as an open question, but it's actually a blocker for the edit half), and the Dashboard "Edit" entry point isn't in the file-by-file plan.

### Blocking issues

**B1. PATCH endpoint on `/api/links/:id` does not exist — proposal needs to design it, not flag it.**
- *Location:* §3 ("supabase/functions/links/index.ts — verify (or add) PATCH support"); §7 Q5 ("worth confirming with `git log` whether it was removed, never built, or lives elsewhere").
- *Issue:* Verified: `supabase/functions/links/index.ts` only handles GET and POST. PLAYBOOK §"API Routes" claims `PATCH /api/links/:id` exists, but the code doesn't. Without PATCH, the entire `/links/:id/edit` half of the proposal can't ship. The author's §3 sketch ("Auth check, URL parse, validate ownership, upsert address, update link") is too thin for a reviewed proposal — it needs the same level of detail as §3.x in a typical Edge Function spec.
- *Suggested fix:* Add a §3 subsection that specifies: (a) auth model (Bearer JWT, owner check via `user_id = auth.uid()` or RLS); (b) which fields are mutable on PATCH (preferences yes; address — does the user "edit" the existing `addresses` row in place, or insert a new row + repoint `recipient_address_id`?); (c) effect on existing shipments using the link (none, since shipments reference `recipient_address_id` directly — but address-edit-in-place would silently mutate historical shipment addresses too); (d) request/response shape; (e) status transition rules (can a `used` link still be edited? probably not — return 409). The "address: insert new row + repoint FK" pattern is safer than in-place edit because it preserves historical shipment correctness.

**B2. Dashboard "Edit" entry point is in the verification walkthrough but missing from the file-by-file plan.**
- *Location:* §6 verification step 4.6 ("Click 'Edit' on the link card → `/links/:id/edit`"); §3 Dashboard.tsx changes.
- *Issue:* §3 Dashboard.tsx changes scope is "change CTA URL" + "surface `?new_link=` banner." There's no Edit button addition in §3 — but §6 verifies clicking Edit. Confirmed via grep: today's Dashboard.tsx has no Edit button anywhere. So either (a) Edit-button addition is silently expected and missing from the plan, or (b) `/links/:id/edit` is technically reachable but has no UI entry point until a follow-up.
- *Suggested fix:* Add Dashboard.tsx Edit-button addition to §3 with the exact placement (next to "Copy link" on the link card, or as an icon button). Alternatively, scope `/links/:id/edit` (and PATCH endpoint) out of v1 and explicitly state "edit ships in a follow-up after PATCH lands." Either is fine; the current state is verification-checks-something-not-built.

**B3. Provider remount during onboarding redirect needs explicit handling.**
- *Location:* §3 "Modified files" — `RecipientFlowContext.tsx` + App.tsx OnboardingLayout sketch.
- *Issue:* The sketch shows `OnboardingLayout` returning `<Navigate>` for auth'd users and `<RecipientFlowProvider><Outlet /></RecipientFlowProvider>` for anon. This means `RecipientFlowProvider` mount must move *into* `OnboardingLayout` from wherever it lives in App.tsx today. The proposal doesn't confirm where the provider currently mounts. If it's at App-level (wrapping all routes), moving it into a layout could break other consumers; if it's already per-route, the sketch is fine. The implementer needs the answer in the proposal, not in their grep history.
- *Suggested fix:* Add one sentence in §3 confirming the current `RecipientFlowProvider` mount location and stating explicitly that the mount moves into `OnboardingLayout`'s else branch. If anything else consumes the provider outside `/onboarding/*`, identify it.

### Non-blocking concerns

**P1. Decoupling refactor (§7 Q4) — extract is right.** The "duplicate JSX" alternative drifts within a sprint as Stripe hold UI, multi-link, and the auto-account-create flow all land. The presenters are exactly where the next round of changes will go. Affirm extract.

**P2. Single-page on `/links/new` (§7 Q1) — single-page wins.** Two-step pacing is friction for an auth'd user with prefill; the wizard's pacing exists for first-time anonymous users who aren't on this surface anyway. Affirm single-page; put the validation summary between the two cards if needed.

**P3. Success view (§7 Q2) — recommend inline success card, not redirect.** Author leaned redirect-to-Dashboard with a banner. Counter: the just-created moment is when the user wants to *share* the link — every extra click loses share intent. Inline success card with copy/share/QR (the v2 `LinkShareCard`) plus a "Done" → Dashboard button keeps the share UX in front of the user. Dashboard banner becomes redundant. Note: the wizard's full-screen "your link is ready!" page is overkill here — a card matches the auth'd context.

**P4. Email field on `/links/new` (§7 Q6) — drop the input by default.** For an auth'd user, `auth.users.email` is the source of truth. An open input invites a divergence: what if they type a different email — do we save it where? Pattern: render "Notifications go to: foo@bar.com [change]" as a single line; clicking [change] reveals an input. Wizard's email field stays for the unauth onboarding path; this is auth-only.

**P5. Cancel button (§7 Q3) — keep. Skip the embed-on-Dashboard alternative.** Embedding the form on Dashboard for the no-link case breaks the URL contract (`/links/new` deep-links from marketing copy, "Create my link" CTAs, etc.). Keep it as a discrete page. Cancel-back-to-Dashboard is fine even if Dashboard has nothing to show.

**P6. `LinksEdit` and `LinksNew` 90% duplication (§3) — extract a shared editor.** Author flagged it. Recommendation: `LinksEditor` component that takes `mode: "create" | "edit"` and `initialValue: FlexFormValue | null`, plus an `onSave` callback. `LinksNew.tsx` and `LinksEdit.tsx` become 20-line wrappers that resolve `initialValue` (none vs. fetched-by-id) and bind submit. The future Stripe hold UI lands in one place rather than two.

**P7. Auto-account-create proposal interaction.** §5 correctly punts the WISHLIST item "Full Label flow doesn't create account or link" to a separate proposal. But this proposal's redirect logic creates a subtle interaction: when auto-account-create ships, an anonymous user mid-onboarding gets signed in, and the redirect would yank them to `/links/new` mid-flow, losing their state. Add a one-line note in §5 ("the auto-account-create proposal must consider this redirect — likely needs a `?just_signed_up=1` bypass or equivalent").

**P8. Cross-proposal handshake with Stripe is right; one detail to pin.** §2 "Stripe hold deferral" cleanly says "both surfaces wire same Stripe component when Stripe lands." Worth pinning in §2: the Stripe proposal's §4.1 distinguishes SetupIntent (post-MVP "Add card" UI for returning users) from PaymentIntent w/ `setup_future_usage` (the wizard path). For `/links/new` (auth'd, no hold needed today, eventually a flex-link hold via saved card), the right Stripe primitive is **SetupIntent** at create-time + **PaymentIntent w/ saved card + manual capture** at sender-side label-buy. Adding this cross-reference saves the future implementer a re-read of the Stripe proposal.

**P9. `?new_link=<short_code>` query param — sanitization.** Short codes are alphanumeric per migration 001 (`SAFE_CHARS` excludes ambiguous chars), so XSS via the URL is structurally impossible — but rendering should still go through React's default escaping (no `dangerouslySetInnerHTML`). One-line note in implementation; not a concern, just worth pinning.

### Nits

- §3 PATCH endpoint sketch: "Upsert recipient address (insert new row, update FK)" — that's "insert + update FK," not "upsert" (`INSERT ... ON CONFLICT UPDATE`). Reword for clarity. Also see B1 for the design implications of which path is taken.
- §3 lists `RecipientStepLinkReady.tsx` in "files explicitly NOT touched," but §2 mentions extracting `LinkShareCard` from it as a v2. Reconcile: either add the extraction to scope (with a §3 entry) or explicitly defer it. As-is the v2 mention dangles.
- §1: The phrase "fictional" framing for the wizard's anonymous path is slightly misleading — `createFlexLink` requires JWT, but the wizard *technically* allows an anon user to traverse steps 1→20→21→22 before hitting step 23 where the JWT requirement bites. So "anonymous framing is partly fictional" is accurate but understates: the wizard is partially-broken for truly-anonymous users today. WISHLIST already tracks this. No action; just clearer wording would help.

### What the proposal got right

- **Diagnosis quality.** §1's "Why this is more than a tactical patch" reads the codebase, not just the surface bug. The seams in the wizard pattern are accurately named.
- **Honest cross-proposal handshake** with stripe-integration-plan. §2 cleanly says "this proposal doesn't relitigate Stripe" without dodging the eventual integration. Avoids the trap of folding Stripe scope in.
- **Auth-redirect at route level** rather than inside the provider. Cleaner than putting `useAuth()` inside `RecipientFlowProvider`.
- **Defer `/links` list page** to v2. Scope discipline — Dashboard's link card is fine for v1.
- **§7 open questions are load-bearing.** Each is a real fork in the road; that's the §7 most reviewers can give back cleanly.
- **Subsumes a WISHLIST item.** §3 correctly notes this proposal closes "Edit my label link from Dashboard" once shipped.

### Implementer checklist (post-decision)

- [x] B1 — Add §3 subsection designing the PATCH endpoint end-to-end (auth, mutable fields, address-edit pattern: insert-new vs in-place, status guards, request/response shape). *Done — see §3 "PATCH endpoint design (B1)".*
- [x] B2 — Add Dashboard.tsx Edit button to §3, OR explicitly scope `/links/:id/edit` + PATCH out of v1 (keeping create-only as the v1 surface). *Done — Edit button added to Dashboard.tsx in §3.*
- [x] B3 — Confirm current `RecipientFlowProvider` mount location in App.tsx and document the move into `OnboardingLayout` (else branch) in §3. *Done — verified provider only mounts inside OnboardingLayout (no other consumers); redirect added inline, no provider move needed.*
- [x] P3 — Switch §3 success view from redirect-to-Dashboard to inline success card (with `LinkShareCard` from §2 v2). *Done — `LinksEditor` renders `LinkShareCard` inline on create success.*
- [x] P4 — Drop email input on `/links/new`; use `user.email` with a [change] expander. *Done — `NotificationEmailField` presenter on auth'd surfaces; wizard keeps freeform input.*
- [x] P6 — Extract `LinksEditor` component; `LinksNew.tsx`/`LinksEdit.tsx` become thin wrappers. *Done — see new `src/components/links/LinksEditor.tsx`.*
- [x] P7 — Add note in §5 about auto-account-create redirect interaction. *Done — see §5.*
- [x] P8 — Cross-reference Stripe proposal §4.1 in §2 (SetupIntent for /links/new auth'd path). *Done — see §2 "Stripe hold deferral".*
- [x] Reconcile `LinkShareCard` extraction (Nit) — in-scope or explicit defer. *Done — promoted to v1 in §2 (P3 needs it); §3 entry added under `RecipientStepLinkReady.tsx`.*

---

## Author response

```yaml
responder: Claude (sendmo session, 2026-04-26)
responded_at: 2026-04-26
disposition: revised
decisions_for_john: 0   # all reviewer findings accepted; no escalations
```

### Summary

All three blockers and all nine non-blocking concerns accepted. No reviewer findings I needed to push back on. Revisions applied inline above (flagged `[revised: ...]`). One reviewer concern (P3 inline success card) explicitly changed my mind — I led the original proposal toward redirect-to-Dashboard for the "teach the user where their links live" reason; reviewer's "peak share intent" counterargument is stronger and shifts where the share UI surface is anyway. Other accepts ranged from "you're right and I should have caught it" (B1 PATCH design) to "agree with reviewer's affirmation of my position" (P1, P2, P5).

### Per-point response

**B1 — PATCH endpoint design.** ✅ Accept. The §3 sketch was indeed too thin for a reviewed proposal; I had been treating "verify whether it exists first" as a precursor question and let it stay in the open-questions bucket. Revised §3 now contains a full PATCH design subsection covering: auth model (Bearer JWT + explicit owner check, since the function uses service-role and bypasses RLS), mutable field whitelist, **insert-new-address-row + repoint-FK pattern** (chosen over in-place edit for the exact reason reviewer flagged — historical shipment integrity), status guards (`active`/`draft` only, 409 on `used`/`cancelled`/`expired`), request/response shape, error responses, audit logging.

**B2 — Dashboard Edit button.** ✅ Accept. Genuine inconsistency in the original — §6 verification step 4.6 referenced a button that §3 didn't add. Revised §3 Dashboard.tsx changes now specify the exact placement (top-right corner of the link card, `<Pencil>` icon, `aria-label`).

**B3 — Provider remount handling.** ✅ Accept (with simplification). Verified via `grep RecipientFlowProvider src/`: provider only mounts inside `OnboardingLayout` today, with no other consumers anywhere in `src/`. So no actual provider move is needed — the auth check just goes inline in `OnboardingLayout`'s body, returning `<Navigate>` for auth'd users before the provider ever renders. Revised §3 documents this explicitly so the implementer doesn't re-derive it.

**P1 — Decoupling refactor is right.** ✅ Accept (affirms my position). No change needed.

**P2 — Single-page on `/links/new` wins.** ✅ Accept (affirms my position). No change needed.

**P3 — Inline success card, not redirect.** ✅ Accept — *changed my mind here.* Reviewer's "just-created moment is when the user wants to share — every extra click loses share intent" argument is stronger than my "redirect-teaches-where-the-link-lives" argument. The dashboard banner I'd planned would have been redundant noise on top of an inline card. Revised §3 has `LinksEditor` rendering `LinkShareCard` inline on create success, with a "Done" button back to Dashboard.

**P4 — Drop email input on `/links/new`.** ✅ Accept. New `NotificationEmailField` presenter renders `user.email` with a `[change]` expander on auth'd surfaces. Wizard keeps its freeform `Input` (the unauth user has no `user.email` to default to). Revised §3.

**P5 — Keep Cancel button; skip embed-on-Dashboard.** ✅ Accept (affirms my position). The URL-contract argument lands. No change needed.

**P6 — Extract `LinksEditor` shared component.** ✅ Accept. `LinksEditor` takes `mode`/`initialValue`/`linkId`, `LinksNew.tsx` resolves prefill and renders create-mode, `LinksEdit.tsx` loads-by-id and renders edit-mode. Future Stripe hold UI lands in one place. Revised §3.

**P7 — Auto-account-create redirect collision.** ✅ Accept. The redirect *would* yank an anonymous user mid-flow once they're auto-signed-in. Note added to §5 flagging the bypass-sentinel pattern (`?just_signed_up=1` or move auth check to fire only on explicit visit) for the future proposal author.

**P8 — Stripe primitive cross-reference.** ✅ Accept. Onboarding wants `PaymentIntent` w/ `setup_future_usage="off_session"` + `capture_method="manual"` (one call captures card AND authorizes hold for an anon user with no Customer); `/links/new` wants `SetupIntent` at create-time + `PaymentIntent` against saved PaymentMethod at sender-side label-buy (auth'd user already has a Customer). Revised §2.

**P9 — `?new_link=` sanitization.** ✅ Accept (note-only). Short codes are alphanumeric per `SAFE_CHARS`, React's default escaping covers it. Now moot anyway — P3 changed the success path to inline, so no `?new_link=` query param is read on Dashboard. The `?updated_link=<id>` query param introduced for edit-success is a UUID, same structural-XSS-impossible argument applies.

**Nit 1 — "Upsert" wording in PATCH sketch.** ✅ Accept. The revised PATCH design uses "insert-new-row + repoint-FK" wording, not "upsert." Resolved as part of B1.

**Nit 2 — `LinkShareCard` extraction reconciliation.** ✅ Accept. Promoted from v2-mention to in-scope: P3 needs it on `/links/new`'s inline success view, so it has to ship in this proposal. Revised §2 (item 3) and added §3 entry for `RecipientStepLinkReady.tsx` extracting the share subtree out.

**Nit 3 — "Fictional" wording for wizard's anonymous path.** ✅ Accept. Not a substantive change; the §1 phrasing could be tighter. Leaving as-is for now (the proposal is already long, the meaning is clear, and this is a nit).

### Decisions for John

None. All reviewer findings accepted on their merits; the proposal now needs decision (approve / request another round / kill) but not tradeoff arbitration.

### What changed in the proposal body

Revised passages are flagged inline with `[revised: <ref>]`. Summary:

- §2 Stripe hold deferral — Stripe primitive cross-reference (P8).
- §2 Component decoupling item 3 — `LinkShareCard` promoted to v1 (Nit + P3).
- §3 New files — added `LinksEditor.tsx`, `NotificationEmailField.tsx`, `LinkShareCard.tsx`; revised `LinksNew.tsx`/`LinksEdit.tsx` as thin wrappers (P6); revised `AddressForm.tsx` to drop email field (P4).
- §3 New "PATCH endpoint design (B1)" subsection — full design (B1).
- §3 Modified files — revised `App.tsx` `OnboardingLayout` with auth check (B3); added Edit button to `Dashboard.tsx` (B2); revised `RecipientStepLinkReady.tsx` from "not touched" to "extract share subtree to `LinkShareCard`" (Nit); added `src/lib/api.ts` `updateFlexLink` helper (B1); added `supabase/functions/links/index.ts` PATCH handler reference (B1).
- §3 "Files NOT touched" — removed `RecipientStepLinkReady.tsx` (now touched).
- §5 Out of scope — auto-account-create redirect interaction note (P7).

---

## Decision

```yaml
decided_by: John
decided_at: 2026-04-26
outcome: approved
```

John approved the revised proposal as-is for implementation. No further changes requested. Implementation proceeds in the order specified in §3 (backend PATCH first → API client → presenters → LinksEditor → pages → routes/Dashboard → wizard adapters → verify), with confirmation before push to main per CLAUDE.md rule 4.
