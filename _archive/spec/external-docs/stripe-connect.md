# Stripe Connect Reference for Marketplaces

> **Source**: Stripe Documentation
> **Relevant for**: Payment processing, seller payouts
> **Use Case**: SendMo marketplace payments

---

## Overview

Stripe Connect enables marketplaces to accept payments, pay out to sellers, and take a platform fee. For SendMo, Connect handles:
- Collecting payment from buyers
- Taking SendMo's fee
- (Future) Paying out to sellers for escrow

---

## Account Types

### 1. Standard Accounts
- Full Stripe dashboard access for sellers
- Seller manages own disputes, refunds
- Least platform control, most seller independence

### 2. Express Accounts (Recommended for SendMo)
- Streamlined onboarding (Stripe-hosted)
- Sellers have limited dashboard
- Platform controls most settings
- Good balance of control and simplicity

### 3. Custom Accounts
- Fully white-labeled experience
- Platform handles everything
- Most work, most control

**Recommendation**: Start with **Express Accounts** for Phase 2 escrow. For MVP (no seller payouts), you don't need Connect at all—just regular Stripe Checkout.

---

## MVP: No Connect Needed

For MVP, buyers pay SendMo directly for shipping labels. No funds go to sellers. Use standard Stripe Checkout:

```
Buyer → Stripe Checkout → SendMo receives funds → SendMo pays EasyPost
```

---

## Phase 2: Escrow with Connect

When adding escrow, the flow becomes:

```
Buyer pays (item + shipping)
         │
         ▼
   Stripe holds funds
         │
         ├─── Shipping portion → SendMo → EasyPost
         │
         └─── Item price (held in escrow)
                    │
                    ▼ (on delivery confirmation)
              Seller receives payout (minus platform fee)
```

### Payment Flow Options

#### Option A: Destination Charges (Simpler)
```javascript
const paymentIntent = await stripe.paymentIntents.create({
  amount: 5000, // $50.00 total
  currency: 'usd',
  application_fee_amount: 500, // $5.00 to SendMo
  transfer_data: {
    destination: 'acct_seller123', // Seller's Connect account
  },
});
```
- Funds go to seller, fee to platform
- Simpler, but seller appears on card statement

#### Option B: Separate Charges and Transfers (More Control)
```javascript
// 1. Charge buyer (SendMo is merchant of record)
const charge = await stripe.charges.create({
  amount: 5000,
  currency: 'usd',
  source: 'tok_visa',
});

// 2. Later, transfer to seller
const transfer = await stripe.transfers.create({
  amount: 4500, // After SendMo's fee
  currency: 'usd',
  destination: 'acct_seller123',
});
```
- SendMo appears on statement
- Can delay transfer (escrow)
- More control over timing

**Recommendation**: Use **Option B** for escrow—it allows holding funds until delivery confirmation.

---

## Onboarding Sellers

### Express Account Onboarding

```javascript
// 1. Create a Connect account
const account = await stripe.accounts.create({
  type: 'express',
  country: 'US',
  email: 'seller@example.com',
  capabilities: {
    transfers: { requested: true },
  },
});

// 2. Create an Account Link for onboarding
const accountLink = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: 'https://sendmo.co/seller/reauth',
  return_url: 'https://sendmo.co/seller/complete',
  type: 'account_onboarding',
});

// 3. Redirect seller to accountLink.url
```

The seller completes Stripe's hosted onboarding (identity verification, bank account, etc.) and returns to SendMo.

---

## Platform Fees

### Taking a Fee

```javascript
// With Destination Charges
const paymentIntent = await stripe.paymentIntents.create({
  amount: 1000,
  currency: 'usd',
  application_fee_amount: 100, // 10% fee
  transfer_data: {
    destination: 'acct_seller123',
  },
});
```

### Fee Structures for SendMo

| Model | Implementation |
|-------|----------------|
| Flat fee | `application_fee_amount: 199` ($1.99) |
| Percentage | `application_fee_amount: Math.round(amount * 0.10)` |
| Hybrid | `application_fee_amount: 99 + Math.round(amount * 0.05)` |

---

## Handling Escrow

For escrow (hold funds until delivery):

### 1. Charge Buyer
```javascript
const paymentIntent = await stripe.paymentIntents.create({
  amount: itemPrice + shippingCost,
  currency: 'usd',
  capture_method: 'manual', // Don't capture yet
  // Or capture immediately and hold in your Stripe balance
});
```

### 2. On Delivery Confirmation
```javascript
// Transfer item price to seller
const transfer = await stripe.transfers.create({
  amount: itemPrice - platformFee,
  currency: 'usd',
  destination: 'acct_seller123',
  transfer_group: 'shipment_xxx', // For tracking
});
```

### 3. On Dispute
```javascript
// Refund buyer
const refund = await stripe.refunds.create({
  payment_intent: 'pi_xxx',
  amount: itemPrice, // Partial refund (keep shipping)
});
```

---

## Webhooks

Essential webhooks for SendMo:

| Event | When | Action |
|-------|------|--------|
| `checkout.session.completed` | Buyer pays | Create label, notify seller |
| `payment_intent.succeeded` | Payment captured | Update order status |
| `transfer.created` | Seller paid out | Update escrow status |
| `account.updated` | Seller onboarding | Check if seller can receive payouts |
| `charge.dispute.created` | Buyer disputes | Pause payout, start resolution |

---

## Stripe Checkout (MVP)

For MVP without Connect, use Checkout Sessions:

```javascript
const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  line_items: [
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Shipping Label - USPS Priority',
          description: 'San Francisco, CA to New York, NY',
        },
        unit_amount: 758, // $7.58
      },
      quantity: 1,
    },
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'SendMo Service Fee',
        },
        unit_amount: 199, // $1.99
      },
      quantity: 1,
    },
  ],
  mode: 'payment',
  success_url: 'https://sendmo.co/success?session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://sendmo.co/cancel',
  metadata: {
    shipment_id: 'shp_xxx',
  },
});
```

---

## Test Mode

Use test API keys (`sk_test_...`) for development:

### Test Cards
| Number | Result |
|--------|--------|
| `4242424242424242` | Successful payment |
| `4000000000000002` | Declined |
| `4000000000009995` | Insufficient funds |
| `4000000000000341` | Attaches, fails on charge |

### Test Bank Accounts (for Connect payouts)
| Routing | Account | Result |
|---------|---------|--------|
| `110000000` | `000123456789` | Success |
| `110000000` | `000111111116` | Fails verification |

---

## SendMo Implementation Phases

### MVP (No Connect)
- Stripe Checkout for shipping label payment
- All funds to SendMo
- No seller payouts

### Phase 2 (Escrow)
- Add Connect with Express accounts
- Buyer pays item + shipping
- Hold item price in escrow
- Payout on delivery confirmation

### Phase 3 (Advanced)
- Instant payouts for trusted sellers
- Dispute resolution integration
- Multi-party payments (item from seller A, shipping from seller B)

---

## Costs

### Stripe Fees
| Service | Fee |
|---------|-----|
| Card payments | 2.9% + $0.30 |
| Connect (Express) | +0.25% per payout |
| Instant payouts | +1% of payout |
| Disputes | $15 per dispute |

### Example: $50 item + $10 shipping, $5 SendMo fee

```
Buyer pays: $65.00
Stripe fee: $2.19 (2.9% + $0.30)
SendMo receives: $62.81
SendMo keeps: $5.00 (platform fee)
Seller receives: $47.81 ($50 - Stripe Connect fee)
Shipping cost: $10.00 (to EasyPost)
```
