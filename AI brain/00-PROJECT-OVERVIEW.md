# Sendmo Project Overview

## What is Sendmo?

**Sendmo** (sendmo.co) is a marketplace shipping solution that eliminates friction in peer-to-peer transactions.

### Core Value Proposition
Buyers create shipping labels and share a link with sellers. Sellers click, print, and ship. No accounts needed for sellers.

### The Problem We Solve
In marketplace transactions (eBay, Facebook Marketplace, Poshmark), shipping coordination is the #1 friction point:
- Buyers and sellers exchange addresses manually
- Payment for shipping is awkward
- Label creation requires technical knowledge
- No accountability or tracking

### The Sendmo Flow
```
1. BUYER creates shipping label on sendmo.co
   - Enters their address (destination)
   - Describes what they're receiving
   - Selects carrier/service/speed
   - Pays for shipping

2. BUYER shares link with SELLER
   - Unique URL: sendmo.co/ship/{shareToken}
   - No login required for seller

3. SELLER clicks link, prints label, ships
   - Pre-paid, ready-to-print PDF
   - Drop off at any carrier location

4. BOTH parties track shipment
   - Real-time tracking updates
   - Email notifications
```

## Product Vision & Phases

### Phase 1: Shipping Labels (CURRENT)
- Multi-carrier support (USPS, UPS, FedEx)
- Address verification
- Rate comparison
- Label generation
- Shipment tracking

### Phase 2: Payment Escrow
- "Pay $X + shipping" button
- Stripe payment integration
- Hold payment until delivery confirmed
- Automatic release on confirmation
- Refund handling for disputes

### Phase 3: Full Trust Platform
- Buyer/seller ratings and reviews
- Dispute resolution system
- Identity verification
- Transaction history
- API for marketplace integrations

## Design Philosophy

Sendmo should feel:
- **Trustworthy** - Dark, professional aesthetic (not startup-playful)
- **Fast** - Minimal steps, no friction
- **Clear** - Every action has obvious next step

Inspired by: Stripe's clarity, Linear's speed, Coinbase's trust.

## Target Users

### Primary: Marketplace Sellers
- Sell on eBay, Poshmark, Facebook Marketplace, Mercari
- Ship 5-50 packages/month
- Want simple, reliable shipping
- Hate complexity and hidden fees

### Secondary: Marketplace Buyers
- Buy from individual sellers
- Want tracking and accountability
- Willing to pay for convenience

### Future: Marketplaces (B2B)
- API integration for platforms
- White-label shipping solution
- Volume discounts
