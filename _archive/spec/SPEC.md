# SendMo Product Specification

> **Status**: Draft v5
> **Last Updated**: 2025-02-09
> **Owner**: [TBD]

---

## 1. Product Vision

**One-liner**: SendMo makes shipping between people effortless—no more exchanging addresses or figuring out shipping costs.

### Marketing Taglines
- "Get it delivered to you"
- "When you need something delivered to you"
- "Shareable shipping label links that help you get things delivered to you"
- "Make it easy for people to ship things to you — marketplace purchases, returned items, and more"

**For Senders/Sellers**:
- "Marketplace sellers: SendMo enables buyers to create and pay for the shipping label, so you can get the product out the door"

### The Problem
Shipping between individuals is unnecessarily complicated:
- Recipients have to share their address with every sender
- Senders have to figure out box sizes, carrier options, and costs
- Both parties go back and forth on shipping estimates
- Neither has visibility once the package is in transit

### The Solution
SendMo Label Links. Recipients create a link once, share it with anyone who needs to send them something. Senders click, enter package details, and print a label. Done.

**Two simple steps:**
1. Configure your shipping label link
2. Share it with the sender for them to finalize and print

### Value Proposition
1. **For Recipients**: Control over shipping—set your preferences once, share a link, receive packages. No more sending your address to everyone.
2. **For Senders**: Dead simple shipping—click a link, enter package info, print label, drop off. No address lookup, no rate shopping, no guesswork.
3. **Privacy** (secondary): Recipients can keep their address private if they choose.

---

## 2. Key Concepts

### Terminology

| Term | Definition |
|------|------------|
| **Recipient** | Person receiving the package. Creates and owns SendMo links. Pays for shipping. |
| **Sender** | Person shipping the package. Clicks the link, enters package details, prints label. |
| **SendMo Link** | A shareable URL that enables shipping to a recipient. |

### Types of SendMo Links

| Type | Description | Address Visible to Sender? |
|------|-------------|---------------------------|
| **Label Link (Flexible)** | Reusable link with default settings. Sender configures package details. | Yes (on printed label) |
| **Label Link (One-Time)** | Pre-configured for specific shipment. Fixed package size, origin area, etc. | Yes (on printed label) |
| **Private Shipment Link** | Sender gets QR code instead of label. Must drop off at carrier location. | No |

### Link Configuration

**Label Links** (both flexible and one-time) are configured by the recipient with:

**Basic Settings:**
- **Ship-to address**: Defaults to primary address (private, only shown on label)
- **Price cap**: Maximum shipping cost (default: $100)
- **Speed preference**: Economy / Standard / Express (default: most affordable)

**Advanced Settings:**
- **Let sender choose carrier**: Yes/No (default: Yes)
- **Let sender choose rate**: Yes/No (default: No — system picks cheapest within preferences)

