# Stripe Checkout Reference

> **Source**: Stripe Documentation
> **Relevant for**: MVP payment flow
> **Use Case**: Collecting payment for shipping labels

---

## Overview

Stripe Checkout is a prebuilt, hosted payment page. For SendMo MVP, it's the fastest way to accept payments without building a custom payment form.

---

## How It Works

```
1. Create Checkout Session (server-side)
         │
         ▼
2. Redirect buyer to Stripe-hosted page
         │
         ▼
3. Buyer enters payment info
         │
         ▼
4. Stripe redirects to success_url
         │
         ▼
5. Webhook confirms payment
         │
         ▼
6. SendMo generates shipping label
```

---

## Creating a Checkout Session

### Basic Session (MVP)

```javascript
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  line_items: [
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'USPS Priority Mail',
          description: 'Estimated delivery: Feb 12-14',
          images: ['https://sendmo.co/carriers/usps.png'],
        },
        unit_amount: 758, // $7.58 in cents
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
  success_url: 'https://sendmo.co/shipment/{CHECKOUT_SESSION_ID}/success',
  cancel_url: 'https://sendmo.co/shipment/xxx/payment',
  metadata: {
    shipment_id: 'shp_xxx',
    rate_id: 'rate_xxx',
  },
  expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 min expiry
});

// Return session.url to redirect buyer
```

### Session Parameters

| Parameter | Description |
|-----------|-------------|
| `payment_method_types` | `['card']` for MVP |
| `line_items` | What the buyer is paying for |
| `mode` | `'payment'` for one-time |
| `success_url` | Where to redirect on success |
| `cancel_url` | Where to redirect on cancel |
| `metadata` | Your custom data (shipment ID, etc.) |
| `expires_at` | Session expiration (optional) |

---

## Line Items

### Dynamic Pricing (Recommended)
Use `price_data` for dynamic prices:

```javascript
line_items: [
  {
    price_data: {
      currency: 'usd',
      product_data: {
        name: 'Shipping Label',
        description: 'USPS Priority - 2-3 day delivery',
      },
      unit_amount: shippingCostInCents,
    },
    quantity: 1,
  },
],
```

### Pre-created Products
If you have fixed products, create them in Stripe Dashboard:

```javascript
line_items: [
  {
    price: 'price_xxx', // Pre-created price ID
    quantity: 1,
  },
],
```

---

## Success URL with Session ID

Use `{CHECKOUT_SESSION_ID}` placeholder:

```javascript
success_url: 'https://sendmo.co/success?session_id={CHECKOUT_SESSION_ID}',
```

On your success page, retrieve the session to verify payment:

```javascript
// In your success page API route
const session = await stripe.checkout.sessions.retrieve(sessionId);

if (session.payment_status === 'paid') {
  // Generate label, update database
}
```

---

## Webhooks (Recommended)

Don't rely solely on success_url. Use webhooks for reliability:

### Webhook Endpoint
```javascript
// POST /api/webhooks/stripe
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

export async function POST(req) {
  const sig = req.headers.get('stripe-signature');
  const body = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
  } catch (err) {
    return new Response('Webhook Error', { status: 400 });
  }

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      await handleSuccessfulPayment(session);
      break;
    case 'checkout.session.expired':
      // Clean up pending shipment
      break;
  }

  return new Response('OK', { status: 200 });
}

async function handleSuccessfulPayment(session) {
  const shipmentId = session.metadata.shipment_id;
  const rateId = session.metadata.rate_id;

  // 1. Update shipment status to 'paid'
  // 2. Generate label via EasyPost
  // 3. Send confirmation email
}
```

### Important Webhook Events

| Event | When | Action |
|-------|------|--------|
| `checkout.session.completed` | Payment successful | Generate label |
| `checkout.session.expired` | Session timed out | Clean up |
| `charge.refunded` | Refund processed | Cancel label |

---

## Customization

### Branding
In Stripe Dashboard → Settings → Branding:
- Logo
- Brand color
- Accent color
- Icon

### Checkout Options
```javascript
const session = await stripe.checkout.sessions.create({
  // ... other options

  // Collect billing address
  billing_address_collection: 'required',

  // Collect shipping address (if needed)
  shipping_address_collection: {
    allowed_countries: ['US'],
  },

  // Add terms of service
  consent_collection: {
    terms_of_service: 'required',
  },

  // Custom text
  custom_text: {
    submit: {
      message: 'Your label will be ready immediately after payment.',
    },
  },

  // Prefill customer email
  customer_email: 'buyer@example.com',
});
```

---

## Mobile Support

Checkout is mobile-optimized out of the box:
- Responsive design
- Apple Pay / Google Pay support
- Touch-friendly inputs

Enable wallet payments:
```javascript
payment_method_types: ['card'],
// Wallets are auto-enabled when available
```

---

## Error Handling

### Session Creation Errors
```javascript
try {
  const session = await stripe.checkout.sessions.create({ ... });
} catch (error) {
  if (error.type === 'StripeInvalidRequestError') {
    // Invalid parameters
  } else if (error.type === 'StripeAPIError') {
    // Stripe API issue
  }
}
```

### Payment Failures
Checkout handles payment failures automatically—the buyer stays on the page and can retry. You only need to handle success.

---

## Testing

### Test Mode
Use test API keys (`pk_test_...`, `sk_test_...`).

### Test Cards
| Card Number | Behavior |
|-------------|----------|
| `4242424242424242` | Success |
| `4000000000000002` | Declined |
| `4000002500003155` | Requires authentication (3DS) |
| `4000000000009995` | Insufficient funds |

### Test Webhooks
Use Stripe CLI for local testing:
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

---

## SendMo Integration

### API Route: Create Payment Session
```javascript
// POST /api/shipments/:id/pay
export async function POST(req, { params }) {
  const shipment = await getShipment(params.id);

  if (!shipment || shipment.status !== 'pending') {
    return NextResponse.json({ error: 'Invalid shipment' }, { status: 400 });
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${shipment.carrier} ${shipment.service}`,
            description: `Ship to ${shipment.toCity}, ${shipment.toState}`,
          },
          unit_amount: Math.round(shipment.rate * 100),
        },
        quantity: 1,
      },
      {
        price_data: {
          currency: 'usd',
          product_data: { name: 'SendMo Fee' },
          unit_amount: 199,
        },
        quantity: 1,
      },
    ],
    mode: 'payment',
    success_url: `${process.env.NEXT_PUBLIC_URL}/shipment/${shipment.id}/success`,
    cancel_url: `${process.env.NEXT_PUBLIC_URL}/shipment/${shipment.id}`,
    metadata: {
      shipment_id: shipment.id,
      rate_id: shipment.selectedRateId,
    },
  });

  return NextResponse.json({ url: session.url });
}
```

### Frontend: Redirect to Checkout
```javascript
async function handlePayment() {
  const response = await fetch(`/api/shipments/${shipmentId}/pay`, {
    method: 'POST',
  });
  const { url } = await response.json();
  window.location.href = url;
}
```

---

## Costs

| What | Cost |
|------|------|
| Checkout usage | Free |
| Card processing | 2.9% + $0.30 |
| International cards | +1.5% |
| Currency conversion | +1% |

**Example**: $10 shipping label
- Buyer pays: $10.00
- Stripe fee: $0.59 (2.9% + $0.30)
- SendMo receives: $9.41
