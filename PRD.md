# SendMo Product Requirements Document

> **Version**: 6.1 (Consolidated)
> **Last Updated**: 2026-02-24
> **Sources merged**: SPEC.md (Draft v5), Loveable PRD v1, Loveable PRD v2 (SENDMO-PRD-V2.md), Claude.ai design session (Feb 24, 2026)
> **Status**: Active — use this as the single source of truth
> **Prototype**: https://sendmo.lovable.app
> **Loveable Project**: https://lovable.dev/projects/e3abd1d5-5b30-4349-98c5-b4e7e8d69031

---

## 1. Product Vision

**One-liner**: SendMo: Prepaid shipping made easy. Create a shipping label or a flexible link, share it with anyone who needs to send you something.

### The Problem
Shipping between individuals is unnecessarily complicated:
- Recipients have to share their address with every sender
- Senders have to figure out box sizes, carrier options, and costs
- Both parties go back and forth on shipping estimates
- Neither has visibility once the package is in transit
- Facebook Marketplace killed prepaid shipping labels (Feb 2025) — sellers now buy their own labels

### The Solution
SendMo Label Links. Recipients create a link once, share it with anyone who needs to send them something. Senders click, enter package details, and print a label. The recipient pays.

### Value Proposition
1. **For Recipients**: Control over shipping — set your preferences once, share a link, receive packages
2. **For Senders**: Dead simple — click a link, enter package info, print label, drop off. No payment needed.
3. **Privacy**: Recipients keep their address private until label is printed

### Target Users
**Primary (Recipients)**: Marketplace buyers (Facebook Marketplace, Craigslist, OfferUp), office managers, anyone receiving packages from multiple senders.
**Secondary (Senders)**: Marketplace sellers, friends/family, vendors, remote employees.

---

## 2. Key Concepts

| Term | Definition |
|------|------------|
| **Recipient** | Person receiving the package. Creates and owns SendMo links. Pays for shipping. |
| **Sender** | Person shipping the package. Clicks the link, enters package details, prints label. No account needed. |
| **SendMo Link** | A shareable URL (e.g., sendmo.co/s/k8Hj2mNp4x) that enables shipping to a recipient. |
| **Price Cap** | Maximum the recipient will pay per shipment. Default: $100. |
| **Speed Tier** | Economy / Standard / Express — recipient's preference for delivery speed. |

### Two Recipient Paths (Both MVP)

SendMo offers two distinct onboarding paths:

1. **Full Prepaid Label** — When the recipient knows exactly what's being shipped. They enter the origin address, package details, choose a carrier/speed, and get an exact price. Results in a downloadable PDF label.
2. **Flexible Shipping Link** — When shipment details are unknown. The recipient sets distance, size hints, and speed preferences. The sender fills in the rest later. Results in a shareable link.

| Type | Status | Description |
|------|--------|-------------|
| **Full Prepaid Label** | MVP | Recipient enters all details, gets exact price + PDF label immediately |
| **Flexible Shipping Link** | MVP | Reusable link. Sender configures package details later. |
| **Private Shipment Link** | Phase 3 | QR code instead of label, no address exposure. |

---

## 3. Pricing Model

### Standard Rate (Credit Card)
```
Display Price = EasyPost Rate × 1.15
SendMo keeps 15%, shown as single "Shipping" price
```

### Discounted Rate (SendMo Balance — Post-MVP)
```
Display Price = EasyPost Rate × 1.10
SendMo keeps 10%
```

### Display Strategy
- Do NOT show SendMo fee separately
- Show single "Shipping" price that includes margin
- Upsell: "Save 5% on shipping with a SendMo Balance"

### Price Cap
- Recipients set maximum they'll pay (default: $100)
- Cap applies to the display price (includes margin)
- Senders can only select rates where display price ≤ cap

---

## 4. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18 + Vite + TypeScript + Tailwind + shadcn/ui | Extracted from Loveable prototype |
| Hosting | Vercel | Auto-deploy from GitHub, preview deploys per PR |
| Backend | Supabase Edge Functions (Deno/TypeScript) | Server-side API logic |
| Database | Supabase PostgreSQL | Existing project fkxykvzsqdjzhurntgah |
| Auth | Supabase Auth | Magic link passwordless + optional Google OAuth |
| Shipping | EasyPost API | Address verification, rates, labels, tracking |
| Payments | Stripe Payment Intents | Manual capture (auth at link activation, capture at label generation) |
| Email | Resend or SendGrid | Transactional: verification OTP, label notifications, tracking |
| Storage | Supabase Storage | Label PDFs, QR codes |
| AI/ML | Anthropic Claude API | Address parsing, FAQ search, item recognition |
| Monitoring | Sentry (errors) + PostHog (analytics) | |
| CI/CD | GitHub Actions | Lint, typecheck, test, deploy |

---

## 5. Route Structure

```
/                       → Landing page (full marketing page)
/onboarding             → Recipient onboarding flow (4 steps)
/s/:shortCode           → Sender flow (5 steps)
/dashboard              → Authenticated recipient dashboard
/faq                    → FAQ & Help page
/admin                  → Admin reporting (internal)
/label-test             → Backend test harness (internal)
/*                      → 404 Not Found
```

---

## 6. Design System

### Brand Identity
- **Name**: SendMo
- **Aesthetic**: Clean, trustworthy, blue accents. Premium but approachable.
- **Typography**: Inter (400, 500, 600, 700)
- **Border radius**: 16px (rounded-2xl) on cards, 12px (rounded-xl) on buttons
- **Page backgrounds**: `bg-gradient-to-b from-background to-muted/50`

### Color System
- **Primary**: HSL 214 89% 52% (SendMo brand blue)
- **Success**: HSL 142 71% 45% (green for verified/delivered)
- **Destructive**: HSL 0 72% 51% (red for errors)
- **Speed tier colors**:
  - Economy: Emerald (bg-emerald-50, border-emerald-300, text-emerald-700)
  - Standard: Blue (bg-blue-50, border-blue-300, text-blue-700)
  - Express: Amber (bg-amber-50, border-amber-300, text-amber-700)

### Component Patterns