**Flexible links** let the sender configure:
- Package dimensions and weight
- Shipping speed (within recipient's preferences)
- Carrier selection (if allowed by recipient)
- Rate selection (if allowed by recipient)

**One-time links** are pre-configured by the recipient for a specific expected shipment.

---

## 3. Target Users

### Primary: Recipients
- People who receive packages from multiple individuals
- Marketplace buyers (Facebook Marketplace, Craigslist, OfferUp)
- **Administrators & office managers** who need employees or customers to send them documents/items
- Anyone who wants a simpler way to receive shipped items

**B2B Use Case**: SendMo is effectively a **pre-paid label system** for businesses. An office manager can share their link with vendors, remote employees, or customers who need to send items to the office.

### Secondary: Senders
- Marketplace sellers
- Friends/family sending items
- Hotels returning forgotten items
- Employees/vendors sending to a business
- Anyone who needs to ship something to someone

---

## 4. Website Structure

### Key Sections

```
┌─────────────────────────────────────────────────────────────┐
│  SendMo                                      [Login] [FAQ]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. PRIMARY FLOWS (Home / Main Experience)                  │
│     - Recipient setup flow (3 screens)                      │
│     - Sender flow (via shared link)                         │
│                                                             │
│  2. "ME" SECTION (Authenticated)                            │
│     - My Shipments                                          │
│     - My Wallet (payment methods, balance)                  │
│     - My Shipping Settings (default preferences)            │
│     - My Links (manage flexible/one-time links)             │
│                                                             │
│  3. FAQ                                                     │
│     - Searchable FAQ with analytics                         │
│     - Contact Us                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### FAQ Section

**Key Questions to Answer:**
- Who pays for shipping?
- How does SendMo make money?
- How do I make sure the item gets delivered?
- What if the sender enters wrong package dimensions?
- Can I get a refund?
- What carriers do you support?

**FAQ Search & Analytics:**
- Search bar at top of FAQ
- Track all search queries (even if no results)
- Log which questions users click on
- Identify gaps: "What are people searching for that we don't answer?"
- Weekly report of top unanswered searches

**Contact Us:**
- Displayed when search yields no results
- Simple form: email, subject, message
- "Didn't find what you need? Contact us"
- Log all contact requests for FAQ improvement

---

## 5. MVP Scope

### Geographic & Carrier Scope
- **US only** (domestic shipments)
- **Carriers**: USPS, UPS, FedEx only

### Core Features

#### SendMo Links
- [x] **Flexible Label Links** (reusable, shareable)
- [ ] **One-Time Label Links** (pre-configured for specific shipment)
- [ ] **Private Shipment Links** (QR code, no address exposure) — requires USPS Label Broker API or UPS Returns API

#### Recipient Account ("Me" Section)
- [ ] Magic link authentication (email-based, passwordless)
- [ ] Optional: Add Google login or password later
- [ ] My Shipments (history + tracking)
- [ ] My Wallet (payment methods, future: balance)
- [ ] My Shipping Settings (default preferences)
- [ ] My Links (manage all links)

#### Sender Experience
- [ ] No account required
- [ ] Enter origin address (saved for return visits)
- [ ] Enter package dimensions/weight
- [ ] See shipping options within recipient's preferences
- [ ] Select carrier/rate (if allowed by recipient's settings)
- [ ] Print label immediately
- [ ] **Sender info sharing**: Option to share contact info with recipient (default: no)
- [ ] **"Save my info" option**: Creates lightweight sender profile

#### Payment
- [ ] Recipient sets price cap (default: $100)
- [ ] **Payment authorized at link creation** (validates card is good)
- [ ] When sender generates label: capture actual amount
- [ ] Handle payment failures at label generation (notify recipient)
- [ ] Handle mid-shipment rate adjustments (carrier billing)
- [ ] **Recipient bears risk** for shipping cost overages

#### Shipping
- [ ] Real rates from USPS, UPS, FedEx via EasyPost
- [ ] Rate selection based on recipient preferences
- [ ] Label generation and PDF download
- [ ] Automatic tracking updates
- [ ] Email notifications

### MVP Non-Features (Out of Scope)
- International shipping
- Escrow/item payment protection
- Dispute resolution
- Mobile apps
- Marketplace integrations (browser extensions)
- Returns handling
- Sender-paid shipping (recipient doesn't pay)
- Multiple flexible links per user
- ACH/stored value funding (coming soon after MVP)

---

## 6. User Flows

### 6.1 Recipient Flow: 3-Screen Setup

#### Screen 1: Address & Email

```
┌─────────────────────────────────────────────────────────────┐
│  SendMo                                                     │
│                                                             │
│  Get it delivered to you                                    │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Create your shipping label link in seconds.                │
│  Share it with anyone who needs to send you something.      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Where should packages be delivered?                  │   │
│  │                                                      │   │
│  │ ┌──────────────────────────────────────────────┐    │   │
│  │ │ 123 Main Street, Apt 4B                      │    │   │
│  │ │ San Francisco, CA 94102                      │    │   │
│  │ │                                              │    │   │
│  │ │ ✓ Verified: 123 Main St Apt 4B              │    │   │
│  │ │            San Francisco, CA 94102-1234     │    │   │
│  │ └──────────────────────────────────────────────┘    │   │
│  │                                                      │   │
│  │ Type or paste your address. We'll verify it         │   │
│  │ automatically.                                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Your email address                                   │   │
│  │ ┌──────────────────────────────────────────────┐    │   │
│  │ │ john@example.com                             │    │   │
│  │ └──────────────────────────────────────────────┘    │   │
│  │ We'll verify your email in the next step.           │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │     Continue to shipping and payment options →       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Address Input UX:**
- Single freeform text field (not structured street/city/state)
- User types or pastes full address
- **AI-powered real-time parsing**: As they type, system parses and shows verified address below
- Feels like autocomplete (similar to Google Maps search)
- Uses EasyPost Address Verification API
- Shows corrected/standardized version: "✓ Verified: [formatted address]"

**Email Validation:**
- Basic format validation on this screen (blocks obviously invalid emails)
- Message: "We'll verify your email in the next step"
- After submit: Send verification code/link
- Must verify to proceed to Screen 2

**Button:** "Continue to shipping and payment options →"

---

#### Screen 2: Shipping Configuration

```
┌─────────────────────────────────────────────────────────────┐
│  SendMo                                          [← Back]   │
│                                                             │
│  Configure your shipping preferences                        │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Estimated shipping cost range:                             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │   $8                                         $45     │   │
│  │    ├────────────────────────────────────────────┤    │   │
│  │    ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●    │   │
│  │                                                      │   │
│  │   Small, close, slow              Large, far, fast   │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  This range covers most shipments. The final price         │
│  depends on what the sender is shipping and where from.    │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  Optional: Narrow the range (if you know the details)      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Expected package size                                │   │
│  │ ○ Small (shoebox)  ○ Medium (moving box)            │   │
│  │ ○ Large (furniture) ○ I don't know                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Where is the sender located?                         │   │
│  │ ┌──────────────────────────────────────────────┐    │   │
│  │ │ e.g., Los Angeles, CA or "East Coast"        │    │   │
│  │ └──────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Shipping speed                                       │   │
│  │ ○ Economy (5-7 days)  ○ Standard (3-5 days)         │   │
│  │ ○ Express (1-2 days)  ● Any speed (default)         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Updated range: $12 - $28                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            Continue to payment →                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Shipping Range Visualization:**
- Graphical range display (like a slider, but user doesn't drag it)
- Shows LOW end (small, close, slow) to HIGH end (large, far, fast)
- Default: Full range based on destination address
- Updates in real-time as user makes selections

**Optional Configuration:**
- Package size: Small / Medium / Large / I don't know
- Sender location: Freeform text (city, state, or region)
- Shipping speed: Economy / Standard / Express / Any

**Real-time Updates:**
- Each selection hits EasyPost API
- Range narrows as user provides more info
- "Updated range: $X - $Y" shows below visualization

**If user does nothing:** Full range applies, sender configures everything.

---

#### Screen 3: Payment & Link Activation

```
┌─────────────────────────────────────────────────────────────┐
│  SendMo                                          [← Back]   │
│                                                             │
│  Your link is ready!                                        │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                      │   │
│  │  sendmo.co/s/k8Hj2mNp4x                              │   │
│  │                                        [Copy Link]   │   │
│  │                                                      │   │
│  │         ┌─────────────┐                              │   │
│  │         │ ▄▄▄▄▄▄▄▄▄▄▄ │                              │   │
│  │         │ █ QR CODE █ │                              │   │
│  │         │ ▀▀▀▀▀▀▀▀▀▀▀ │                              │   │
│  │         └─────────────┘                              │   │
│  │                                                      │   │
│  │  Share this link with anyone who needs to send you   │   │
│  │  a package. They'll enter the details and print a    │   │
│  │  shipping label.                                     │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  ⚠️ Add a payment method to activate your link             │
│                                                             │
│  Your link won't work until you add a payment method.      │
│  Shipping costs will be charged when a sender prints a     │
│  label (estimated range: $12 - $28).                       │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           💳 Add Payment Method                      │   │
│  │                                                      │   │
│  │     (Opens Stripe payment method form)               │   │
│  │                                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │     ✓ Confirm payment to activate your link          │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  💡 Or share the link now and add payment later.           │
│     Senders will see the link but can't print until        │
│     your payment method is confirmed.                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Link Display:**
- Show the link immediately (even before payment)
- Show QR code for easy sharing
- Copy button

**Payment CTA:**
- Clear message: "Add a payment method to activate your link"
- Show estimated range from Screen 2
- Stripe Elements for card entry
- **"Confirm payment to activate your link"** button

**Link State:**
- **Before payment**: Link exists, can be shared, but shows "pending payment" to senders
- **After payment**: Link is active, senders can complete flow

**Magic Account:**
- Account created automatically with verified email
- User lands in "Me" section after completing flow
- Can add Google login or password later in settings

---

### 6.2 Returning Recipient: Dashboard

After first-time setup, recipients see the dashboard (covered in Section 4).

---

### 6.3 Sender Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Click Link │────▶│   Enter     │────▶│   Package   │
│             │     │   Address   │     │   Details   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
┌─────────────┐     ┌─────────────┐     ┌──────▼──────┐
│   Done!     │◀────│   Email +   │◀────│   Select    │
│   Print     │     │   Save?     │     │   Rate      │
└─────────────┘     └─────────────┘     └─────────────┘
```

**Screen: Click Link**
- "You're sending a package to [Recipient Name]"
- "[Recipient Name] will pay for shipping"
- Instructions from recipient (if any)
- If link not activated: "This link is pending payment. Contact [Recipient] to complete setup."

**Screen: Enter Address**
- Origin address (where shipping from)
- Same AI-powered freeform input as recipient flow
- If returning sender, offer to use saved address

**Screen: Package Details**
- Weight (required)
- Dimensions (or select: Small / Medium / Large / Custom)
- Item description (optional)

**Screen: Select Rate**
- If "let sender choose rate" = YES: Show all available rates
- If "let sender choose rate" = NO: System auto-selects cheapest
- Carrier selection (if allowed)
- Delivery estimates

**Screen: Email & Save Preference**
- Email address (required for tracking)
- Checkbox: "Save my information to get updates and use SendMo later"
- Option to share contact info with recipient

**Screen: Print Label**
- "Print Label" button → PDF download
- Carrier drop-off instructions
- Tracking number

---

### 6.4 Payment Flow

```
Recipient completes Screen 3, adds payment method
        │
        ▼
Card authorized for price cap ($100) ◄── Validates card is good
        │
        ▼
Link is now active and shareable
        │
        ▼
Sender clicks link, enters package info, selects rate ($18.50)
        │
        ▼
System captures $18.50 from authorized card
        │
        ├── Capture succeeds ──▶ Generate label ✓
        │
        └── Capture fails ──▶ Error state
                              │
                              ├── Shipment held
                              ├── Recipient notified via email
                              ├── "Update your payment method"
                              └── When updated → re-auth → retry capture
```

**Payment Authorization Timing:**
- **Auth happens**: When recipient confirms payment (Screen 3)
- **Capture happens**: When sender generates a label
- **Re-auth happens**: When recipient adds/updates payment method

---

### 6.5 Mid-Shipment Rate Adjustments

Carriers may adjust rates after label generation if the package differs from what was declared.

```
Label generated with declared: 2 lbs, 12x8x4
        │
        ▼
Carrier weighs/measures: 3 lbs, 14x10x5
        │
        ▼
Carrier adjustment: +$4.50
        │
        ▼
EasyPost bills SendMo
        │
        ▼
SendMo charges recipient's card for adjustment
        │
        ├── Charge succeeds ──▶ Log adjustment, notify recipient
        │
        └── Charge fails ──▶ Flag for manual review
```

---

## 7. Pricing Model

### Formula

**Standard Rate (no SendMo Balance):**
```
Display Price = EasyPost Rate × 1.15
(SendMo takes 15%, shown as "Shipping")
```

**Discounted Rate (with SendMo Balance):**
```
Display Price = EasyPost Rate × 1.10
(SendMo takes 10%, shown as "Shipping")
```

### Display Strategy
- **Do NOT show SendMo fee separately**
- Show single "Shipping" price that includes our margin
- Upsell: "Save 5% on shipping with a SendMo Balance" → [Learn More - Coming Soon]

### Examples (Standard Rate - 15%)

| EasyPost Rate | Display Price |
|---------------|---------------|
| $8.00 | $9.20 |
| $15.00 | $17.25 |
| $25.00 | $28.75 |
| $50.00 | $57.50 |

### Price Cap
- Recipients set a maximum they're willing to pay (default: $100)
- Cap applies to the display price (includes our margin)
- Senders can only select rates where display price ≤ cap

---

## 8. Security Requirements

### Prevent Brute Force / Link Enumeration
- Links use cryptographically secure random IDs (not sequential)
- Minimum 10 characters, mixed case + numbers
- Rate limiting on link lookups
- CAPTCHA after failed attempts

### Prevent Unauthorized Charges
- Payment authorized at link activation (Screen 3)
- Authorization renewed when payment method changes
- Capture for exact rate amount at label generation
- Recipient must have valid, authorized payment method before link works

### Prevent Spam Packages
- Recipients can pause/deactivate their link
- Recipients can block specific sender addresses
- Configurable daily/weekly shipment limits
- Require sender email for tracking (creates accountability)

### Sender Privacy
- Sender contact info not shared with recipient by default
- Sender can opt-in to share email/phone with recipient

---

## 9. Technical Requirements

### 9.1 API Integrations

| Service | Purpose | Priority |
|---------|---------|----------|
| EasyPost | Addresses, rates, labels, tracking | MVP |
| Stripe | Payment authorization & capture | MVP |
| SendGrid | Email notifications + verification | MVP |
| USPS Label Broker API | Private shipment links (QR codes) | MVP (for private links) |
| UPS Returns API | Alternative for private links | Post-MVP |
| Plaid | ACH funding for stored balance | Post-MVP |

### 9.2 Data Models

See `decisions/001-data-model.md` for full schema.

**Core Entities:**
- `User` - Recipient accounts (magic link auth)
- `SendMoLink` - Links with type and preferences
- `Shipment` - Individual shipments
- `Address` - Verified addresses
- `PaymentMethod` - Stored payment methods
- `PaymentAuthorization` - Track auth status per link
- `RateAdjustment` - Track carrier billing adjustments
- `FAQSearch` - Track FAQ search queries

### 9.3 API Endpoints

```
# Auth
POST /api/auth/magic-link          # Send magic link email
POST /api/auth/verify              # Verify magic link token
POST /api/auth/google              # Google OAuth
POST /api/auth/set-password        # Optional password setup
GET  /api/auth/me

# Onboarding (Recipient Setup Flow)
POST /api/onboarding/address       # Screen 1: Validate address
POST /api/onboarding/email         # Screen 1: Send verification
POST /api/onboarding/verify-email  # Verify email code
POST /api/onboarding/preferences   # Screen 2: Save preferences
POST /api/onboarding/payment       # Screen 3: Add payment + activate

# Links (Recipient)
GET  /api/links                     # List my links
GET  /api/links/:id                 # Get link details
PUT  /api/links/:id                 # Update link settings
DELETE /api/links/:id               # Deactivate link

# Public Link Access (Sender)
GET  /api/s/:shortId                # Get link info (public)
POST /api/s/:shortId/shipment       # Start shipment
GET  /api/s/:shortId/rates          # Get rates for shipment
POST /api/s/:shortId/buy            # Purchase label (captures payment)

# Shipments (Recipient Dashboard)
GET  /api/shipments                 # List my shipments
GET  /api/shipments/:id             # Get shipment details
GET  /api/shipments/:id/track       # Get tracking info

# Payment Methods
GET  /api/payment-methods
POST /api/payment-methods           # Add method (triggers auth)
DELETE /api/payment-methods/:id
PUT  /api/payment-methods/:id/default

# Addresses
GET  /api/addresses
POST /api/addresses
POST /api/addresses/verify          # AI-powered address parsing
POST /api/addresses/parse           # Parse freeform text to structured

# FAQ
GET  /api/faq                       # Get all FAQ items
GET  /api/faq/search                # Search FAQ (logged)
POST /api/faq/contact               # Contact form submission

# Webhooks
POST /api/webhooks/easypost         # Tracking updates, rate adjustments
POST /api/webhooks/stripe           # Payment events
```

---

## 10. Logging & Data Tracking

### Overview
Track all user actions and system events for debugging, analytics, and business intelligence.

### Data Categories

| Category | Examples | Storage | Retention |
|----------|----------|---------|-----------|
| **Click/Event Data** | Page views, button clicks, funnel steps | ClickHouse | 1 year |
| **Transactional Data** | Shipments, payments, labels | PostgreSQL (primary DB) | Indefinite |
| **Audit Logs** | Auth events, setting changes, admin actions | PostgreSQL | 2 years |
| **Error Logs** | API errors, payment failures, EasyPost errors | Structured logs (JSON) | 90 days |
| **FAQ Searches** | Search queries, clicked articles | PostgreSQL | 1 year |

### Proposed Stack

| Component | Tool | Rationale |
|-----------|------|-----------|
| **Event Tracking** | PostHog or Mixpanel | Product analytics, funnels, feature flags |
| **Click Data Warehouse** | ClickHouse (via Tinybird or self-hosted) | High-volume event storage, fast aggregations |
| **Transactional DB** | PostgreSQL (Supabase) | Already in use, ACID compliance |
| **Error Tracking** | Sentry | Exception tracking, performance monitoring |
| **Dashboard** | Metabase or Preset (hosted Superset) | SQL-based BI, connect to Postgres + ClickHouse |

### MVP: Email Notifications

**For every transaction, send an email to admin with full details** (see previous spec version for format).

### Events to Track

**User Events:**
- `user.signup` (magic link)
- `user.login`
- `user.added_google` / `user.added_password`
- `link.created`
- `link.copied`
- `link.shared`
- `link.settings_updated`
- `payment_method.added`

**Onboarding Events:**
- `onboarding.address_entered`
- `onboarding.address_verified`
- `onboarding.email_sent`
- `onboarding.email_verified`
- `onboarding.preferences_set`
- `onboarding.payment_added`
- `onboarding.completed`

**Sender Events:**
- `link.viewed`
- `link.viewed_pending` (before payment activated)
- `shipment.started`
- `shipment.address_entered`
- `shipment.package_entered`
- `shipment.rate_selected`
- `shipment.label_generated`
- `sender.saved_info` / `sender.remained_guest`

**FAQ Events:**
- `faq.searched` (query, results count)
- `faq.article_viewed`
- `faq.contact_submitted`

**System Events:**
- `payment.authorized`
- `payment.captured`
- `payment.failed`
- `payment.adjustment`
- `easypost.rate_fetched`
- `easypost.label_created`
- `easypost.tracking_updated`

---

## 11. Post-MVP: Stored Balance (Coming Soon)

**Timeline**: Immediately after MVP launch

### Overview
Users can fund a SendMo Balance via ACH and get discounted shipping rates.

### Features
- [ ] ACH bank linking via Plaid
- [ ] Fund balance (minimum $25, topup in $25 increments)
- [ ] Auto-topup when balance falls below threshold
- [ ] 10% fee (vs 15% standard) when using balance
- [ ] Balance visible in wallet section
- [ ] Transaction history for balance

### Payment Priority
1. Use SendMo Balance first
2. Fall back to card if balance insufficient
3. Split payment: balance + card for remainder

---

## 12. Future Ideas

### Multiple Flexible Links (Power Users)
- One flexible link per address (home, office, vacation home)
- One flexible link per preference set (fast shipping, cheap shipping)
- Dashboard shows all links with distinct synopses

### Sender-Paid Shipping
- Recipient creates a link but doesn't add payment
- Sender pays for shipping instead

### Private Links via Carrier APIs
- USPS Label Broker API for QR codes
- UPS Digital Returns for mobile codes

### Escrow Payments
- Hold item price until delivery confirmed

### Marketplace Integrations
- Browser extension for Facebook Marketplace

---

## 13. Success Metrics

### MVP Metrics

| Metric | Target |
|--------|--------|
| Time to first link | < 60 seconds |
| Onboarding completion rate | > 60% |
| Sender completion rate (clicked → printed) | > 70% |
| Payment failure rate | < 5% |
| Payment auth failure at activation | < 2% |

### Business Metrics

| Metric | Definition |
|--------|------------|
| Revenue | SendMo margin collected (15% or 10%) |
| GMV | Total shipping costs processed |
| MAU | Monthly active recipients |
| Shipments/user/month | Retention indicator |
| Sender return rate | % of senders who use SendMo again |

---

## 14. Open Questions (Resolved)

| Question | Decision |
|----------|----------|
| Pricing model? | **15% margin (standard), 10% (with balance)** |
| Show fees separately? | **No — show as single "Shipping" price** |
| Who bears shipping cost risk? | **Recipient** (including carrier adjustments) |
| When to auth payment? | **At link activation (Screen 3)** |
| Account creation? | **Magic link (passwordless), optional Google/password later** |
| Address input? | **Freeform text field with AI parsing** |

---

## 15. Open Questions (Pending)

1. **Private links MVP**: Defer pending carrier API integration?
2. **Rate display on Screen 2**: What's the default range before any configuration?
3. **Carrier adjustment threshold**: Below what amount do we eat the cost?

---

## Appendix: Competitive Positioning

| Competitor | Model | SendMo Advantage |
|------------|-------|------------------|
| Pirate Ship | Sender-focused | Recipient control, no address sharing |
| PayPal Shipping | Requires accounts | Frictionless for senders |
| Shippo | Business-focused | Consumer-friendly |
| Facebook Shipping | Platform-locked | Works everywhere |

**SendMo's unique value**: Recipient-initiated links that make shipping dead simple for both parties—recipients set preferences once, senders just click and print.
