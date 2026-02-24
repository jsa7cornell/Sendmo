# ADR 001: Data Model Design

**Status**: Accepted (Updated)
**Date**: 2025-02-09
**Context**: Designing the database schema for SendMo

---

## Decision

Design a **recipient-centric data model** where:
- Recipients have accounts and own SendMo Links
- Links are reusable and generate multiple Shipments
- Senders are lightweight (no account required, recognized by cookie/address)
- Payment authorization is tied to Links, capture happens per Shipment

---

## Core Entities

```
┌─────────────┐
│    User     │ (Recipient account)
│─────────────│
│ - email     │
│ - address   │──────────────────────────┐
│ - payment   │                          │
└──────┬──────┘                          │
       │ owns                            │
       ▼                                 │
┌──────────────────┐                     │
│   SendMoLink     │                     │
│──────────────────│                     │
│ - shortId        │                     │
│ - type:          │                     │
│   • FLEXIBLE     │─────────────────────┤
│   • ONETIME      │   ship-to address   │
│   • PRIVATE      │                     │
│ - priceCap       │                     │
│ - speedPref      │                     │
│ - carrierPref    │                     │
└───────┬──────────┘                     │
        │ generates                      │
        ▼                                │
┌─────────────┐        ┌─────────────────┤
│  Shipment   │        │    Address      │
│─────────────│        │─────────────────│
│ - status    │───────▶│ - street1       │
│ - tracking  │ origin │ - verified      │
│ - label/QR  │        │ - easypostId    │
│ - sender*   │        │ - addressHash   │
└─────────────┘        └─────────────────┘

* sender info stored on shipment, not as separate entity
```

---

## Schema

```prisma
// ============================================
// USER (Recipient Account)
// ============================================
model User {
  id                  String    @id @default(cuid())
  email               String    @unique
  emailVerified       DateTime?
  passwordHash        String?
  name                String?

  // Destination address (private, never shown to senders)
  defaultAddressId    String?
  defaultAddress      Address?  @relation("UserDefaultAddress", fields: [defaultAddressId], references: [id])

  // Stripe
  stripeCustomerId    String?   @unique

  // Settings
  defaultPriceCap     Decimal   @default(100.00)
  shipmentLimit       Int?      // Max shipments per day (spam protection)

  // Relations
  links               SendMoLink[]
  paymentMethods      PaymentMethod[]
  addresses           Address[] @relation("UserAddresses")

  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}

// ============================================
// SENDMO LINK (Shipping link - multiple types)
// ============================================
model SendMoLink {
  id                  String    @id @default(cuid())
  shortId             String    @unique // e.g., "abc123xyz" for sendmo.co/s/abc123xyz (min 10 chars)

  // Owner
  userId              String
  user                User      @relation(fields: [userId], references: [id])

  // Link Type
  type                LinkType  @default(FLEXIBLE_LABEL)
  isReusable          Boolean   @default(true) // false for one-time links

  // Ship-to Address (defaults to user's primary, can be overridden)
  shipToAddressId     String?
  shipToAddress       Address?  @relation("LinkShipTo", fields: [shipToAddressId], references: [id])

  // Preferences (configured by recipient)
  priceCap            Decimal   @default(100.00)
  speedPreference     SpeedPreference @default(ECONOMY) // Most affordable by default
  carrierPreference   CarrierPreference @default(ANY)
  instructions        String?   // Optional note for senders

  // One-time link specifics (pre-configured)
  expectedWeightOz    Decimal?
  expectedLengthIn    Decimal?
  expectedWidthIn     Decimal?
  expectedHeightIn    Decimal?
  expectedOriginState String?   // For rate estimation
  expectedOriginCity  String?

  // Status
  isActive            Boolean   @default(true)
  isPaused            Boolean   @default(false)
  expiresAt           DateTime? // For one-time links

  // Parent link (for one-time variants of flexible links)
  parentLinkId        String?
  parentLink          SendMoLink? @relation("LinkVariants", fields: [parentLinkId], references: [id])
  variants            SendMoLink[] @relation("LinkVariants")

  // Relations
  shipments           Shipment[]

  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  @@index([shortId])
  @@index([userId])
  @@index([type])
}

enum LinkType {
  FLEXIBLE_LABEL  // Reusable, sender configures package details
  ONETIME_LABEL   // Pre-configured for specific shipment
  PRIVATE         // QR code, address not visible to sender
}

enum SpeedPreference {
  ECONOMY   // 5-7 days (default - most affordable)
  STANDARD  // 3-5 days
  EXPRESS   // 1-2 days
}

enum CarrierPreference {
  ANY       // Use cheapest available
  USPS_ONLY
  UPS_ONLY
  FEDEX_ONLY
}

// ============================================
// SHIPMENT (Individual package)
// ============================================
model Shipment {
  id                  String    @id @default(cuid())

  // Link this shipment came from
  linkId              String
  link                SendMoLink @relation(fields: [linkId], references: [id])

  // Addresses
  originAddressId     String?
  originAddress       Address?  @relation("ShipmentOrigin", fields: [originAddressId], references: [id])
  destAddressId       String
  destAddress         Address   @relation("ShipmentDest", fields: [destAddressId], references: [id])

  // Package details (from sender)
  weightOz            Decimal?
  lengthIn            Decimal?
  widthIn             Decimal?
  heightIn            Decimal?

  // Shipping
  carrier             String?   // USPS, UPS, FedEx
  service             String?   // Priority, Ground, etc.
  shippingCost        Decimal?  // EasyPost cost
  sendmoFee           Decimal?  // Our fee (10% + $1)
  totalCost           Decimal?  // shippingCost + sendmoFee

  // EasyPost
  easypostShipmentId  String?
  easypostRateId      String?
  trackingCode        String?
  labelUrl            String?
  publicTrackingUrl   String?

  // Payment
  stripePaymentIntentId String?
  paymentStatus       PaymentStatus @default(PENDING)

  // Status
  status              ShipmentStatus @default(DRAFT)

  // Sender info (lightweight, no account)
  senderEmail         String?
  senderPhone         String?
  senderCookie        String?   // For recognizing returning senders
  senderShareInfo     Boolean   @default(false) // Sender opts in to share contact with recipient

  // Timestamps
  labelPrintedAt      DateTime?
  shippedAt           DateTime?
  deliveredAt         DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  // Relations
  trackingEvents      TrackingEvent[]

  @@index([linkId])
  @@index([trackingCode])
  @@index([status])
}

enum ShipmentStatus {
  DRAFT               // Sender started but not complete
  PENDING_SENDER      // Waiting for sender to enter details
  PENDING_PAYMENT     // Sender done, waiting for payment capture
  PAYMENT_FAILED      // Payment capture failed
  READY_TO_PRINT      // Label ready for sender to print
  LABEL_PRINTED       // Sender printed label
  IN_TRANSIT          // Package scanned by carrier
  OUT_FOR_DELIVERY    // On delivery vehicle
  DELIVERED           // Package delivered
  RETURNED            // Returned to sender
  CANCELLED           // Cancelled by recipient
  EXPIRED             // Link expired before completion
}

enum PaymentStatus {
  PENDING             // No payment attempt yet
  AUTHORIZED          // Payment authorized (hold)
  CAPTURED            // Payment captured (charged)
  FAILED              // Payment failed
  REFUNDED            // Payment refunded
}

// ============================================
// ADDRESS (Verified addresses)
// ============================================
model Address {
  id                  String    @id @default(cuid())

  // Owner (optional - senders don't have accounts)
  userId              String?
  user                User?     @relation("UserAddresses", fields: [userId], references: [id])

  // Address fields
  street1             String
  street2             String?
  city                String
  state               String
  zip                 String
  country             String    @default("US")

  // Verification
  verified            Boolean   @default(false)
  verifiedAt          DateTime?
  easypostId          String?   // EasyPost address ID for reuse
  verificationData    Json?     // Full EasyPost response

  // For sender recognition
  addressHash         String?   // Hash for matching returning senders

  // Usage tracking
  usedAsOriginCount   Int       @default(0)
  usedAsDestCount     Int       @default(0)
  lastUsedAt          DateTime?

  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  // Relations
  userDefault         User?     @relation("UserDefaultAddress")
  linksAsShipTo       SendMoLink[] @relation("LinkShipTo")
  shipmentsAsOrigin   Shipment[] @relation("ShipmentOrigin")
  shipmentsAsDest     Shipment[] @relation("ShipmentDest")

  @@index([addressHash])
  @@index([userId])
}

// ============================================
// PAYMENT METHOD
// ============================================
model PaymentMethod {
  id                  String    @id @default(cuid())
  userId              String
  user                User      @relation(fields: [userId], references: [id])

  // Stripe
  stripePaymentMethodId String  @unique
  type                String    // card, us_bank_account
  last4               String
  brand               String?   // visa, mastercard, etc.
  expiryMonth         Int?
  expiryYear          Int?

  isDefault           Boolean   @default(false)

  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  @@index([userId])
}

// ============================================
// TRACKING EVENT
// ============================================
model TrackingEvent {
  id                  String    @id @default(cuid())
  shipmentId          String
  shipment            Shipment  @relation(fields: [shipmentId], references: [id])

  status              String
  statusDetail        String?
  message             String
  location            String?

  occurredAt          DateTime
  createdAt           DateTime  @default(now())

  @@index([shipmentId])
}

// ============================================
// BLOCKED SENDER (Spam protection)
// ============================================
model BlockedSender {
  id                  String    @id @default(cuid())
  userId              String

  // Block by address hash or email
  addressHash         String?
  email               String?
  reason              String?

  createdAt           DateTime  @default(now())

  @@index([userId, addressHash])
  @@index([userId, email])
}
```