**Cards**: `bg-card rounded-2xl border border-border shadow-sm p-5`

**Selection cards (selected)**: Color varies by type (see speed tier colors above). Default: `border-primary bg-primary/5`

**Selection cards (unselected)**: `border-border hover:border-muted-foreground/30`

**Segmented toggles**: `Container: flex gap-1 bg-muted rounded-xl p-1` / Selected: `bg-card text-foreground rounded-lg shadow-sm` / Unselected: `text-muted-foreground`

**Primary buttons**: `rounded-xl shadow-sm` — landing page CTA: `text-lg py-4 px-8 shadow-md`

**Radio dots**: `w-4 h-4 rounded-full border-2` / Selected: `border-primary` with inner `w-2 h-2 rounded-full bg-primary`

**Info notes**: `bg-muted rounded-xl px-4 py-3 text-xs text-muted-foreground`

**Verified badge**: `text-success bg-success/10 rounded-xl px-3 py-2` + CheckCircle2 icon

**Validation error summary**: `rounded-xl border border-destructive/50 bg-destructive/5 px-4 py-3` — lists all issues above the Continue button

**Field error**: `border-destructive` + "Required" label at top-right of card

### Validation Pattern

SendMo uses **"try-then-show"** validation: user clicks Continue → `tried` flag set → field-level red borders + "Required" labels appear → validation summary block animates in above the button listing all issues. See Loveable PRD v2 Section 9 for per-step validation details.

### Animation Patterns (Framer Motion)

- **Step transitions**: `AnimatePresence mode="wait"` — `initial={{ opacity: 0, x: 20 }}` / `animate={{ opacity: 1, x: 0 }}` / `exit={{ opacity: 0, x: -20 }}` / `duration: 0.25`
- **Verified addresses**: `initial={{ opacity: 0, y: 4 }}` / `animate={{ opacity: 1, y: 0 }}`
- **Price updates**: `animate={{ scale: [1, 1.02, 1] }}` on cost cards
- **Selection feedback**: `whileTap={{ scale: 0.98 }}` on selectable cards

---


## 7. Recipient Onboarding Flow (/get-started)

### Step Numbering

The flow uses numeric step IDs for branching:
- `0` = Path Choice
- `1` = Address + Email (shared by both paths)
- `10-12` = Full Label path (Shipment Details -> Payment -> Label)
- `20-23` = Flexible Link path (Shipping Prefs -> Email Verify -> Payment -> Link Activated)

### Component File Structure

```
src/components/recipient/
  RecipientStepPathChoice.tsx      # Step 0: Full vs Flexible
  RecipientStepAddress.tsx          # Step 1: Address + email (shared)
  RecipientStepFullShipping.tsx     # Full path: shipment details (Step 10)
  RecipientStepShipping.tsx         # Link path: shipping prefs (Step 20)
  RecipientStepVerify.tsx           # Link path: OTP email verify (Step 21)
  RecipientStepPayment.tsx          # Payment + activated state (Steps 11/12/22/23)
```

### Progress Bar (4 visual steps, varies by path)

| Path | Step 1 | Step 2 | Step 3 | Step 4 |
|------|--------|--------|--------|--------|
| **Full Label** | Destination (MapPin) | Shipment Details (Package2) | Payment (CreditCard) | Label & Link (Tag) |
| **Flexible Link** | Destination (MapPin) | Shipping Info (Sliders) | Payment & Verification (CreditCard) | Label & Link (Tag) |

Steps are clickable to navigate back to completed steps (but not forward).

### Step 0: Path Choice
**Component**: `RecipientStepPathChoice.tsx` -- Step ID: `0`

Two large selection cards with `whileTap={{ scale: 0.98 }}`:

| Option | Icon | Title | Badge | Subtitle |
|--------|------|-------|-------|----------|
| Full prepaid label | Package2 | "Full prepaid label" | "Recommended" (blue pill) | "I know exactly what's being shipped" |
| Flexible shipping link | Link2 | "Flexible shipping link" | -- | "Details will be filled in by the sender" |

Each card has 4 bullet points explaining the path.

### Step 1: Destination & Email (Shared)
**Component**: `RecipientStepAddress.tsx` -- Step ID: `1`

- Freeform address input with auto-verification (mock: length > 15 chars; production: EasyPost API)
- Green verified badge with CheckCircle2 icon
- Email input for verification in next step
- **Validation**: Red borders + "Required" labels + summary block above button
- **Button**: "Continue to shipping preferences"

---

### FULL LABEL PATH (Steps 10-12)

#### Step 10: Shipment Details
**Component**: `RecipientStepFullShipping.tsx`

The most complex step -- collects all package details to compute an exact shipping price.

**Layout (top to bottom)**:

1. **Sticky destination + cost card** (pinned to top on scroll):
   - "Shipping to [address]" with "Change" link
   - Large price in primary blue (or "Complete details to see cost")
   - Arrival estimate with day name + date
   - Price animates with `scale: [1, 1.02, 1]`

