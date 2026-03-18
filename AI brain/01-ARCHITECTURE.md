# Sendmo Technical Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND                                  │
│  React 18 (standalone) - index.html, RateSelector.tsx           │
│  Deployed: Vercel (sendmo.co)                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND API                                 │
│  Next.js 14 API Routes - /backend/app/api/                      │
│  Deployed: Vercel (same project)                                │
├─────────────────────────────────────────────────────────────────┤
│  POST /api/shipments              - Create shipment, get rates  │
│  POST /api/shipments/[id]/buy     - Purchase label              │
│  POST /api/addresses/verify       - Verify address              │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   PostgreSQL    │ │    EasyPost     │ │     Stripe      │
│   (Prisma ORM)  │ │   Shipping API  │ │   Payments API  │
│   Vercel Postgres│ │   PROD READY   │ │   (PENDING)     │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## Directory Structure

```
/home/user/Sendmo/
├── index.html                 # Main frontend (React 18, 1,436 lines)
├── RateSelector.tsx           # Rate selection component (472 lines)
├── email-templates.ts         # Email templates (332 lines)
├── schema.sql                 # PostgreSQL DDL (349 lines, 10 tables)
├── AI_FEATURE_SPEC.md         # AI feature specification
├── README.md                  # Project documentation
├── vercel.json                # Vercel deployment config
├── playwright.config.ts       # E2E test configuration
│
├── backend/                   # Next.js 14 API
│   ├── app/
│   │   ├── layout.tsx
│   │   └── api/
│   │       ├── shipments/
│   │       │   ├── route.ts          # POST: create shipment, get rates
│   │       │   └── [id]/buy/route.ts # POST: purchase label
│   │       └── addresses/
│   │           └── verify/route.ts   # POST: verify address
│   ├── lib/
│   │   └── address-verification.ts   # EasyPost address logic
│   ├── prisma/
│   │   ├── schema.prisma            # ORM schema (323 lines)
│   │   └── schema-old.prisma        # Legacy reference
│   ├── tests/
│   │   └── easypost.test.ts         # Vitest integration tests
│   └── package.json
│
├── tests/                     # Frontend E2E tests
│   └── shipping-flow.spec.ts  # Playwright tests
│
├── credentials/               # API keys (gitignored)
│   └── easypost-prod.json     # EasyPost production credentials
│
├── AI brain/                  # Knowledge base (this folder)
│   └── *.md files
│
└── .github/workflows/
    ├── test.yml               # CI/CD pipeline
    └── auto-fix.yml           # Claude Code auto-fix
```

## Key Architectural Decisions

### 1. Generalized Request Model
Instead of separate tables for shipping/escrow/services, one polymorphic `Request` table:
```typescript
requestType: "shipping" | "escrow" | "local_pickup" | "digital" | "service"
```
**Rationale**: Enables Phase 2 (escrow) and Phase 3 (trust platform) without schema changes.

### 2. Optional User Accounts
- Sellers don't need accounts to print labels
- Buyers can optionally create accounts for history
- Implicit verification through email clicks
**Rationale**: Reduces friction, enables viral growth.

### 3. Demo Mode with Live Mode Fallback
```typescript
if (!EASYPOST_API_KEY) {
  return generateMockRates(weight);
} else {
  return client.Shipment.create(...);
}
```
**Rationale**: Local testing works without API keys.

### 4. Address Caching
Verified addresses cached in database by (street1, city, state, zip).
**Rationale**: Reduces EasyPost API calls (cost + latency).

### 5. EasyPost EndShipper
All labels use EndShipper for compliance with carrier requirements.
**Rationale**: Required by UPS/FedEx for third-party shipping.

## Technology Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend | React 18 (standalone) | Simple, no build step needed for MVP |
| Styling | Vanilla CSS | Full control, no dependencies |
| Backend | Next.js 14 | API routes + future SSR if needed |
| ORM | Prisma | Type-safe, migrations, excellent DX |
| Validation | Zod | Runtime type checking on API inputs |
| Auth | NextAuth | Industry standard, OAuth + email support |
| Shipping | EasyPost | Multi-carrier abstraction, best API |
| Payments | Stripe | Best-in-class, already familiar |
| Database | PostgreSQL | Reliable, Vercel Postgres available |
| Testing | Playwright + Vitest | E2E + unit, fast and reliable |
| CI/CD | GitHub Actions | Native to GitHub, easy setup |

## API Contracts

### POST /api/shipments
```typescript
// Request
{
  from_address: { street1, city, state, zip, name?, company?, phone? },
  to_address: { street1, city, state, zip, name?, company?, phone? },
  parcel: { length, width, height, weight }
}

// Response
{
  id: string,
  rates: Array<{
    id: string,
    carrier: "USPS" | "UPS" | "FedEx",
    service: string,
    rate: string,  // e.g. "8.50"
    delivery_days: number,
    delivery_date: string
  }>
}
```

### POST /api/shipments/[id]/buy
```typescript
// Request
{ rate_id: string }

// Response
{
  tracking_code: string,
  label_url: string,
  shipment: { ... }
}
```

### POST /api/addresses/verify
```typescript
// Request
{ street1, city, state, zip }

// Response
{
  verified: boolean,
  address: { street1, street2, city, state, zip, country },
  coordinates: { latitude, longitude },
  timezone: string
}
```