---

## Key Design Decisions

### 1. Three Link Types
- **Flexible Label Link**: Reusable, sender configures package details. Default type.
- **One-Time Label Link**: Pre-configured by recipient for specific shipment. Has expected dimensions, origin area.
- **Private Shipment Link**: Sender gets QR code instead of label. Address never exposed.

### 2. Link Hierarchy
- Each user gets a primary flexible link automatically
- One-time links can be created as variants (`parentLinkId` points to flexible link)
- One-time links inherit defaults from parent but can override settings

### 3. Sender Recognition without Accounts
- Store `addressHash` (SHA-256 of normalized address)
- Store `senderCookie` on shipment
- On return visit, match cookie → find previous address → pre-fill
- Sender can optionally share contact info with recipient (`senderShareInfo` flag)

### 4. Payment Authorization Flow
- When recipient creates link: No authorization yet
- When sender selects rate: Authorize exact rate amount
- When label generated: Capture authorized amount
- Recipient bears risk for shipping cost variations

### 5. Address Privacy (by Link Type)
- **Label Links**: Address shown on printed label only (not in UI)
- **Private Links**: Address never visible to sender (QR code for carrier location)
- Sender only sees recipient name + city/state on link landing page

---

## Consequences

### Positive
- Clean separation between Links and Shipments
- Scales to many shipments per link
- Sender recognition improves UX without requiring accounts
- Payment authorization is flexible

### Negative
- One-time link variants add complexity
- Sender cookie can be lost (browser cleared)
- Need to handle authorization expiry (typically 7 days)

### Mitigations
- Limit variant depth (no variants of variants)
- Fall back to address entry if cookie missing
- Re-authorize if needed before capture