2. **Ship from (sender's address)** -- Text input with address auto-verification

3. **Magic Guestimator** -- AI-powered form pre-filler:
   - Textarea: "Skis in a large box, shipped slow and affordably"
   - "Guestimate it" button with sparkle icon
   - Parses keywords to auto-fill packaging, dimensions, weight, shipping method
   - Supported: laptop, phone, book, clothes, skis, shoes, document, headphones, tablet, poster, wine
   - Urgency: "urgent"/"rush" -> express; "next week"/"soon" -> standard; "cheapest"/"no rush" -> economy

4. **Item description** -- Optional text input

5. **Packaging type** -- 3-option grid: Box/Rigid (default), Envelope/Soft Pack, Tube/Irregular

6. **Package dimensions** -- L x W x H (Height hidden for envelopes)

7. **Package weight** -- Pounds + Ounces

8. **Shipping method** -- Grid of 8 carrier x speed combinations:
   - USPS: Ground Advantage (Economy), Priority Mail (Standard), Priority Express (Express)
   - UPS: Ground (Economy), 3 Day Select (Standard), 2nd Day Air (Express)
   - FedEx: Home Delivery (Economy), 2Day (Express)
   - Color-coded speed tier tags: green=economy, blue=standard, amber=express

9. **Insurance** -- Toggle card: "Add shipping insurance" (+$2.50, covers up to $100)

**Price computation (mock)**:
```
dimWeight = (L x W x H) / 166
billableWeight = max(totalLbs, dimWeight)
base = 5 + billableWeight x 1.8 + (L + W + H) x 0.05
final = base x carrier_multiplier (1.0-1.8) + insurance ($2.50 if selected)
```
**Production**: Replace with EasyPost Rate API.

**Validation**: Ship from address, all dimensions, weight, shipping method, computed price -- all required. Summary block lists up to 6 issues.

#### Step 11: Payment (Full Label)
**Component**: `RecipientStepPayment.tsx` -- Step ID: `11`

- **Shipment summary card**: To, From, Service, Est. delivery, Package type + dimensions + weight, Total charge (exact price, large blue text)
- **Payment form** (tabbed: Credit Card / SendMo Balance)
- **No insurance toggle** here (already selected in Step 10)
- **CTA**: "Pay & generate label" -- charges card immediately (not a hold)

**Full Label Payment Flow**:
1. Recipient completes details -> exact price calculated
2. Stripe charges card immediately (PaymentIntent with immediate capture)
3. Label PDF generated via EasyPost
4. Recipient downloads/shares label

#### Step 12: Label & Link Ready (Full Label)
**Component**: `RecipientStepPayment.tsx` with `isActivated=true` -- Step ID: `12`

- Title: "Your shipping label and link are ready"
- **View/download/print card** -- "View label" + "Download PDF" buttons
- **Share link card** -- Copyable sendmo.co/s/... link
- **Shipment details card** -- To, From, Speed, Distance, Estimated cost, Protection status
- **CTA**: "Go to your account page" -> `/dashboard`

---

### FLEXIBLE LINK PATH (Steps 20-23)

#### Step 20: Shipping Preferences (REDESIGNED 2026-02-24)
**Component**: `RecipientStepShipping.tsx`

**Layout (top to bottom)**:

1. **Destination display** -- Shows verified address with MapPin icon

2. **Distance selector** -- 3 radio-style cards:
   - Nearby ("Same state / neighbor state", <300 mi, Zones 1-3)
   - **Regional** ("Same half of the country", 300-1,000 mi, Zones 4-5) <- DEFAULT
   - Cross-country ("Coast to coast", 1,000+ mi, Zones 6-8)

3. **Package size hint** -- 3 optional tile buttons (toggle on/off, deselectable):
   - Padded envelope (Under 1 lb)
   - Small box (2-5 lbs)
   - Large / heavy box (10-25 lbs)
   - **These are hints, not constraints.** Sender is never limited.

4. **Speed tier selection** -- 3 expandable cards, Standard pre-selected:
   - Economy (emerald accent) -- cost range, delivery window, carrier
   - Standard (blue accent) -- DEFAULT
   - Express (amber accent)
   - All update dynamically based on distance + size selections

5. **"See detailed rate estimates"** link -> bottom-sheet modal with full rate matrix (distance toggleable within modal)

6. **Context notes** -- "Prices are estimates and may vary...", "Your card is not charged..."

7. **Buttons**: "Back" / "Continue" / "Skip, use defaults" (ghost)

**Skip behavior**: Sets defaults: distance=regional, size=unsure, speed=standard, carrier=any, insurance=none

**Data interface**:
```typescript
interface ShippingConfig {
  distance: "nearby" | "regional" | "cross";
  size: "envelope" | "smallbox" | "largebox" | null;
  speed: "economy" | "standard" | "express";
  priceCap: number; // default 100
}
```

#### Step 21: Email Verification (Flexible Link only)
**Component**: `RecipientStepVerify.tsx` -- Step ID: `21`

- Current email in muted box with "Use different email" button
- 5-digit OTP input (auto-verifies; mock: any 5 digits succeeds)
- "Resend code" button with loading state
- Green verified badge on success
- Continue button disabled until verified

#### Step 22: Payment & Activation (Flexible Link)
**Component**: `RecipientStepPayment.tsx` -- Step ID: `22`

- **Estimated cost summary**: cost range ($X - $Y) with hold amount explanation
- **Payment form** (tabbed: Credit Card / SendMo Balance)
- **Insurance toggle** (3-option segmented: Off / $100 coverage / $300 coverage)
  - Insurance costs: none=$0, $100=+$3, $300=+$5
  - Dynamically updates cost range and hold amount
- **CTA**: "Add payment & activate label link"

**Hold Calculation**:
```
adjustedHigh = highRange + insuranceCost
holdAmount = adjustedHigh x 1.10 (rounded)
discounted = amount x 0.95 (for Balance tab)
```

**Flexible Link Payment Flow**:
1. Recipient sets preferences -> estimated cost range
2. Stripe creates authorization hold (manual capture) at 110% of high range + insurance
3. Sender uses link later -> enters package -> rates fetched -> label purchased
4. Stripe captures actual amount, excess hold released

#### Step 23: Link Activated (Flexible Link)
- Title: "Your label link is active!"
- **Share link card** -- Copyable link with QR code
- **Shipment details card**: Speed, Distance, Estimated cost, Protection status
- **CTA**: "Go to your account page" -> `/dashboard`

---

### 7.1 Rate Tables (Flexible Link Path)

2026 commercial pricing via EasyPost + 15% SendMo margin.

**Padded envelope (Under 1 lb):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-3 days, $5-6, USPS Ground Advantage | 1-2 days, $8-10, USPS Priority Mail | Next day, $28-30, USPS Priority Express |
| Regional | 3-4 days, $6-7, USPS Ground Advantage | 2-3 days, $9-12, USPS Priority Mail | 1-2 days, $29-32, USPS Priority Express |
| Cross-country | 4-5 days, $7-9, USPS Ground Advantage | 2-3 days, $11-14, USPS Priority Mail | 1-2 days, $30-34, USPS Priority Express |

**Small box (2-5 lbs):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-4 days, $7-10, USPS Ground / UPS Ground | 1-3 days, $10-14, USPS Priority Mail | 1-2 days, $32-42, UPS 2nd Day Air |
| Regional | 3-5 days, $10-15, USPS Ground / UPS Ground | 2-3 days, $14-19, USPS Priority Mail | 1-2 days, $36-48, FedEx 2Day |
| Cross-country | 5-7 days, $14-20, UPS Ground / FedEx Ground | 2-3 days, $18-24, USPS Priority Mail | 1-2 days, $42-56, FedEx 2Day |

**Large / heavy box (10-25 lbs):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-4 days, $14-20, UPS Ground | 1-3 days, $18-26, USPS Priority Mail | 1-2 days, $48-68, UPS 2nd Day Air |
| Regional | 3-5 days, $20-30, UPS Ground / FedEx Ground | 2-3 days, $26-38, USPS Priority Mail | 1-2 days, $58-82, FedEx 2Day |
| Cross-country | 5-7 days, $28-40, UPS Ground / FedEx Ground | 2-3 days, $34-48, USPS Priority Mail | 1-2 days, $72-100, FedEx 2Day |

**Default (no size selected):**

| Distance | Economy | Standard | Express |
|----------|---------|----------|---------|
| Nearby | 2-5 days, $5-20 | 1-3 days, $8-26 | 1-2 days, $28-68 |
| Regional | 3-5 days, $6-30 | 2-3 days, $9-38 | 1-2 days, $29-82 |
| Cross-country | 4-7 days, $7-40 | 2-3 days, $11-48 | 1-2 days, $30-100 |

---

## 8. Sender Flow (/send/:linkId)

5-step linear wizard. Sender never pays. Progress bar is NOT clickable.

### Step 0: Intro
- Badge: "SendMo Label Link"
- Title: "You're sending a package to {recipientName}"
- Insurance banner (conditional): green badge if recipient enabled protection
- How it works: 3 numbered steps in styled cards
- **CTA**: "Get Started"

### Step 1: Origin & Package Details
- **Destination display** -- "Shipping to {recipientName} -- {address}"
- **Ship from** -- Address input with auto-verification
- **Sendmo Package Guestimator** -- Same AI pre-filler as full label path
- **Item description** -- Optional
- **Packaging type** -- 3-option grid (Box, Envelope, Tube)
- **Package dimensions** -- L x W x H
- **Package weight** -- Pounds + Ounces
- **Validation**: Same try-then-show pattern. Red borders, "Required" labels, summary list.
- **CTA**: "See rates"

### Step 2: Choose Shipping Method
- Radio-style cards: carrier + service + delivery estimate
- **No pricing shown** (recipient pays)
- "Preferred by {recipientName}" badge on methods matching recipient's speed tier
- Default selection: first method matching `standard` speed tier
- **Rate Filtering (Production)**: Methods filtered by recipient's speed preference, price cap, and distance. Methods exceeding cap shown disabled.
- **CTA**: "Continue"

### Step 3: Review & Confirm
- **Package summary** card with "Edit" button -> back to step 1
- **Shipping method** card with "Edit" button -> back to step 2 (includes insurance status)
- **Email input** for tracking updates
- **Checkboxes**: "Save my information" (checked), "Share contact info" (unchecked)
- **CTA**: "Confirm and generate label" -> AlertDialog confirmation
- **Validation**: Email format validated inline if entered

### Step 4: Label Ready
- **Success banner** -- Green with CheckCircle2: "Label ready!"
- **Label preview** -- Dark header, FROM/TO addresses, service + price, tracking #
- **Print CTA**: "Print Label (PDF)" -- largest button in the app
- **Drop-off instructions** -- Carrier location info, package attachment reminder
- **Label printing CSS**: 4x6 thermal label support (`@page { size: 4in 6in; margin: 0; }`)

---

## 9. Dashboard (/dashboard)

### My Label Link
- Link URL with Copy button (primary), preference pills (Destination, Speed, Distance, Price cap, Insurance)
- **Preferences dialog** (gear icon): editable Speed, Distance, Package hint, Price cap, Insurance -- all using same UI components as Step 20
- **Link management**: Copy, Deactivate/Reactivate, Edit preferences
- "+ New Link" button (Post-MVP: multiple links)

### My Wallet
- Payment method display (Visa ...4242, brand, expiry)
- Balance display ($0.00)
- **Management**: Add card (Stripe Elements Setup Intent), Remove card, View balance
- Expandable dialog with "Add Balance" and "Edit Methods"

### Shipments Table
- Columns: ID, From, Location, Status, Carrier, Amount, Created, Shipped, ETA, Tracking
- Status badges (pill-shaped):
  - Label Created: purple
  - In Transit: blue
  - Delivered: green

---

## 10. FAQ & Help (/faq)

- Prominent search bar with real-time filtering
- 10 accordion FAQ items (what is SendMo, who pays, revenue model, privacy, carriers, price caps, dimension adjustments, international, tracking, cancellation)
- Contact support card (email link to support@sendmo.com)
- Production: pgvector semantic search, search analytics, contact form

---

## 11. API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/addresses/verify` | Verify address | No |
| POST | `/api/links` | Create new SendMo link | Yes |
| GET | `/api/links/:shortCode` | Get link details (sender view) | No |
| PATCH | `/api/links/:id` | Update link preferences | Yes |
| POST | `/api/rates` | Get shipping rates for package | No |
| POST | `/api/labels` | Purchase label and generate PDF | No (link auth) |
| POST | `/api/payments/authorize` | Create Stripe payment intent | Yes |
| POST | `/api/payments/capture` | Capture authorized payment | Internal |
| POST | `/api/cancel-label` | Void an unused label | Admin |
| POST | `/api/email/verify` | Send OTP verification email | No |
| POST | `/api/email/verify/confirm` | Confirm OTP code | No |
| POST | `/api/webhooks/stripe` | Stripe webhook handler | Webhook sig |
| POST | `/api/webhooks/easypost` | Shipping tracking webhook | Webhook sig |

---

## 12. Database Schema

### Core Tables

```sql
-- Users (extends Supabase auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Addresses
CREATE TABLE addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  street1 TEXT NOT NULL, street2 TEXT,
  city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL,
  country TEXT DEFAULT 'US',
  verified BOOLEAN DEFAULT false,
  easypost_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SendMo Links (supports both full label and flexible link)
CREATE TABLE sendmo_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) NOT NULL,
  short_code TEXT UNIQUE NOT NULL,
  destination_address_id UUID REFERENCES addresses(id),
  link_type TEXT NOT NULL CHECK (link_type IN ('full_label', 'flexible_link', 'shipping_and_escrow')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paused', 'deactivated')),
  -- Flexible link preferences
  speed_preference TEXT DEFAULT 'standard',
  distance_preference TEXT DEFAULT 'regional',
  size_hint TEXT,
  price_cap NUMERIC DEFAULT 100,
  carrier_preference TEXT DEFAULT 'any',
  insurance TEXT DEFAULT 'none' CHECK (insurance IN ('none', '100', '300')),
  -- Full label details (if link_type = 'full_label')
  origin_address_id UUID REFERENCES addresses(id),
  package_type TEXT, length NUMERIC, width NUMERIC, height NUMERIC,
  weight_lbs NUMERIC, weight_oz NUMERIC,
  shipping_method TEXT, exact_price NUMERIC, label_pdf_url TEXT,
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Shipments
CREATE TABLE shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID REFERENCES sendmo_links(id) NOT NULL,
  sendmo_id TEXT UNIQUE NOT NULL,
  sender_name TEXT, sender_email TEXT,
  origin_address_id UUID REFERENCES addresses(id),
  carrier TEXT, service TEXT,
  tracking_number TEXT, easypost_shipment_id TEXT, easypost_tracker_id TEXT,
  status TEXT NOT NULL DEFAULT 'label_created'
    CHECK (status IN ('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'return_to_sender', 'cancelled')),
  is_test BOOLEAN NOT NULL DEFAULT false,
  -- Refund/cancellation tracking (migration 002)
  refund_status TEXT NOT NULL DEFAULT 'none'
    CHECK (refund_status IN ('none', 'submitted', 'refunded', 'rejected', 'not_applicable')),
  refund_submitted_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  carrier_refund_id TEXT,
  -- Financials
  shipping_cost NUMERIC, insurance_cost NUMERIC DEFAULT 0, total_charged NUMERIC,
  label_pdf_url TEXT,
  shipped_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, eta TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Payments
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) NOT NULL,
  shipment_id UUID REFERENCES shipments(id),
  link_id UUID REFERENCES sendmo_links(id),
  stripe_payment_intent_id TEXT,
  amount NUMERIC NOT NULL, hold_amount NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'authorized', 'captured', 'refunded', 'failed')),
  payment_method TEXT CHECK (payment_method IN ('card', 'balance')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- SendMo Balance (Post-MVP)
CREATE TABLE balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) UNIQUE NOT NULL,
  amount NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Webhook idempotency
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now(),
  payload JSONB
);

-- PHASE 3: ESCROW & MARKETPLACE (Conceptual Modeling)
-- Money transmission requires strict double-entry or append-only ledgering.
-- These tables represent future architectural additions to support "shipping_and_escrow" links.

-- CREATE TABLE escrows (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   shipment_id UUID REFERENCES shipments(id),
--   amount NUMERIC,
--   currency VARCHAR(3) DEFAULT 'USD',
--   status TEXT CHECK (status IN ('pending', 'funded', 'held_in_transit', 'dispute_opened', 'released', 'refunded', 'frozen_fraud')),
--   risk_score NUMERIC,
--   funded_at TIMESTAMPTZ, released_at TIMESTAMPTZ, disputed_at TIMESTAMPTZ
-- );

-- CREATE TABLE disputes (
--   id UUID PRIMARY KEY,
--   escrow_id UUID REFERENCES escrows(id),
--   opened_by UUID REFERENCES profiles(id),
--   reason TEXT,
--   status TEXT CHECK (status IN ('open', 'under_review', 'resolved_buyer', 'resolved_seller')),
--   evidence_urls JSONB,
--   resolution_notes TEXT
-- );

-- CREATE TABLE transactions (
--   -- Immutable ledger for all money transmission (funding, release, fees, dispute holding)
--   id UUID PRIMARY KEY,
--   escrow_id UUID REFERENCES escrows(id),
--   type TEXT CHECK (type IN ('hold', 'release', 'fee_deduction', 'refund')),
--   amount NUMERIC,
--   created_at TIMESTAMPTZ DEFAULT now()
-- );
```

### RLS Policies
- Users read/write own profiles, addresses, links, payments
- Shipments readable by link owner (recipient) AND sender (via short_code)
- Links publicly readable (for sender flow), writable only by owner

---

## 13. Payment System

### Full Label Flow
1. Recipient completes shipment details -> exact price
2. Stripe charges card immediately (PaymentIntent, immediate capture)
3. EasyPost generates label PDF
4. Recipient downloads/shares

### Flexible Link Flow
1. Recipient sets preferences -> estimated range
2. Stripe authorization hold at 110% of high range + insurance (manual capture)
3. Sender uses link -> enters package -> rates fetched
4. Label purchased at actual cost -> Stripe captures actual amount
5. Excess hold released automatically

### SendMo Balance (Post-MVP)
- Pre-loaded wallet via card or ACH (Plaid)
- 5% discount on all shipments
- Balance deducted instead of card charged

---

## 13.1 Label Void & Refund Policy

SendMo allows labels to be voided before the package has been picked up and scanned by the carrier. All refund policies are presented under SendMo branding — carrier names are never surfaced to users.

### Eligibility

| Condition | Eligible? |
|-----------|----------|
| Label printed, not yet scanned | ✅ Yes |
| Package in transit | ❌ No |
| Package delivered | ❌ No |
| Previous void already submitted | ❌ No |
| USPS labels | Within 30 days of creation |
| UPS / FedEx labels | Within 90 days of creation |

### Refund Process

1. Admin (or user, post-MVP) initiates void from `/admin` Actions column
2. `CancelLabelModal` shows shipment details + SendMo refund policy (no carrier branding)
3. Click **"Void Label"** → calls `POST /api/cancel-label`
4. Edge function validates eligibility, submits void to carrier
5. `shipments.status` → `cancelled`, `refund_status` → `submitted`
6. Refund credited to SendMo account within **2–4 weeks** after carrier confirmation
7. Credit appears as SendMo account balance (not original payment method in Phase 1)

### Refund Status Values

| Status | Meaning | UI Label |
|--------|---------|----------|
| `none` | No void requested | — |
| `submitted` | Void submitted, awaiting carrier | "Refund Pending" (blue) |
| `refunded` | Carrier confirmed, credit issued | "Refunded" (green) |
| `rejected` | Carrier rejected (label was used) | "Refund Rejected" (red) |
| `not_applicable` | Label type not refundable | "Not Eligible" |

### Admin Void UI (`/admin`)

- **Actions column** in admin table shows **"Void"** button for eligible labels
- Button is **disabled** (with tooltip) for in-transit, delivered, cancelled, or already-voided labels
- **CancelLabelModal**: 4-state dialog (confirm → loading → success/error)
- On success: row updates optimistically to show "Cancelled" status + "Refund Pending" badge

### Future: User-Facing Void (Post-MVP)

- Dashboard Shipments table will show a "Void Label" action for eligible labels
- Same backend (`cancel-label` function) — just a different UI entry point
- Stripe refund to original card will be added in this phase (currently admin-only, credit to balance)

---

## 14. Security Requirements

- **HTTPS** enforced on all routes
- **Stripe Elements** for PCI compliance (never handle raw card numbers)
- **Input validation**: Client-side (Zod) + server-side (Edge Function)
- **Address privacy**: Recipient address only on printed label, never in sender UI text
- **OTP**: 5-digit codes, 10-minute expiry, rate-limited to 3 attempts
- **RLS**: All database access scoped to authenticated user
- **Webhook signatures**: Verify Stripe and EasyPost webhook authenticity
- **Short codes**: Cryptographically random, 10-char alphanumeric (no ambiguous 0/O, 1/I/l), UNIQUE constraint + retry on collision
- **CORS**: Restrict to production domains
- **CSRF**: Supabase Auth tokens in headers (not cookies)

### Rate Limits

| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| `POST /api/email/verify` | 3 req | 10 min | IP + email |
| `POST /api/email/verify/confirm` | 5 attempts | 10 min | IP + email |
| `POST /api/addresses/verify` | 20 req | 1 min | IP |
| `POST /api/rates` | 10 req | 1 min | IP |
| `POST /api/labels` | 5 req | 1 min | IP + link_id |
| `POST /api/links` | 3 req | 1 hour | user_id |
| `GET /api/links/:shortCode` | 30 req | 1 min | IP |

---

## 15. Webhook Processing

### EasyPost Tracking Webhook
Endpoint: `POST /api/webhooks/easypost`
- Verify signature -> extract tracking_code + status -> map to shipment status:
  - `in_transit` -> `in_transit` + send email
  - `out_for_delivery` -> `in_transit` + send email
  - `delivered` -> `delivered` + trigger payment capture (flexible link) + send email
  - `return_to_sender` -> `returned` + initiate refund
- Respond 200 OK (even on processing errors to prevent retries)

### Stripe Webhook
Endpoint: `POST /api/webhooks/stripe`
- `payment_intent.succeeded` -> update payments.status, send receipt
- `payment_intent.payment_failed` -> update status, send failure notification
- `charge.refunded` -> update status, send refund confirmation
- Idempotency via `webhook_events` table

---

## 16. Email Notifications

| Email | Trigger | Recipients |
|-------|---------|-----------|
| OTP Verification (5-digit, 10-min expiry) | Email verification step | Recipient |
| Link Activated | Payment authorized | Recipient |
| Label Created | Sender prints label | Recipient + Sender |
| In Transit | EasyPost webhook | Recipient + Sender |
| Out for Delivery | EasyPost webhook | Recipient |
| Delivered | Final delivery scan | Recipient + Sender |
| Payment Receipt | Payment captured | Recipient |

---

## 17. Authentication

- **Primary**: Magic link (passwordless) via Supabase Auth
- **Account creation**: Automatic during onboarding (after email verify + payment)
- **Returning users**: Email -> magic link -> `/dashboard`
- **Session**: JWT access + refresh tokens, auto-refresh via Supabase client
- **Protected routes**: `/dashboard` requires auth, redirects to `/` if unauthenticated
- **Senders**: No account needed. Optional email for tracking stored in `shipments.sender_email`. "Save my info" stores in `localStorage`.

---

## 18. Mobile & Accessibility

- All flows `container max-w-2xl` -- naturally responsive
- Progress labels hidden on mobile (`hidden sm:inline`)
- Rate modal: `Drawer` on mobile, `Dialog` on desktop
- Touch targets: 44x44px minimum
- `inputMode="numeric"` for dimensions/weight
- `prefers-reduced-motion` respected
- WCAG AA color contrast
- Label printing: 4x6 thermal support

---

## 19. Success Metrics

| Metric | Target |
|--------|--------|
| Time to first link | < 60 seconds |
| Onboarding completion rate | > 60% |
| Sender completion rate (click -> print) | > 70% |
| Payment failure rate | < 5% |
| Revenue (SendMo margin) | 15% standard, 10% with balance |

---

## 20. Phased Execution

### Phase 0: Foundation (Week 1)
- Fresh GitHub repo (sendmo-app), extract Loveable components
- Vercel deploy, sendmo.co domain
- Supabase schema migration (all tables + RLS)
- CLAUDE.md for Claude Code, GitHub Actions CI/CD

### Phase 1: Core Shipping MVP (Weeks 2-4)
- Both recipient paths (Full Label + Flexible Link) with real APIs
- Supabase Auth (magic link)
- AI address parsing + Magic Guestimator Edge Functions
- Stripe: immediate charge (full label) + auth/capture (flexible link)
- EasyPost: address verify, rate shopping, label generation, tracking webhooks
- Email notifications (OTP, label, tracking)
- Dashboard (shipments, links, wallet, preferences)
- FAQ with semantic search

### Phase 2: Payments, Trust & AI (Weeks 5-7)
- Rate adjustment handling, AI shipping advisor
- Google OAuth, saved sender profiles
- Sentry + PostHog integration
- Security hardening, abuse prevention

### Phase 3: Scale, Marketplace & Escrow (Weeks 8+)
- SendMo Balance / prepaid wallet (Plaid ACH)
- **Escrow Service / Trust Platform**: Allow recipients to fund an item (`escrow_amount`) in addition to shipping costs. Held funds released on delivery scan.
- **Money Transmission Compliance**: KYC/AML integration (`identity_verified`), append-only ledger `transactions` tracking, and 1099-K tax reporting (`total_volume_processed`).
- **Dispute Resolution Flow**: UI for buyers to freeze/dispute funds upon delivery, and Admin panel to mediate `disputes` & view `risk_score` / `frozen_fraud` events.
- Multiple links per user
- International shipping
- Private shipment links (QR code)
- Admin dashboard expansion (financial observability)

---

## 21. Development Workflow

### Tool Roles
- **Loveable**: Visual reference prototype only (sendmo.lovable.app) — not used for production code
- **Claude.ai**: Strategy, architecture, PRDs, design decisions
- **Claude Code**: All production code — frontend, Edge Functions, DB migrations, tests
- **GitHub**: Single source of truth
- **Vercel**: Auto-deploys from GitHub

### File Ownership
- Claude Code owns all production code (`/src`, `/supabase`, `/tests`)
- Loveable prototype is reference only — do not extract code from it

---

## 22. AI Item Recognition (Magic Guestimator)

### Overview

Allow users to describe an item (text) or upload a photo, and AI will automatically estimate package dimensions, weight, and suggest the best shipping method. This powers the "Magic Guestimator" feature in both the Full Label path (Step 10) and Sender flow (Step 1).

### User Flows

**Text description**: User types "iPhone 14 Pro in original box" → AI returns dimensions (6.5×3.5×2"), weight (12 oz), suggested packaging (Small Box), fragility flag, carrier recommendation.

**Photo upload** (Phase 2): User uploads photo → AI vision model analyzes → returns size/weight estimates.

**Combined** (Phase 2): Text + photo for higher accuracy.

### API Specification

```
POST /api/ai/analyze-item
```

**Request**:
```typescript
{
  description?: string;
  imageUrl?: string;        // Phase 2
  imageBase64?: string;     // Phase 2
  userHints?: {
    approximateWeight?: number;
    approximateSize?: string;
  }
}
```

**Response**:
```typescript
{
  success: boolean;
  data: {
    itemCategory: string;           // "Electronics > Mobile Phone"
    itemName: string;               // "iPhone 14 Pro"
    confidence: number;             // 0-1
    estimatedDimensions: { length: number; width: number; height: number; unit: "in" };
    estimatedWeightOz: number;
    suggestedPackageSize: "envelope" | "small" | "medium" | "large";
    fragile: boolean;
    fragileReason?: string;
    requiresSignature: boolean;
    insuranceRecommended: boolean;
    recommendedCarriers: Array<{ carrier: string; service: string; reason: string }>;
    warnings?: string[];
  };
}
```

### Implementation Strategy (Hybrid — MVP)

1. **Common items database** — Pre-loaded dimensions for top 100 shipped items (iPhone, MacBook, t-shirt, etc.). Fast lookup, zero cost.
2. **Claude API fallback** — For items not in the database, use Anthropic Claude API for text analysis (Phase 1) and vision analysis (Phase 2).

```typescript
async function analyzeItem(description: string, imageUrl?: string) {
  const commonItem = await checkCommonItems(description);
  if (commonItem && commonItem.confidence > 0.9) return commonItem;
  return await callClaudeAPI(description, imageUrl);
}
```

### Confidence Indicators

| Level | Threshold | UI |
|-------|-----------|-----|
| High | >0.8 | ✅ "We're confident about these estimates" |
| Medium | 0.5-0.8 | ⚠️ "Please verify these estimates" |
| Low | <0.5 | ❌ "Please enter details manually" |

### Cost Analysis

- Common item lookup: $0 (cached)
- Claude API text: ~$0.001 per request
- Claude API vision: ~$0.01 per image (Phase 2)
- At 10K labels/month, 30% using AI: **~$17/month**

### Phased Rollout

- **Phase 1 (MVP)**: Text-only Guestimator with common items DB + Claude API
- **Phase 2**: Photo upload + Claude Vision
- **Phase 3**: Learning from actual shipments (estimate vs. actual feedback loop)
- **Phase 4**: Marketplace-specific models (eBay, Poshmark, FBMP)

---

## 23. Logging & Observability

### Overview

SendMo uses a **structured event log** in Supabase (`event_logs` table) as a debugging knowledge base. It is written by Edge Functions during every significant operation, and queryable via the Supabase SQL editor.

**Today scope:** Debugging agents and developers can query `event_logs` with plain SQL to answer investigation questions without reading raw logs.

**Future scope (Phase 2):** When production volume justifies it, export to ClickHouse for clickstream analytics, funnel analysis, and throughput testing.

### Data Model

| Column | Type | Purpose |
|--------|------|---------|
| `event_type` | TEXT | e.g. `address.verified`, `label.created` |
| `session_id` | TEXT | Client-generated UUID; primary debug join key |
| `actor_id` | UUID | Supabase user_id (null for anonymous senders) |
| `entity_type` | TEXT | `address` \| `rate` \| `label` \| `shipment` |
| `entity_id` | TEXT | EasyPost ID or Supabase UUID |
| `severity` | TEXT | `info` \| `warn` \| `error` |
| `source` | TEXT | `edge_fn` \| `webhook` \| `frontend` |
| `duration_ms` | INT | External API call latency |
| `properties` | JSONB | All structured debug fields |

### Event Sources (Phase 1)

| Edge Function | Events Emitted |
|---|---|
| `addresses` | `address.verified`, `address.soft_warning`, `address.hard_error`, `address.google_fallback` |
| `rates` | `rate.fetched`, `rate.no_results`, `rate.error` |
| `labels` | `label.created`, `label.buy_error`, `label.endshipper_error` |

### Retention Policy

- **`event_logs`:** 90 days (pg_cron purge job)
- **Transactional tables** (`shipments`, `payments`, etc.): indefinite

### Infrastructure

- **Write path:** Edge Functions → `_shared/logger.ts` (fire-and-forget) → `ingest` Edge Function → `event_logs` table
- **Read path:** Supabase SQL Editor (service role), no RLS
- **Migration:** `supabase/migrations/003_event_logs.sql`
- **Query guide:** See `CLAUDE.md` § Logging & Observability

### Future: ClickHouse Migration (Phase 2+)

Trigger: `event_logs` exceeds ~5M rows or analytical query latency becomes noticeable.

**Recommended path:**
1. Add pg_cron export job (every 5 min): SELECT unexported rows → POST to ClickHouse HTTP API
2. No changes to `ingest` function or Edge Function instrumentation
3. Use ClickHouse for analytics; Supabase remains write target and transactional source of truth

**ClickHouse use cases:**
- Funnel conversion analysis (step drop-off)
- Address failure pattern analysis at scale
- Carrier reliability reporting
- Throughput and load testing baseline metrics

---

## 24. Open Questions

| Question | Status |
|----------|--------|
| Private links MVP timing | Deferred to Phase 3 |
| Carrier adjustment threshold | Pending -- needs Phase 1 data |
| Multiple links per user | Phase 2+ |
| Sender-paid shipping | Post-MVP evaluation |

---

## Appendix A: Decisions Log (2026-02-24)

| Decision | Rationale |
|----------|-----------|
| Two recipient paths (Full Label + Flexible Link) | Full label for known shipments (FBMP purchase); flexible link for ongoing/unknown |
| 3 distance tiers (Nearby/Regional/Cross-country) | Zone 4-5 rates are 40-50% higher than Zone 1-3 |
| 3 package scenarios (Envelope/Small box/Large box) | Maps to physical packaging which drives cost |
| Scenarios are optional hints, not constraints | Recipient doesn't know exact package; sender can ship anything |
| Insurance on Payment step, not Shipping step | Recipient doesn't know item value at shipping step; payment-adjacent decision |
| Insurance as 3-option (Off/$100/$300) | Meaningful choice without complexity |
| Magic Guestimator for AI form pre-fill | Reduces friction for users who know what's being shipped but not packaging specs |
| Full label = immediate charge; flexible link = auth + capture | Full label has exact price; flexible has range requiring hold |
| "Skip -- use default settings" as explicit action | Defaults: Regional, Standard, $100 cap. Prevents users from feeling stuck |
| PRD as bridge document between sessions | Avoids long context; each session starts fresh with PRD upload |

## Appendix B: Archived Reference Documents

These documents are archived in `_archive/` for reference. Content has been consolidated into this PRD and CLAUDE.md:

- `_archive/spec/SPEC.md` -- Original SPEC v5 (event tracking list, wireframes)
- `_archive/spec/external-docs/easypost-*.md` -- EasyPost API references
- `_archive/spec/external-docs/stripe-*.md` -- Stripe API references
- `_archive/spec/decisions/001-data-model.md` -- Data model decisions
- `_archive/frontend/AI_FEATURE_SPEC.md` -- Full AI feature spec (merged into §22)
- `_archive/backend/` -- Deployment guides, data model docs

## Appendix C: Prototype vs Production

| Feature | Prototype (Loveable) | Production |
|---------|---------------------|------------|
| Address verification | Length check (>15 chars) | EasyPost Address API |
| Shipping rates | Hardcoded rate tables + formula | EasyPost Rate API |
| Payment processing | Mock card inputs | Stripe Elements |
| Label generation | Static preview | EasyPost Label API + PDF |
| Email verification | Any 5 digits succeeds | SendGrid OTP with expiry |
| Authentication | None (localStorage) | Supabase Auth (magic link) |
| Tracking | Static mock data | EasyPost Tracker + webhooks |
| Dashboard data | Hardcoded array | PostgreSQL + Supabase |
| Guestimator | Keyword matching | Claude API with item recognition |

---

## 22. Testing Strategy

SendMo uses a 3-tier testing pyramid to ensure code quality and prevent shipping regressions:

1. **Unit & Component Tests** (Vitest + React Testing Library)
   - Tests individual UI components, interactive user flows, and utility functions in isolation.
   - Run on every commit. Fast execution (< 10s).
   - **Agent Directive**: Whenever a new component or utility is created in `src/`, a co-located `.test.tsx` or `.test.ts` MUST be created in the `tests/unit/` directory.

2. **Integration Tests** (Node Scripts)
   - Tests the interaction between the application and external APIs (primarily EasyPost via Supabase Edge Functions).
   - Located in `tests/integration/` (e.g., `easypost-test.mjs`).

3. **End-to-End (E2E) Tests** (Playwright)
   - Tests full user journeys in a real browser environment.
   - Requires the local dev server and mocked connections to be running.
   - Located in `tests/e2e/`.

### Continuous Integration (CI/CD)

- GitHub Actions (`.github/workflows/test.yml`) ensures that the full test suite (linting, type-checking, unit, and E2E) passes on every push and pull request to the `main` branch.
- Vercel is used for deployment, but relies on GitHub Actions as the primary quality gate.

### Execution Commands

- `npm run lint` — Runs ESLint. Crucial for catching React anti-patterns.
- `npm run test:unit` — Runs all Vitest unit and component tests.
- `npm run test:coverage` — Runs Vitest with v8 coverage reporting.
- `npm run test:e2e` — Runs Playwright E2E tests (requires `npm run dev` to be active).
- You can use the agent workflow `/run-tests` to execute the full validation pipeline locally.

### Known Anti-Patterns to Avoid

- **Nested Component Definitions**: NEVER define a React component inside another component's render function or body (e.g., defining `AddressFields` inside `LabelTest`). This causes React to remount the child component on every render, leading to massive bugs like input fields losing focus on every keystroke. These bugs are caught by robust Component Interaction tests and the `react/no-unstable-nested-components` ESLint rule.
